#!/usr/bin/env node
/**
 * Builds the landing hero's 3D scene (L10): scripts/hero3d/scene.mjs + three, tree-shaken, into one
 * content-hashed file, public/brand/hero3d.<sha8>.js, and points the loader in public/landing.html at it.
 *
 * Why this exists instead of a CDN tag: three@0.186.1 on jsdelivr ships no minified build (a 1.3 MB module that
 * pulls its own core), and the landing is the one page whose first visit cannot afford a third-party round trip.
 * The bundle is committed, like everything else under public/: the app has no build step on Vercel.
 *
 * The file name carries the hash of its bytes, so the route can say `immutable` for a year and a change can never
 * be served stale: a new build is a new URL, and the loader's HERO3D constant is the only thing that names it.
 * The previous bundle is kept for one release so a browser holding the previous page still finds its file.
 *
 *   node scripts/build-hero3d.mjs            build, write the bundle, rewrite HERO3D, drop bundles older than the previous
 *   node scripts/build-hero3d.mjs --check    change nothing; exit 1 unless
 *                                              - the build is reproducible and its bytes are what the file named for the hash holds,
 *                                              - HERO3D in landing.html names exactly that file (or is '', the rollback state),
 *                                              - the bundle is at most 145 KB gzipped,
 *                                              - at most two bundles exist, and each one's name is the hash of its bytes.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = join(ROOT, 'scripts/hero3d/scene.mjs');
export const OUT_DIR = join(ROOT, 'public/brand');
export const LANDING = join(ROOT, 'public/landing.html');

/** 145 KB gzipped, the ceiling in docs/brand/LANDING_3D_LOGOS.md. The production check is `gzip -c | wc -c <= 148480`. */
export const MAX_GZIP = 145 * 1024;
export const MAX_BUNDLES = 2;

const LOADER_CONSTANT = /var HERO3D = '([^']*)';/;
const BUNDLE_NAME = /^hero3d\.([0-9a-f]{8})\.js$/;

/** Bundle the scene. Pure: the same sources and the same esbuild give the same bytes on any machine. */
export async function bundle() {
    const result = await build({
        entryPoints: [ENTRY],
        bundle: true,
        write: false,
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
    if (result.outputFiles.length !== 1) throw new Error(`expected one output file, got ${result.outputFiles.length}`);
    const bytes = Buffer.from(result.outputFiles[0].contents);
    const sha8 = createHash('sha256').update(bytes).digest('hex').slice(0, 8);
    return { bytes, sha8, name: `hero3d.${sha8}.js`, gzip: gzipSync(bytes).length };
}

const bundlesOnDisk = () => (existsSync(OUT_DIR) ? readdirSync(OUT_DIR).filter((f) => BUNDLE_NAME.test(f)) : []);
const loaderValue = (html) => LOADER_CONSTANT.exec(html)?.[1] ?? null;
const sha8Of = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 8);

async function main() {
    const check = process.argv.includes('--check');
    const built = await bundle();
    const html = readFileSync(LANDING, 'utf8');
    const current = loaderValue(html);
    const kb = (n) => (n / 1024).toFixed(1);

    if (!check) {
        mkdirSync(OUT_DIR, { recursive: true });
        const target = join(OUT_DIR, built.name);
        if (!existsSync(target)) writeFileSync(target, built.bytes);
        // Keep this build and the one the page named until now; anything older goes.
        const previous = current ? current.replace('/brand/', '') : null;
        for (const f of bundlesOnDisk()) {
            if (f !== built.name && f !== previous) unlinkSync(join(OUT_DIR, f));
        }
        if (current === null) throw new Error("landing.html has no `var HERO3D = '…';` in its loader");
        writeFileSync(LANDING, html.replace(LOADER_CONSTANT, `var HERO3D = '/brand/${built.name}';`));
        console.log(`built ${built.name}: ${kb(built.bytes.length)} KB, ${kb(built.gzip)} KB gzipped (limit ${kb(MAX_GZIP)})`);
        if (built.gzip > MAX_GZIP) {
            console.error(`over the ${kb(MAX_GZIP)} KB gzip ceiling: report it, do not trim it silently`);
            process.exit(1);
        }
        return;
    }

    const problems = [];
    const have = bundlesOnDisk();
    if (current === null) problems.push("landing.html has no `var HERO3D = '…';` in its loader");

    // 1. Reproducible, and the file named for the hash is exactly what the sources build to.
    const file = join(OUT_DIR, built.name);
    if (!existsSync(file)) {
        problems.push(`public/brand/${built.name} does not exist: the sources build to ${built.name}, so the committed bundle is stale (run npm run build:hero3d)`);
    } else if (!readFileSync(file).equals(built.bytes)) {
        problems.push(`public/brand/${built.name} differs from a fresh build of the same sources`);
    }
    // 2. The loader names it (or is deliberately empty: the rollback).
    if (current === '') {
        console.log('note: HERO3D is empty, the loader is switched off (the documented rollback)');
    } else if (current !== null && current !== `/brand/${built.name}`) {
        problems.push(`the loader's HERO3D is '${current}' but the sources build to /brand/${built.name} (run npm run build:hero3d)`);
    }
    // 3. Size.
    if (built.gzip > MAX_GZIP) problems.push(`${built.name} is ${kb(built.gzip)} KB gzipped, over the ${kb(MAX_GZIP)} KB ceiling`);
    // 4. Count, and every bundle's name is its hash.
    if (have.length > MAX_BUNDLES) problems.push(`${have.length} bundles in public/brand (${have.join(', ')}); at most ${MAX_BUNDLES}: this release and the one before`);
    for (const f of have) {
        const m = BUNDLE_NAME.exec(f);
        const actual = sha8Of(readFileSync(join(OUT_DIR, f)));
        if (m && m[1] !== actual) problems.push(`${f} holds bytes that hash to ${actual}: a bundle must be named for its own hash`);
    }
    // 5. Nothing else lives there: the route serves this directory `immutable`.
    if (existsSync(OUT_DIR)) {
        for (const f of readdirSync(OUT_DIR)) {
            if (!BUNDLE_NAME.test(f)) problems.push(`public/brand/${f} is not a hero3d.<sha8>.js bundle, and this directory is served immutable for a year`);
        }
    }

    if (problems.length) {
        console.error('\nhero3d check failed:\n');
        for (const p of problems) console.error(`   - ${p}\n`);
        process.exit(1);
    }
    console.log(`hero3d ok: ${built.name} is reproducible, ${kb(built.bytes.length)} KB, ${kb(built.gzip)} KB gzipped (limit ${kb(MAX_GZIP)}), ${have.length} bundle(s) in public/brand`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
