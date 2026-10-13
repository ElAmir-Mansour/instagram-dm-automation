/**
 * The 3D engine behind the landing page's scenes (L10, L11): ONE WebGL renderer and ONE canvas for the whole page.
 *
 * A scene lives on a host element (the hero stage, a diagram's figure). The canvas is moved into whichever host is most on
 * screen, so the page never holds more than one WebGL context however many scenes it has; a scene's GPU resources stay valid
 * on that one renderer while it waits its turn. The engine owns everything about being a good citizen: the gates' second half
 * (a renderer that must not be a software one), the loop and what stops it (off screen, a hidden tab, three loops of no
 * input), the downgrade ladder (DPR 1.0, then the lite profile, then give up and show the posters), the theme and language
 * watchers, context loss, reduced motion switched on, and the page going away. A scene only draws.
 *
 * A scene is a factory, `create(ctx) -> Promise<instance>`; an instance is
 *   { scene, camera, resize(w, h), update(T, dt, input), retheme(tokens), repaint(), setProfile(profile), dispose(), debug? }
 * where `T` counts seconds of this scene's own time (it only runs while it is the one on screen). The hero's factory ships in
 * this chunk; the diagram scenes are their own chunks, named by a host's data-scene3d and fetched when it nears the viewport.
 *
 * Failure rules: nothing here may leave a canvas, a listener, an observer or a context behind. A failure while the engine
 * comes up disposes everything it made and rethrows (the loader keeps the posters). A scene that fails later is marked failed
 * and its host keeps its HTML diagram; the rest carry on.
 */
import { BufferAttribute, BufferGeometry, SRGBColorSpace, WebGLRenderer } from 'three';
import { LOOP, MAX_DPR, median, parseColor } from './core.mjs';

const WINDOW = 120, WARMUP = 12;
const SLEEP_MS = 3 * LOOP * 1000;
/** How early a scene's chunk is fetched: this far outside the viewport. */
export const NEAR = '200px 0px';

export const langOf = () => (document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'ar');

/** A flat BufferGeometry from core.mjs's {positions, index}: no UVs, no normals, the material is unlit and untextured. */
export function flat({ positions, index }) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setIndex(new BufferAttribute(index, 1));
    return g;
}

/** The theme, read from the page's tokens. Parsed here: Color.setStyle warns on alpha, and these tokens carry it. */
export function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const t = (name, fallback) => parseColor(cs.getPropertyValue(name)) ?? parseColor(fallback);
    return {
        page: t('--surface-page', '#111210'),
        solid: t('--surface-solid', '#1e1f1b'),
        ring: t('--border-strong', 'rgba(255, 255, 255, 0.2)'),
        subtle: t('--border-subtle', 'rgba(255, 255, 255, 0.12)'),
        glass: t('--surface-glass', 'rgba(255, 255, 255, 0.08)'),
        text: t('--text-default', '#d2d4ca'),
        strong: t('--text-strong', '#f2f3ec'),
        muted: t('--text-muted', '#a8ab9e'),
        logo: t('--logo-mono', '#ffffff'),
        mark: t('--accent-soft', 'rgba(188, 222, 112, 0.16)'),
        markRing: t('--accent-ring', 'rgba(188, 222, 112, 0.4)'),
        markText: t('--accent-text', '#c9e683'),
        accent: t('--accent', '#bcde70'),
        onAccent: t('--text-on-accent', '#141610'),
    };
}

const glyphs = {};
/** A platform's mark as a Path2D, read from the page's own sprite (so it is exactly the logo the page draws). */
export function glyphPath(p) {
    if (!(p in glyphs)) {
        const d = document.querySelector(`#plogo-${p} path`)?.getAttribute('d');
        glyphs[p] = d ? new Path2D(d) : null;
    }
    return glyphs[p];
}

/** Make sure the face a label will be drawn in is loaded for those texts before they are drawn. */
export const loadFonts = (family, texts, weight = 600) => Promise.all(texts.map((t) => document.fonts.load(`${weight} 22px ${family}`, t)));

/**
 * Bring the engine up.
 * @param {Array<{el: HTMLElement, id: string, create?: Function, url?: string}>} entries the hosts, in document order
 * @param {{lite?: boolean}} options
 * @returns {Promise<{dispose(): void, stats(): object}>} resolved once the first scene that can be on screen is (or none is)
 */
