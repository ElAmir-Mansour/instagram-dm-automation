/**
 * The platform map as a 3D scene (L11): the table #pmap-*, re-drawn in its own box.
 *
 * The table stays where it is, as the plate; its rows are lifted off it and settle back in a little depth, each drifting a hair,
 * and what each says is read from the table's own cells and drawn where the browser laid them out (a table on a desktop, a card
 * a row on a phone). Then the one thing the product does on a comment: the platform's name is lit, a message leaves its logo for
 * its own "Comment to DM" cell, and the cell rings. A row whose cell is a dash never gets a message, because it never does that.
 * Plan and timeline: pmap.plan.mjs.
 */
import { Group } from 'three';
import { bezier3, cssColor } from '../core.mjs';
import { glyphPath } from '../engine.mjs';
import { defineScene, rrect } from '../kit.mjs';
import { LOOP, SETTLE, fly, lit, litAlpha, messageAlpha, ring, rowIn, sway } from './pmap.plan.mjs';

const lerp = (a, b, t) => a + (b - a) * t;

/** What a row (or the header) says and where, read from the page: every item's box is the one the browser gave it. */
function readRow(kit, tr) {
    const box = kit.rel(tr);
    const rel = (r) => ({ l: r.left - kit.host.getBoundingClientRect().left - box.l, t: r.top - kit.host.getBoundingClientRect().top - box.t, w: r.width, h: r.height });
    const items = [];
    const label = [];
    for (const cell of tr.cells) {
        const role = cell.tagName === 'TH' ? (cell.scope === 'row' ? 'strong' : 'muted') : cell.classList.contains('x') ? 'muted' : 'text';
        let run = [];
        const flush = () => {
            const nodes = run.filter((n) => n.textContent.trim());
            run = [];
            if (!nodes.length) return;
            const text = nodes.map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
            const rects = nodes.map((n) => { const g = document.createRange(); g.selectNodeContents(n); return g.getBoundingClientRect(); });
            const l = Math.min(...rects.map((r) => r.left)), r = Math.max(...rects.map((x) => x.right));
            const t = Math.min(...rects.map((x) => x.top)), b = Math.max(...rects.map((x) => x.bottom));
            const cs = getComputedStyle(nodes[0].parentElement);
            items.push({ kind: 'text', text, role, size: parseFloat(cs.fontSize), weight: cs.fontWeight, rect: rel({ left: l, top: t, width: r - l, height: b - t }) });
        };
        const walk = (n) => {
            for (const ch of n.childNodes) {
                if (ch.nodeType === 3) run.push(ch);
                else if (ch.nodeType === 1) {
                    if (ch.classList.contains('sr-only')) continue;
                    if (ch.matches('svg.pm-ic')) { flush(); items.push({ kind: 'check', rect: rel(ch.getBoundingClientRect()) }); continue; }
                    if (ch.matches('svg.plogo')) { flush(); items.push({ kind: 'glyph', name: /#plogo-([a-z]+)/.exec(ch.querySelector('use')?.getAttribute('href') ?? '')?.[1] ?? null, rect: rel(ch.getBoundingClientRect()) }); continue; }
                    walk(ch);
                }
            }
        };
        walk(cell);
        flush();
        // A card names each cell's column at its start (the table's own `td::before`, which is not a node to read).
        if (cell.dataset.th && getComputedStyle(cell, '::before').content !== 'none') {
            const cs = getComputedStyle(cell);
            const r = rel(cell.getBoundingClientRect());
            label.push({ text: cell.dataset.th, size: parseFloat(cs.fontSize), weight: cs.fontWeight, rect: r });
        }
    }
    return { box, items, label };
}

export default defineScene({
    texts: (host) => [...host.querySelectorAll('th, td, caption')].flatMap((n) => [n.textContent.trim(), n.dataset?.th ?? '']).filter(Boolean),

    build(kit) {
        const table = kit.host.querySelector(':scope > .pmap');
        if (!table || !table.tBodies[0]) throw new Error('the platform map has no table to re-draw');
        const bodyRows = [...table.tBodies[0].rows];
        const headRow = table.tHead?.rows[0];
        const sk = kit.sign;
        const cardMode = getComputedStyle(table).display === 'block';
        const headShown = !!headRow && !cardMode;

        // ── One group per row: its tile, its words, the platform's highlighter, the ring on its "Comment to DM" cell ─────
        const paintRow = (spec) => kit.paint(spec.box.w, spec.box.h, (c, W, H, k) => {
            const tk = k.tokens;
            const ink = { strong: tk.strong, muted: tk.muted, text: tk.text };
            for (const it of spec.items) {
                const r = it.rect;
                if (it.kind === 'check') {
                    c.save(); c.translate(r.l, r.t); c.scale(r.w / 24, r.h / 24);
                    c.strokeStyle = cssColor(tk.markText); c.lineWidth = 2.5; c.lineCap = c.lineJoin = 'round';
                    c.stroke(new Path2D('M20 6 9 17l-5-5'));
                    c.restore();
                } else if (it.kind === 'glyph') {
                    const g = it.name && glyphPath(it.name);
                    if (!g) continue;
                    c.save(); c.translate(r.l, r.t); c.scale(r.w / 24, r.h / 24); c.fillStyle = cssColor(tk.logo, 0.95); c.fill(g); c.restore();
                } else {
                    c.font = `${it.weight} ${it.size}px ${k.family}`;
                    c.fillStyle = cssColor(ink[it.role] ?? tk.text);
                    c.fillText(it.text, sk > 0 ? r.l : r.l + r.w, r.t + r.h / 2 + it.size * 0.34);
                }
            }
            for (const lb of spec.label) {
                c.font = `${lb.weight} ${lb.size}px ${k.family}`;
                c.fillStyle = cssColor(tk.muted);
                c.fillText(lb.text, sk > 0 ? lb.rect.l : lb.rect.l + lb.rect.w, lb.rect.t + lb.rect.h / 2 + lb.size * 0.34);
            }
        });

        const rows = bodyRows.map((tr, i) => {
            const spec = readRow(kit, tr);
            const b = spec.box;
            const group = new Group();
            const radius = cardMode ? parseFloat(getComputedStyle(tr).borderTopLeftRadius) || 14 : 10;
            const inset = cardMode ? { x: 0, y: 0 } : { x: 6, y: 3 };
            const w = b.w - 2 * inset.x, h = b.h - 2 * inset.y;
            const body = kit.shape('solid', w, h, Math.min(radius, h / 2), b.cx, b.cy, 0);
            const edge = kit.shape('subtle', w, h, Math.min(radius, h / 2), b.cx, b.cy, 0.5, 1);
            const content = kit.sprite(paintRow(spec), b.cx, b.cy, 1);
            const kids = [body, edge, content];
            for (const m of kids) { group.add(m); m.position.set(0, 0, m.position.z); }
            content.position.z = 1;
            // The platform's name, lit; and the cell that will be given the message, ringed.
            const name = spec.items.find((it) => it.kind === 'text' && it.role === 'strong');
            const glyph = spec.items.find((it) => it.kind === 'glyph');
            const check = tr.cells[1]?.querySelector('svg.pm-ic') ? spec.items.find((it) => it.kind === 'check') : null;   // the first cell's, if it says yes
            let mark = null, rg = null;
            if (check && name) {
                const nm = name.rect;
                mark = kit.bar('mark', 1, 1, 0, 0, 0);
                mark.userData = { ...mark.userData, w: nm.w + 8, h: Math.max(14, nm.h - 2), x: nm.l - b.w / 2 + nm.w / 2, y: b.h / 2 - (nm.t + nm.h / 2) };
                group.add(mark);
                mark.position.set(mark.userData.x, mark.userData.y, 2);
                mark.renderOrder = 2;
                const cr = check.rect;
                rg = kit.shape('markRing', 34, 24, 12, 0, 0, 0, 2);
                group.add(rg);
                rg.position.set(cr.l + cr.w / 2 - b.w / 2, b.h / 2 - (cr.t + cr.h / 2), 3);
                rg.visible = false;
            }
            kit.root.add(group);
            return { i, group, kids, mark, ringMesh: rg, spec, b, check, glyph, tr };
        });

        // ── The header: on the plate, not lifted ─────────────────────────────────────────────────────────────────
        let head = null;
        if (headShown) {
            const spec = readRow(kit, headRow);
            head = kit.sprite(paintRow(spec), spec.box.cx, spec.box.cy, 1);
        }

        // ── The messages: from a platform's logo to its own "Comment to DM" cell. Only rows that say yes have one. ──
        const hosts = kit.host.getBoundingClientRect();
        const centreOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left - hosts.left + r.width / 2, y: r.top - hosts.top + r.height / 2 }; };
        const msgArt = kit.paint(18, 14, (c, W, H, k) => {
            const tk = k.tokens;
            c.fillStyle = cssColor(tk.accent);
            c.beginPath(); rrect(c, 0, 0, W, H - 3, 5); c.fill();
            c.beginPath(); c.moveTo(sk > 0 ? 4 : W - 4, H - 4); c.lineTo(sk > 0 ? 3 : W - 3, H); c.lineTo(sk > 0 ? 9 : W - 9, H - 4); c.closePath(); c.fill();
            c.fillStyle = cssColor(tk.onAccent);
            for (let d = 0; d < 3; d++) { c.beginPath(); c.arc(5 + d * 4, (H - 3) / 2, 1.2, 0, Math.PI * 2); c.fill(); }
        });
        const given = rows.filter((r) => r.check && r.glyph);
        const messages = given.map((r, k) => {
            const from = centreOf(r.tr.cells[0].querySelector('svg.plogo'));
            const to = centreOf(r.tr.cells[1].querySelector('svg.pm-ic'));
            const lift = cardMode ? 14 : 22;
            const path = [[from.x, from.y, 4], [lerp(from.x, to.x, 0.33), lerp(from.y, to.y, 0.33) - (cardMode ? 0 : 6), 30], [lerp(from.x, to.x, 0.7), lerp(from.y, to.y, 0.7) - (cardMode ? 0 : 6), 26], [to.x, to.y, lift - 12]];
            const sprite = kit.sprite(msgArt, from.x, from.y, 4);
            return { k, row: r, path, sprite };
        });
        const cur = [0, 0, 0];

        return {
            update(T) {
                const u = T % LOOP;
                if (head) kit.fade(head, rowIn(-1.5, T));
                for (const r of rows) {
                    const a = rowIn(r.i, T);
                    const s = sway(r.i, T);
                    const z = lerp(SETTLE.rise, s.z, a);
                    r.group.position.set(kit.wx(r.b.cx, z), kit.wy(r.b.cy, z), z);
                    r.group.rotation.set(lerp(SETTLE.tip, s.x, a), s.y * a, 0);
                    for (const m of r.kids) kit.fade(m, a);
                    if (r.mark) {
                        const grow = lit(u);
                        kit.fade(r.mark, grow > 0.001 ? litAlpha(u) * a : 0);
                        const full = r.mark.userData.w, span = Math.max(full * grow, 0.001);
                        r.mark.scale.set(span, r.mark.userData.h, 1);
                        r.mark.position.x = r.mark.userData.x - sk * (full - span) / 2;
                    }
                }
                for (const m of messages) {
                    const t = fly(m.k, u);
                    bezier3(m.path[0], m.path[1], m.path[2], m.path[3], t, cur);
                    m.sprite.position.set(kit.wx(cur[0], cur[2]), kit.wy(cur[1], cur[2]), cur[2]);
                    const s = lerp(1, 1.35, Math.sin(Math.PI * t)) * lerp(1, 0.7, Math.max(0, (t - 0.75) / 0.25));
                    m.sprite.scale.set(18 * s, 14 * s, 1);
                    m.sprite.rotation.z = (1 - t) * 0.25 * -sk;
                    kit.fade(m.sprite, messageAlpha(m.k, u) * rowIn(m.row.i, T));
                    if (m.row.ringMesh) kit.fade(m.row.ringMesh, ring(m.k, u));
                }
            },
        };
    },
});
