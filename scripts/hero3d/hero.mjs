/**
 * The landing hero's 3D scene (L10): flat comment bubbles drifting in depth behind the hero card, one keyword
 * lit by the cardamom highlighter, and that bubble flying into the card's own message bubble.
 *
 * One instance of the engine (engine.mjs): this file is only what the hero draws. The engine brings the renderer, the loop
 * and everything about when to stop it; the hero is built once per language, because each language's article has its own
 * stage. The card stays the content and the LCP element; this is an addition behind it, and any failure leaves the poster.
 *
 * Look: unlit and flat. MeshBasicMaterial only, no lights, fog as the only depth cue, no bloom, no particles,
 * no glow. The mark never appears in the scene, cardamom is the keyword's highlighter and nothing else
 * (IDENTITY.md sections 5 and 6). Everything coloured comes from the page's own tokens, read at run time.
 */
import {
    CanvasTexture, Fog, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Raycaster, SRGBColorSpace,
    Scene, Vector2,
} from 'three';
import {
    CAMERA, FLY_SPLIT, FOG, LOOP, MAX_TEXTURE, MAX_TEXTURES, RECEIPT_MS, SLOTS, TIMES, bezier3, bubbleCount,
    clamp01, cssColor, easeDive, easeFly, loopAt, mulberry32, phase, roundedRectBody, roundedRectRing,
    splitAtKeyword,
} from './core.mjs';
import { flat, glyphPath, loadFonts } from './engine.mjs';

// World units. A bubble is 2.5 wide and 0.7 tall; its label is drawn on a 250 x 70 canvas, 100 px to the unit.
const BW = 2.5, BH = 0.62, BR = 0.24, RING = 0.028;
const NOM_W = 250, NOM_H = 62, WPP = BW / NOM_W;

const rad = (deg) => (deg * Math.PI) / 180;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);


/**
 * Build the hero for one stage.
 * @param {object} ctx the engine's context: { el (the .hero-stage), canvas, fine, tokens, dpr, profile }
 */
export async function createHero(ctx) {
    const stage = ctx.el;
    const canvas = ctx.canvas;
    const fine = ctx.fine;
    const S = {
        lang: stage.id.endsWith('-en') ? 'en' : 'ar', stage, art: stage.querySelector('.artifact'),
        dm: stage.querySelector('.artifact .bubble'), data: null, sign: getComputedStyle(stage).direction === 'rtl' ? -1 : 1,
        profile: ctx.profile, dpr: ctx.dpr, tokens: ctx.tokens, bubbles: [], cycle: [],
        p: 0, heroEnd: 1, cam: [0, 0], hover: -1, card: null, target: [0, 0], dive: [0, 0], grow: 1, sway: 1,
        lastDeliver: -1, fontFamily: '',
    };
    S.data = JSON.parse(stage.getAttribute('data-hero3d'));
    S.fontFamily = getComputedStyle(stage.querySelector('.said') || stage).fontFamily;
    if (!S.art || !S.dm || !Array.isArray(S.data.comments) || !S.data.comments.length) throw new Error('hero stage is incomplete');

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
            const g = glyphPath(b.c.p);
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
        const reach = (halfW) => {
            // Where the centre of a bubble of this half-width may be along the card, so it stays inside the canvas
            // (magnified: halfW * 1.45).
            const lo = card.L + Math.max(0, halfW * 1.45 + 0.1 - bandL);
            const hi = card.R - Math.max(0, halfW * 1.45 + 0.1 - bandR);
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

    function update(T, dt, input) {
        const { k, u } = loopAt(T);
        const focus = S.cycle.length ? S.cycle[k % S.cycle.length] : null;

        // Camera: a pointer moves it a little, damped, always looking at the card's plane, so the bubbles behind it
        // shift past the card and the card itself does not move. Scroll tilts it.
        const follow = 1 - Math.pow(1 - 0.08, dt * 60);
        const tx = fine ? clamp((input.px / innerWidth) * 2 - 1, -1, 1) * 0.35 : 0;
        const ty = fine ? -clamp((input.py / innerHeight) * 2 - 1, -1, 1) * 0.35 : 0;
        S.cam[0] += (tx - S.cam[0]) * follow;
        S.cam[1] += (ty - S.cam[1]) * follow;
        S.p = clamp(input.scrollY / S.heroEnd, 0, 1);
        // Scrolling tilts the scene, and a tilt moves the deep bubbles most. Past the first eighth of the hero they fade, gone
        // by 40 %, so none is ever seen cut off by the canvas's edge, and a hero that is leaving costs nothing to draw.
        const away = 1 - (S.p <= 0.12 ? 0 : S.p >= 0.4 ? 1 : ((t) => t * t * (3 - 2 * t))((S.p - 0.12) / 0.28));
        camera.position.set(S.cam[0], S.cam[1] + 0.8 * S.p, CAMERA.z);
        camera.lookAt(0, 0, 0);
        world.rotation.x = 0.12 * S.p;

        if (input.moved && fine) {
            input.moved = false;
            const cr = canvas.getBoundingClientRect();
            ndc.set(((input.px - cr.left) / cr.width) * 2 - 1, -(((input.py - cr.top) / cr.height) * 2 - 1));
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
                    // Down into the card inside the canvas; hidden from there to the bubble itself.
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


    // ── The card's receipt: the flying bubble arrived, so the card's own message bubble rings once ──────────────
    const deliver = () => {
        const el = S.dm;
        el.classList.remove('is-delivering');
        void el.offsetWidth;
        el.classList.add('is-delivering');
        setTimeout(() => el.classList.remove('is-delivering'), RECEIPT_MS);
    };
    stage.addEventListener('hero3d:deliver', deliver);

    await loadFonts(S.fontFamily, S.data.comments.map((c) => c.t));
    buildBubbles();
    paintTextures();

    return {
        scene, camera, debug: S,
        resize() { layout(); },
        update,
        retheme() { S.tokens = ctx.tokens; paintTextures(); },
        repaint() { S.dpr = ctx.dpr; S.tokens = ctx.tokens; paintTextures(); layout(); },
        setProfile(profile) {
            S.profile = profile;
            S.dpr = ctx.dpr;
            S.tokens = ctx.tokens;
            buildBubbles();
            paintTextures();
            layout();
        },
        dispose() {
            stage.removeEventListener('hero3d:deliver', deliver);
            stage.classList.remove('is-3d');
            S.dm?.classList.remove('is-delivering');
            for (const b of S.bubbles) disposeBubble(b);
            for (const g of Object.values(geo)) g.dispose();
        },
    };
}