export async function start(entries, options = {}) {
    const root = document.documentElement;
    const debug = /[?&]debug3d=1\b/.test(location.search);
    const fine = matchMedia('(pointer: fine)').matches;
    const E = {
        profile: options.lite ? 'lite' : 'full',
        dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
        tokens: readTokens(), ver: { tokens: 0, dpr: 0, profile: 0 },
        raf: 0, prev: 0, paused: false, asleep: false, dead: false, ready: false, settle: null,
        active: null, target: null, activity: performance.now(),
        input: { px: 0, py: 0, moved: false, scrollY: window.scrollY, fine },
        ms: [], level: 0, median: 0, frames: 0,
    };
    const reg = entries.map((e) => ({
        ...e, inst: null, building: null, T: 0, vis: 0, seen: { tokens: 0, dpr: 0, profile: 0 },
        state: e.create ? 'ready' : 'idle',
    }));

    // ── The renderer. A software or otherwise slow context throws here, and the posters stay. ───────────────────
    const renderer = new WebGLRenderer({
        alpha: true,
        antialias: (window.devicePixelRatio || 1) < 2,
        powerPreference: 'low-power',
        failIfMajorPerformanceCaveat: true,
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(E.dpr);
    const canvas = renderer.domElement;
    canvas.className = 'stage-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    const on = [];
    const listen = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); on.push(() => t.removeEventListener(type, fn, opts)); };
    const ctxFor = (e) => ({
        el: e.el, id: e.id, canvas, renderer, fine, input: E.input,
        get tokens() { return E.tokens; }, get dpr() { return E.dpr; }, get profile() { return E.profile; },
    });

    // ── Instances: made when a host first needs one ─────────────────────────────────────────────────────────────
    function instanceFor(e) {
        e.building ||= (async () => {
            const inst = await e.create(ctxFor(e));
            if (E.dead) { inst.dispose(); throw new Error('disposed while building'); }
            e.inst = inst;
            e.seen = { ...E.ver };
            await renderer.compileAsync(inst.scene, inst.camera);
            if (E.dead) throw new Error('disposed while compiling');
            return inst;
        })();
        return e.building;
    }
    function fail(e, err) {
        // While the engine is still coming up, its first scene failing is the engine failing: mount() rejects and disposes.
        if (E.settle) { settle(err); return; }
        console.info('hero3d: scene ' + e.id + ' stays as its poster,', err);
        e.state = 'failed';
        if (E.active === e) { E.active = null; e.el.classList.remove('is-3d'); }
        if (E.target === e) E.target = null;
        try { e.inst?.dispose(); } catch (x) { /* already gone */ }
        e.inst = null;
        pick();
    }

    const sizeNow = () => {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h || !E.active?.inst) return false;
        renderer.setSize(w, h, false);
        E.active.inst.resize(w, h);
        return true;
    };

    /** Bring an instance up to date with what changed while it waited: the profile, the pixel ratio, the theme. */
    function refresh(e) {
        const inst = e.inst;
        if (e.seen.profile !== E.ver.profile) inst.setProfile(E.profile);
        else if (e.seen.dpr !== E.ver.dpr) inst.repaint();
        if (e.seen.tokens !== E.ver.tokens && e.seen.profile === E.ver.profile) inst.retheme(E.tokens);
        e.seen = { ...E.ver };
    }

    // ── Which host is on screen ─────────────────────────────────────────────────────────────────────────────────
    function pick() {
        if (E.dead || !E.ready) return;
        let best = null;
        for (const e of reg) if (e.state === 'ready' && e.vis > 0 && (!best || e.vis > best.vis)) best = e;
        if (best && best !== E.active && best !== E.target) void activate(best);
        else if (!E.target) { settle(); kick(); }
    }
    /** The first pick has run its course (a scene is up, or none can be): mount() may answer. */
    function settle(err) {
        const done = E.settle;
        E.settle = null;
        done?.(err);
    }

    async function activate(e) {
        E.target = e;
        let inst;
        try { inst = await instanceFor(e); } catch (err) { if (!E.dead) fail(e, err); return; }
        if (E.dead || E.target !== e) return;
        E.target = null;
        try {
            const old = E.active;
            E.active = e;
            const poster = e.el.querySelector(':scope > .stage-poster');
            e.el.insertBefore(canvas, poster ? poster.nextSibling : e.el.firstChild);
            if (e.seen.profile !== E.ver.profile || e.seen.dpr !== E.ver.dpr || e.seen.tokens !== E.ver.tokens) refresh(e);
            if (!sizeNow()) throw new Error('the host has no size');
            inst.update(e.T, 0.016, E.input);
            renderer.render(inst.scene, inst.camera);
            if (old && old !== e) old.el.classList.remove('is-3d');
            e.el.classList.add('is-3d');
        } catch (err) {
            if (!E.dead) fail(e, err);
            return;
        }
        ro.disconnect();
        ro.observe(e.el);
        poke();
        kick();
        settle();
    }

    // ── The loop ────────────────────────────────────────────────────────────────────────────────────────────────
    const running = () => !!E.active && !E.paused && E.active.vis > 0 && !document.hidden && !E.asleep && !E.dead;
    function frame(now) {
        E.raf = 0;
        if (!running()) return;
        if (now - E.activity > SLEEP_MS) { E.asleep = true; return; }
        const dt = Math.min((now - E.prev) / 1000, 0.1);
        E.prev = now;
        const e = E.active;
        e.T += dt;
        e.inst.update(e.T, dt, E.input);
        renderer.render(e.inst.scene, e.inst.camera);
        sample(dt);
        if (E.dead) return;
        E.raf = requestAnimationFrame(frame);
    }
    function kick() {
        if (E.raf || !running()) return;
        E.prev = performance.now();
        E.raf = requestAnimationFrame(frame);
    }
    function poke() {
        E.activity = performance.now();
        if (E.asleep) { E.asleep = false; kick(); }
    }

    /** The downgrade ladder: a median over 20 ms is under 50 fps. Cheaper pixels first, then fewer things, then give up. */
    function sample(dt) {
        E.frames++;
        if (E.frames <= WARMUP) return;
        E.ms.push(dt * 1000);
        if (E.ms.length < WINDOW) return;
        E.median = median(E.ms);
        E.ms.length = 0;
        if (E.median <= 20) return;
        if (E.level === 0 && E.dpr > 1) {
            E.level = 1;
            E.dpr = 1;
            E.ver.dpr++;
            renderer.setPixelRatio(1);
            if (E.active) { E.active.inst.repaint(); E.active.seen = { ...E.ver }; sizeNow(); }
        } else if (E.level < 2 && E.profile === 'full') {
            E.level = 2;
            E.profile = 'lite';
            E.ver.profile++;
            if (E.active) { E.active.inst.setProfile('lite'); E.active.seen = { ...E.ver }; sizeNow(); }
        } else if (E.median > 24) {
            fallback('slow: median ' + E.median.toFixed(1) + ' ms');
        }
    }

    // ── Events and observers ────────────────────────────────────────────────────────────────────────────────────
    listen(window, 'pointermove', (ev) => { E.input.px = ev.clientX; E.input.py = ev.clientY; E.input.moved = true; poke(); }, { passive: true });
    listen(window, 'scroll', () => { E.input.scrollY = window.scrollY; poke(); }, { passive: true });
    listen(window, 'keydown', poke, { passive: true });
    listen(document, 'visibilitychange', () => { if (!document.hidden) kick(); });
    // A page that is going away for good takes its context with it now, not at garbage collection; one that is only
    // being put in the back/forward cache (persisted) is left whole.
    listen(window, 'pagehide', (ev) => { if (!ev.persisted) dispose(); });
    listen(canvas, 'webglcontextlost', (ev) => { ev.preventDefault(); fallback('context lost'); });
    const schemeMq = matchMedia('(prefers-color-scheme: light)');
    const motionMq = matchMedia('(prefers-reduced-motion: reduce)');
    listen(motionMq, 'change', () => { if (motionMq.matches) fallback('reduced motion'); });

    // Every host reports how much of it is on screen; the most visible one that can draw is the one the canvas goes to.
    const io = new IntersectionObserver((records) => {
        for (const r of records) {
            const e = reg.find((x) => x.el === r.target);
            if (e) e.vis = r.isIntersecting ? r.intersectionRect.width * r.intersectionRect.height : 0;
        }
        pick();
    }, { threshold: [0, 0.05, 0.25, 0.5, 0.75, 1] });
    // A scene's chunk is fetched only when its host is near the viewport; a visitor who never scrolls there never pays for it.
    const lazy = new IntersectionObserver((records) => {
        for (const r of records) {
            if (!r.isIntersecting) continue;
            lazy.unobserve(r.target);
            const e = reg.find((x) => x.el === r.target);
            if (e && e.state === 'idle') void load(e);
        }
    }, { rootMargin: NEAR });
    async function load(e) {
        e.state = 'loading';
        try {
            const m = await import(e.url);
            if (E.dead) return;
            e.create = m.default;
            e.state = typeof e.create === 'function' ? 'ready' : 'failed';
        } catch (err) {
            if (E.dead) return;
            e.state = 'failed';
            console.info('hero3d: scene ' + e.id + ' stays as its poster,', err);
        }
        pick();
    }

    const ro = new ResizeObserver(() => { if (!E.dead && sizeNow() && !E.raf) renderer.render(E.active.inst.scene, E.active.inst.camera); });

    const rethemeAll = () => {
        if (E.dead) return;
        E.tokens = readTokens();
        E.ver.tokens++;
        const e = E.active;
        if (e?.inst) {
            e.inst.retheme(E.tokens);
            e.seen = { ...e.seen, tokens: E.ver.tokens };
            if (!E.raf) renderer.render(e.inst.scene, e.inst.camera);
        }
    };
    listen(schemeMq, 'change', () => requestAnimationFrame(rethemeAll));
    // The page's theme or language changed: a theme re-reads the tokens, a language is a different host coming on screen.
    const mo = new MutationObserver((records) => {
        if (E.dead || !E.ready) return;
        if (records.some((r) => r.attributeName === 'data-theme')) rethemeAll();
        pick();
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-lang'] });

    // ── The ways out ────────────────────────────────────────────────────────────────────────────────────────────
    function dispose() {
        if (E.dead) return;
        E.dead = true;
        E.ready = false;
        settle();
        cancelAnimationFrame(E.raf);
        for (const off of on) off();
        io.disconnect(); lazy.disconnect(); ro.disconnect(); mo.disconnect();
        for (const e of reg) {
            try { e.inst?.dispose(); } catch (x) { /* already gone */ }
            e.inst = null;
            e.el.classList.remove('is-3d');
        }
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
    }
    function fallback(why) {
        console.info('hero3d: poster, ' + why);
        if (why !== 'context lost' && why !== 'reduced motion') {
            try { sessionStorage.setItem('hero3d_off', '1'); } catch (e) { /* private mode */ }
        }
        dispose();
    }

    // ── Go ──────────────────────────────────────────────────────────────────────────────────────────────────────
    // Whatever goes wrong while the engine comes up (a font that will not load, a host with no size, a shader that will not
    // compile, the visitor asking for less motion while this waits) disposes everything this call made and rethrows.
    try {
        if (motionMq.matches) throw new Error('reduced motion');
        E.ready = true;
        // The first scene that can be on screen: the hero of the language shown, if it is. Others wait for their turn.
        // (The observer's first report decides; a host that takes more than six seconds to come up is a failure.)
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('the first scene did not come up')), 6000);
            on.push(() => clearTimeout(timer));
            E.settle = (err) => { clearTimeout(timer); if (err) reject(err); else resolve(); };
            for (const e of reg) {
                io.observe(e.el);
                if (e.state === 'idle') lazy.observe(e.el);
            }
        });
        if (E.dead) throw new Error('disposed while mounting');
    } catch (err) {
        dispose();
        throw err;
    }

    const api = {
        dispose,
        stats() {
            const i = renderer.info;
            const e = E.active;
            return {
                active: e?.id ?? null, profile: E.profile, dpr: E.dpr, lang: langOf(),
                bubbles: e?.inst?.debug?.bubbles?.filter((b) => b.shown).length ?? 0,
                calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures, geometries: i.memory.geometries,
                median: E.median, frames: E.frames, T: e?.T ?? 0, canvas: [canvas.width, canvas.height],
                running: !!E.raf, paused: E.paused, asleep: E.asleep, dead: E.dead,
                scenes: reg.map((x) => [x.id, x.state]),
            };
        },
    };
    if (debug) {
        window.__hero3d = {
            ...api,
            /** Draw a scene at a chosen moment of its own time, held there: for screenshots and the budget checks. */
            seek(T, id) {
                const e = id ? reg.find((x) => x.id === id && x.inst) : E.active;
                if (!e?.inst) throw new Error('no such scene on screen: ' + id);
                E.paused = true;
                cancelAnimationFrame(E.raf);
                E.raf = 0;
                if (E.active !== e) {
                    // hold a scene that is not the one the observer chose (a harness frame of an off-screen host)
                    E.active?.el.classList.remove('is-3d');
                    E.active = e;
                    const poster = e.el.querySelector(':scope > .stage-poster');
                    e.el.insertBefore(canvas, poster ? poster.nextSibling : e.el.firstChild);
                    refresh(e);
                    sizeNow();
                    e.el.classList.add('is-3d');
                }
                e.T = T;
                e.inst.update(T, 0.016, E.input);
                renderer.render(e.inst.scene, e.inst.camera);
                return api.stats();
            },
            /** Let a scene held by seek() run again. */
            resume() {
                E.paused = false;
                poke();
                kick();
            },
            get state() { return reg.find((x) => x.inst?.debug && x.id.startsWith('hero') && x.el.offsetWidth)?.inst.debug ?? reg.find((x) => x.inst?.debug)?.inst.debug; },
            get camera() { return E.active?.inst.camera; },
            engine: E,
            entries: reg,
        };
    }
    return api;
}
