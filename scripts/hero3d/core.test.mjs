/**
 * The 3D scenes' decisions, pinned without a GPU (L10, L11).
 *
 * hero.mjs and the diagram scenes draw what core.mjs and the scenes' plan files decide, so these tests are their contract: the
 * loop is the identity's highlight -> deliver motion at four times its tempo, the colours come out of the real tokens, a comment
 * that has no keyword is never lit, a platform that cannot do something is never sent it, and the plans fit the draw-call and
 * triangle budgets the PRs are accepted against. The engine's rules (one context, lazy chunks, a failed mount leaves nothing)
 * are read from its source, because they are what a browser test cannot see being broken until it is.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    CORNER_SEGMENTS, FLY_SPLIT, LOOP, MAX_TEXTURES, PROFILES, RECEIPT_MS, SLOTS, TIMES, bezier3, bubbleCount, cssColor,
    cubicBezier, easeDive, easeFly, easeStandard, loopAt, median, mulberry32, parseColor, phase, roundedRectBody,
    roundedRectContour, roundedRectRing, span, splitAtKeyword,
} from './core.mjs';
import * as monteur from './scenes/monteur.plan.mjs';
import * as pmap from './scenes/pmap.plan.mjs';
import * as studio from './scenes/studio.plan.mjs';

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const RAW = Object.fromEntries(['engine', 'hero', 'kit', 'entry', 'scenes/monteur', 'scenes/studio', 'scenes/pmap'].map((f) => [f, readFileSync(`scripts/hero3d/${f}.mjs`, 'utf8')]));
/** Every source the browser runs, comments removed: the rules below are about what is written, not what is said. */
const SRC = Object.fromEntries(Object.entries(RAW).map(([f, text]) => [f, strip(text)]));

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

    it('reads every token the engine uses, in both themes, from tokens.css and the landing, and each fallback parses', () => {
        const tokens = readFileSync('dashboard/css/tokens.css', 'utf8');
        const landing = readFileSync('public/landing.html', 'utf8');
        const blocks = {
            dark: /:root,\s*:root\[data-theme='dark'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)[1] + (/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/.exec(landing)?.[1] ?? ''),
            light: /:root\[data-theme='light'\]\s*\{([\s\S]*?)\n\}/.exec(tokens)[1] + (/:root\[data-theme='light'\]\s*\{([^}]*)\}/.exec(landing)?.[1] ?? ''),
        };
        const read = RAW.engine.slice(RAW.engine.indexOf('export function readTokens()'));
        const wanted = [...read.slice(0, read.indexOf('\n}\n')).matchAll(/t\('(--[a-z-]+)', '([^']+)'\)/g)].map((m) => [m[1], m[2]]);
        assert.ok(wanted.length >= 14, 'the engine reads the hero\'s six and the diagrams\' eight more');
        for (const [name, fallback] of wanted) {
            assert.ok(parseColor(fallback), `${name}: the fallback ${fallback} parses`);
            for (const theme of ['dark', 'light']) {
                const m = new RegExp(`${name}:\\s*([^;]+);`).exec(blocks[theme]);
                assert.ok(m, `${name} (${theme}) is defined`);
                assert.ok(parseColor(m[1]), `${name} (${theme}) = ${m[1]} parses`);
            }
        }
        // The two tokens that carry alpha keep it.
        near(parseColor(/--accent-soft:\s*([^;]+);/.exec(blocks.dark)[1]).a, 0.16);
        near(parseColor(/--border-strong:\s*([^;]+);/.exec(blocks.dark)[1]).a, 0.2);
        near(parseColor(/--surface-glass:\s*([^;]+);/.exec(blocks.dark)[1]).a, 0.08);
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

describe('hero3d: what the sources are allowed to be (IDENTITY.md section 5: flat, unlit, no mark)', () => {
    const HERO = SRC.hero, ENGINE = SRC.engine, KIT = SRC.kit;
    const LOCAL = new Set(['./core.mjs', './engine.mjs', './kit.mjs', './hero.mjs', '../core.mjs', '../kit.mjs', '../engine.mjs', './monteur.plan.mjs', './studio.plan.mjs', './pmap.plan.mjs']);

    it('imports only three and its own modules, and only unlit things from three', () => {
        for (const [name, src] of Object.entries(SRC)) {
            for (const m of src.matchAll(/from '([^']+)'/g)) assert.ok(m[1] === 'three' || LOCAL.has(m[1]), `${name} imports ${m[1]}`);
            for (const from of src.matchAll(/import\s*\{([^}]*)\}\s*from 'three'/g)) {
                const named = from[1].split(',').map((x) => x.trim()).filter(Boolean);
                assert.deepEqual(named.filter((n) => /Light|Standard|Phong|Lambert|Physical|Toon|Matcap|Shader|Points|Sprite|Bloom|Effect/.test(n)), [], name);
            }
        }
        for (const src of [HERO, KIT]) {
            const named = /import\s*\{([^}]*)\}\s*from 'three'/.exec(src)[1].split(',').map((x) => x.trim());
            assert.ok(named.includes('MeshBasicMaterial') && named.includes('Fog'));
        }
    });

    it('has no lights, no other material, no particles and no post-processing, anywhere', () => {
        for (const [name, src] of Object.entries(SRC)) {
            assert.equal(/new \w*Light\b/.test(src), false, name);
            assert.equal([...src.matchAll(/new (\w*Material)\b/g)].every((m) => m[1] === 'MeshBasicMaterial'), true, name);
            assert.equal(/new (?:Sprite|Points)\b|SpriteMaterial|PointsMaterial|EffectComposer|bloom|shadowMap|castShadow/i.test(src), false, name);
        }
    });

    it('is configured as the spec says: low-power, no major performance caveat, DPR capped, 28 degrees, fog', () => {
        assert.match(ENGINE, /powerPreference:\s*'low-power'/);
        assert.match(ENGINE, /failIfMajorPerformanceCaveat:\s*true/);
        assert.match(ENGINE, /alpha:\s*true/);
        assert.match(ENGINE, /antialias:\s*\(window\.devicePixelRatio \|\| 1\) < 2/);
        assert.match(HERO, /new PerspectiveCamera\(CAMERA\.fov/);
        assert.match(HERO, /scene\.fog = new Fog\(/);
        assert.match(KIT, /const FOV = 28;/);
        assert.match(KIT, /new PerspectiveCamera\(FOV/);
        assert.match(KIT, /this\.scene\.fog = new Fog\(/);
        const core = readFileSync('scripts/hero3d/core.mjs', 'utf8');
        assert.match(core, /CAMERA = \{ fov: 28, z: 14, near: 0\.1, far: 40 \}/);
        assert.match(core, /MAX_DPR = 1\.5/);
        assert.match(core, /FOG = \{ near: 12, far: 22 \}/);
    });

    it('never draws the mark, and takes every colour from a token (the only literals are the fallbacks readTokens carries)', () => {
        const inTokens = /export function readTokens\(\) \{[\s\S]*?\n\}/.exec(ENGINE)[0];
        for (const [name, src] of Object.entries(SRC)) {
            assert.equal(/plogo-zap|favicon|site\.webmanifest|mark-tile|wordmark/.test(src), false, `${name}: the mark is not in a scene`);
            const literals = [...src.matchAll(/'(#[0-9a-fA-F]{3,8}|rgba?\([^']*\))'/g)].map((m) => m[1]);
            for (const lit of literals) assert.ok(name === 'engine' && inTokens.includes(`'${lit}'`), `${name}: ${lit} is outside readTokens`);
            assert.equal(/setStyle|new Color\(\s*['"]/.test(src), false, `${name}: Color.setStyle warns on alpha: tokens are parsed by parseColor`);
        }
    });

    it('draws Arabic through the browser shaper: direction, start alignment, no letter spacing, fonts loaded first', () => {
        assert.match(HERO, /direction: rtl \? 'rtl' : 'ltr'/);
        assert.match(KIT, /direction: this\.sign < 0 \? 'rtl' : 'ltr'/);
        for (const src of [HERO, KIT]) {
            assert.match(src, /textAlign: 'start'/);
            assert.match(src, /letterSpacing: '0px'/);
        }
        assert.match(ENGINE, /document\.fonts\.load\(/);
        assert.match(KIT, /await loadFonts\(kit\.family, texts\(ctx\.el\)\)/, 'a diagram scene loads the faces of its own words before it draws them');
        assert.match(HERO, /fontBoundingBoxAscent/);
        assert.match(ENGINE, /new Path2D\(d\)/);
    });

    it('the hero is the only thing that listens for the deliver event, and it pulses the card through a class, not styles', () => {
        assert.match(HERO, /'hero3d:deliver'/);
        assert.match(HERO, /classList\.add\('is-delivering'\)/);
        for (const [name, src] of Object.entries(SRC)) {
            if (name !== 'hero') assert.equal(src.includes('hero3d:deliver'), false, name);
            assert.equal(/\.style\./.test(src), false, `${name} sets no inline style on the page`);
        }
    });

    it('uses nothing Safari 15 lacks that a build target cannot supply: no roundRect (16), no .at() / hasOwn / structuredClone (15.4)', () => {
        assert.match(build(), /target: \['es2020', 'safari15'\]/);
        for (const [name, src] of Object.entries(SRC)) {
            if (name === 'kit') assert.equal((src.match(/\.roundRect\(/g) ?? []).length, 0, 'kit draws through rrect()');
            else assert.equal(/\.roundRect\(/.test(src), false, `${name}: use rrect() from the kit`);
            assert.equal(/\.at\(|Object\.hasOwn|structuredClone|\.findLast\(|\.replaceAll\(/.test(src), false, name);
        }
        assert.match(SRC.kit, /export function rrect\(c, x, y, w, h, r\) \{[\s\S]*?c\.arcTo\(/, 'a path of arcs, which every browser has');
    });
});

function build() { return readFileSync('scripts/build-hero3d.mjs', 'utf8'); }

describe('hero3d: one renderer, one canvas, and a chunk only when its figure is near (L11)', () => {
    const ENGINE = SRC.engine;

    it('makes exactly one WebGL renderer in all of the scene sources, and nothing else makes a context', () => {
        let renderers = 0;
        for (const [name, src] of Object.entries(SRC)) {
            renderers += (src.match(/new WebGLRenderer\(/g) ?? []).length;
            if (name !== 'engine') assert.equal(/WebGLRenderer|getContext\('webgl/.test(src), false, `${name} does not make a context`);
        }
        assert.equal(renderers, 1);
        assert.equal((ENGINE.match(/renderer\.domElement/g) ?? []).length, 1, 'one canvas, moved between hosts');
        assert.match(ENGINE, /e\.el\.insertBefore\(canvas,/);
    });

    it("fetches a scene's chunk from a second observer whose margin is NEAR (200 px), once, and never from anything else", () => {
        assert.match(ENGINE, /export const NEAR = '200px 0px';/);
        assert.match(ENGINE, /const lazy = new IntersectionObserver\(\(records\) => \{[\s\S]*?\}, \{ rootMargin: NEAR \}\);/);
        assert.match(ENGINE, /if \(!r\.isIntersecting\) continue;\s*lazy\.unobserve\(r\.target\);/, 'once: the host is dropped from the observer as it is asked for');
        assert.match(ENGINE, /if \(e && e\.state === 'idle'\) void load\(e\);/);
        assert.match(ENGINE, /if \(e\.state === 'idle'\) lazy\.observe\(e\.el\);/, 'only a host that has no scene yet is observed for it');
        assert.equal((ENGINE.match(/\bimport\(/g) ?? []).length, 1, 'one dynamic import in the engine');
        assert.match(ENGINE, /const m = await import\(e\.url\);/);
        for (const [name, src] of Object.entries(SRC)) if (name !== 'engine') assert.equal(/\bimport\(/.test(src), false, `${name} fetches nothing`);
        assert.equal((ENGINE.match(/\bload\(e\)/g) ?? []).length, 2, 'load() is defined, and called from the lazy observer only');
    });

    it("the entry builds the hero's hosts and the diagram hosts from the page, and hands them all to one engine", () => {
        const entry = SRC.entry;
        assert.match(entry, /querySelectorAll\('\[data-scene3d\]'\)/);
        assert.equal((entry.match(/\bstart\(/g) ?? []).length, 1, 'one engine');
        assert.equal(/createHero/.test(entry), true);
        assert.equal(/WebGLRenderer|import\(/.test(entry), false);
    });

    it('a scene host that fails stays as its DOM diagram: it is told apart in one place and logged as an info line', () => {
        assert.match(ENGINE, /console\.info\('hero3d: scene ' \+ e\.id \+ ' stays as its poster,', err\);/);
        assert.equal((ENGINE.match(/console\.(?:error|warn)/g) ?? []).length, 0);
        assert.match(ENGINE, /e\.state = 'failed';\s*if \(E\.active === e\) \{ E\.active = null; e\.el\.classList\.remove\('is-3d'\); \}/);
    });

    it('draws nothing while its host is off screen: the loop runs only for an active host with something visible', () => {
        assert.match(ENGINE, /const running = \(\) => !!E\.active && !E\.paused && E\.active\.vis > 0 && !document\.hidden && !E\.asleep && !E\.dead;/);
    });
});

describe('hero3d: the bubble geometry is hand-built, flat and faces the camera', () => {
    const sceneSrc = RAW.hero;
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

    it('hero.mjs and the kit build their shapes from these, not from three\'s Shape and ShapeGeometry (about 7 KB of gzip for a rectangle)', () => {
        assert.match(sceneSrc, /flat\(roundedRectBody\(BW, BH, BR\)\)/);
        assert.match(sceneSrc, /flat\(roundedRectRing\(BW, BH, BR, RING\)\)/);
        assert.match(RAW.kit, /flat\(ring \? roundedRectRing\(w, h, r, ring\) : roundedRectBody\(w, h, r\)\)/);
        const named = /import\s*\{([^}]*)\}\s*from 'three'/.exec(SRC.engine)[1].split(',').map((x) => x.trim()).filter(Boolean);
        assert.ok(named.includes('BufferGeometry') && named.includes('BufferAttribute'), 'the one place a geometry is built from arrays: flat() in the engine');
        for (const [name, src] of Object.entries(SRC)) {
            for (const from of src.matchAll(/import\s*\{([^}]*)\}\s*from 'three'/g)) assert.deepEqual(from[1].split(',').map((x) => x.trim()).filter((x) => /^Shape/.test(x)), [], name);
            assert.equal(/new Shape\b|ShapeGeometry|ExtrudeGeometry/.test(src), false, name);
        }
    });
});

describe('hero3d: a failed mount leaves nothing behind, and a finished page lets go', () => {
    const src = SRC.engine;

    it('wraps everything after the renderer in a try/catch that disposes and rethrows', () => {
        assert.match(src, /try \{\s*if \(motionMq\.matches\) throw new Error\('reduced motion'\);/);
        assert.match(src, /\} catch \(err\) \{\s*dispose\(\);\s*throw err;\s*\}/);
        // the one thing that can fail before it: the renderer itself, which has made nothing yet
        assert.ok(src.indexOf('new WebGLRenderer(') < src.indexOf('try {\n        if (motionMq.matches)'));
    });

    it('checks, after every wait, that the engine was not disposed meanwhile, and a scene that fails while it comes up fails the mount', () => {
        assert.ok((src.match(/E\.dead/g) ?? []).length >= 10);
        for (const why of ['disposed while building', 'disposed while compiling', 'disposed while mounting']) assert.ok(src.includes(`throw new Error('${why}')`), why);
        assert.match(src, /if \(E\.settle\) \{ settle\(err\); return; \}/, "while the engine comes up, its first scene failing is the engine failing");
        assert.match(src, /dispose\(\);\s*throw err;/);
    });

    it('re-checks reduced motion at mount, and lets go of the context when the page is unloaded for good', () => {
        assert.match(src, /if \(motionMq\.matches\) throw new Error\('reduced motion'\)/);
        assert.match(src, /listen\(motionMq, 'change', \(\) => \{ if \(motionMq\.matches\) fallback\('reduced motion'\); \}\)/);
        assert.match(src, /listen\(window, 'pagehide', \(ev\) => \{ if \(!ev\.persisted\) dispose\(\); \}\)/);
    });

    it('dispose removes the listeners, all four observers, the renderer and its context, every instance and the canvas', () => {
        const dispose = /function dispose\(\) \{[\s\S]*?\n    \}\n/.exec(src)[0];
        for (const part of ['for (const off of on) off();', 'io.disconnect(); lazy.disconnect(); ro.disconnect(); mo.disconnect();', 'e.inst?.dispose()', 'renderer.dispose();', 'renderer.forceContextLoss();', 'canvas.remove();', "classList.remove('is-3d')", 'cancelAnimationFrame(E.raf)']) {
            assert.ok(dispose.includes(part), part);
        }
    });

    it('a change of language or theme re-picks the host on screen, and the context-loss and slow-frame ladders end in the DOM diagram', () => {
        assert.match(src, /mo\.observe\(root, \{ attributes: true, attributeFilter: \['data-theme', 'data-lang'\] \}\);/);
        assert.match(src, /listen\(canvas, 'webglcontextlost', \(ev\) => \{ ev\.preventDefault\(\); fallback\('context lost'\); \}\)/);
        assert.match(src, /if \(E\.median <= 20\) return;/);
        assert.match(src, /\} else if \(E\.median > 24\) \{\s*fallback\('slow: median '/);
    });
});

// ─── The diagram scenes' timelines (L11) ───────────────────────────────────────────────────────────────────────────────

/** Sample a plan function over a whole loop, a frame at a time. */
const frames = Array.from({ length: 601 }, (_, i) => i / 60);

describe('hero3d: the diagram scenes are the same motion as the hero, highlight -> deliver at four times its tempo', () => {
    it('each loops in ten seconds, with the sweep at 3.0-4.3 s, the delivery at 4.8-6.4 s and a ring of 0.8 s', () => {
        for (const plan of [monteur, studio, pmap]) {
            assert.equal(plan.LOOP, 10);
            assert.deepEqual(plan.TIMES.sweep, [3.0, 4.3]);
            assert.deepEqual(plan.TIMES.fly, [4.8, 6.4]);
            assert.equal(plan.TIMES.ring, 0.8);
            assert.equal(plan.TIMES.ring * 1000, RECEIPT_MS, 'the same receipt as the hero and the CSS: --kw-receipt times four');
            assert.ok(plan.TIMES.away[0] > plan.TIMES.fly[1] + plan.TIMES.ring, 'the ring is over before everything lets go');
            assert.ok(plan.TIMES.away[1] <= plan.LOOP);
        }
        near(monteur.TIMES.sweep[1] - monteur.TIMES.sweep[0], 4 * 0.32, 0.03);
        near(monteur.TIMES.fly[0] - monteur.TIMES.sweep[1], 4 * 0.12, 0.03);
    });

    it('every value a plan returns is a finite number from 0 to 1, at every frame of the loop', () => {
        const all = [
            ...['cellIn', 'litAlpha'].flatMap((n) => monteur.HOOKS.map((_, j) => [`monteur.${n}`, (u) => monteur[n](n === 'cellIn' ? monteur.HOOKS[j] : j, u)])),
            ...['fly', 'becomes', 'approved', 'reelAlpha', 'ring', 'lit'].flatMap((n) => monteur.HOOKS.map((_, j) => [`monteur.${n}`, (u) => monteur[n](j, u)])),
            ['monteur.listening', monteur.listening], ['monteur.sweep', monteur.sweep],
            ['studio.lesson', studio.lesson], ['studio.fanned', studio.fanned], ['studio.flipped', studio.flipped], ['studio.sweep', studio.sweep],
            ...studio.SENT.flatMap((_, j) => ['fly', 'reviewed', 'tall', 'sentAlpha', 'ring'].map((n) => [`studio.${n}`, (u) => studio[n](j, u)])),
            ...Array.from({ length: studio.SLIDES }, (_, s) => ['dealtOut', 'stackAlpha'].map((n) => [`studio.${n}`, (u) => studio[n](s, u)])).flat(),
            ['pmap.lit', pmap.lit], ['pmap.litAlpha', pmap.litAlpha],
            ...[0, 1].flatMap((k) => ['fly', 'messageAlpha', 'ring'].map((n) => [`pmap.${n}`, (u) => pmap[n](k, u)])),
            ...[0, 1, 2, 3].map((r) => ['pmap.rowIn', (u) => pmap.rowIn(r, u)]),
        ];
        for (const [name, f] of all) {
            for (const u of frames) {
                const v = f(u);
                assert.ok(Number.isFinite(v) && v >= -1e-9 && v <= 1 + 1e-9, `${name}(${u}) = ${v}`);
            }
        }
    });

    it('nothing jumps: no plan value moves by more than 0.35 between two frames (60 fps), except the hard cut a hold ends with', () => {
        const smooth = [
            ['monteur.fly', (u) => monteur.fly(0, u)], ['monteur.sweep', monteur.sweep], ['monteur.listening', monteur.listening],
            ['studio.fly', (u) => studio.fly(1, u)], ['studio.flipped', studio.flipped], ['studio.fanned', studio.fanned], ['studio.sweep', studio.sweep],
            ['studio.lesson', studio.lesson], ['pmap.fly', (u) => pmap.fly(0, u)], ['pmap.lit', pmap.lit], ['pmap.ring', (u) => pmap.ring(0, u)],
        ];
        for (const [name, f] of smooth) {
            for (let i = 1; i < frames.length; i++) assert.ok(Math.abs(f(frames[i]) - f(frames[i - 1])) < 0.35, `${name} jumps at ${frames[i]}`);
        }
    });

    it('a ring is one swell: it starts at 0, reaches 1, and ends at 0, once per loop, from the moment its thing arrives', () => {
        const rings = [
            ...monteur.HOOKS.map((_, j) => ['monteur', j, (u) => monteur.ring(j, u), monteur.arrival(j), monteur.SCHEDULED[j]]),
            ...studio.SENT.map((o, j) => ['studio', j, (u) => studio.ring(j, u), studio.arrival(j), o.ring]),
            ...[0, 1].map((k) => ['pmap', k, (u) => pmap.ring(k, u), pmap.arrival(k), true]),
        ];
        for (const [name, j, f, at, rings1] of rings) {
            const values = frames.map(f);
            if (!rings1) { assert.ok(values.every((v) => v === 0), `${name} ${j} never rings`); continue; }
            assert.equal(f(at - 1e-3), 0, `${name} ${j} is quiet before it arrives`);
            assert.equal(f(at + 0.8 + 1e-3), 0, `${name} ${j} is quiet after`);
            near(Math.max(...frames.map((u) => f(u))), 1, 0.01);
            const rises = values.filter((v, i) => i && v > 0 && values[i - 1] === 0).length;
            assert.equal(rises, 1, `${name} ${j} rings once`);
        }
    });

    it('delivery is staggered inside its window, and the last thing to land lands before the window closes', () => {
        assert.ok(monteur.arrival(monteur.HOOKS.length - 1) <= monteur.TIMES.fly[1] + 1e-9);
        assert.ok(studio.arrival(studio.SENT.length - 1) <= studio.TIMES.fly[1] + 1e-9);
        assert.ok(pmap.arrival(1) <= pmap.TIMES.fly[1] + 1e-9);
        for (const [plan, n] of [[monteur, 4], [studio, 3], [pmap, 2]]) {
            const gap = plan.FLY_GAP;
            assert.ok(gap > 0 && gap <= 0.3, 'one after another, not all at once and not a queue');
            for (let j = 1; j < n; j++) assert.ok(plan.arrival(j) > plan.arrival(j - 1), 'in order');
        }
        near(pmap.arrival(0) - pmap.TIMES.fly[0], pmap.FLY_LEN, 1e-9);
    });
});

describe('hero3d: what each diagram scene shows is what its figure says, and nothing it does not (slot plans)', () => {
    it('Monteur: four hooks inside the strip, one reel for each place the figure names, TikTok as a draft that never rings', () => {
        assert.equal(monteur.HOOKS.length, 4);
        assert.equal(new Set(monteur.HOOKS).size, 4, 'distinct cells');
        assert.ok(monteur.HOOKS.every((c) => c >= 0 && c < monteur.CELLS));
        assert.deepEqual(monteur.TARGETS, ['instagram', 'facebook', 'youtube', 'tiktok']);
        assert.deepEqual(monteur.SCHEDULED, [true, true, true, false], 'TikTok is "Draft / Only me": placed, never received');
        for (let j = 0; j < 4; j++) {
            const settled = monteur.reelAlpha(j, monteur.TIMES.fly[1] + 1.2);
            if (monteur.SCHEDULED[j]) assert.equal(settled, 0, 'a received reel goes into its slot');
            else assert.ok(settled > 0.5 && settled < 1, 'a draft stays, quieter');
        }
    });

    it('Studio: a lesson becomes five slides; the keyword is on the last; two are received and one 9:16 is held for TikTok', () => {
        assert.equal(studio.SLIDES, 5);
        assert.equal(studio.KEYWORD_SLIDE, studio.SLIDES - 1);
        assert.deepEqual(studio.SENT.map((o) => o.to), ['instagram', 'facebook', 'tiktok']);
        assert.deepEqual(studio.SENT.map((o) => o.ring), [true, true, false]);
        assert.equal(new Set(studio.SENT.map((o) => o.slide)).size, 3, 'three different slides');
        assert.ok(studio.SENT.every((o) => o.slide !== studio.KEYWORD_SLIDE && o.slide >= 0 && o.slide < studio.SLIDES), 'the keyword slide stays: it is shown, not sent');
        // the 9:16 version is TikTok's alone
        assert.deepEqual(studio.SENT.map((_, j) => studio.tall(j, studio.TIMES.fly[1])), [0, 0, 1]);
        // slides come off the lesson one after another, then the last one turns over, and only then is its keyword lit
        for (let s = 1; s < studio.SLIDES; s++) assert.ok(studio.dealtOut(s, 1.2) <= studio.dealtOut(s - 1, 1.2), 'dealt in order');
        assert.ok(studio.TIMES.flip[1] <= studio.TIMES.sweep[0] + 0.5);
        assert.equal(studio.sweep(studio.TIMES.flip[0]), 0, 'nothing is lit before the slide turns');
        near(studio.flipped(studio.TIMES.sweep[1]), 1, 1e-9);   // and it stays turned over while it is lit
        // a held TikTok slide stays; a received one is gone before everything lets go
        assert.ok(studio.sentAlpha(2, studio.TIMES.fly[1] + 1) > 0.5);
        assert.equal(studio.sentAlpha(0, studio.TIMES.fly[1] + 1), 0);
        // a slide that is sent leaves the stack when its copy takes off
        for (const [j, o] of studio.SENT.entries()) {
            assert.equal(studio.stackAlpha(o.slide, studio.TIMES.fly[0] - 0.01), studio.dealtOut(o.slide, studio.TIMES.fly[0] - 0.01));
            assert.equal(studio.stackAlpha(o.slide, studio.TIMES.fly[0] + j * studio.FLY_GAP + 0.1), 0);
        }
    });

    it('Platform map: a message is only ever sent where the table says yes, and the rows settle once and never again', () => {
        // The scene derives its messages from the table (a row whose "Comment to DM" cell holds a check); the plan only times them.
        const html = readFileSync('public/landing.html', 'utf8');
        const rows = [...html.slice(html.indexOf('<table class="pmap" id="pmap-en"')).matchAll(/<tr role="row"><th scope="row"[^>]*>(?:<svg[^>]*><use href="#plogo-([a-z]+)"\/><\/svg>)[^<]*<\/th><td role="cell" class="([a-z]+)" data-th="Comment to DM">/g)].slice(0, 4);
        assert.deepEqual(rows.map((m) => [m[1], m[2]]), [['instagram', 'y'], ['facebook', 'y'], ['tiktok', 'x'], ['youtube', 'x']]);
        assert.equal(rows.filter((m) => m[2] === 'y').length, 2, 'two messages, as many as the plan times');
        // Settling happens once, from the scene's own first frame: a later loop does not replay it.
        for (let r = 0; r < 4; r++) {
            near(pmap.rowIn(r, 0), 0, 1e-9);
            near(pmap.rowIn(r, pmap.ROW_GAP * r + pmap.ROW_LEN), 1, 1e-9);
            near(pmap.rowIn(r, 10 * 3 + 0.5), 1, 1e-9);   // still settled in the fourth loop
        }
        for (let r = 1; r < 4; r++) assert.ok(pmap.rowIn(r, 0.5) <= pmap.rowIn(r - 1, 0.5), 'one after another');
        // The drift is a hair: it must never move a row enough to blur what it says.
        for (let r = 0; r < 4; r++) for (const T of frames) {
            const sw = pmap.sway(r, T);
            assert.ok(Math.abs(sw.x) <= pmap.SWAY.x + 1e-9 && Math.abs(sw.y) <= pmap.SWAY.y + 1e-9 && Math.abs(sw.z) <= pmap.SWAY.z + 1e-9);
        }
        assert.ok(pmap.SWAY.x < 0.03 && pmap.SWAY.y < 0.03 && pmap.SWAY.z < 3);
    });
});

describe('hero3d: the diagram scenes fit the budgets of a full hero frame', () => {
    it('a scene is at most 40 draw calls and 3,000 triangles on the full profile (the hero\'s own ceilings),', () => {
        // The headless suite measures calls and triangles on a real context; this pins the plan they are measured against.
        assert.equal(PROFILES.full.triangles, 3000);
        assert.ok(monteur.CELLS * 2 + monteur.HOOKS.length * 6 + 6 * 8 + 14 * 2 < 3000, 'strip, marks, reels, rings, tiles and the waveform fit by construction');
        assert.ok(studio.SLIDES * 4 + studio.SENT.length * 8 + 5 * 8 + 40 < 3000);
        assert.ok(4 * 52 * 2 + 2 * 4 + 40 < 3000, 'four rows of body + ring, and two messages');
    });
});
