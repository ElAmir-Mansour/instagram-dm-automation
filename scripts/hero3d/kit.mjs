/**
 * The diagram scenes' toolbox (L11): what the Monteur, Studio and platform-map scenes share and the hero does not need.
 *
 * A diagram scene re-draws a diagram that is already on the page, in the box it already has. So the world here is measured in the
 * page's own pixels: the camera is placed so that one world unit is one CSS pixel on the host's plane (z = 0), and every tile is
 * put exactly where its HTML node is (`rel(el)`), whatever the layout: a row on a desktop, a column on a phone, mirrored in
 * Arabic. Depth (z) then only adds what the HTML cannot: things in front of and behind the plane, drifting, fanning, flying.
 *
 * Same rules as the hero: MeshBasicMaterial only, no lights, fog as the only depth cue; every colour a page token, read at run time
 * and re-read on a theme change; text drawn by the browser's own shaper (so Arabic joins and mirrors) and baked into textures that
 * are re-drawn, not re-made, when the theme or the pixel ratio changes. The scene's meshes are rebuilt whenever the host's size
 * changes (a different layout puts the tiles somewhere else), which is cheap: a handful of small textures.
 */
import { CanvasTexture, Fog, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, SRGBColorSpace, Scene } from 'three';
import { cssColor, roundedRectBody, roundedRectRing } from './core.mjs';
import { flat, glyphPath, loadFonts } from './engine.mjs';

const FOV = 28;
const HALF = Math.tan((FOV / 2) * (Math.PI / 180));
const MAX_TEX = 1024;

/** What a node of a flow diagram says, read from the page's own markup so the 3D can never say anything the HTML does not. */
export function readNode(li) {
    const icon = li.querySelector(':scope > .flow-ic');
    const text = li.querySelector(':scope > .flow-t')?.textContent.trim() ?? '';
    const fork = [...li.querySelectorAll(':scope > .flow-fork > li')].map((row) => ({
        chips: [...row.querySelectorAll('.flow-chip')].map((c) => ({
            name: c.textContent.trim(),
            glyph: /#plogo-([a-z]+)/.exec(c.querySelector('use')?.getAttribute('href') ?? '')?.[1] ?? null,
        })),
        note: row.querySelector(':scope > .flow-s')?.textContent.trim() ?? '',
    }));
    return { icon, text, fork: fork.length ? fork : null };
}

/** Draw a Lucide icon's SVG children (path, circle, rect, line, polyline, ellipse) into a 2D context, stroked, the way CSS does. */
export function drawIcon(ctx, svg, x, y, size, color) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = 2;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.strokeStyle = ctx.fillStyle = color;
    for (const el of svg.children) {
        const n = (a, d = 0) => parseFloat(el.getAttribute(a) ?? d);
        const solid = el.getAttribute('fill') === 'currentColor';
        ctx.beginPath();
        switch (el.tagName.toLowerCase()) {
            case 'path': { const p = new Path2D(el.getAttribute('d')); solid ? ctx.fill(p) : ctx.stroke(p); continue; }
            case 'circle': ctx.arc(n('cx'), n('cy'), n('r'), 0, Math.PI * 2); break;
            case 'ellipse': ctx.ellipse(n('cx'), n('cy'), n('rx'), n('ry'), 0, 0, Math.PI * 2); break;
            case 'rect': rrect(ctx, n('x'), n('y'), n('width'), n('height'), n('rx')); break;
            case 'line': ctx.moveTo(n('x1'), n('y1')); ctx.lineTo(n('x2'), n('y2')); break;
            case 'polyline': case 'polygon': {
                const pts = el.getAttribute('points').trim().split(/[\s,]+/).map(Number);
                for (let i = 0; i < pts.length; i += 2) (i ? ctx.lineTo : ctx.moveTo).call(ctx, pts[i], pts[i + 1]);
                if (el.tagName.toLowerCase() === 'polygon') ctx.closePath();
                break;
            }
            default: continue;
        }
        solid ? ctx.fill() : ctx.stroke();
    }
    ctx.restore();
}

/**
 * A rounded rectangle as a path. CanvasRenderingContext2D.roundRect is Safari 16: the build targets Safari 15, and the scenes
 * draw every card, chip and bar with this, so a browser without it does not lose its scene for one missing method.
 */
export function rrect(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
}

