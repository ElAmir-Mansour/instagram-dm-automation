/**
 * The wizard's door to the profile draft (docs/onboarding/03 §4, P24): start a draft, watch it, let the person carry on while it is
 * written ("Start without waiting"), and apply what it found field by field. A helper with no screen of its own: the wizard (P18) and the
 * operator's tenant page load it on demand (`App.loadPageModule('draft_client')`) and keep every pixel and every word themselves.
 *
 * ─── What the server gives it ───────────────────────────────────────────────
 * `GET /api/onboarding/draft` (the tenant) or `GET /api/admin/tenants/:id/draft` (an operator) answers `{ draft }`, a view:
 *   status         queued → fetching → drafting → ready, or failed / superseded
 *   advanceable    a caller may fire `advance` now and expect it to do something (nobody holds the draft, its back-off is over)
 *   working        somebody is working on it right now          retryAt   a failed try's next attempt, when it is waiting one out
 *   needsAiKey     no AI provider has a key: continue by hand    error     { kind, message }, a fixed sentence for a tenant
 *   draft          the checked draft, when ready: { profile, provenance, touched, flags, samples, pillars, faqPending, ... }
 *   prefill        when no model could be asked: only what code found (colours, links, the handle)
 *   sourcesStatus  one line per source, ids and kinds of what was read: never the text of it
 *
 * ─── What it does ───────────────────────────────────────────────────────────
 * - `watch()` polls every 3 s while the tab is visible (not at all while it is hidden), fires `advance` when the poll says `advanceable`
 *   and no advance of this page is in flight, and stops when the draft is finished. `advance` is ONE long request (up to 270 s): the server
 *   works inside it, and if this tab closes the backstop sweep finishes the draft.
 * - `startWithoutWaiting(onFill)` is the "continue manually while it drafts" button: the person goes on typing, the watch goes on, and when
 *   the draft is ready `onFill` is handed the fields the person has NOT touched, so the screen can fill them in live. A field the person edited
 *   (`markEdited`) is never offered: what they wrote is theirs.
 * - `applyFields(keys)` writes the chosen fields into the profile through `PATCH /api/profile` (an operator's client: `PATCH
 *   /api/admin/tenants/:id/profile`), in ONE patch (one version, one history row). Nothing is applied by itself: a draft is a suggestion until a
 *   person says so. Only fields the server lists in `touched` can be applied.
 *
 * ─── Escaping ───────────────────────────────────────────────────────────────
 * Everything in a draft came from a bio, a web page or a model. This module never builds markup; it hands the values back as data, and whoever
 * renders them goes through `html` like everything else in the dashboard.
 */
