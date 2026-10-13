/**
 * The Studio diagram as a 3D scene (L11): the figure #flow-studio-*, re-drawn in its own box.
 *
 * The figure's five nodes are drawn where they are. On top of them a lesson turns into a stack of carousel slides that riffle
 * off it and fan in depth; the last slide turns over and its keyword is lit by the cardamom highlighter; the slides pass your
 * review and three leave: one for Instagram and one for Facebook (each rings when it is received) and the 9:16 version for
 * TikTok, which is held (the figure says: "Scheduled, or held in a queue until TikTok approves the app"). Plan: studio.plan.mjs.
 *
 * The slides are drawn as slides, not as the course's: bars and blocks, no words, no people and no picture. The keyword is a pill
 * with a highlighter over it: the Studio writes the carousel's keyword, which word it is is the visitor's business.
 */
import { Group } from 'three';
import { bezier3, cssColor } from '../core.mjs';
import { defineScene, readNode, rrect } from '../kit.mjs';
import { FAN, KEYWORD_SLIDE, LOOP, SENT, dealtOut, fanned, flipped, fly, lesson, reviewed, ring, sentAlpha, stackAlpha, sweep, tall } from './studio.plan.mjs';

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export default defineScene({
    texts: (host) => [...host.querySelectorAll('.flow-t, .flow-chip, .flow-s')].map((n) => n.textContent.trim()).filter(Boolean),

    build(kit) {
        const lis = [...kit.host.querySelectorAll(':scope > .flow-steps > .flow-node')];
        if (lis.length < 5) throw new Error('the Studio figure has ' + lis.length + ' nodes, the scene needs 5');
        const rects = lis.map((li) => kit.rel(li));
        const tallNodes = Math.abs(rects[1].t - rects[0].t) < rects[0].h / 2;     // a row of tall nodes, or a column of wide ones
        const tiles = lis.map((li, i) => kit.tile(rects[i], readNode(li), tallNodes));
        // Where each node leaves its middle free: a row keeps it a little above the tiles' middle, a column at the end side.
        const lane = rects.map((r) => (tallNodes ? { x: r.cx, y: r.t + r.h * 0.42 } : { x: kit.sign > 0 ? r.r - 34 : r.l + 34, y: r.cy }));
        const dx = lane[2].x - lane[0].x, dy = lane[2].y - lane[0].y;
        const len = Math.hypot(dx, dy);
        const dir = { x: dx / len, y: dy / len };
        const perp = { x: -dir.y, y: dir.x };
        const lean0 = kit.sign > 0 ? -1 : 1;                                      // a fan leans towards the reading end

        // ── The slides: 4:5, bars and blocks ─────────────────────────────────────────────────────────────────────
        const sw = tallNodes ? 46 : 30, sh = Math.round(sw * 1.25);
        const spacing = tallNodes ? 21 : 12;
        const pill = { x: sw * 0.2, w: sw * 0.6, y: sh * 0.56, h: Math.max(9, Math.round(sw * 0.3)) };
        const art = (kind) => kit.paint(sw, sh, (c, W, H, k) => {
            const tk = k.tokens;
            const bar = (x, y, w, h, a = 0.8) => { c.fillStyle = cssColor(tk.muted, a); c.beginPath(); rrect(c, x, y, w, h, h / 2); c.fill(); };
            c.fillStyle = cssColor(tk.solid); c.beginPath(); rrect(c, 0, 0, W, H, 4); c.fill();
            c.strokeStyle = cssColor(tk.ring); c.lineWidth = 1; c.beginPath(); rrect(c, 0.5, 0.5, W - 1, H - 1, 3.5); c.stroke();
            if (kind === 'cover') {
                bar(4, 5, W * 0.7, 4, 0.95); bar(4, 12, W * 0.46, 3, 0.7);
                c.fillStyle = cssColor(tk.glass, 3); c.beginPath(); rrect(c, 4, H * 0.42, W - 8, H * 0.46, 3); c.fill();
            } else if (kind === 'back') {
                bar(4, 5, W * 0.62, 3.5, 0.95); bar(4, 11, W * 0.8, 2.5, 0.6); bar(4, 16, W * 0.5, 2.5, 0.6);
                c.strokeStyle = cssColor(tk.markRing); c.lineWidth = 1;
                c.beginPath(); rrect(c, pill.x + 0.5, pill.y + 0.5, pill.w - 1, pill.h - 1, pill.h / 2); c.stroke();
                bar(pill.x + pill.w * 0.2, pill.y + pill.h / 2 - 1.25, pill.w * 0.6, 2.5, 0.8);
            } else {
                bar(4, 5, W * 0.56, 3.5, 0.95); bar(4, 11, W - 8, 2.5, 0.6); bar(4, 16, W * 0.7, 2.5, 0.6);
                c.fillStyle = cssColor(tk.glass, 3); c.beginPath(); rrect(c, 4, H * 0.52, W - 8, H * 0.36, 3); c.fill();
            }
        });
        const arts = [art('cover'), art('body'), art('body'), art('body'), art('body')];
        const back = art('back');
        const lw = tallNodes ? 44 : 34, lh = tallNodes ? 30 : 24;
        const lessonArt = kit.paint(lw, lh, (c, W, H, k) => {
            const tk = k.tokens;
            c.fillStyle = cssColor(tk.solid); c.beginPath(); rrect(c, 0, 0, W, H, 4); c.fill();
            c.strokeStyle = cssColor(tk.ring); c.lineWidth = 1; c.beginPath(); rrect(c, 0.5, 0.5, W - 1, H - 1, 3.5); c.stroke();
            c.fillStyle = cssColor(tk.muted, 0.95); c.beginPath(); rrect(c, 5, 5, W * 0.5, 3.5, 1.7); c.fill();
            c.fillStyle = cssColor(tk.muted, 0.6);
            for (let i = 0; i < 3; i++) { c.beginPath(); rrect(c, 5, 12 + i * 5, W - 10 - i * 7, 2.5, 1.2); c.fill(); }
        });
        const lessonMesh = kit.sprite(lessonArt, lane[0].x, lane[0].y, 8);

        // The stack: one group per slide, so a slide can turn over as one thing. The keyword slide has a back, with the highlighter on it.
        const stackPos = (s) => ({ x: lane[2].x + dir.x * (s - 2) * spacing, y: lane[2].y + dir.y * (s - 2) * spacing });
        const stackZ = (s) => 8 + FAN.rise * s * 1.2;
        const slides = arts.map((a, s) => {
            const group = new Group();
            const front = kit.sprite(a, 0, 0, 0);
            front.position.set(0, 0, 0);
            group.add(front);
            const slide = { s, group, front, back: null, mark: null };
            if (s === KEYWORD_SLIDE) {
                const bk = kit.sprite(back, 0, 0, 0);
                bk.position.set(0, 0, 0);
                bk.rotation.y = Math.PI;
                group.add(bk);
                // The highlighter is the back's child, so it turns over with it; its unit square is the slide, it grows from the reading start.
                const m = kit.bar('mark', 1, 1, 0, 0, 0);
                m.renderOrder = 2;
                bk.add(m);
                slide.back = bk;
                slide.mark = m;
            }
            kit.root.add(group);
            return slide;
        });

        // ── The slides that are sent: to Instagram and Facebook (a ring when received), to TikTok in 9:16 (held) ────
        const tw = Math.round(24 * (tallNodes ? 1.3 : 1)), th = Math.round(tw * 16 / 9);
        const tt = kit.paint(tw, th, (c, W, H, k) => {
            const tk = k.tokens;
            c.fillStyle = cssColor(tk.solid); c.beginPath(); rrect(c, 0, 0, W, H, 4); c.fill();
            c.strokeStyle = cssColor(tk.ring); c.lineWidth = 1; c.beginPath(); rrect(c, 0.5, 0.5, W - 1, H - 1, 3.5); c.stroke();
            c.fillStyle = cssColor(tk.muted, 0.9); c.beginPath(); rrect(c, 3, 4, W * 0.6, 2.5, 1.2); c.fill();
            c.fillStyle = cssColor(tk.glass, 3); c.beginPath(); rrect(c, 3, 9, W - 6, H * 0.5, 2); c.fill();
            c.fillStyle = cssColor(tk.muted, 0.7); c.beginPath(); rrect(c, 3, H - 8, W * 0.7, 2, 1); c.fill();
        });
        const stampArt = kit.paint(12, 12, (c, W, H, k) => {
            c.fillStyle = cssColor(k.tokens.accent); c.beginPath(); c.arc(6, 6, 6, 0, Math.PI * 2); c.fill();
            c.strokeStyle = cssColor(k.tokens.onAccent); c.lineWidth = 1.6; c.lineCap = c.lineJoin = 'round';
            c.beginPath(); c.moveTo(3.2, 6.2); c.lineTo(5.2, 8); c.lineTo(8.8, 4.2); c.stroke();
        });
        const chips = tiles[4].chips;
        const sent = SENT.map((o, j) => {
            const chip = chips.find((c) => c.glyph === o.to) ?? chips[Math.min(j, chips.length - 1)];
            const from = stackPos(o.slide);
            const off = (j - 1) * (tallNodes ? 26 : 9);
            const mid = { x: lane[3].x + perp.x * off, y: lane[3].y + perp.y * off };
            const path = [
                [from.x, from.y, stackZ(o.slide)],
                [lerp(from.x, mid.x, 0.7), lerp(from.y, mid.y, 0.7), 34 + j * 8],
                [mid.x, mid.y, 40 + j * 8],
                [chip.cx, chip.cy, 18],
            ];
            const nine = o.to === 'tiktok';
            const sprite = kit.sprite(arts[o.slide], from.x, from.y, 10);                // the 4:5 slide
            const sprite9 = nine ? kit.sprite(tt, from.x, from.y, 10) : null;           // which becomes the 9:16 one, for TikTok
            const stamp = kit.sprite(stampArt, 0, 0, 12);
            const ringMesh = o.ring ? kit.shape('markRing', chip.w + 8, chip.h + 8, (chip.h + 8) / 2, chip.cx, chip.cy, 20, 2) : null;
            if (ringMesh) ringMesh.visible = false;
            return { o, j, chip, path, sprite, sprite9, stamp, ringMesh };
        });
        const cur = [0, 0, 0];

        return {
            update(T) {
                const u = T % LOOP;
                // the lesson, and the slides that come off it
                kit.fade(lessonMesh, lesson(u) * (1 - smooth(Math.min(1, Math.max(0, (u - 2.0) / 0.8)))));
                const fan = fanned(u);
                for (const { s, group, front, back: bk, mark } of slides) {
                    const d = dealtOut(s, u);
                    const to = stackPos(s);
                    const x = lerp(lane[0].x, lerp(lane[2].x, to.x, fan), d);
                    const y = lerp(lane[0].y, lerp(lane[2].y, to.y, fan), d);
                    const z = lerp(8, stackZ(s), fan);
                    group.position.set(kit.wx(x, z), kit.wy(y, z), z);
                    group.rotation.z = (s - 2) * FAN.turn * fan * lean0;
                    const a = stackAlpha(s, u);
                    const isKw = s === KEYWORD_SLIDE;
                    const flip = isKw ? flipped(u) : 0;
                    group.rotation.y = Math.PI * flip;
                    // the one that turns over comes towards the viewer a little, to be read
                    group.scale.setScalar(isKw ? 1 + 0.4 * Math.sin(Math.PI * flip) + 0.6 * smooth(flip) : 1);
                    kit.fade(front, a);
                    if (bk) kit.fade(bk, a);
                    if (mark) {
                        const grow = sweep(u);
                        kit.fade(mark, flip > 0.9 && grow > 0.001 ? a : 0);
                        const pw = pill.w / sw, ph = (pill.h - 2) / sh;
                        const edge = (kit.sign > 0 ? pill.x : sw - pill.x) / sw;
                        mark.scale.set(pw * grow, ph, 1);
                        mark.position.set(edge + kit.sign * pw * grow / 2 - 0.5, 0.5 - (pill.y + pill.h / 2) / sh, 0.6);
                    }
                }
                // the slides on their way
                for (const r of sent) {
                    const t = fly(r.j, u);
                    const a = sentAlpha(r.j, u);
                    bezier3(r.path[0], r.path[1], r.path[2], r.path[3], t, cur);
                    const k916 = tall(r.j, u);
                    const zoom = lerp(1, 1.4, Math.sin(Math.PI * t)) * lerp(1, 0.6, smooth(Math.max(0, (t - 0.7) / 0.3)));
                    const lean = (1 - t) * (r.o.slide - 2) * FAN.turn * lean0;
                    const w = lerp(sw, tw, k916) * zoom, h = lerp(sh, th, k916) * zoom;
                    for (const m of [r.sprite, r.sprite9]) {
                        if (!m) continue;
                        m.position.set(kit.wx(cur[0], cur[2]), kit.wy(cur[1], cur[2]), cur[2]);
                        m.scale.set(w, h, 1);
                        m.rotation.z = lean;
                    }
                    kit.fade(r.sprite, a * (1 - k916));
                    if (r.sprite9) kit.fade(r.sprite9, a * k916);
                    r.stamp.position.set(r.sprite.position.x + w * 0.42, r.sprite.position.y + h * 0.4, r.sprite.position.z + 2);
                    kit.fade(r.stamp, reviewed(r.j, u) * a);
                    if (r.ringMesh) kit.fade(r.ringMesh, ring(r.j, u));
                }
            },
        };
    },
});
