/**
 * The hero scene's decisions, pinned without a GPU (L10).
 *
 * scene.mjs draws what core.mjs decides, so these tests are the scene's contract: the loop is the identity's
 * highlight -> deliver motion at four times its tempo, the colours come out of the real tokens, a comment that has no
 * keyword is never lit, and the plan fits the draw-call and triangle budgets the PR is accepted against.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    CORNER_SEGMENTS, FLY_SPLIT, LOOP, MAX_TEXTURES, PROFILES, RECEIPT_MS, SLOTS, TIMES, bezier3, bubbleCount, cssColor,
    cubicBezier, easeDive, easeFly, easeStandard, loopAt, median, mulberry32, parseColor, phase, roundedRectBody,
    roundedRectContour, roundedRectRing, span, splitAtKeyword,
} from './core.mjs';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not within ${eps} of ${b}`);

describe('hero3d: the loop is highlight -> deliver at four times the product tempo (IDENTITY.md section 6)', () => {
    it('is ten seconds, and its windows are ordered and inside it', () => {
        assert.equal(LOOP, 10);
        const order = [TIMES.lift[0], TIMES.sweep[0], TIMES.sweep[1], TIMES.fly[0], TIMES.fly[1], TIMES.fade[1], TIMES.back[1]];
        assert.deepEqual([...order].sort((a, b) => a - b), order);
        assert.equal(TIMES.back[1], LOOP);
        assert.equal(TIMES.fade[1], TIMES.back[0]);
        assert.equal(TIMES.fly[1], TIMES.fade[0], 'it leaves the moment it arrives');
    });

    it('sweeps 3.0-4.3 s and flies 4.8-6.4 s: --kw-sweep, --kw-hold and --kw-deliver times four, give or take a frame', () => {
        assert.deepEqual(TIMES.sweep, [3.0, 4.3]);
        assert.deepEqual(TIMES.fly, [4.8, 6.4]);
        near(TIMES.sweep[1] - TIMES.sweep[0], 4 * 0.32, 0.03);
        near(TIMES.fly[0] - TIMES.sweep[1], 4 * 0.12, 0.03);
        near(TIMES.fly[1] - TIMES.fly[0], 4 * 0.32, 0.35);
        assert.equal(RECEIPT_MS, 4 * 200, '--kw-receipt (200 ms) times four');
    });

    it('the CSS receipt the scene triggers is the same length', () => {
        const css = readFileSync('public/landing.html', 'utf8');
        assert.match(css, new RegExp(`--lp-kw-receipt:\\s*${RECEIPT_MS}ms`));
    });

    it('a keyword comment: lifts, sweeps, holds, flies, arrives, leaves, comes back', () => {
        const at = (u) => phase(u, true);
        assert.equal(at(0).lift, 0);
        assert.equal(at(0).sweep, 0);
        assert.equal(at(2.9).sweep, 0, 'nothing is lit before the sweep');
        near(at(3.65).sweep, easeStandard(0.5), 1e-9);
        assert.equal(at(4.3).sweep, 1);
        assert.equal(at(4.6).sweep, 1, 'the highlight holds through the pause');
        assert.equal(at(4.7).fly, 0, 'and nothing has left yet');
        assert.equal(at(4.8).fly, 0);
        near(at(5.6).fly, 0.5, 1e-9);
        assert.equal(at(6.4).fly, 1);
        assert.equal(at(6.39).delivered, false);
        assert.equal(at(6.4).delivered, true);
        assert.equal(at(6.4).alpha, 1);
        near(at(6.8).alpha, 0.5, 1e-9);
        assert.equal(at(7.2).alpha, 0);
        assert.equal(at(7.2).sweep, 0, 'the highlight is reset while it is invisible');
        assert.equal(at(7.2).lift, 0);
        assert.equal(at(9.99).alpha > 0.99, true, 'the next bubble is back before the loop ends');
        for (let u = 0; u < LOOP; u += 0.05) {
            const p = at(u);
            for (const k of ['lift', 'sweep', 'fly', 'alpha']) assert.ok(p[k] >= 0 && p[k] <= 1, `${k} at ${u}`);
        }
    });

    it('a comment without a keyword is read and put back: never lit, never sent', () => {
        for (let u = 0; u < LOOP; u += 0.05) {
            const p = phase(u, false);
            assert.equal(p.sweep, 0, `lit at ${u}`);
            assert.equal(p.fly, 0, `sent at ${u}`);
            assert.equal(p.delivered, false, `delivered at ${u}`);
            assert.equal(p.alpha, 1);
        }
        assert.ok(phase(5, false).lift > 0.99, 'it comes forward to be read');
        assert.equal(phase(0, false).lift, 0);
        assert.equal(phase(7.2, false).lift, 0, 'and is back by the time the next one is read');
    });
});

describe('hero3d: the curves', () => {
    it('cubicBezier is the CSS function: 0 -> 0, 1 -> 1, monotone, and linear for (0,0,1,1)', () => {
        const lin = cubicBezier(0, 0, 1, 1);
        for (const x of [0, 0.1, 0.5, 0.9, 1]) near(lin(x), x, 1e-4);
        for (const f of [easeStandard, easeFly, easeDive]) {
            assert.equal(f(0), 0);
            assert.equal(f(1), 1);
            let last = -1;
            for (let x = 0; x <= 1; x += 0.01) {
                const y = f(x);
                assert.ok(y >= last - 1e-9, `monotone at ${x}`);
                last = y;
            }
        }
    });

    it('--ease-standard (0.16, 1, 0.3, 1) is front-loaded, which is why the flight has its own curve', () => {
        assert.ok(easeStandard(0.25) > 0.7);
        assert.ok(Math.abs(easeFly(0.5) - 0.5) < 0.1, 'the margin leg is symmetric');
        assert.ok(easeDive(0.5) < 0.5, 'the dive accelerates, out of sight');
        assert.ok(FLY_SPLIT > 0.5 && FLY_SPLIT < 0.8, 'most of the visible time is the margin leg');
    });

    it('bezier3 starts and ends on its end points', () => {
        const out = [0, 0, 0];
        assert.deepEqual(bezier3([1, 2, 3], [9, 9, 9], [9, 9, 9], [4, 5, 6], 0, out), [1, 2, 3]);
        assert.deepEqual(bezier3([1, 2, 3], [9, 9, 9], [9, 9, 9], [4, 5, 6], 1, out), [4, 5, 6]);
        assert.deepEqual(bezier3([0, 0, 0], [0, 0, 0], [0, 0, 0], [2, 4, 6], 0.5, out).map((v) => +v.toFixed(6)), [0.25, 0.5, 0.75]);
    });

    it('span, median, loopAt', () => {
        assert.equal(span(1, [2, 4]), 0);
        assert.equal(span(3, [2, 4]), 0.5);
        assert.equal(span(5, [2, 4]), 1);
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1, 3, 2]), 2.5);
        assert.equal(median([]), 0);
        assert.deepEqual(loopAt(25), { k: 2, u: 5 });
        assert.deepEqual(loopAt(0), { k: 0, u: 0 });
    });

    it('the drift generator is deterministic: a screenshot is a fact', () => {
        const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8);
        const xs = [a(), a(), a()], ys = [b(), b(), b()];
        assert.deepEqual(xs, ys);
        assert.notDeepEqual(xs, [c(), c(), c()]);
        for (const v of xs) assert.ok(v >= 0 && v < 1);
    });
});

describe('hero3d: colours come out of the real tokens, alpha included', () => {
    it('parses every colour form the tokens are written in', () => {
        const close = (c, [r, g, b, a]) => {
            near(c.r, r / 255, 1e-9); near(c.g, g / 255, 1e-9); near(c.b, b / 255, 1e-9); near(c.a, a, 1e-9);
        };
        close(parseColor('#fff'), [255, 255, 255, 1]);
        close(parseColor('#1e1f1b'), [30, 31, 27, 1]);
        close(parseColor('#BCDE70'), [188, 222, 112, 1]);
        close(parseColor('#bcde7080'), [188, 222, 112, 128 / 255]);
        close(parseColor('#0f08'), [0, 255, 0, 136 / 255]);
        close(parseColor('rgba(188, 222, 112, 0.16)'), [188, 222, 112, 0.16]);
        close(parseColor('rgb(10 20 30)'), [10, 20, 30, 1]);
        close(parseColor('rgb(10 20 30 / 50%)'), [10, 20, 30, 0.5]);
        close(parseColor('  RGBA(255,255,255,.2) '), [255, 255, 255, 0.2]);
    });

    it('refuses what it cannot read, so the caller keeps its fallback', () => {
        for (const bad of ['', 'red', 'hsl(10 20% 30%)', '#12', '#12345', 'rgb(1 2)', 'rgb(a b c)', 'var(--x)', null, undefined]) {
            assert.equal(parseColor(bad), null, String(bad));
        }
    });

    it('reads every token the scene uses, in both themes, from tokens.css and the landing', () => {
        const tokens = readFileSync('dashboard/css/tokens.css', 'utf8');
        const landing = readFileSync('public/landing.html', 'utf8');
        const blocks = {
            dark: /:root,\s*:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)[1],
            light: /:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)[1],
        };
        const logo = {
            dark: /:root,\s*:root\[data-theme='dark'\]\s*\{\s*--logo-mono:\s*([^;]+);/.exec(landing)[1],
            light: /:root\[data-theme='light'\]\s*\{\s*--logo-mono:\s*([^;]+);/.exec(landing)[1],
        };
        for (const theme of ['dark', 'light']) {
            for (const name of ['--surface-page', '--surface-solid', '--border-strong', '--text-default', '--accent-soft', '--accent-text']) {
                const m = new RegExp(`${name}:\\s*([^;]+);`).exec(blocks[theme]);
                assert.ok(m, `${name} (${theme})`);
                assert.ok(parseColor(m[1]), `${name} (${theme}) = ${m[1]} parses`);
            }
            assert.ok(parseColor(logo[theme]), `--logo-mono (${theme})`);
        }
        // The two tokens that carry alpha keep it.
        near(parseColor(/--accent-soft:\s*([^;]+);/.exec(blocks.dark)[1]).a, 0.16);
        near(parseColor(/--border-strong:\s*([^;]+);/.exec(blocks.dark)[1]).a, 0.2);
    });

    it('cssColor writes Canvas 2D colours and scales alpha', () => {
        assert.equal(cssColor({ r: 1, g: 0.5, b: 0, a: 0.5 }), 'rgba(255, 128, 0, 0.5)');
        assert.equal(cssColor({ r: 1, g: 1, b: 1, a: 1 }, 0.7), 'rgba(255, 255, 255, 0.7)');
    });
});

describe('hero3d: a keyword is a word of its own', () => {
    it('splits a comment around its keyword', () => {
        assert.deepEqual(splitAtKeyword('كم السعر؟ وهل فيه توصيل؟', 'السعر'), { before: 'كم ', word: 'السعر', after: '؟ وهل فيه توصيل؟' });
        assert.deepEqual(splitAtKeyword('How much is the price?', 'price'), { before: 'How much is the ', word: 'price', after: '?' });
        assert.deepEqual(splitAtKeyword('بكم الاشتراك الشهري؟', 'بكم'), { before: '', word: 'بكم', after: ' الاشتراك الشهري؟' });
    });
    it('does not light half of another word, and has nothing to say without a keyword', () => {
        assert.equal(splitAtKeyword('اهتمام كبير', 'تم'), null, 'تم inside اهتمام');
        assert.equal(splitAtKeyword('The priceless one.', 'price'), null);
        assert.equal(splitAtKeyword('A price', 'price'), null, 'at the very end there is nothing after it to delimit it');
        assert.equal(splitAtKeyword('Great work', undefined), null);
        assert.equal(splitAtKeyword('Great work', 'price'), null);
    });
});

describe('hero3d: the plan fits the budgets', () => {
    // A bubble is a ring, a body and a label; a keyword bubble adds the highlighter and the keyword. That is the most it can cost.
    const callsFor = (n) => n * 5;
    it('full: 8 bubbles, at most 40 draw calls and 3,000 triangles; lite: 5 bubbles, at most 25 and 2,000', () => {
        assert.equal(PROFILES.full.bubbles, 8);
        assert.equal(PROFILES.lite.bubbles, 5);
        assert.ok(callsFor(PROFILES.full.bubbles) <= PROFILES.full.calls);
        assert.ok(callsFor(PROFILES.lite.bubbles) <= PROFILES.lite.calls);
        assert.equal(PROFILES.full.calls, 40);
        assert.equal(PROFILES.full.triangles, 3000);
        assert.equal(PROFILES.lite.calls, 25);
        assert.equal(PROFILES.lite.triangles, 2000);
        assert.equal(MAX_TEXTURES, 16);
        assert.ok(PROFILES.full.bubbles * 2 <= MAX_TEXTURES, 'a label and a keyword texture each');
    });

    it('has a slot for every bubble of the biggest profile, and the lite five are the ones a phone can see', () => {
        assert.ok(SLOTS.length >= PROFILES.full.bubbles);
        for (const s of SLOTS.slice(0, PROFILES.lite.bubbles)) {
            assert.ok(s.edge === 'top' || s.edge === 'bottom', 'a phone has no side margin to show a side bubble in');
        }
        for (const s of SLOTS) {
            assert.ok(['top', 'bottom', 'start', 'end'].includes(s.edge));
            assert.ok(s.along >= 0 && s.along <= 1 && s.z <= 0 && s.s > 0 && s.s <= 1);
        }
        assert.equal(bubbleCount('full', Array(12).fill({})), 8);
        assert.equal(bubbleCount('lite', Array(12).fill({})), 5);
        assert.equal(bubbleCount('full', Array(3).fill({})), 3);
    });

    it('depth only ever goes back from the card: nothing is in front of it', () => {
        assert.ok(SLOTS.every((s) => s.z <= 0));
        assert.ok(SLOTS.some((s) => s.z <= -4), 'and some of it is far enough to be a different layer');
    });
});

describe('hero3d: what scene.mjs is allowed to be (IDENTITY.md section 5: flat, unlit, no mark)', () => {
    const src = readFileSync('scripts/hero3d/scene.mjs', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('imports only three and its own core, and only unlit things from three', () => {
        const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        assert.deepEqual([...new Set(imports)].sort(), ['./core.mjs', 'three']);
        const named = /import\s*\{([^}]*)\}\s*from 'three'/.exec(src)[1].split(',').map((x) => x.trim()).filter(Boolean);
        assert.ok(named.includes('MeshBasicMaterial') && named.includes('Fog'));
        assert.deepEqual(named.filter((n) => /Light|Standard|Phong|Lambert|Physical|Toon|Matcap|Shader|Points|Sprite|Bloom|Effect/.test(n)), []);
    });

    it('has no lights, no other material, no particles and no post-processing', () => {
        assert.equal(/new \w*Light\b/.test(src), false);
        assert.equal([...src.matchAll(/new (\w*Material)\b/g)].every((m) => m[1] === 'MeshBasicMaterial'), true);
        assert.equal(/Points|Sprite|EffectComposer|bloom|shadowMap|castShadow/i.test(src), false);
    });

    it('is configured as the spec says: low-power, no major performance caveat, DPR capped, 28 degrees, fog', () => {
        assert.match(src, /powerPreference:\s*'low-power'/);
        assert.match(src, /failIfMajorPerformanceCaveat:\s*true/);
        assert.match(src, /alpha:\s*true/);
        assert.match(src, /antialias:\s*\(window\.devicePixelRatio \|\| 1\) < 2/);
        assert.match(src, /new PerspectiveCamera\(CAMERA\.fov/);
        assert.match(src, /scene\.fog = new Fog\(/);
        const core = readFileSync('scripts/hero3d/core.mjs', 'utf8');
        assert.match(core, /CAMERA = \{ fov: 28, z: 14, near: 0\.1, far: 40 \}/);
        assert.match(core, /MAX_DPR = 1\.5/);
        assert.match(core, /FOG = \{ near: 12, far: 22 \}/);
    });

    it('never draws the mark, and takes every colour from a token (the only literals are the fallbacks readTokens carries)', () => {
        assert.equal(/plogo-zap|favicon|site\.webmanifest|mark-tile|wordmark/.test(src), false, 'the mark is not in the scene');
        const literals = [...src.matchAll(/'(#[0-9a-fA-F]{3,8}|rgba?\([^']*\))'/g)].map((m) => m[1]);
        const inTokens = /function readTokens\(\)[\s\S]*?\n\}/.exec(src)[0];
        for (const lit of literals) assert.ok(inTokens.includes(`'${lit}'`), `${lit} is outside readTokens`);
        assert.equal(/setStyle|new Color\(\s*['"]/.test(src), false, 'Color.setStyle warns on alpha: tokens are parsed by parseColor');
    });

    it('draws Arabic through the browser shaper: direction, start alignment, no letter spacing, fonts loaded first', () => {
        assert.match(src, /direction: rtl \? 'rtl' : 'ltr'/);
        assert.match(src, /textAlign: 'start'/);
        assert.match(src, /letterSpacing: '0px'/);
        assert.match(src, /document\.fonts\.load\(/);
        assert.match(src, /fontBoundingBoxAscent/);
        assert.match(src, /new Path2D\(d\)/);
    });

    it('is the only thing that listens for the deliver event, and it pulses the card through a class, not styles', () => {
        assert.match(src, /'hero3d:deliver'/);
        assert.match(src, /classList\.add\('is-delivering'\)/);
        assert.equal(/\.style\./.test(src), false, 'the scene sets no inline style on the page');
    });
});

describe('hero3d: the bubble geometry is hand-built, flat and faces the camera', () => {
    const sceneSrc = readFileSync('scripts/hero3d/scene.mjs', 'utf8');
    const [, BW, BH, BR, RING] = /const BW = ([\d.]+), BH = ([\d.]+), BR = ([\d.]+), RING = ([\d.]+);/.exec(sceneSrc).map(Number);
    const body = roundedRectBody(BW, BH, BR);
    const ring = roundedRectRing(BW, BH, BR, RING);

    const vertex = (g, i) => [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]];
    const triangles = (g) => Array.from({ length: g.index.length / 3 }, (_, t) => [0, 1, 2].map((k) => vertex(g, g.index[t * 3 + k])));
    /** Twice the signed area: positive when the triangle runs counter-clockwise as seen from +z (facing the camera). */
    const turn = ([a, b, c]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const area = (g) => triangles(g).reduce((n, t) => n + turn(t) / 2, 0);
    /** Signed distance to a rounded rectangle centred on the origin: negative inside. */
    const sdf = ([x, y], w, h, r) => {
        const qx = Math.abs(x) - (w / 2 - r), qy = Math.abs(y) - (h / 2 - r);
        return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
    };
    const exactArea = (w, h, r) => w * h - (4 - Math.PI) * r * r;

    it('has 12 segments in each corner, so the body is 52 triangles and the ring 104', () => {
        assert.equal(CORNER_SEGMENTS, 12);
        assert.equal(roundedRectContour(BW, BH, BR).length, 4 * (CORNER_SEGMENTS + 1));
        assert.equal(body.index.length / 3, 4 * (CORNER_SEGMENTS + 1), 'a fan: one triangle per outline segment');
        assert.equal(body.positions.length / 3, 4 * (CORNER_SEGMENTS + 1) + 1, 'the outline and its centre');
        assert.equal(ring.index.length / 3, 2 * 4 * (CORNER_SEGMENTS + 1), 'a strip: two triangles per outline segment');
        assert.equal(ring.positions.length / 3, 2 * 4 * (CORNER_SEGMENTS + 1), 'the outer outline and the inner one');
        for (const g of [body, ring]) {
            assert.ok(g.index.every((i) => i < g.positions.length / 3), 'every index points at a vertex');
            assert.ok(g.index instanceof Uint16Array && g.positions instanceof Float32Array);
        }
    });

    it('is centred on the origin, at z = 0, exactly as wide and tall as asked', () => {
        const xs = [], ys = [];
        for (let i = 0; i < body.positions.length / 3; i++) {
            const [x, y, z] = vertex(body, i);
            xs.push(x); ys.push(y);
            assert.equal(z, 0, 'flat: no bevel, no depth');
        }
        near(Math.min(...xs), -BW / 2, 1e-6); near(Math.max(...xs), BW / 2, 1e-6);
        near(Math.min(...ys), -BH / 2, 1e-6); near(Math.max(...ys), BH / 2, 1e-6);
        for (let i = 0; i < ring.positions.length / 3; i++) assert.equal(vertex(ring, i)[2], 0);
        assert.equal(vertex(body, 0)[0], 0, 'the fan starts at the centre');
        assert.equal(vertex(body, 0)[1], 0);
    });

    it('every triangle runs counter-clockwise as seen from +z: it faces the camera, so back-face culling and the hover raycast see it', () => {
        for (const [name, g] of [['body', body], ['ring', ring]]) {
            const tri = triangles(g);
            tri.forEach((t, i) => assert.ok(turn(t) > 1e-9, `${name} triangle ${i} is ${turn(t) > 0 ? 'degenerate' : 'clockwise'} (${turn(t)})`));
        }
        // And the outline itself winds counter-clockwise, which is what the two meshes inherit.
        const c = roundedRectContour(BW, BH, BR);
        const shoelace = c.reduce((n, p, i) => { const q = c[(i + 1) % c.length]; return n + (p[0] * q[1] - q[0] * p[1]); }, 0);
        assert.ok(shoelace > 0);
    });

    it('the body covers the rounded rectangle: its area is the analytic one, give or take the chords', () => {
        assert.ok(Math.abs(area(body) - exactArea(BW, BH, BR)) / exactArea(BW, BH, BR) < 1e-3, `${area(body)} vs ${exactArea(BW, BH, BR)}`);
        // ...and every vertex sits on the outline, or at the centre.
        for (let i = 1; i < body.positions.length / 3; i++) near(sdf(vertex(body, i), BW, BH, BR), 0, 1e-6);
    });

    it('the ring is the band between the outline and the same outline inset by RING with a corner radius of BR - RING', () => {
        const inner = [BW - 2 * RING, BH - 2 * RING, BR - RING];
        const n = 4 * (CORNER_SEGMENTS + 1);
        for (let i = 0; i < n; i++) {
            near(sdf(vertex(ring, i), BW, BH, BR), 0, 1e-6);          // the outer vertices are on the outer outline
            near(sdf(vertex(ring, n + i), ...inner), 0, 1e-6);          // the inner ones on the inner outline
            // one thickness all the way round: an inner point is RING inside the outer outline
            near(-sdf(vertex(ring, n + i), BW, BH, BR), RING, 1e-5);
        }
        const innerArea = exactArea(...inner);
        assert.ok(Math.abs(area(ring) - (exactArea(BW, BH, BR) - innerArea)) / (exactArea(BW, BH, BR) - innerArea) < 2e-3, 'the band is outer minus inner');
        // Nothing of the strip lies inside the hole or outside the outline.
        for (const [i, t] of triangles(ring).entries()) {
            const centroid = [0, 1].map((k) => (t[0][k] + t[1][k] + t[2][k]) / 3);
            assert.ok(sdf(centroid, BW, BH, BR) <= 1e-9, `ring triangle ${i} is outside the outline`);
            assert.ok(sdf(centroid, ...inner) >= -1e-9, `ring triangle ${i} is inside the hole`);
        }
    });

    it("a frame of the full profile fits the triangle budgets with this shape: 8 bubbles of ring + body + label, plus 5 highlighters", () => {
        const perBubble = body.index.length / 3 + ring.index.length / 3 + 2;   // body, ring, the label plane
        const keyword = 2 + 2;                                                   // the highlighter and the keyword planes
        assert.ok(PROFILES.full.bubbles * perBubble + PROFILES.full.bubbles * keyword <= PROFILES.full.triangles);
        assert.ok(PROFILES.lite.bubbles * perBubble + PROFILES.lite.bubbles * keyword <= PROFILES.lite.triangles);
    });

    it('scene.mjs builds the bubbles from these, not from three\'s Shape and ShapeGeometry (about 7 KB of gzip for a rectangle)', () => {
        assert.match(sceneSrc, /flat\(roundedRectBody\(BW, BH, BR\)\)/);
        assert.match(sceneSrc, /flat\(roundedRectRing\(BW, BH, BR, RING\)\)/);
        const named = /import\s*\{([^}]*)\}\s*from 'three'/.exec(sceneSrc)[1].split(',').map((x) => x.trim()).filter(Boolean);
        assert.ok(named.includes('BufferGeometry') && named.includes('BufferAttribute'));
        assert.deepEqual(named.filter((x) => /^Shape/.test(x)), []);
        assert.equal(/new Shape\b|ShapeGeometry|ExtrudeGeometry/.test(sceneSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), false);
    });
});