const DraftClient = (() => {
    const POLL_MS = 3000;
    const FINISHED = ['ready', 'failed', 'superseded'];

    // ─── Paths (pure) ───────────────────────────────────────────────────────────────

    /** `audience.pains[0].x` as `['audience', 'pains', 0, 'x']`. Keys that could reach a prototype are refused (null). */
    function parsePath(path) {
        if (typeof path !== 'string' || path === '' || path.length > 200) return null;
        const keys = [];
        for (const part of path.split('.')) {
            const m = /^([A-Za-z_][A-Za-z0-9_]*)((?:\[\d{1,3}\])*)$/.exec(part);
            if (!m) return null;
            if (m[1] === '__proto__' || m[1] === 'constructor' || m[1] === 'prototype') return null;
            keys.push(m[1]);
            for (const index of m[2].matchAll(/\[(\d+)\]/g)) keys.push(Number(index[1]));
        }
        return keys;
    }

    function getAt(object, path) {
        const keys = parsePath(path);
        if (!keys) return undefined;
        let node = object;
        for (const key of keys) {
            if (node === null || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
            node = node[key];
        }
        return node;
    }

    /** Sets `path` in `object`, making the objects on the way. Only plain names: a list is never entered (see `fieldKey`). */
    function setAt(object, path, value) {
        const keys = parsePath(path);
        if (!keys || keys.some((k) => typeof k === 'number')) return false;
        let node = object;
        for (let i = 0; i < keys.length - 1; i += 1) {
            if (node[keys[i]] === undefined || node[keys[i]] === null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
            node = node[keys[i]];
        }
        node[keys[keys.length - 1]] = value;
        return true;
    }

    /**
     * The path a field is applied at. A patch replaces a list whole and cannot change one entry of it, so a drafted entry's field is its
     * list: `audience.pains[0]`, `offers[1].url` and `dm.faq[2].a` are applied as `audience.pains`, `offers` and `dm.faq`.
     */
    function fieldKey(path) {
        const at = String(path).indexOf('[');
        return at === -1 ? String(path) : String(path).slice(0, at);
    }

    const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

    // ─── Reading a view (pure) ──────────────────────────────────────────────────────

    /**
     * Where the draft is, as something a screen can say. `phase`: `none` (no draft yet), `working` (being made now), `retrying` (a try failed and the
     * next is not due), `ready`, `needs_key` (no AI key: carry on by hand), `failed`, `superseded` (replaced by a newer one). `step` while it is
     * being made: `queued`, `fetching` (reading the accounts) or `drafting` (the assistant is writing). `canSkipWaiting`: the "Start without
     * waiting" button makes sense. `prefill`: what code found is there to use even though no assistant answered.
     */
    function phaseOf(view) {
        if (!view || typeof view !== 'object' || Array.isArray(view)) return { phase: 'none', step: null, canSkipWaiting: false, prefill: false, retryAt: null };
        const prefill = Boolean(view.prefill);
        if (view.status === 'ready') return { phase: 'ready', step: null, canSkipWaiting: false, prefill: false, retryAt: null };
        if (view.status === 'superseded') return { phase: 'superseded', step: null, canSkipWaiting: false, prefill: false, retryAt: null };
        if (view.status === 'failed') return { phase: view.needsAiKey ? 'needs_key' : 'failed', step: null, canSkipWaiting: false, prefill, retryAt: null };
        const step = view.status === 'queued' || view.status === 'fetching' || view.status === 'drafting' ? view.status : null;
        if (view.retryAt) return { phase: 'retrying', step, canSkipWaiting: true, prefill: false, retryAt: view.retryAt };
        return { phase: 'working', step, canSkipWaiting: true, prefill: false, retryAt: null };
    }

    /**
     * The fields a draft offers, one per `fieldKey`: `{ key, paths, value, provenance, flags, source }`. `value` is a copy. `provenance` is where
     * each fact came from (`{ path, source, evidence, confidence }`: a source id and a quote that was checked against it, or `inferred`), and is
     * EMPTY for what code found on its own (the colours, the links, the handle): the screen can say "found on your site" for those and show the
     * quote for the rest. `flags` are what the checker took out or doubts, for a person to tick. `source` is `draft` or `prefill`.
     */
    function fieldsOf(view) {
        const column = view && (view.draft || view.prefill);
        if (!column || !column.profile || !Array.isArray(column.touched)) return [];
        const source = view.draft ? 'draft' : 'prefill';
        const byKey = new Map();
        for (const path of column.touched) {
            if (parsePath(path) === null) continue;
            const key = fieldKey(path);
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push(path);
        }
        const provenance = column.provenance || {};
        const flags = Array.isArray(column.flags) ? column.flags : [];
        const out = [];
        for (const [key, paths] of byKey) {
            const value = getAt(column.profile, key);
            if (value === undefined) continue;
            const proven = paths.filter((p) => provenance[p]).map((p) => Object.assign({ path: p }, provenance[p]));
            out.push({
                key,
                paths,
                value: clone(value),
                provenance: proven,
                flags: flags.filter((f) => f && typeof f.path === 'string' && (f.path === key || fieldKey(f.path) === key)),
                source,
            });
        }
        return out;
    }

    /** The one patch that applies `fields` (see `fieldsOf`) on top of the profile: `{ audience: { pains: [...] }, brand: { primary: '#…' } }`. */
    function patchFor(fields) {
        const patch = {};
        for (const field of fields) setAt(patch, field.key, clone(field.value));
        return patch;
    }

    // ─── The controller ─────────────────────────────────────────────────────────────

    /**
     * One draft's controller. `tenantId`: an operator's, for a tenant it names; omitted: the signed-in tenant's own wizard.
     * `timers` and `visible` are for tests; by default `setTimeout` and the page's visibility.
     */
    function create(options) {
        const opts = options || {};
        const base = opts.tenantId ? `/admin/tenants/${encodeURIComponent(opts.tenantId)}/draft` : '/onboarding/draft';
        // Applying goes through the profile's own PATCH: the tenant's `/profile`, or for an operator the admin's on-behalf route (P19), which is
        // the same function with the same version lock and records that the operator wrote it.
        const profile = opts.tenantId ? `/admin/tenants/${encodeURIComponent(opts.tenantId)}/profile` : '/profile';
        const timers = opts.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };
        const visible = opts.visible || (() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
        const request = (path, init) => API.request(path, init);

        const client = {
            /** The latest view, or null. */
            view: null,
            /** The person chose to carry on by hand while it drafts. */
            manual: false,
            _edited: new Set(),
            _applied: new Set(),
            _advancing: null,
            _filledFor: null,
            _onFill: null,
            _listeners: [],
            _timer: null,
            _watching: false,
            _removeWatchListener: null,

            /** The listener is told about every change of the view, with what changed it (`start`, `advance`, `refresh`). */
            onChange(listener) {
                client._listeners.push(listener);
                return () => { client._listeners = client._listeners.filter((l) => l !== listener); };
            },

            _set(view, why, force) {
                const changed = force === true || !client.view || !view || client.view.id !== view.id || client.view.status !== view.status || client.view.updatedAt !== view.updatedAt
                    || client.view.advanceable !== view.advanceable || client.view.working !== view.working || client.view.retryAt !== view.retryAt;
                client.view = view || null;
                if (changed) for (const listener of client._listeners.slice()) { try { listener(client.view, why); } catch (err) { /* a screen's bug is not ours */ } }
                client._maybeFill();
                return client.view;
            },

            /** Read the current draft. */
            async refresh(force) {
                const reply = await request(base, { method: 'GET' });
                return client._set(reply && reply.draft ? reply.draft : null, 'refresh', force);
            },

            /**
             * Start a draft from what the person typed: `{ instagram, website, youtube, about }`, any of them; what is not sent comes from
             * what the operator typed at creation. An operator may add `force: true`. Answers `{ draft, reused, superseded }`: `reused` says the
             * same inputs already had a draft (nothing was made and nothing was spent).
             */
            async start(inputs, startOptions) {
                const body = Object.assign({}, inputs || {});
                if (startOptions && startOptions.force && opts.tenantId) body.force = true;
                const reply = await request(base, { method: 'POST', body: JSON.stringify(body) });
                client._edited.clear();
                client._applied.clear();
                client._filledFor = null;
                client._set(reply.draft, 'start');
                return reply;
            },

            /**
             * Fire `advance`: the server does the next steps of the draft inside this one request, which can last minutes. Only one runs at a time
             * from this page: a second call gets the first one's promise. Resolves with `{ draft, advance }`.
             */
            advance() {
                if (client._advancing) return client._advancing;
                client._advancing = request(`${base}/advance`, { method: 'POST', body: '{}' })
                    .then((reply) => { client._set(reply.draft, 'advance'); return reply; })
                    .finally(() => { client._advancing = null; });
                return client._advancing;
            },

            /**
             * Poll until the draft is finished. `onChange(view, why)` is called as the draft moves; `onError(err)` once, if the watch has to give up
             * (the session ended, the tenant's onboarding is over). A network blip is not one: the next tick tries again.
             */
            watch(onChange, onError) {
                client.stop();
                client._watching = true;
                if (client._removeWatchListener) client._removeWatchListener();
                client._removeWatchListener = onChange ? client.onChange(onChange) : null;
                // The first poll tells the listener where the draft is even if nothing changed since it last looked.
                let first = true;
                const tick = async () => {
                    client._timer = null;
                    if (!client._watching) return;
                    if (visible()) {
                        try {
                            const view = await client.refresh(first);
                            first = false;
                            if (!client._watching) return;
                            if (view && view.advanceable && !client._advancing) {
                                // Un-awaited: it is the long request, and the poll must keep going while it runs.
                                client.advance().catch((err) => client._fail(err, onError));
                            }
                            if (!view || FINISHED.indexOf(view.status) !== -1) { client._watching = false; return; }
                        } catch (err) {
                            if (client._isFatal(err)) { client._fail(err, onError); return; }
                        }
                    }
                    if (client._watching) client._timer = timers.set(tick, POLL_MS);
                };
                client._timer = timers.set(tick, 0);
                return { stop: () => client.stop() };
            },

            stop() {
                client._watching = false;
                if (client._timer !== null) timers.clear(client._timer);
                client._timer = null;
            },

            /** An error that polling again will not fix: the session is gone, or this tenant is not in a wizard. */
            _isFatal(err) {
                return Boolean(err) && (err.status === 401 || err.status === 403 || err.status === 404 || (err.status === 409 && err.body && err.body.code === 'ONBOARDING_COMPLETED'));
            },

            _fail(err, onError) {
                if (client._isFatal(err)) client.stop();
                if (typeof onError === 'function') { try { onError(err); } catch (e) { /* the caller's */ } }
            },

            /**
             * "Start without waiting": the person carries on by hand while the draft is written. The watch (if it is running) goes on; when the draft is
             * ready, or when only what code found is there, `onFill(fields, view)` is called ONCE for that draft with the fields the person has not
             * touched, for the screen to fill in. Safe to call when the draft is already finished: it answers at once.
             */
            startWithoutWaiting(onFill) {
                client.manual = true;
                client._onFill = typeof onFill === 'function' ? onFill : null;
                client._maybeFill();
            },

            _maybeFill() {
                if (!client.manual || !client._onFill || !client.view) return;
                const phase = phaseOf(client.view).phase;
                const there = phase === 'ready' || ((phase === 'needs_key' || phase === 'failed') && client.view.prefill);
                if (!there || client._filledFor === client.view.id) return;
                client._filledFor = client.view.id;
                const fields = client.fieldsToFill();
                try { client._onFill(fields, client.view); } catch (err) { /* the screen's */ }
            },

            /** The person typed into this field (a profile path, or its key): what they wrote is theirs, and the draft will not be offered over it. */
            markEdited(path) {
                if (parsePath(String(path)) !== null) client._edited.add(fieldKey(path));
            },

            /** Everything the draft offers, applied or not. */
            fields() {
                return fieldsOf(client.view);
            },

            /** What may still be filled in: not edited by the person, not already applied. */
            fieldsToFill() {
                return client.fields().filter((f) => !client._edited.has(f.key) && !client._applied.has(f.key));
            },

            /**
             * Apply fields to the profile, by key, in ONE patch (`PATCH /api/profile`, owner only). Only keys the draft offers are applied, and each
             * one as the draft has it; a key it does not offer is ignored. If the profile moved on since it was read (409, version conflict) the patch is
             * made again once against the version the server names: a patch is by path, so a newer version is no reason to refuse it. Resolves with
             * `{ applied, version, activationMissing }`. Rejects with the server's refusal (`err.body.problems` on a 400).
             */
            async applyFields(keys) {
                const wanted = new Set((keys || []).map((k) => fieldKey(k)));
                const chosen = client.fields().filter((f) => wanted.has(f.key));
                if (chosen.length === 0) return { applied: [], version: null, activationMissing: null };
                const patch = patchFor(chosen);
                const state = await request(profile, { method: 'GET' });
                let version = state && state.version !== undefined ? state.version : null;
                let reply;
                for (let attempt = 0; ; attempt += 1) {
                    try {
                        reply = await request(profile, { method: 'PATCH', body: JSON.stringify({ version, patch }) });
                        break;
                    } catch (err) {
                        const conflict = err && err.status === 409 && err.body && err.body.code === 'PROFILE_VERSION_CONFLICT';
                        if (!conflict || attempt >= 1) throw err;
                        version = err.body.currentVersion !== undefined ? err.body.currentVersion : null;
                    }
                }
                for (const field of chosen) client._applied.add(field.key);
                return { applied: chosen.map((f) => f.key), version: reply.version, activationMissing: reply.activationMissing };
            },

            applyField(key) {
                return client.applyFields([key]);
            },
        };
        return client;
    }

    return { POLL_MS, FINISHED, parsePath, getAt, setAt, fieldKey, patchFor, phaseOf, fieldsOf, create };
})();
