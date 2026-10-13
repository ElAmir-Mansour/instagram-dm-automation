/**
 * The landing hero's 3D scene (L10): flat comment bubbles drifting in depth behind the hero card, one keyword
 * lit by the cardamom highlighter, and that bubble flying into the card's own message bubble.
 *
 * Bundled with three by scripts/build-hero3d.mjs into public/brand/hero3d.<sha8>.js and loaded by the inline
 * loader in public/landing.html only after the loader's gates pass. The card stays the content and the LCP
 * element; this is an addition behind it, and any failure here leaves the poster.
 *
 * Look: unlit and flat. MeshBasicMaterial only, no lights, fog as the only depth cue, no bloom, no particles,
 * no glow. The mark never appears in the scene, cardamom is the keyword's highlighter and nothing else
 * (IDENTITY.md sections 5 and 6). Everything coloured comes from the page's own tokens, read at run time.
 */
import {
    BufferAttribute, BufferGeometry, CanvasTexture, Fog, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry,
    Raycaster, SRGBColorSpace, Scene, Vector2, WebGLRenderer,
} from 'three';
import {
    CAMERA, FLY_SPLIT, FOG, LOOP, MAX_DPR, MAX_TEXTURE, MAX_TEXTURES, RECEIPT_MS, SLOTS, TIMES, bezier3, bubbleCount,
    clamp01, cssColor, easeDive, easeFly, loopAt, median, mulberry32, parseColor, phase, roundedRectBody, roundedRectRing,
    splitAtKeyword,
} from './core.mjs';

// World units. A bubble is 2.5 wide and 0.7 tall; its label is drawn on a 250 x 70 canvas, 100 px to the unit.
const BW = 2.5, BH = 0.62, BR = 0.24, RING = 0.028;
const NOM_W = 250, NOM_H = 62, WPP = BW / NOM_W;
const SLEEP_MS = 3 * LOOP * 1000;
const WINDOW = 120, WARMUP = 12;

const rad = (deg) => (deg * Math.PI) / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/** A flat BufferGeometry from core.mjs's {positions, index}: no UVs, no normals, the material is unlit and untextured. */
function flat({ positions, index }) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions, 3));
    g.setIndex(new BufferAttribute(index, 1));
    return g;
}

/** The theme, read from the page's tokens. Parsed here: Color.setStyle warns on alpha, and these tokens carry it. */
function readTokens() {
    const cs = getComputedStyle(document.documentElement);
    const t = (name, fallback) => parseColor(cs.getPropertyValue(name)) ?? parseColor(fallback);
    return {
        page: t('--surface-page', '#111210'),
        solid: t('--surface-solid', '#1e1f1b'),
        ring: t('--border-strong', 'rgba(255, 255, 255, 0.2)'),
        text: t('--text-default', '#d2d4ca'),
        logo: t('--logo-mono', '#ffffff'),
        mark: t('--accent-soft', 'rgba(188, 222, 112, 0.16)'),
        markText: t('--accent-text', '#c9e683'),
    };
}

const langOf = () => (document.documentElement.getAttribute('data-lang') === 'en' ? 'en' : 'ar');

/**
 * Mount the scene on the hero stage of the language on screen.
 * @param {HTMLElement[]} stages every .hero-stage (one per language article)
 * @param {{lite?: boolean}} options
 * @returns {Promise<{pause(p: boolean): void, dispose(): void, stats(): object}>} resolved after the first frame
 */