/** Break a text into lines no wider than `maxW`, at spaces (so each line is a run the shaper can join on its own). */
export function wrap(ctx, text, maxW) {
    const lines = [];
    let line = '';
    for (const word of text.split(/\s+/).filter(Boolean)) {
        const next = line ? line + ' ' + word : word;
        if (line && ctx.measureText(next).width > maxW) { lines.push(line); line = word; } else line = next;
    }
    if (line) lines.push(line);
    return lines;
}

const unit = new PlaneGeometry(1, 1);

export class Kit {
    constructor(ctx) {
        this.ctx = ctx;
        this.host = ctx.el;
        this.scene = new Scene();
        this.scene.fog = new Fog(0x000000, 1, 2);
        this.camera = new PerspectiveCamera(FOV, 1, 1, 10);
        this.root = new Group();
        this.scene.add(this.root);
        this.w = 0; this.h = 0; this.dist = 1; this.k = 1;
        this.mats = []; this.texs = []; this.geos = []; this.sign = 1; this.family = '';
        this.run = null;
        this.family = getComputedStyle(this.host).fontFamily;
        this.sign = getComputedStyle(this.host).direction === 'rtl' ? -1 : 1;
    }

    get tokens() { return this.ctx.tokens; }

    /** Where `el` is inside the host, in CSS pixels. */
    rel(el) {
        const h = this.host.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const l = r.left - h.left, t = r.top - h.top;
        return { l, t, w: r.width, h: r.height, r: l + r.width, b: t + r.height, cx: l + r.width / 2, cy: t + r.height / 2 };
    }
    /** The inline-start edge of a box: where text begins, and the reading starts, in this direction. */
    startOf(rect) { return this.sign > 0 ? rect.l : rect.r; }

    /**
     * Page pixels (x right, y down, origin the host's top-left) to world units (x right, y up, origin its centre), for a thing
     * `z` pixels in front of the host's plane: perspective pushes it away from the centre by dist / (dist - z), so it is
     * pulled in by the same factor and lands on the page pixel that was asked for (a ring over a chip, at any depth).
     */
    wx(px, z = 0) { return (px - this.w / 2) * ((this.dist - z) / this.dist); }
    wy(py, z = 0) { return (this.h / 2 - py) * ((this.dist - z) / this.dist); }

    // ── Materials and textures that follow the theme ─────────────────────────────────────────────────────────────
    /** A flat material painted from a token (`solid`, `ring`, `mark`…) or `white` for a texture that carries its own colours. */
    material(role, map = null) {
        const m = new MeshBasicMaterial({ transparent: true, map });
        m.userData = { role, base: 1, fade: 1 };
        this.mats.push(m);
        this.paintMaterial(m);
        return m;
    }
    paintMaterial(m) {
        const c = m.userData.role === 'white' ? { r: 1, g: 1, b: 1, a: 1 } : this.tokens[m.userData.role];
        m.color.setRGB(c.r, c.g, c.b, SRGBColorSpace);
        m.userData.base = c.a;
        m.opacity = c.a * m.userData.fade;
    }
    /** Set a mesh's visibility from a 0..1 amount: its material's opacity, and out of the draw list when it is nothing. */
    fade(mesh, a) {
        const m = mesh.material;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        if (m.userData.fade !== a) { m.userData.fade = a; m.opacity = m.userData.base * a; }
        mesh.visible = a > 0.003;
    }

    /** Draw something into a canvas of `w` x `h` CSS pixels and keep how, so the theme or the pixel ratio can draw it again. */
    paint(w, h, draw) {
        const handle = { w, h, draw, cv: document.createElement('canvas'), tex: null };
        this.render(handle);
        handle.tex = new CanvasTexture(handle.cv);
        handle.tex.colorSpace = SRGBColorSpace;
        this.texs.push(handle);
        return handle;
    }
    render(handle) {
        const k = Math.min(Math.max(this.ctx.dpr, 1) * 1.25, MAX_TEX / Math.max(handle.w, handle.h, 1));
        this.k = k;
        handle.cv.width = Math.max(1, Math.round(handle.w * k));
        handle.cv.height = Math.max(1, Math.round(handle.h * k));
        const c = handle.cv.getContext('2d');
        c.setTransform(k, 0, 0, k, 0, 0);
        Object.assign(c, { direction: this.sign < 0 ? 'rtl' : 'ltr', textAlign: 'start', textBaseline: 'alphabetic', letterSpacing: '0px', fontKerning: 'normal', lang: this.host.closest('[lang]')?.lang ?? '' });
        handle.draw(c, handle.w, handle.h, this);
        if (handle.tex) handle.tex.needsUpdate = true;
    }
    /** After the theme changed: the same drawings in the new colours, the same materials in the new tokens. */
    repaint() {
        for (const m of this.mats) this.paintMaterial(m);
        for (const t of this.texs) this.render(t);
    }

