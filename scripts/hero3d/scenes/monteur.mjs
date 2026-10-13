/**
 * The Monteur diagram as a 3D scene (L11): the figure #flow-monteur-*, re-drawn in its own box.
 *
 * The figure's six nodes are drawn where they are (a row on a desktop, a column on a phone). On top of them, a strip of the long
 * video comes out of the folder, the Mac listens to it, the cardamom highlighter sweeps four hooks on it, each hook is cut out as
 * a 9:16 reel, the reels pass your approval, and one lands on each platform: three slots that ring when they are received, and a
 * TikTok draft that only sits in the drafts (the figure says: "Draft / Only me"). Plan and timeline: monteur.plan.mjs.
 *
 * Founder-only (L4): the figure's caption says so and stays on the page as text under the scene; nothing here claims more.
 */
import { bezier3, cssColor } from '../core.mjs';
import { defineScene, readNode, rrect } from '../kit.mjs';
import { CELLS, HOOKS, LOOP, TARGETS, approved, becomes, cellIn, fly, listening, lit, litAlpha, reelAlpha, ring } from './monteur.plan.mjs';

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

export default defineScene({
    texts: (host) => [...host.querySelectorAll('.flow-t, .flow-chip, .flow-s')].map((n) => n.textContent.trim()).filter(Boolean),

    build(kit) {
        const lis = [...kit.host.querySelectorAll(':scope > .flow-steps > .flow-node')];
        if (lis.length < 6) throw new Error('the Monteur figure has ' + lis.length + ' nodes, the scene needs 6');
        const rects = lis.map((li) => kit.rel(li));
        const tall = Math.abs(rects[1].t - rects[0].t) < rects[0].h / 2;     // a row of tall nodes, or a column of wide ones
        const lite = kit.ctx.profile === 'lite';
        const tiles = lis.map((li, i) => kit.tile(rects[i], readNode(li), tall));

        // The lane: where each node leaves its middle free. A row keeps it a little above the tiles' middle; a column keeps it
        // at the end side, where the words do not reach.
        const lane = rects.map((r) => (tall ? { x: r.cx, y: r.t + r.h * 0.42 } : { x: kit.sign > 0 ? r.r - 34 : r.l + 34, y: r.cy }));
        const dx = lane[3].x - lane[0].x, dy = lane[3].y - lane[0].y;
        const len = Math.hypot(dx, dy);
        const dir = { x: dx / len, y: dy / len };
        const perp = { x: -dir.y, y: dir.x };
        const along = Math.abs(dir.x) > Math.abs(dir.y) ? 'x' : 'y';
        const th = tall ? 26 : 18;
        const pitch = len / CELLS;
        const cellLen = pitch * 0.82;
        const at = (s, off = 0) => ({ x: lane[0].x + dir.x * len * s + perp.x * off, y: lane[0].y + dir.y * len * s + perp.y * off });
        const box = (l, t) => (along === 'x' ? [l, t] : [t, l]);

        // ── The strip: the long video, a frame at a time ─────────────────────────────────────────────────────────
        const cells = [];
        const n = lite ? CELLS - 2 : CELLS;
        for (let i = 0; i < CELLS; i++) {
            const p = at((i + 0.5) / CELLS);
            const [w, h] = box(cellLen, th);
            const m = kit.bar('ring', w, h, p.x, p.y, 4);
            m.userData.i = i;
            if (lite && i >= n) m.visible = false;
            cells.push({ mesh: m, p });
        }
        // The highlighter on each hook: it grows from the reading start, which here is the side the video comes from.
        const marks = HOOKS.map((c) => {
            const p = cells[c].p;
            const [w, h] = box(cellLen, th);
            const m = kit.bar('mark', w, h, p.x, p.y, 6);
            m.userData = { ...m.userData, len: cellLen, p };
            return m;
        });

        // ── The Mac listening: a few bars swelling over the strip at the second node ─────────────────────────────
        const wave = lite ? [] : [-2, -1, 0, 1, 2].map((k) => {
            const p = { x: lane[1].x + dir.x * k * 7, y: lane[1].y + dir.y * k * 7 };
            const [w, h] = box(3, 14);
            const m = kit.bar('muted', w, h, p.x, p.y, 8);
            return { m, k, p };
        });

        // ── The reels: 9:16, with a title, captions and a cover ──────────────────────────────────────────────────
        const cw = tall ? 26 : 22, ch = Math.round(cw * 16 / 9);
        const reelArt = kit.paint(cw, ch, (c, W, H, k) => {
            const tk = k.tokens;
            c.fillStyle = cssColor(tk.solid); c.beginPath(); rrect(c, 0, 0, W, H, 4); c.fill();
            c.strokeStyle = cssColor(tk.ring); c.lineWidth = 1; c.beginPath(); rrect(c, 0.5, 0.5, W - 1, H - 1, 3.5); c.stroke();
            c.fillStyle = cssColor(tk.muted, 0.9); c.beginPath(); rrect(c, 3, 4, W * 0.6, 2.5, 1.2); c.fill();      // the title
            c.fillStyle = cssColor(tk.glass, 3); c.beginPath(); rrect(c, 3, 9, W - 6, H * 0.46, 2); c.fill();       // the cover
            c.fillStyle = cssColor(tk.muted, 0.7);
            c.beginPath(); rrect(c, 3, H - 11, W - 6, 2, 1); c.fill();                                              // the captions
            c.beginPath(); rrect(c, 3, H - 6.5, W * 0.62, 2, 1); c.fill();
        });
        const stampArt = kit.paint(12, 12, (c, W, H, k) => {
            c.fillStyle = cssColor(k.tokens.accent); c.beginPath(); c.arc(6, 6, 6, 0, Math.PI * 2); c.fill();
            c.strokeStyle = cssColor(k.tokens.onAccent); c.lineWidth = 1.6; c.lineCap = c.lineJoin = 'round';
            c.beginPath(); c.moveTo(3.2, 6.2); c.lineTo(5.2, 8); c.lineTo(8.8, 4.2); c.stroke();
        });
        const chips = tiles[5].chips;
        const reels = HOOKS.map((c, j) => {
            const chip = chips.find((x) => x.glyph === TARGETS[j]) ?? chips[Math.min(j, chips.length - 1)];
            const sprite = kit.sprite(reelArt, cells[c].p.x, cells[c].p.y, 10);
            const stamp = kit.sprite(stampArt, 0, 0, 12);
            const off = (j - (HOOKS.length - 1) / 2) * (tall ? 26 : 9);          // fanned across the lane, in depth too
            const mid = at(0.9, off);
            // out of its cell, across the lane in front of the tiles (fanned by `off` and by depth), to its slot
            const path = [
                [cells[c].p.x, cells[c].p.y, 10],
                [mid.x, mid.y, 26 + j * 10],
                [lane[4].x + perp.x * off * 0.6, lane[4].y + perp.y * off * 0.6, 40 + j * 8],
                [chip.cx, chip.cy, 18],
            ];
            return { sprite, stamp, chip, path, j };
        });
        // A slot that is received rings once.
        const rings = reels.map((r) => (TARGETS[r.j] === 'tiktok' ? null : kit.shape('markRing', r.chip.w + 8, r.chip.h + 8, (r.chip.h + 8) / 2, r.chip.cx, r.chip.cy, 20, 2)));
        rings.forEach((m) => m && (m.visible = false));
        const cur = [0, 0, 0];

        return {
            update(T) {
                const u = T % LOOP;
                // the strip
                cells.forEach((c, i) => {
                    const a = cellIn(i, u);
                    kit.fade(c.mesh, lite && i >= n ? 0 : a * 0.9);
                    c.mesh.position.z = 4 + 8 * (1 - a);
                });
                // the highlighter
                marks.forEach((m, j) => {
                    const grow = lit(j, u);
                    const a = litAlpha(j, u);
                    kit.fade(m, grow > 0.001 ? a : 0);
                    const full = m.userData.len;
                    const span = Math.max(full * grow, 0.001);
                    const sgn = Math.sign(along === 'x' ? dir.x : dir.y);
                    const centre = (along === 'x' ? m.userData.p.x : m.userData.p.y) - sgn * full / 2 + sgn * span / 2;
                    if (along === 'x') { m.scale.x = span; m.position.x = kit.wx(centre, 6); } else { m.scale.y = span; m.position.y = kit.wy(centre, 6); }
                });
                // the Mac listens
                const l = listening(u);
                wave.forEach(({ m, k }) => {
                    kit.fade(m, l * 0.55);
                    const h = 4 + 16 * l * (0.5 + 0.5 * Math.sin(T * 7 + k * 1.7));
                    if (along === 'x') m.scale.y = h; else m.scale.x = h;
                });
                // the reels
                reels.forEach((r) => {
                    const t = fly(r.j, u);
                    const a = reelAlpha(r.j, u);
                    bezier3(r.path[0], r.path[1], r.path[2], r.path[3], t, cur);
                    r.sprite.position.set(kit.wx(cur[0], cur[2]), kit.wy(cur[1], cur[2]), cur[2]);
                    // from a cell of the strip to a 9:16 card, bigger in the middle of the way, small again as it is put into its slot
                    const b = becomes(r.j, u);
                    const zoom = lerp(1, 1.5, Math.sin(Math.PI * t)) * lerp(1, 0.62, smooth(Math.max(0, (t - 0.7) / 0.3)));
                    const sx = lerp(along === 'x' ? cellLen / cw : th / cw, 1, b) * zoom;
                    const sy = lerp(along === 'x' ? th / ch : cellLen / ch, 1, b) * zoom;
                    r.sprite.scale.set(cw * sx, ch * sy, 1);
                    kit.fade(r.sprite, a);
                    const ap = approved(r.j, u);
                    r.stamp.position.set(r.sprite.position.x + cw * sx * 0.42, r.sprite.position.y + ch * sy * 0.4, r.sprite.position.z + 2);
                    kit.fade(r.stamp, ap * a);
                    if (rings[r.j]) kit.fade(rings[r.j], ring(r.j, u));
                });
            },
        };
    },
});
