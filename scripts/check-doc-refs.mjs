#!/usr/bin/env node
/**
 * Guards the file references in the tracked docs, and moves line anchors that have drifted.
 *
 * The docs cite code as `src/…/file.ts` or `src/…/file.ts:123`. On 2026-10-25 the docs audit
 * (`docs/DOCS_AUDIT.md`, local) measured what happens to those anchors with nothing checking
 * them: of 450 `path:line` anchors in FLOWS.md, only 27% still pointed at the line they named
 * when they were written; 65% had moved (median 70 lines) and 8% pointed at code that was gone.
 * The same audit found public docs linking files that are not in this repo at all (CLAUDE.md,
 * docs/specs/…), which work on the maintainer's Mac and are dead links on GitHub.
 *
 * Two modes:
 *
 *   node scripts/check-doc-refs.mjs             CHECK (CI). Fails when a tracked doc
 *       - names a repo path that is not a tracked file or folder,
 *       - cites `path:N` with N past the end of the file,
 *       - links (`[text](target)`) to a file that is not tracked.
 *     It does not judge whether line N is still the right line: only the history knows that.
 *
 *   node scripts/check-doc-refs.mjs --reanchor  FIX (by hand, any time). For every `path:N`
 *     (or `path:N-M`) anchor, `git blame` finds the commit that wrote that doc line, reads the
 *     code line N as it was at that commit, and looks for the same text in the file today.
 *     Found once: N (and M, by the same offset) is rewritten. Found several times (a `}`, a
 *     `try {`, a repeated call): the lines around each copy are compared with the lines that
 *     were around it then, and only a copy whose surroundings match better than every other
 *     copy's is taken, and only when at least two of its neighbours still agree, even for a single
 *     copy (a rewritten line can leave its twin elsewhere). Anything less is listed as "ambiguous"
 *     and left alone: picking the nearest copy put about 21 of 31 such anchors on the wrong line on
 *     2026-10-25. Not found: listed as
 *     "gone" for a person to fix. Writes the docs in place; review the diff. Run it on a clean
 *     tree: blame needs the doc lines committed. A doc whose name carries a date
 *     (`UX_AUDIT_2026-09-27.md`) is a snapshot of the code as it was, and is not re-anchored.
 *
 * Paths that live in the Mac render worker's repo (aicourse-captions) are not checked here;
 * WORKER_PREFIXES lists them. A path with a wildcard or a placeholder (`*`, `<`, `{`) is a
 * pattern, not a file, and is skipped.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

/** Paths in the docs that name files in the worker repo (aicourse-captions), not this one. */
export const WORKER_PREFIXES = [
    'scripts/studio/', 'scripts/studio-worker.mjs', 'scripts/install-studio-worker.sh', 'scripts/uninstall-studio-worker.sh',
    'scripts/studio-mock-app.mjs', 'scripts/monteur/', 'scripts/pro/', 'scripts/render-carousels.mjs', 'scripts/render-carousel-reels.mjs',
    'scripts/check-carousels.mts', 'scripts/extract-shots.py', 'scripts/shots-spec.json', 'scripts/render-infographic.mjs',
    'scripts/explainer-tts.mjs', 'scripts/illustrated-stills.mjs', 'scripts/autoreply-vo.mjs', 'scripts/make-music-bed.py',
    'src/promo/', 'src/carousel/', 'src/monteur/', 'src/pro/', 'src/illustrated/', 'src/infographic/', 'src/explainer/',
    'src/autoreply/', 'src/toplist/', 'src/showcase/', 'src/nle/', 'src/Root.tsx',
    'public/sfx/', 'public/mascots/', 'public/shots/', 'public/autoreply/', 'public/studio-shots/', 'public/explainer-render/',
];

const ROOTS = '(?:src|dashboard|scripts|public|heroku-worker|\\.github|docs)';
const EXT = '(?:json|tsx|mts|mjs|ts|js|sql|html|css|yaml|yml|md|sh|py|txt|svg|png|jpg|webmanifest)';
/** `src/a/b.ts`, `src/a/b.ts:12`, `src/a/b.ts:12-18` (also an en dash), and folders `src/jobs/`. */
const PATH_RE = new RegExp(`(?<![\\w/.@-])(${ROOTS}/[\\w./@-]*?(?:\\.${EXT}(?![\\w])|/(?![\\w.@-])))(?::(\\d+)(?:[-–](\\d+))?)?`, 'g');
/** A markdown link with a relative target: `[text](../FLOWS.md)`, `[t](docs/X.md#part)`. */
const LINK_RE = /\[[^\]\n]*\]\(([^)\s]+)\)/g;