    // ── Meshes ───────────────────────────────────────────────────────────────────────────────────────────────────
    /** A textured rectangle centred at page pixel (cx, cy), `z` pixels in front of the host's plane. */
    sprite(handle, cx, cy, z = 0, w = handle.w, h = handle.h) {
        const mesh = new Mesh(unit, this.material('white', handle.tex));
        mesh.scale.set(w, h, 1);
        mesh.position.set(this.wx(cx, z), this.wy(cy, z), z);
        this.root.add(mesh);
        return mesh;
    }
    /** A flat rounded rectangle (`ring` = a hairline of the given thickness instead of a fill), centred at (cx, cy). */
    shape(role, w, h, r, cx, cy, z = 0, ring = 0) {
        const geo = flat(ring ? roundedRectRing(w, h, r, ring) : roundedRectBody(w, h, r));
        this.geos.push(geo);
        const mesh = new Mesh(geo, this.material(role));
        mesh.position.set(this.wx(cx, z), this.wy(cy, z), z);
        this.root.add(mesh);
        return mesh;
    }
    /** A flat rectangle with no rounding, drawn as a plane, for bars and highlighters (`origin` is the edge it grows from). */
    bar(role, w, h, cx, cy, z = 0) {
        const mesh = new Mesh(unit, this.material(role));
        mesh.scale.set(w, h, 1);
        mesh.position.set(this.wx(cx, z), this.wy(cy, z), z);
        this.root.add(mesh);
        return mesh;
    }

    // ── Tiles: a node of the diagram, drawn where it is ─────────────────────────────────────────────────────────
    /**
     * @param {object} rect the node's box (kit.rel)
     * @param {{icon, text, fork}} node read by readNode
     * @param {boolean} tall a node taller than wide (a row of them) gets its words at the foot and leaves its middle free
     * @returns the group of its meshes, and where its chips are (page pixels), for things to be delivered to
     */
    tile(rect, node, tall) {
        const { w, h } = rect;
        const group = new Group();
        const body = this.shape('solid', w, h, 12, rect.cx, rect.cy, 0);
        const ring = this.shape('subtle', w, h, 12, rect.cx, rect.cy, 0.5, 1);
        const chips = [];
        const handle = this.paint(w, h, (c, W, H, kit) => {
            const tk = kit.tokens;
            const pad = 14, ic = 20;
            const start = kit.sign > 0 ? pad : W - pad;                  // where this direction's reading starts
            const ix = kit.sign > 0 ? pad : W - pad - ic;
            if (node.icon) drawIcon(c, node.icon, ix, tall ? pad : pad + 1, ic, cssColor(tk.muted));
            let size = 15;
            const place = (fs) => {
                c.font = `600 ${fs}px ${kit.family}`;
                const tx = tall ? start : kit.sign > 0 ? pad + ic + 12 : W - pad - ic - 12;
                const maxW = tall ? W - 2 * pad : W - 2 * pad - ic - 12 - (node.fork ? 0 : 56);
                return { lines: node.text ? wrap(c, node.text, maxW) : [], tx, lh: Math.round(fs * 1.35) };
            };
            let t = place(size);
            while (t.lines.length * t.lh > (tall ? H * 0.42 : H - 2 * pad) && size > 11) t = place(--size);
            c.fillStyle = cssColor(tk.strong);
            const textTop = tall ? (node.fork ? pad + ic + 10 : H - pad - t.lines.length * t.lh) : pad;
            t.lines.forEach((ln, i) => c.fillText(ln, t.tx, textTop + (i + 1) * t.lh - 4));
            if (!node.fork) return;
            // The branch: chips in rows (a row wraps), each row's note under it, a hairline between rows.
            const fs = 13;
            const ch = 24, gap = 6;
            let y = textTop + t.lines.length * t.lh + 8;
            const left = pad, right = W - pad;
            node.fork.forEach((row, ri) => {
                if (ri) { c.strokeStyle = cssColor(tk.subtle); c.lineWidth = 1; c.beginPath(); c.moveTo(left, y - 3.5); c.lineTo(right, y - 3.5); c.stroke(); y += 5; }
                let x = kit.sign > 0 ? left : right;
                for (const chip of row.chips) {
                    c.font = `500 ${fs}px ${kit.family}`;
                    const tw = c.measureText(chip.name).width;
                    const cw = 10 + 14 + 6 + tw + 10;
                    if ((kit.sign > 0 ? x + cw > right : x - cw < left) && x !== (kit.sign > 0 ? left : right)) { x = kit.sign > 0 ? left : right; y += ch + gap; }
                    const cl = kit.sign > 0 ? x : x - cw;
                    c.fillStyle = cssColor(tk.glass);
                    c.beginPath(); rrect(c, cl, y, cw, ch, ch / 2); c.fill();
                    c.strokeStyle = cssColor(tk.subtle); c.lineWidth = 1;
                    c.beginPath(); rrect(c, cl + 0.5, y + 0.5, cw - 1, ch - 1, ch / 2); c.stroke();
                    const g = chip.glyph && glyphPath(chip.glyph);
                    const gx = kit.sign > 0 ? cl + 10 : cl + cw - 10 - 14;
                    if (g) { c.save(); c.translate(gx, y + (ch - 14) / 2); c.scale(14 / 24, 14 / 24); c.fillStyle = cssColor(tk.logo, 0.9); c.fill(g); c.restore(); }
                    c.fillStyle = cssColor(tk.strong);
                    c.fillText(chip.name, kit.sign > 0 ? cl + 10 + 14 + 6 : cl + cw - 10 - 14 - 6, y + ch / 2 + fs * 0.35);
                    chips.push({ name: chip.name, glyph: chip.glyph, cx: rect.l + cl + cw / 2, cy: rect.t + y + ch / 2, w: cw, h: ch, row: ri });
                    x += kit.sign > 0 ? cw + gap : -(cw + gap);
                }
                y += ch + 4;
                if (row.note) {
                    c.font = `400 12px ${kit.family}`;
                    c.fillStyle = cssColor(tk.muted);
                    for (const ln of wrap(c, row.note, W - 2 * pad)) { c.fillText(ln, start, y + 12); y += 16; }
                }
                y += 6;
            });
        });
        const content = this.sprite(handle, rect.cx, rect.cy, 1);
        group.add(body, ring, content);
        this.root.add(group);
        return { group, body, ring, content, chips, rect };
    }