describe('hero3d: a failed mount leaves nothing behind, and a finished page lets go', () => {
    const src = readFileSync('scripts/hero3d/scene.mjs', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    it('wraps everything after the renderer in a try/catch that disposes and rethrows', () => {
        assert.match(src, /try \{\s*pickStage\(\);/);
        assert.match(src, /\} catch \(err\) \{\s*dispose\(\);\s*throw err;\s*\}/);
        // the one thing that can fail before it: the renderer itself, which has made nothing yet
        assert.ok(src.indexOf('new WebGLRenderer(') < src.indexOf('try {\n        pickStage();'));
    });

    it('checks, after every wait, that the scene was not disposed meanwhile, and that the page did not change language', () => {
        assert.ok((src.match(/alive\(\);/g) ?? []).length >= 4);
        assert.match(src, /throw new Error\('disposed while mounting'\)/);
        assert.match(src, /while \(langOf\(\) !== S\.lang\) \{\s*pickStage\(\);\s*buildBubbles\(\);\s*await fontsFor\(\);\s*alive\(\);/);
        assert.match(src, /if \(langOf\(\) !== S\.lang\) await switchLang\(\);/);
    });

    it('re-checks reduced motion at mount, and lets go of the context when the page is unloaded for good', () => {
        assert.match(src, /if \(motionMq\.matches\) throw new Error\('reduced motion'\)/);
        assert.match(src, /listen\(window, 'pagehide', \(e\) => \{ if \(!e\.persisted\) dispose\(\); \}\)/);
    });

    it('dispose removes the listeners, all three observers, the renderer and its context, and the canvas', () => {
        const dispose = /function dispose\(\) \{[\s\S]*?\n    \}\n/.exec(src)[0];
        for (const part of ['for (const off of on) off();', 'ro.disconnect(); io.disconnect(); mo.disconnect();', 'renderer.dispose();', 'renderer.forceContextLoss();', 'canvas.remove();', "classList.remove('is-3d')", 'cancelAnimationFrame(S.raf)']) {
            assert.ok(dispose.includes(part), part);
        }
    });

    it('a change of language or theme that arrives mid-switch is not dropped', () => {
        assert.match(src, /if \(busy\) \{ again = true; return; \}/);
        assert.match(src, /\} while \(again && !S\.dead\);/);
    });
});