export async function mount(stages, options = {}) {
    const root = document.documentElement;
    stages = Array.from(stages);
    const byLang = { ar: stages.find((s) => s.id === 'hero-stage-ar'), en: stages.find((s) => s.id === 'hero-stage-en') };
    const debug = /[?&]debug3d=1\b/.test(location.search);
    const fine = matchMedia('(pointer: fine)').matches;

    const S = {
        lang: langOf(), stage: null, art: null, dm: null, data: null, sign: 1,
        profile: options.lite ? 'lite' : 'full',
        dpr: Math.min(window.devicePixelRatio || 1, MAX_DPR),
        tokens: readTokens(), bubbles: [], cycle: [],
        T: 0, prev: 0, raf: 0, paused: false, inView: true, asleep: false, dead: false, active: performance.now(),
        px: 0, py: 0, moved: false, scrollY: window.scrollY, p: 0, heroEnd: 1, cam: [0, 0], hover: -1,
        card: null, target: [0, 0], dive: [0, 0], grow: 1, sway: 1, ready: false,
        lastDeliver: -1, ms: [], level: 0, median: 0, frames: 0, fontFamily: '',
    };

    // ── The renderer. A software or otherwise slow context throws here, and the poster stays. ──────────────────
    const renderer = new WebGLRenderer({
        alpha: true,
        antialias: (window.devicePixelRatio || 1) < 2,
        powerPreference: 'low-power',
        failIfMajorPerformanceCaveat: true,
    });
    renderer.outputColorSpace = SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(S.dpr);
    const canvas = renderer.domElement;
    canvas.className = 'stage-canvas';
    canvas.setAttribute('aria-hidden', 'true');

    const scene = new Scene();
    scene.fog = new Fog(0x000000, FOG.near, FOG.far);
    const camera = new PerspectiveCamera(CAMERA.fov, 1, CAMERA.near, CAMERA.far);
    camera.position.set(0, 0, CAMERA.z);
    const world = new Group();
    scene.add(world);
    const ray = new Raycaster();
    const ndc = new Vector2();

    // Shared geometry: every bubble is the same shape, so the scene owns six buffers, not forty.
    const geo = {
        body: flat(roundedRectBody(BW, BH, BR)),
        ring: flat(roundedRectRing(BW, BH, BR, RING)),
        plane: new PlaneGeometry(BW, BH),
        unit: new PlaneGeometry(1, 1),
        sweepLtr: new PlaneGeometry(1, 1).translate(0.5, 0, 0),
        sweepRtl: new PlaneGeometry(1, 1).translate(-0.5, 0, 0),
    };

    const glyphs = {};
    const glyphOf = (p) => {
        if (!(p in glyphs)) {
            const d = document.querySelector(`#plogo-${p} path`)?.getAttribute('d');
            glyphs[p] = d ? new Path2D(d) : null;
        }
        return glyphs[p];
    };

    // ── Which stage, and what is on it ───────────────────────────────────────────────────────────────────────
    function pickStage() {
        S.lang = langOf();
        S.stage = byLang[S.lang];
        if (!S.stage) throw new Error('no hero stage for ' + S.lang);
        S.art = S.stage.querySelector('.artifact');
        S.dm = S.stage.querySelector('.artifact .bubble');
        S.data = JSON.parse(S.stage.getAttribute('data-hero3d'));
        S.sign = getComputedStyle(S.stage).direction === 'rtl' ? -1 : 1;
        const said = S.stage.querySelector('.said');
        S.fontFamily = getComputedStyle(said || S.stage).fontFamily;
        if (!S.art || !S.dm || !Array.isArray(S.data.comments) || !S.data.comments.length) throw new Error('hero stage is incomplete');
    }

    // ── Bubbles ──────────────────────────────────────────────────────────────────────────────────────────────
    function disposeBubble(b) {
        world.remove(b.group);
        for (const m of b.meshes) m.material.dispose();
        b.labelTex?.dispose();
        b.kwTex?.dispose();
    }

    function buildBubbles() {
        for (const b of S.bubbles) disposeBubble(b);
        S.bubbles = [];
        const n = bubbleCount(S.profile, S.data.comments);
        const rnd = mulberry32(7);
        for (let i = 0; i < n; i++) {
            const c = S.data.comments[i];
            const split = splitAtKeyword(c.t, c.kw);
            const group = new Group();
            const meshes = [];
            const add = (g, z, layer) => {
                const m = new Mesh(g, new MeshBasicMaterial({ transparent: true }));
                m.position.z = z;
                m.userData.layer = layer;
                group.add(m);
                meshes.push(m);
                return m;
            };
            const body = add(geo.body, 0, 'body');
            const ring = add(geo.ring, 0.003, 'ring');
            const label = add(geo.plane, 0.006, 'label');
            const sweep = split ? add(S.sign < 0 ? geo.sweepRtl : geo.sweepLtr, 0.009, 'mark') : null;
            const word = split ? add(geo.unit, 0.012, 'word') : null;
            body.userData.i = i;
            const slot = SLOTS[i];
            const b = {
                i, c, split, group, meshes, body, ring, label, sweep, word, slot,
                home: [0, 0, slot.z], shown: true, alpha: 1, hv: 0, hlW: 0,
                drift: {
                    ax: 0.09 + rnd() * 0.04, ay: 0.08 + rnd() * 0.04,
                    wx: 0.7 + rnd() * 0.6, wy: 0.7 + rnd() * 0.6, px: rnd() * 6.283, py: rnd() * 6.283,
                },
                labelTex: null, kwTex: null,
            };
            world.add(group);
            S.bubbles.push(b);
        }
    }

    /** Draw every bubble's label (and keyword) into canvases and hand them to the GPU. Colours and text are baked in. */
    function paintTextures() {
        const tk = S.tokens;
        const rtl = S.sign < 0;
        const k = Math.min(MAX_TEXTURE.width / NOM_W, S.dpr * 1.4);
        const W = Math.round(NOM_W * k), H = Math.round(NOM_H * k);
        if (W > MAX_TEXTURE.width || H > MAX_TEXTURE.height) throw new Error('label texture over budget');
        const PAD = 18, GLYPH = 20, GAP = 10, KPAD = 4;
        // A Canvas 2D surface that shapes text the way the page does: the browser's own shaper, in the page's direction,
        // anchored at the reading start, with no letter spacing (it would break Arabic joining).
        const surface = (width) => {
            const cv = document.createElement('canvas');
            cv.width = width; cv.height = H;
            const c = cv.getContext('2d');
            c.setTransform(k, 0, 0, k, 0, 0);
            Object.assign(c, { direction: rtl ? 'rtl' : 'ltr', textAlign: 'start', textBaseline: 'alphabetic', letterSpacing: '0px', fontKerning: 'normal', lang: S.lang });
            return c;
        };
        const texture = (c) => {
            const t = new CanvasTexture(c.canvas);
            t.colorSpace = SRGBColorSpace;
            return t;
        };
        for (const b of S.bubbles) {
            b.labelTex?.dispose();
            b.kwTex?.dispose();
            b.labelTex = b.kwTex = null;

            const ctx = surface(W);

            // The platform's mark first, at the reading start, then the words.
            const gx = rtl ? NOM_W - PAD - GLYPH : PAD;
            const g = glyphOf(b.c.p);
            if (g) {
                ctx.save();
                ctx.translate(gx, (NOM_H - GLYPH) / 2);
                ctx.scale(GLYPH / 24, GLYPH / 24);
                ctx.fillStyle = cssColor(tk.logo, 0.7);
                ctx.fill(g);
                ctx.restore();
            }
            const tx = rtl ? gx - GAP : gx + GLYPH + GAP;
            const avail = NOM_W - PAD * 2 - GLYPH - GAP;
            let fs = 22;
            ctx.font = `600 ${fs}px ${S.fontFamily}`;
            let m = ctx.measureText(b.c.t);
            if (m.width > avail) {
                fs = Math.max(13, Math.floor((fs * avail / m.width) * 10) / 10);
                ctx.font = `600 ${fs}px ${S.fontFamily}`;
                m = ctx.measureText(b.c.t);
            }
            // The line box is 1.75 of the size; its middle is the bubble's middle.
            const asc = m.fontBoundingBoxAscent ?? fs * 0.9;
            const desc = m.fontBoundingBoxDescent ?? fs * 0.3;
            const base = NOM_H / 2 + (asc - desc) / 2;
            ctx.fillStyle = cssColor(tk.text);
            ctx.fillText(b.c.t, tx, base);
            b.label.material.map = b.labelTex = texture(ctx);

            if (b.split) {
                const pre = ctx.measureText(b.split.before).width;
                const kw = ctx.measureText(b.split.word).width;
                const left = rtl ? tx - pre - kw : tx + pre;
                // The highlighter: .3em of padding each side and .1em over the line, grown from the reading start.
                const hl = { x: left - 0.3 * fs, w: kw + 0.6 * fs, h: asc + desc + 0.2 * fs };
                const pivot = rtl ? hl.x + hl.w : hl.x;
                b.sweep.position.x = (pivot - NOM_W / 2) * WPP;
                b.sweep.scale.y = hl.h * WPP;
                b.hlW = hl.w * WPP;
                // The keyword again, in the accent's text colour, on a canvas of its own as wide as the word.
                const kwW = kw + 2 * KPAD;
                const kx = surface(Math.ceil(kwW * k));
                kx.font = ctx.font;
                kx.fillStyle = cssColor(tk.markText);
                kx.fillText(b.split.word, rtl ? KPAD + kw : KPAD, base);
                b.word.material.map = b.kwTex = texture(kx);
                b.word.position.x = (left + kw / 2 - NOM_W / 2) * WPP;
                b.word.scale.set(kwW * WPP, NOM_H * WPP, 1);
            }
        }
        const count = S.bubbles.reduce((n, b) => n + 1 + (b.kwTex ? 1 : 0), 0);
        if (count > MAX_TEXTURES) throw new Error('texture budget');
        applyColours();
    }

    /** Fog and material colours from the tokens. Cheap: no canvas is touched. */
    function applyColours() {
        const tk = S.tokens;
        scene.fog.color.setRGB(tk.page.r, tk.page.g, tk.page.b, SRGBColorSpace);
        const set = (mesh, c) => {
            mesh.material.color.setRGB(c.r, c.g, c.b, SRGBColorSpace);
            mesh.userData.base = c.a;
        };
        const white = { r: 1, g: 1, b: 1, a: 1 };
        for (const b of S.bubbles) {
            set(b.body, tk.solid);
            set(b.ring, tk.ring);
            set(b.label, white);
            if (b.sweep) { set(b.sweep, tk.mark); set(b.word, white); }
            b.alpha = -1; // force the opacities to be written on the next update
        }
    }

    // ── Layout: the card's box in the canvas, as world coordinates on the card's plane ───────────────────────
    const hh = CAMERA.z * Math.tan(rad(CAMERA.fov / 2));
    function layout() {
        const cr = canvas.getBoundingClientRect();
        if (!cr.width || !cr.height) return false;
        const aspect = cr.width / cr.height;
        camera.aspect = aspect;
        camera.updateProjectionMatrix();
        const hw = hh * aspect;
        const X = (px) => ((px - cr.left) / cr.width * 2 - 1) * hw;
        const Y = (py) => (1 - (py - cr.top) / cr.height * 2) * hh;
        const sr = S.art.getBoundingClientRect();
        const br = S.dm.getBoundingClientRect();
        const card = { L: X(sr.left), R: X(sr.right), T: Y(sr.top), B: Y(sr.bottom) };
        S.card = card;
        S.target = [X((br.left + br.right) / 2), Y((br.top + br.bottom) / 2)];
        const bandTop = hh - card.T, bandBottom = card.B + hh;
        const bandL = card.L + hw, bandR = hw - card.R;
        const bandStart = S.sign > 0 ? bandL : bandR;
        const bandEnd = S.sign > 0 ? bandR : bandL;
        const ltr = S.sign > 0;
        // How much room the margins give. A phone's is 32 px (half a unit): there a bubble cannot also swell toward the
        // camera, drift far or sway with a pointer and still stay whole, so those shrink with the room (grow and sway
        // are 1 from a 48 px margin, and a bubble's size is fitted to what is left). Everywhere a bubble keeps a small gap
        // to the canvas edge, which is also the gap to whatever sits against it: the button above, on a phone.
        const band = Math.min(bandTop, bandBottom);
        S.grow = clamp01((band - 0.5) / 0.25);
        S.sway = 0.45 + 0.55 * S.grow;
        // The most a bubble is ever magnified, in flight: the lift (x1.12) and the flight (x1.15) together, and seen from
        // nearer the camera (it rises to z = 0.9 at full growth).
        const peak = (1 + 0.12 * S.grow) * (1 + 0.15 * S.grow) * CAMERA.z / (CAMERA.z - 0.9 * S.grow);
        const gap = 0.04 + 0.13 * S.sway + (fine ? 0.06 : 0) + 0.05;   // its own drift, the pointer's parallax, a little scroll
        const ink = 0.1;                                        // the bubble's text needs this much of it clear of the card
        // The pause control overhangs the card's corner at the reading end: nothing in the margin may pass under it.
        const tg = S.stage.querySelector('.stage-toggle')?.getBoundingClientRect();
        const toggle = tg && tg.width ? [X(tg.left), X(tg.right)] : null;
        const reach = (halfW) => {
            // Where the centre of a bubble of this half-width may be along the card, so it stays inside the canvas
            // (magnified: halfW * 1.45) and clear of the toggle.
            let lo = card.L + Math.max(0, halfW * 1.45 + 0.1 - bandL);
            let hi = card.R - Math.max(0, halfW * 1.45 + 0.1 - bandR);
            if (toggle) {
                if (ltr) hi = Math.min(hi, toggle[0] - halfW * 1.45 - 0.08);
                else lo = Math.max(lo, toggle[1] + halfW * 1.45 + 0.08);
            }
            return [lo, Math.max(lo, hi)];
        };
        S.dive = reach(BW / 2);
        for (const b of S.bubbles) {
            const { edge, along, z, s } = b.slot;
            const f = (CAMERA.z - z) / CAMERA.z;     // apparent position on the card's plane -> world position at depth z
            let x, y;
            b.shown = true;
            b.fit = 1;
            if (edge === 'top' || edge === 'bottom') {
                const above = edge === 'top';
                const room = (above ? bandTop : bandBottom) - gap - ink;
                const h0 = (BH * s) / 2;                       // half its height, in world units
                b.fit = clamp(room / (peak * h0), 0.55, 1);
                const halfW = (BW * s * b.fit) / 2;
                const [lo, hi] = reach(halfW);
                const x0 = ltr ? card.L : card.R;
                x = clamp(x0 + S.sign * along * (card.R - card.L), lo, hi);
                // Its far edge, magnified, stays `gap` inside the canvas; the rest of it is under the card.
                const up = (above ? bandTop : bandBottom) - gap - peak * h0 * b.fit;
                y = above ? card.T + Math.max(up, 0.04) : card.B - Math.max(up, 0.04);
            } else {
                const side = edge === 'start' ? bandStart : bandEnd;
                const visible = clamp(side * 0.8 - 0.13 * S.sway - (fine ? 0.1 : 0), 0, 1);
                b.shown = visible > 0.12;
                y = card.T + along * (card.B - card.T);
                // The side is the card's left or right edge: 'start' is the reading start, which flips with direction.
                const left = (edge === 'start') === ltr;
                const halfW = (BW * s) / 2;
                x = left ? card.L - visible + halfW : card.R + visible - halfW;
            }
            b.home = [x * f, y * f, z];
        }
        // The loop visits the bubbles that can be seen, in slot order.
        S.cycle = S.bubbles.filter((b) => b.shown);
        // Scroll progress: 0 at the top of the page, 1 once the hero has scrolled out.
        const top = sr.top + window.scrollY;
        S.heroEnd = Math.max(1, top + sr.height);
        return true;
    }

    function size() {
        const w = canvas.clientWidth, h = canvas.clientHeight;
        if (!w || !h) return false;
        renderer.setSize(w, h, false);
        return layout();
    }

    // ── One frame ────────────────────────────────────────────────────────────────────────────────────────────
    const tmp = [0, 0, 0];
    const driftAt = (b, T, out) => {
        const d = b.drift;
        out[0] = b.home[0] + S.sway * d.ax * Math.sin(d.wx * T + d.px);
        out[1] = b.home[1] + S.sway * d.ay * Math.sin(d.wy * T + d.py);
        out[2] = b.home[2];
        return out;
    };
    const p0 = [0, 0, 0], p1 = [0, 0, 0], p2 = [0, 0, 0], p3 = [0, 0, 0];

    function update(T, dt) {
        const { k, u } = loopAt(T);
        const focus = S.cycle.length ? S.cycle[k % S.cycle.length] : null;

        // Camera: a pointer moves it a little, damped, always looking at the card's plane, so the bubbles behind it
        // shift past the card and the card itself does not move. Scroll tilts it.
        const follow = 1 - Math.pow(1 - 0.08, dt * 60);
        const tx = fine ? clamp((S.px / innerWidth) * 2 - 1, -1, 1) * 0.35 : 0;
        const ty = fine ? -clamp((S.py / innerHeight) * 2 - 1, -1, 1) * 0.35 : 0;
        S.cam[0] += (tx - S.cam[0]) * follow;
        S.cam[1] += (ty - S.cam[1]) * follow;
        S.p = clamp(S.scrollY / S.heroEnd, 0, 1);
        // Scrolling tilts the scene, and a tilt moves the deep bubbles most. Past the first eighth of the hero they fade, gone
        // by 40 %, so none is ever seen cut off by the canvas's edge, and a hero that is leaving costs nothing to draw.
        const away = 1 - (S.p <= 0.12 ? 0 : S.p >= 0.4 ? 1 : ((t) => t * t * (3 - 2 * t))((S.p - 0.12) / 0.28));
        camera.position.set(S.cam[0], S.cam[1] + 0.8 * S.p, CAMERA.z);
        camera.lookAt(0, 0, 0);
        world.rotation.x = 0.12 * S.p;

        if (S.moved && fine) {
            S.moved = false;
            const cr = canvas.getBoundingClientRect();
            ndc.set(((S.px - cr.left) / cr.width) * 2 - 1, -(((S.py - cr.top) / cr.height) * 2 - 1));
            S.hover = -1;
            if (Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1) {
                camera.updateMatrixWorld();
                world.updateMatrixWorld(true);
                ray.setFromCamera(ndc, camera);
                const hit = ray.intersectObjects(S.bubbles.filter((b) => b.shown && b.split).map((b) => b.body), false)[0];
                if (hit) S.hover = hit.object.userData.i;
            }
        }

        let delivered = false;
        for (const b of S.bubbles) {
            if (!b.shown) { b.group.visible = false; continue; }
            driftAt(b, T, tmp);
            let [x, y, z] = tmp;
            const slot = b.slot;
            let ry = slot.ry * S.sign, rz = 0.03 * S.sign * (slot.ry < 0 ? -1 : 1);
            let sc = slot.s * b.fit, alpha = away, sweep = 0;
            if (b === focus) {
                const ph = phase(u, !!b.split);
                const grow = S.grow;
                ry *= 1 - ph.lift;
                rz *= 1 - ph.lift;
                z += 0.5 * ph.lift * grow;
                sc *= 1 + 0.12 * ph.lift * grow;
                sweep = ph.sweep;
                alpha = ph.alpha * away;
                if (b.split && u >= TIMES.fly[0] && u < TIMES.back[0]) {
                    // Fly, in two legs: from where it was when the flight began, along the margin to above the card's own
                    // message bubble, then down into it. Each leg is a cubic bezier, drawn in apparent coordinates (where
                    // the point lands on the card's plane) so rising toward the camera does not push it out of the canvas;
                    // the card hides the second leg.
                    driftAt(b, k * LOOP + TIMES.fly[0], p0);
                    p0[2] += 0.5 * grow;
                    const g0 = CAMERA.z / (CAMERA.z - p0[2]);
                    p0[0] *= g0; p0[1] *= g0;
                    // Down into the card where the margin is clear of the toggle; hidden from there to the bubble itself.
                    const tx = clamp(S.target[0], S.dive[0], S.dive[1]), ty = S.target[1];
                    const dx = tx - p0[0];
                    // A little toward the card (down from a margin above it, up from one below), away from the canvas's edge.
                    const inward = p0[1] > (S.card.T + S.card.B) / 2 ? -0.06 : 0.06;
                    if (ph.fly < FLY_SPLIT) {
                        const ly = p0[1] + inward;
                        p1[0] = p0[0] + dx * 0.35; p1[1] = ly; p1[2] = 0.9 * grow;
                        p2[0] = tx - dx * 0.3; p2[1] = ly; p2[2] = 0.9 * grow;
                        p3[0] = tx; p3[1] = ly; p3[2] = 0.8 * grow;
                        bezier3(p0, p1, p2, p3, easeFly(ph.fly / FLY_SPLIT), tmp);
                    } else {
                        p0[0] = tx; p0[1] += inward; p0[2] = 0.8 * grow;
                        p1[0] = tx; p1[1] = p0[1] + (ty - p0[1]) * 0.3; p1[2] = 0.6 * grow;
                        p2[0] = S.target[0]; p2[1] = ty - (ty - p0[1]) * 0.3; p2[2] = 0.4 * grow;
                        p3[0] = S.target[0]; p3[1] = ty; p3[2] = 0.25 * grow;
                        bezier3(p0, p1, p2, p3, easeDive((ph.fly - FLY_SPLIT) / (1 - FLY_SPLIT)), tmp);
                    }
                    const g = (CAMERA.z - tmp[2]) / CAMERA.z;
                    x = tmp[0] * g; y = tmp[1] * g; z = tmp[2];
                    sc *= 1 + 0.15 * Math.sin(Math.PI * ph.fly) * grow;
                }
                if (b.split && ph.delivered && S.lastDeliver !== k) {
                    delivered = true;
                    S.lastDeliver = k;
                }
            }
            // Hovering a keyword lights it too, the same way, without a flight.
            b.hv += ((S.hover === b.i ? 1 : 0) - b.hv) * (1 - Math.pow(1 - 0.18, dt * 60));
            const lit = Math.max(sweep, b.hv);
            const g = b.group;
            g.visible = alpha > 0.002;
            g.position.set(x, y, z);
            g.rotation.set(0, ry, rz);
            g.scale.setScalar(sc);
            if (b.sweep) {
                b.sweep.scale.x = Math.max(1e-4, b.hlW * lit);
                b.sweep.visible = b.word.visible = lit > 0.004;
            }
            if (alpha !== b.alpha || b.lit !== lit) {
                b.alpha = alpha;
                b.lit = lit;
                for (const m of b.meshes) {
                    m.material.opacity = (m.userData.base ?? 1) * alpha * (m.userData.layer === 'word' ? lit : 1);
                }
            }
        }
        if (delivered) S.stage.dispatchEvent(new CustomEvent('hero3d:deliver', { detail: { bubble: S.dm } }));
    }

    function sample(dt) {
        S.frames++;
        if (S.frames <= WARMUP) return;
        S.ms.push(dt * 1000);
        if (S.ms.length < WINDOW) return;
        S.median = median(S.ms);
        S.ms.length = 0;
        // The downgrade ladder: a median over 20 ms is under 50 fps. Cheaper pixels first, then fewer bubbles, then give up.
        if (S.median <= 20) return;
        if (S.level === 0 && S.dpr > 1) {
            S.level = 1;
            S.dpr = 1;
            renderer.setPixelRatio(1);
            size();
            rebuild(false);
        } else if (S.level < 2 && S.profile === 'full') {
            S.level = 2;
            S.profile = 'lite';
            rebuild(true);
        } else if (S.median > 24) {
            fallback('slow: median ' + S.median.toFixed(1) + ' ms');
        }
    }

    function rebuild(buildToo) {
        if (buildToo) buildBubbles();
        paintTextures();
        layout();
        S.cycle = S.bubbles.filter((b) => b.shown);
    }

    // ── The loop ─────────────────────────────────────────────────────────────────────────────────────────────
    const running = () => !S.paused && S.inView && !document.hidden && !S.asleep && !S.dead;

    function frame(now) {
        S.raf = 0;
        if (!running()) return;
        if (now - S.active > SLEEP_MS) { S.asleep = true; return; }
        const dt = Math.min((now - S.prev) / 1000, 0.1);
        S.prev = now;
        S.T += dt;
        update(S.T, dt);
        renderer.render(scene, camera);
        sample(dt);
        if (S.dead) return;
        S.raf = requestAnimationFrame(frame);
    }
    function start() {
        if (S.raf || !running()) return;
        S.prev = performance.now();
        S.raf = requestAnimationFrame(frame);
    }
    function poke() {
        S.active = performance.now();
        if (S.asleep) { S.asleep = false; start(); }
    }

    // ── Events ───────────────────────────────────────────────────────────────────────────────────────────────
    const on = [];
    const listen = (t, type, fn, opts) => { t.addEventListener(type, fn, opts); on.push(() => t.removeEventListener(type, fn, opts)); };
    listen(window, 'pointermove', (e) => { S.px = e.clientX; S.py = e.clientY; S.moved = true; poke(); }, { passive: true });
    listen(window, 'scroll', () => { S.scrollY = window.scrollY; poke(); }, { passive: true });
    listen(window, 'keydown', poke, { passive: true });
    listen(document, 'visibilitychange', () => { if (!document.hidden) start(); });
    // A page that is going away for good takes its context with it now, not at garbage collection; one that is only
    // being put in the back/forward cache (persisted) is left whole.
    listen(window, 'pagehide', (e) => { if (!e.persisted) dispose(); });
    listen(canvas, 'webglcontextlost', (e) => { e.preventDefault(); fallback('context lost'); });
    const deliver = () => {
        const el = S.dm;
        el.classList.remove('is-delivering');
        void el.offsetWidth;
        el.classList.add('is-delivering');
        setTimeout(() => el.classList.remove('is-delivering'), RECEIPT_MS);
    };
    for (const s of stages) listen(s, 'hero3d:deliver', deliver);

    const ro = new ResizeObserver(() => { if (!S.dead && size()) { if (!S.raf) renderer.render(scene, camera); } });
    const io = new IntersectionObserver((es) => {
        S.inView = es[es.length - 1].isIntersecting;
        if (S.inView) start();
    });
    const schemeMq = matchMedia('(prefers-color-scheme: light)');
    const motionMq = matchMedia('(prefers-reduced-motion: reduce)');
    const retheme = () => {
        if (S.dead) return;
        S.tokens = readTokens();
        paintTextures();
        if (!S.raf) renderer.render(scene, camera);
    };
    listen(schemeMq, 'change', () => requestAnimationFrame(retheme));
    listen(motionMq, 'change', () => { if (motionMq.matches) fallback('reduced motion'); });

    // The page's language or theme changed. Nothing is done before the scene is up (the mount reads both when it
    // paints), and a change that arrives while this runs is not lost: it runs again until the page and the scene agree.
    let busy = false, again = false;
    const mo = new MutationObserver(async () => {
        if (S.dead || !S.ready) return;
        if (busy) { again = true; return; }
        busy = true;
        try {
            do {
                again = false;
                if (langOf() !== S.lang) await switchLang();
                else retheme();
            } while (again && !S.dead);
        } catch (err) {
            fallback('switch failed: ' + (err && err.message));
        }
        busy = false;
    });
    mo.observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-lang'] });

    async function fontsFor() {
        await Promise.all(S.data.comments.map((c) => document.fonts.load(`600 22px ${S.fontFamily}`, c.t)));
    }

    function attach() {
        const poster = S.stage.querySelector('.stage-poster');
        S.stage.insertBefore(canvas, poster ? poster.nextSibling : S.stage.firstChild);
        ro.disconnect();
        io.disconnect();
        ro.observe(S.stage);
        io.observe(S.stage);
    }

    async function switchLang() {
        const old = S.stage;
        pickStage();
        buildBubbles();
        await fontsFor();
        if (S.dead) return;
        S.tokens = readTokens();
        old.classList.remove('is-3d');
        attach();
        paintTextures();
        if (size()) {
            S.cycle = S.bubbles.filter((b) => b.shown);
            update(S.T, 0.016);
            renderer.render(scene, camera);
            S.stage.classList.add('is-3d');
        }
        poke();
        start();
    }

    // ── The ways out ─────────────────────────────────────────────────────────────────────────────────────────
    function dispose() {
        if (S.dead) return;
        S.dead = true;
        S.ready = false;
        cancelAnimationFrame(S.raf);
        for (const off of on) off();
        ro.disconnect(); io.disconnect(); mo.disconnect();
        for (const b of S.bubbles) disposeBubble(b);
        for (const g of Object.values(geo)) g.dispose();
        renderer.dispose();
        renderer.forceContextLoss();
        canvas.remove();
        // A scene that is gone has nothing to pause: the poster stays, and so does no control for it.
        for (const s of stages) {
            s.classList.remove('is-3d');
            s.querySelector('.stage-toggle')?.remove();
        }
        S.dm?.classList.remove('is-delivering');
    }
    function fallback(why) {
        console.info('hero3d: poster, ' + why);
        if (why !== 'context lost' && why !== 'reduced motion') {
            try { sessionStorage.setItem('hero3d_off', '1'); } catch (e) { /* private mode */ }
        }
        dispose();
    }

    // ── Go ───────────────────────────────────────────────────────────────────────────────────────────────────
    // Whatever goes wrong from here (a font that will not load, a stage with no size, a shader that will not compile, the
    // page changing language or the visitor asking for less motion while this waits) disposes everything this call made,
    // the canvas, the listeners, the observers and the renderer's context, and rethrows: the loader keeps the poster.
    const alive = () => {
        if (S.dead) throw new Error('disposed while mounting');
    };
    try {
        pickStage();
        buildBubbles();
        await fontsFor();
        alive();
        // The page may have changed language while the fonts loaded: build for the one it is in now.
        while (langOf() !== S.lang) {
            pickStage();
            buildBubbles();
            await fontsFor();
            alive();
        }
        S.tokens = readTokens();
        attach();
        paintTextures();
        if (!size()) throw new Error('the stage has no size');
        S.cycle = S.bubbles.filter((b) => b.shown);
        update(0, 0.016);
        await renderer.compileAsync(scene, camera);
        alive();
        if (motionMq.matches) throw new Error('reduced motion');
        renderer.render(scene, camera);
        S.stage.classList.add('is-3d');
        S.ready = true;
        // ...or while the shaders compiled: switch now, the way a later change would.
        if (langOf() !== S.lang) await switchLang();
        alive();
        start();
    } catch (err) {
        dispose();
        throw err;
    }

    const api = {
        pause(p) {
            S.paused = !!p;
            if (!p) { poke(); start(); }
        },
        dispose,
        stats() {
            const i = renderer.info;
            return {
                profile: S.profile, dpr: S.dpr, lang: S.lang, bubbles: S.bubbles.filter((b) => b.shown).length,
                calls: i.render.calls, triangles: i.render.triangles, textures: i.memory.textures,
                geometries: i.memory.geometries, median: S.median, frames: S.frames, T: S.T,
                canvas: [canvas.width, canvas.height], running: !!S.raf, paused: S.paused, asleep: S.asleep, dead: S.dead,
            };
        },
    };
    if (debug) {
        window.__hero3d = {
            ...api,
            /** Render the scene at an absolute time, paused: for screenshots and the budget check. */
            seek(T) {
                S.paused = true;
                cancelAnimationFrame(S.raf);
                S.raf = 0;
                S.T = T;
                update(T, 0.016);
                renderer.render(scene, camera);
                return api.stats();
            },
            state: S,
            camera,
        };
    }
    return api;
}