    // ── The camera, and the instance the engine drives ───────────────────────────────────────────────────────────
    frame(w, h) {
        this.w = w; this.h = h;
        this.dist = h / (2 * HALF);
        this.camera.aspect = w / h;
        this.camera.near = this.dist * 0.1;
        this.camera.far = this.dist * 4;
        this.camera.position.set(0, 0, this.dist);
        this.camera.updateProjectionMatrix();
        // Fog is the only depth cue: nothing on the host's plane or in front of it is touched, what is behind it fades.
        this.scene.fog.near = this.dist;
        this.scene.fog.far = this.dist * 1.9;
        const p = this.tokens.page;
        this.scene.fog.color.setRGB(p.r, p.g, p.b, SRGBColorSpace);
    }
    /** Throw away everything the last build made. */
    clear() {
        for (const m of this.mats) m.dispose();
        for (const t of this.texs) t.tex.dispose();
        for (const g of this.geos) g.dispose();
        this.mats = []; this.texs = []; this.geos = [];
        this.root.clear();
    }
}

/**
 * Define a diagram scene: `texts(host)` lists the strings it will draw (so their fonts are loaded first), `build(kit)` makes the
 * meshes for the host's current size and returns `{ update(T, dt, input) }`.
 */
export function defineScene({ texts, build }) {
    return async function create(ctx) {
        const kit = new Kit(ctx);
        await loadFonts(kit.family, texts(ctx.el));
        let lastW = 0, lastH = 0;
        const rebuild = () => {
            kit.clear();
            kit.frame(lastW, lastH);
            kit.run = build(kit);
        };
        return {
            scene: kit.scene, camera: kit.camera, debug: kit,
            resize(w, h) { lastW = w; lastH = h; rebuild(); },
            update(T, dt, input) { kit.run?.update(T, dt, input); },
            retheme() { kit.frame(lastW, lastH); kit.repaint(); },
            repaint() { kit.repaint(); },
            setProfile() { rebuild(); },
            dispose() { kit.clear(); },
        };
    };
}
