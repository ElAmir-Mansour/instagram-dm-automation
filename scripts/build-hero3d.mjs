#!/usr/bin/env node
/**
 * Builds the landing's 3D scenes (L10, L11): the engine, the hero and three diagram scenes, from scripts/hero3d/ and three,
 * tree-shaken and code-split into content-hashed files under public/brand/, and points the page at them.
 *
 *   hero3d.<sha8>.js    the entry the loader imports: engine + hero (its three is in the shared chunk)
 *   monteur|studio|pmap.<sha8>.js   one diagram scene each, fetched when its figure nears the viewport
 *   chunk.<sha8>.js     what entries share: three and the engine for every entry, the scene kit for the diagram scenes
 *
 * Why not a CDN tag: three@0.186.1 on jsdelivr ships no minified build (a 1.3 MB module that pulls its own core), and the
 * landing is the one page whose first visit cannot afford a third-party round trip. The files are committed, like everything
 * under public/: the app has no build step on Vercel.
 *
 * Every name carries the SHA-256 of its own bytes, so /brand/* is served `immutable` for a year and a change can never be
 * served stale: a new build is a new URL. esbuild names chunks by its own hash; here each file is renamed for the hash of what
 * it finally holds (imports rewritten leaves first), so "a bundle is named for its own bytes" can be checked with sha256sum.
 * The page names the files in two places, written by this script: `var HERO3D = '…'` in the loader, and each diagram
 * host's `data-scene3d="…"`. The previous release's files are kept so a browser holding the previous page still finds its own.
 *
 *   node scripts/build-hero3d.mjs            build, write the files, rewrite the page's names, drop files older than the previous release
 *   node scripts/build-hero3d.mjs --check    change nothing; exit 1 unless
 *                                              - the build is reproducible and the committed files are exactly what it makes,
 *                                              - the page names exactly those entries (HERO3D = '' is the rollback and passes),
 *                                              - the hero (entry + everything it imports) is at most 145 KB gzipped,
 *                                              - each diagram scene (its entry + what only the scenes share) is at most 20 KB gzipped,
 *                                              - at most two entries of a kind exist (this release and the one before), no
 *                                                file is an orphan, and every file's name is the hash of its own bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { FONT_FILE, LICENCE_FILE } from './build-font.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = join(ROOT, 'public/brand');
export const LANDING = join(ROOT, 'public/landing.html');

/** The entries, in the order they are reported. `hero3d` is the one the loader imports. */
export const ENTRIES = {
    hero3d: 'scripts/hero3d/entry.mjs',
    monteur: 'scripts/hero3d/scenes/monteur.mjs',
    studio: 'scripts/hero3d/scenes/studio.mjs',
    pmap: 'scripts/hero3d/scenes/pmap.mjs',
};
const SCENES = Object.keys(ENTRIES).filter((k) => k !== 'hero3d');

/** 145 KB gzipped, the ceiling in docs/brand/LANDING_3D_LOGOS.md, for what a hero visitor downloads. */
export const MAX_HERO_GZIP = 145 * 1024;
/** What one diagram scene costs on top of the hero's own files. */
export const MAX_SCENE_GZIP = 20 * 1024;
export const MAX_PER_KIND = 2;

const NAME = /^(hero3d|monteur|studio|pmap|chunk)\.([0-9a-f]{8})\.js$/;
const LOADER_CONSTANT = /var HERO3D = '([^']*)';/;
const sceneAttr = (name) => new RegExp(`data-scene3d="/brand/${name}\\.[0-9a-f]{8}\\.js"`, 'g');
const sha8Of = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 8);
const gz = (bytes) => gzipSync(bytes).length;
const kb = (n) => (n / 1024).toFixed(1);