const git = (args, opts = {}) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

export function trackedFiles() {
    return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

export function isWorkerPath(p) {
    return WORKER_PREFIXES.some((prefix) => p === prefix || p.startsWith(prefix));
}

/** Every path reference on one doc line: `{ ref, line, lineEnd, index }`. */
export function refsOnLine(text) {
    const out = [];
    for (const m of text.matchAll(PATH_RE)) {
        const ref = m[1];
        // A pattern (`migration_v*.sql`, `routes/<name>.ts`, `{a,b}`) names no single file, even when its prefix parses as one.
        if (/[*<{]/.test(ref) || /[*<{]/.test(text[m.index + m[0].length] ?? '')) continue;
        out.push({ ref, line: m[2] ? Number(m[2]) : null, lineEnd: m[3] ? Number(m[3]) : null, index: m.index, length: m[0].length });
    }
    return out;
}

/** The problems in one doc, given the tracked files. Pure apart from reading the cited files. */
export function checkDoc(doc, text, tracked, readLines) {
    const trackedSet = tracked instanceof Set ? tracked : new Set(tracked);
    const folders = new Set();
    for (const f of trackedSet) for (let d = path.dirname(f); d !== '.'; d = path.dirname(d)) folders.add(d + '/');
    const problems = [];
    const lines = text.split('\n');
    lines.forEach((lineText, i) => {
        const at = `${doc}:${i + 1}`;
        for (const { ref, line } of refsOnLine(lineText)) {
            if (isWorkerPath(ref)) continue;
            if (ref.endsWith('/')) {
                if (!folders.has(ref)) problems.push(`${at}  folder not in the repo: ${ref}`);
                continue;
            }
            if (!trackedSet.has(ref)) {
                problems.push(`${at}  not a tracked file: ${ref}`);
                continue;
            }
            if (line !== null) {
                const count = readLines(ref).length;
                if (line > count) problems.push(`${at}  ${ref}:${line} is past the end of the file (${count} lines)`);
            }
        }
        for (const m of lineText.matchAll(LINK_RE)) {
            const target = m[1].split('#')[0];
            if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
            const resolved = path.normalize(path.join(path.dirname(doc), decodeURI(target))).replace(/\\/g, '/');
            const clean = resolved.replace(/\/$/, '');
            if (trackedSet.has(clean) || folders.has(clean + '/')) continue;
            problems.push(`${at}  link to a file that is not in the repo: ${m[1]}`);
        }
    });
    return problems;
}

/** git blame: doc line number (1-based) → the commit that last wrote it. */
function blameCommits(doc) {
    const out = git(['blame', '--line-porcelain', '--', doc]).split('\n');
    const byLine = new Map();
    let commit = null;
    let finalLine = 0;
    for (const l of out) {
        const head = /^([0-9a-f]{40}) \d+ (\d+)/.exec(l);
        if (head) { commit = head[1]; finalLine = Number(head[2]); continue; }
        if (l.startsWith('\t')) byLine.set(finalLine, commit);
    }
    return byLine;
}

/** How many of the lines around a cited line still agree with the lines that were around it: what tells one copy of a repeated line from another. */
const CONTEXT_LINES = 4;
/** A move needs at least this many agreeing neighbours (of up to 8); below it the anchor is listed for a person instead. */
const MIN_CONTEXT = 2;
function contextScore(then, thenIdx, now, nowIdx) {
    let score = 0;
    for (let k = 1; k <= CONTEXT_LINES; k++) {
        for (const d of [-k, k]) {
            const a = then[thenIdx + d];
            const b = now[nowIdx + d];
            if (a !== undefined && b !== undefined && a.trim() !== '' && a.trim() === b.trim()) score++;
        }
    }
    return score;
}

/** A dated doc (`…_2026-09-27.md`) records the code as it was that day; its anchors are history, not drift. */
export const isSnapshotDoc = (doc) => /\d{4}-\d{2}-\d{2}/.test(path.basename(doc));

/** Rewrites the drifted `path:N` anchors of one doc; returns `{ text, moved, gone, ambiguous }`. */
export function reanchorDoc(doc, text, { commitOfLine, readAt, readNow }) {
    const lines = text.split('\n');
    let moved = 0;
    const gone = [];
    const ambiguous = [];
    const result = lines.map((lineText, i) => {
        const commit = commitOfLine(i + 1);
        if (!commit || /^0+$/.test(commit)) return lineText;
        let out = '';
        let last = 0;
        for (const r of refsOnLine(lineText)) {
            if (r.line === null || isWorkerPath(r.ref)) continue;
            const then = readAt(commit, r.ref);
            const now = readNow(r.ref);
            if (!then || !now || r.line > then.length) continue;
            const target = then[r.line - 1].trim();
            if (target.length < 4) continue;
            const hits = [];
            now.forEach((l, j) => { if (l.trim() === target) hits.push(j + 1); });
            if (hits.length === 0) { gone.push(`${doc}:${i + 1}  ${r.ref}:${r.line}`); continue; }
            // Even a single copy needs company: a line that was rewritten can leave an identical line elsewhere (a second
            // `metaHttp.post(url, {` in another function), and moving to it would be confidently wrong.
            const scored = hits.map((h) => ({ h, score: contextScore(then, r.line - 1, now, h - 1) }));
            const top = Math.max(...scored.map((x) => x.score));
            const winners = scored.filter((x) => x.score === top);
            if (winners.length === 1 && winners[0].h === r.line) continue;
            if (top < MIN_CONTEXT || winners.length !== 1) { ambiguous.push(`${doc}:${i + 1}  ${r.ref}:${r.line}`); continue; }
            const best = winners[0].h;
            const shift = best - r.line;
            const replacement = r.lineEnd !== null ? `${r.ref}:${best}-${r.lineEnd + shift}` : `${r.ref}:${best}`;
            out += lineText.slice(last, r.index) + replacement;
            last = r.index + r.length;
            moved++;
        }
        return out + lineText.slice(last);
    });
    return { text: result.join('\n'), moved, gone, ambiguous };
}

function main() {
    const reanchor = process.argv.includes('--reanchor');
    const tracked = trackedFiles();
    const docs = tracked.filter((f) => f.endsWith('.md'));
    const cache = new Map();
    const readNow = (p) => {
        if (!cache.has(p)) {
            try { cache.set(p, readFileSync(p, 'utf8').split('\n')); } catch { cache.set(p, null); }
        }
        return cache.get(p);
    };

    if (reanchor) {
        const atCache = new Map();
        const readAt = (commit, p) => {
            const key = `${commit}:${p}`;
            if (!atCache.has(key)) {
                try { atCache.set(key, git(['show', key], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n')); } catch { atCache.set(key, null); }
            }
            return atCache.get(key);
        };
        let movedTotal = 0;
        const goneTotal = [];
        const ambiguousTotal = [];
        for (const doc of docs) {
            if (isSnapshotDoc(doc)) continue;
            const text = readFileSync(doc, 'utf8');
            const byLine = blameCommits(doc);
            const { text: next, moved, gone, ambiguous } = reanchorDoc(doc, text, { commitOfLine: (n) => byLine.get(n), readAt, readNow });
            if (moved) writeFileSync(doc, next);
            movedTotal += moved;
            goneTotal.push(...gone);
            ambiguousTotal.push(...ambiguous);
            if (moved || gone.length || ambiguous.length) console.log(`${doc}: ${moved} anchor(s) moved, ${gone.length} gone, ${ambiguous.length} ambiguous`);
        }
        console.log(`\n${movedTotal} anchor(s) moved. ${goneTotal.length} point at code that no longer exists; fix these by hand:`);
        for (const g of goneTotal) console.log(`  ${g}`);
        console.log(`\n${ambiguousTotal.length} could not be told apart from another copy of the same line; check these by hand:`);
        for (const a of ambiguousTotal) console.log(`  ${a}`);
        return;
    }

    const problems = [];
    for (const doc of docs) problems.push(...checkDoc(doc, readFileSync(doc, 'utf8'), tracked, (p) => readNow(p) ?? []));
    if (problems.length) {
        console.error(`✗ ${problems.length} broken reference(s) in the docs:\n`);
        for (const p of problems) console.error(`  ${p}`);
        console.error('\nFix the path, or cite the file it moved to. A file outside this repo (local notes, the worker repo) is named in words, not linked.');
        process.exit(1);
    }
    console.log(`✓ doc references: ${docs.length} tracked docs, every cited path and link resolves`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) main();
