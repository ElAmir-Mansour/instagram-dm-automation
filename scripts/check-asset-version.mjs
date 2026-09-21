#!/usr/bin/env node
/**
 * Guards the dashboard's cache-busting version.
 *
 * The dashboard has no bundler, so `?v=N` on the nine asset refs in index.html and
 * `ASSET_VERSION` in app.js (which builds the URL for lazy-loaded page modules) are the only
 * things telling a returning browser to re-fetch. They must move together.
 *
 * On 2026-09-21 three dashboard PRs merged without touching either. A returning browser then
 * ran a *mixed* bundle — new posts.js against old cached components.js — which throws inside
 * renderLayout() before the container is painted. `/dashboard#/posts` rendered nothing while
 * the API was returning 16 scheduled and 20 live posts. Nothing caught it: there is no build
 * step, and both files were individually valid.
 *
 * Two checks:
 *   1. CONSISTENCY (always) — every ?v= agrees with each other and with ASSET_VERSION.
 *      This is the one that matters: it describes the broken state directly, so it fails on
 *      any branch, in any merge result, without needing to know what changed.
 *   2. BUMP (only when BASE_REF is set, i.e. in a PR) — if anything under dashboard/ changed,
 *      the version must differ from the base's.
 *
 * Usage:  node scripts/check-asset-version.mjs            # consistency only
 *         BASE_REF=origin/main node scripts/...           # consistency + bump
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const INDEX = 'dashboard/index.html';
const APP = 'dashboard/js/app.js';

const fail = [];

/** Every `?v=…` in index.html. */
function refVersions(html) {
    return [...html.matchAll(/\?v=([\w.]+)/g)].map(m => m[1]);
}

/** The `ASSET_VERSION: '…'` literal in app.js. */
function assetVersion(js) {
    const m = js.match(/ASSET_VERSION\s*:\s*['"]([\w.]+)['"]/);
    return m ? m[1] : null;
}

const html = readFileSync(INDEX, 'utf8');
const js = readFileSync(APP, 'utf8');

const refs = refVersions(html);
const av = assetVersion(js);
const distinct = [...new Set(refs)];

// ── Check 1: consistency ────────────────────────────────────────────────────
if (refs.length === 0) {
    fail.push(`${INDEX}: no ?v= asset refs found at all — the cache-busting mechanism is gone.`);
}
if (av === null) {
    fail.push(`${APP}: no ASSET_VERSION literal found — lazy-loaded page modules would be uncacheable or stale.`);
}
if (distinct.length > 1) {
    fail.push(`${INDEX}: asset refs disagree (${distinct.join(', ')}) — a browser would fetch a mixed bundle.`);
}
if (av !== null && distinct.length === 1 && distinct[0] !== av) {
    fail.push(
        `version mismatch: ${INDEX} serves ?v=${distinct[0]} but ${APP} has ASSET_VERSION '${av}'.\n` +
        `      Page modules load at '${av}' while the shell loads at '${distinct[0]}', which is the ` +
        `mixed-bundle state that blanks the page.`
    );
}

// ── Check 2: bump-on-change ─────────────────────────────────────────────────
const base = process.env.BASE_REF;
if (base && fail.length === 0) {
    let changed = [];
    try {
        changed = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`, '--', 'dashboard/'], { encoding: 'utf8' })
            .split('\n').filter(Boolean);
    } catch {
        console.log(`note: could not diff against ${base}; skipping the bump check.`);
    }
    if (changed.length > 0) {
        let baseVersion = null;
        try {
            baseVersion = assetVersion(execFileSync('git', ['show', `${base}:${APP}`], { encoding: 'utf8' }));
        } catch { /* app.js is new on this branch — nothing to compare */ }

        if (baseVersion !== null && baseVersion === av) {
            fail.push(
                `${changed.length} file(s) under dashboard/ changed but ASSET_VERSION is still '${av}'.\n` +
                `      Returning browsers keep their cached copies and run a mixed bundle.\n` +
                `      Bump ASSET_VERSION in ${APP} and all ?v= refs in ${INDEX} together.\n` +
                `      Changed: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', …' : ''}`
            );
        }
    }
}

if (fail.length > 0) {
    console.error('\n❌ dashboard cache-version check failed:\n');
    for (const f of fail) console.error(`   • ${f}\n`);
    process.exit(1);
}

console.log(`✓ dashboard cache version consistent: ${refs.length} ref(s) and ASSET_VERSION all at '${av}'`);