/** The static imports of a built file (esbuild writes them as `from"./x.js"` and `import"./x.js"`). */
export const importsOf = (text) => [...text.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map((m) => m[1]);

/** Everything a file needs: itself and, transitively, what it imports. `files` maps name -> text. */
export function closure(name, files, seen = new Set()) {
    if (seen.has(name)) return seen;
    seen.add(name);
    for (const dep of importsOf(files.get(name) ?? '')) closure(dep, files, seen);
    return seen;
}

/** Bundle everything. Pure: the same sources and the same esbuild give the same bytes on any machine. */
export async function bundle() {
    const entryPoints = Object.fromEntries(Object.entries(ENTRIES).filter(([, p]) => existsSync(join(ROOT, p))).map(([k, p]) => [k, join(ROOT, p)]));
    const result = await build({
        entryPoints,
        bundle: true,
        splitting: true,
        outdir: join(ROOT, '.hero3d-out'),
        entryNames: '[name].[hash]',
        chunkNames: 'chunk.[hash]',
        write: false,
        metafile: true,
        format: 'esm',
        platform: 'browser',
        target: ['es2020', 'safari15'],
        minify: true,
        legalComments: 'eof',
        treeShaking: true,
        charset: 'ascii',
        // three guards its browser-devtools hook behind this global; false here, so the dead branch goes (about 180 bytes).
        define: { __THREE_DEVTOOLS__: 'undefined' },
        logLevel: 'silent',
    });
    // esbuild's own names, then the final ones: leaves first, so each file is hashed with its imports already renamed.
    const raw = new Map(result.outputFiles.map((f) => [basename(f.path), Buffer.from(f.contents).toString('utf8')]));
    const entryOf = new Map();
    for (const [out, meta] of Object.entries(result.metafile.outputs)) if (meta.entryPoint) entryOf.set(basename(out), Object.keys(entryPoints).find((k) => meta.entryPoint.endsWith(ENTRIES[k])));
    const final = new Map();   // esbuild name -> final name
    const files = new Map();   // final name -> text
    const visit = (name, stack = []) => {
        if (final.has(name)) return;
        if (stack.includes(name)) throw new Error('circular chunks: ' + [...stack, name].join(' -> '));
        for (const dep of importsOf(raw.get(name))) visit(dep, [...stack, name]);
        let text = raw.get(name);
        for (const [from, to] of final) text = text.split(`"./${from}"`).join(`"./${to}"`);
        const finalName = `${entryOf.get(name) ?? 'chunk'}.${sha8Of(Buffer.from(text, 'utf8'))}.js`;
        final.set(name, finalName);
        files.set(finalName, text);
    };
    for (const name of raw.keys()) visit(name);
    const entries = {};
    for (const [name, finalName] of final) if (entryOf.has(name)) entries[entryOf.get(name)] = finalName;
    return { files, entries };
}

/** What a hero visitor downloads, and what each scene adds on top. */
export function sizes({ files, entries }) {
    const bytes = (names) => [...names].reduce((n, f) => n + gz(Buffer.from(files.get(f), 'utf8')), 0);
    const hero = closure(entries.hero3d, files);
    const out = { hero: { names: [...hero], gzip: bytes(hero) }, scenes: {} };
    for (const s of SCENES) {
        if (!entries[s]) continue;
        const own = [...closure(entries[s], files)].filter((f) => !hero.has(f));
        out.scenes[s] = { names: own, gzip: bytes(own) };
    }
    return out;
}

const bundlesOnDisk = () => (existsSync(OUT_DIR) ? readdirSync(OUT_DIR) : []);

/** The names the page refers to: the loader's constant and each host's data-scene3d, as {entryKind: file}. */
export function referenced(html) {
    const out = {};
    const hero = LOADER_CONSTANT.exec(html)?.[1];
    if (hero) out.hero3d = [hero.replace('/brand/', '')];
    for (const s of SCENES) out[s] = [...html.matchAll(sceneAttr(s))].map((m) => /brand\/([^"]+)"/.exec(m[0])[1]);
    return out;
}

async function main() {
    const check = process.argv.includes('--check');
    const built = await bundle();
    const html = readFileSync(LANDING, 'utf8');
    const sz = sizes(built);
    const report = `hero ${kb(sz.hero.gzip)} KB gz (limit ${kb(MAX_HERO_GZIP)}), scenes ${Object.entries(sz.scenes).map(([k, v]) => `${k} +${kb(v.gzip)}`).join(', ')} KB gz (limit +${kb(MAX_SCENE_GZIP)} each)`;

    if (!check) {
        if (LOADER_CONSTANT.exec(html) === null) throw new Error("landing.html has no `var HERO3D = '…';` in its loader");
        mkdirSync(OUT_DIR, { recursive: true });
        for (const [name, text] of built.files) if (!existsSync(join(OUT_DIR, name))) writeFileSync(join(OUT_DIR, name), text);
        // Keep this release and the one the page named until now (and what each needs); anything older goes.
        const onDisk = new Map(bundlesOnDisk().filter((f) => NAME.test(f)).map((f) => [f, readFileSync(join(OUT_DIR, f), 'utf8')]));
        const keep = new Set(built.files.keys());
        const prev = referenced(html);
        for (const names of Object.values(prev)) for (const n of names) if (onDisk.has(n)) for (const c of closure(n, onDisk)) keep.add(c);
        for (const f of onDisk.keys()) if (!keep.has(f)) unlinkSync(join(OUT_DIR, f));
        let next = html.replace(LOADER_CONSTANT, `var HERO3D = '/brand/${built.entries.hero3d}';`);
        for (const s of SCENES) if (built.entries[s]) next = next.replace(sceneAttr(s), `data-scene3d="/brand/${built.entries[s]}"`);
        writeFileSync(LANDING, next);
        console.log(`built ${Object.values(built.entries).join(', ')}\n${report}`);
        const over = sz.hero.gzip > MAX_HERO_GZIP || Object.values(sz.scenes).some((v) => v.gzip > MAX_SCENE_GZIP);
        if (over) {
            console.error('over a ceiling: report it, do not trim it silently');
            process.exit(1);
        }
        return;
    }

    const problems = [];
    const have = bundlesOnDisk();
    const onDisk = new Map(have.filter((f) => NAME.test(f)).map((f) => [f, readFileSync(join(OUT_DIR, f), 'utf8')]));
    // 1. Reproducible: every file the sources build to is there, byte for byte.
    for (const [name, text] of built.files) {
        if (!onDisk.has(name)) problems.push(`public/brand/${name} does not exist: the sources build to it, so the committed files are stale (run npm run build:hero3d)`);
        else if (onDisk.get(name) !== text) problems.push(`public/brand/${name} differs from a fresh build of the same sources`);
    }
    // 2. The page names exactly those entries (or is deliberately off: HERO3D = '').
    const ref = referenced(html);
    if (LOADER_CONSTANT.exec(html) === null) problems.push("landing.html has no `var HERO3D = '…';` in its loader");
    if (ref.hero3d?.[0] === '') console.log("note: HERO3D is empty, the loader is switched off (the documented rollback)");
    else if (ref.hero3d?.[0] !== built.entries.hero3d) problems.push(`the loader's HERO3D is '/brand/${ref.hero3d?.[0]}' but the sources build to /brand/${built.entries.hero3d} (run npm run build:hero3d)`);
    for (const s of SCENES) {
        if (!built.entries[s]) continue;
        const names = ref[s];
        if (names.length === 0) problems.push(`no host names the ${s} scene: nothing carries data-scene3d="/brand/${s}.<sha8>.js"`);
        for (const n of names) if (n !== built.entries[s]) problems.push(`a host's data-scene3d is /brand/${n} but the ${s} scene builds to /brand/${built.entries[s]} (run npm run build:hero3d)`);
    }
    // 3. Size: what a hero visitor downloads, and what each scene adds.
    if (sz.hero.gzip > MAX_HERO_GZIP) problems.push(`the hero's files (${sz.hero.names.join(', ')}) are ${kb(sz.hero.gzip)} KB gzipped, over the ${kb(MAX_HERO_GZIP)} KB ceiling`);
    for (const [s, v] of Object.entries(sz.scenes)) if (v.gzip > MAX_SCENE_GZIP) problems.push(`the ${s} scene adds ${kb(v.gzip)} KB gzipped (${v.names.join(', ')}), over the ${kb(MAX_SCENE_GZIP)} KB ceiling`);
    // 4. This release and the one before, no orphans, every name the hash of its own bytes.
    const kinds = {};
    for (const f of onDisk.keys()) {
        const kind = NAME.exec(f)[1];
        (kinds[kind] ||= []).push(f);
    }
    for (const [kind, list] of Object.entries(kinds)) if (kind !== 'chunk' && list.length > MAX_PER_KIND) problems.push(`${list.length} ${kind} entries in public/brand (${list.join(', ')}); at most ${MAX_PER_KIND}: this release and the one before`);
    const reachable = new Set();
    for (const f of onDisk.keys()) if (NAME.exec(f)[1] !== 'chunk') for (const c of closure(f, onDisk)) reachable.add(c);
    for (const [f, text] of onDisk) {
        const actual = sha8Of(Buffer.from(text, 'utf8'));
        if (NAME.exec(f)[2] !== actual) problems.push(`${f} holds bytes that hash to ${actual}: a file must be named for its own hash`);
        if (!reachable.has(f)) problems.push(`${f} is a chunk no entry imports: an orphan from a release before the previous one (run npm run build:hero3d)`);
        for (const dep of importsOf(text)) if (!onDisk.has(dep)) problems.push(`${f} imports ${dep}, which is not in public/brand`);
    }
    // 5. Nothing else lives there: the route serves this directory `immutable` for a year. The display font and its licence are
    //    another script's (scripts/build-font.mjs, npm run check:font), which owns and verifies them.
    for (const f of have) if (!NAME.test(f) && !FONT_FILE.test(f) && f !== LICENCE_FILE) problems.push(`public/brand/${f} is not a built file, and this directory is served immutable for a year`);

    if (problems.length) {
        console.error('\nhero3d check failed:\n');
        for (const p of problems) console.error(`   - ${p}\n`);
        process.exit(1);
    }
    console.log(`hero3d ok: ${Object.values(built.entries).join(', ')} are reproducible; ${report}; ${onDisk.size} file(s) in public/brand`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
