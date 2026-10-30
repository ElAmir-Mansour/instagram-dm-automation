/**
 * The doc-reference guard: `npm run check:docs` is what CI runs; this file tests the guard's parts.
 *
 * refsOnLine is the parser both modes share. checkDoc is the CI check: each case builds a tiny doc against a fake set of tracked
 * files, so a failure names exactly which rule broke. reanchorDoc is the `--reanchor` fixer: each case gives it the code as it was
 * when the doc line was written and the code as it is now, and checks the anchor it writes. A guard that was never shown to fail
 * has not been shown to work, so every rule below has a case that must produce a finding.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDoc, isSnapshotDoc, isWorkerPath, reanchorDoc, refsOnLine } from './check-doc-refs.mjs';

const tracked = new Set(['src/a.ts', 'src/jobs/runner.ts', 'docs/X_GUIDE.md', 'FLOWS.md']);
const fileLines = { 'src/a.ts': 10, 'src/jobs/runner.ts': 200 };
const readLines = (p) => Array.from({ length: fileLines[p] ?? 0 }, (_, i) => `line ${i + 1}`);
const check = (doc, text) => checkDoc(doc, text, tracked, readLines);

describe('refsOnLine', () => {
    it('reads a file, a line, a range (hyphen and en dash) and a folder', () => {
        const refs = refsOnLine('**`src/jobs/runner.ts:191-194`**, `src/a.ts:3–5`, `src/jobs/` and src/a.ts');
        assert.deepEqual(refs.map((r) => [r.ref, r.line, r.lineEnd]), [
            ['src/jobs/runner.ts', 191, 194], ['src/a.ts', 3, 5], ['src/jobs/', null, null], ['src/a.ts', null, null],
        ]);
    });
    it('does not stop at the first slash of a deeper path', () => {
        assert.deepEqual(refsOnLine('`src/webhook/router.ts:74`').map((r) => [r.ref, r.line]), [['src/webhook/router.ts', 74]]);
    });
    it('skips patterns and placeholders', () => {
        assert.deepEqual(refsOnLine('`src/config/migration_v*.sql`, `src/routes/<name>.ts`, `src/{a,b}.ts`'), []);
    });
    it('reads a bare anchor as the last full path before it on the line, in bold or in code', () => {
        const refs = refsOnLine('see `src/a.ts:3` and (**:7**), then `:9-10`');
        assert.deepEqual(refs.map((r) => [r.ref, r.line, r.lineEnd, r.bare]), [
            ['src/a.ts', 3, null, false], ['src/a.ts', 7, null, true], ['src/a.ts', 9, 10, true],
        ]);
    });
    it('leaves a bare anchor it cannot place: no full path before it, or a file named alone in between', () => {
        assert.deepEqual(refsOnLine('as above (**:32**)'), []);
        assert.deepEqual(refsOnLine('see `src/a.ts:3`, **`ai.ts:5`** (**:7**)').map((r) => r.line), [3]);
    });
    it('knows the worker repo’s paths', () => {
        assert.equal(isWorkerPath('scripts/studio/explainerWrite.mjs'), true);
        assert.equal(isWorkerPath('scripts/migrate.mjs'), false);
    });
});

describe('checkDoc', () => {
    it('passes a doc whose paths, lines and links all resolve', () => {
        assert.deepEqual(check('docs/X_GUIDE.md', 'See `src/a.ts:10`, `src/jobs/`, [flows](../FLOWS.md#5) and https://x.test.'), []);
    });
    it('flags a path that is not a tracked file', () => {
        assert.match(check('FLOWS.md', 'see `src/gone.ts`').join('\n'), /FLOWS\.md:1 {2}not a tracked file: src\/gone\.ts/);
    });
    it('flags a line past the end of the file', () => {
        assert.match(check('FLOWS.md', 'x\n`src/a.ts:11`').join('\n'), /FLOWS\.md:2 {2}src\/a\.ts:11 is past the end of the file \(10 lines\)/);
    });
    it('flags a folder that is not in the repo, and a link to a local-only file', () => {
        const found = check('docs/X_GUIDE.md', 'plan: `docs/specs/001/` and [notes](../CLAUDE.md)').join('\n');
        assert.match(found, /folder not in the repo: docs\/specs\/001\//);
        assert.match(found, /link to a file that is not in the repo: \.\.\/CLAUDE\.md/);
    });
    it('flags a bare anchor past the end of its file', () => {
        assert.match(check('FLOWS.md', '`src/a.ts:3` and (**:11**)').join('\n'), /src\/a\.ts:11 is past the end of the file \(10 lines\)/);
    });
    it('leaves the worker repo’s paths alone', () => {
        assert.deepEqual(check('FLOWS.md', 'the worker: `scripts/studio/explainerDraw.mjs:12`'), []);
    });
});

describe('reanchorDoc', () => {
    // The function moved down two lines (a header and a new line above it); its neighbours moved with it.
    const then = ['a', 'b', 'function run() {', 'c', 'd', 'e'];
    const now = ['header', 'new', 'a', 'b', 'function run() {', 'c', 'd', 'e'];
    const io = (current) => ({ commitOfLine: () => 'c'.repeat(40), readAt: () => then, readNow: () => current });

    it('moves an anchor to where its line now is, and a range by the same offset', () => {
        const out = reanchorDoc('FLOWS.md', 'see `src/a.ts:3` and `src/a.ts:3-4`', io(now));
        assert.equal(out.text, 'see `src/a.ts:5` and `src/a.ts:5-6`');
        assert.equal(out.moved, 2);
        assert.deepEqual(out.gone, []);
    });
    it('leaves an anchor that still points at its line', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:3`', io(then));
        assert.equal(out.text, '`src/a.ts:3`');
        assert.equal(out.moved, 0);
    });
    it('reports an anchor whose line is gone, and leaves it as it is', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:3`', io(['a', 'b']));
        assert.equal(out.text, '`src/a.ts:3`');
        assert.deepEqual(out.gone, ['FLOWS.md:1  src/a.ts:3']);
    });
    it('does not touch an uncommitted line (blame has no commit for it)', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:3`', { ...io(now), commitOfLine: () => '0'.repeat(40) });
        assert.equal(out.text, '`src/a.ts:3`');
    });

    // A repeated line (`try {`, `}`, a call made twice) is where the old rule, "the nearest copy", went wrong: on 2026-10-25
    // about 21 of 31 such anchors landed on the wrong copy. The lines around each copy decide now, and a tie is left alone.
    const at = (then, current) => ({ commitOfLine: () => 'c'.repeat(40), readAt: () => then, readNow: () => current });
    it('picks the copy of a repeated line whose surroundings match, not the nearest one', () => {
        const then = ['a', 'x', 'try {', 'b', 'c'];
        const current = ['try {', 'q', 'p', 'a', 'x', 'try {', 'b', 'c'];
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:3`', at(then, current));
        assert.equal(out.text, '`src/a.ts:6`');
        assert.deepEqual(out.ambiguous, []);
    });
    it('moves an anchor whose line still reads the same when another copy is the one whose surroundings match', () => {
        const then = ['a', 'b', 'try {', 'c', 'd'];
        const current = ['p', 'q', 'try {', 'r', 's', 'a', 'b', 'try {', 'c', 'd'];
        assert.equal(reanchorDoc('FLOWS.md', '`src/a.ts:3`', at(then, current)).text, '`src/a.ts:8`');
    });
    it('reports copies it cannot tell apart, and leaves the anchor as it is', () => {
        const then = ['x', 'try {', 'y'];
        const current = ['x', 'try {', 'y', 'x', 'try {', 'y', 'z'];
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:2`', at(then, current));
        assert.equal(out.text, '`src/a.ts:2`');
        assert.deepEqual(out.ambiguous, ['FLOWS.md:1  src/a.ts:2']);
    });
    it('does not follow a rewritten line to an identical line elsewhere whose surroundings do not match', () => {
        const then = ['function sendPrivate() {', '  return post(url, {', '    recipient,', '  });', '}'];
        const current = ['function sendPrivate() {', '  tries++;', '  return client.post(url, {', '    recipient,', '}', 'function sendPublic() {', '  return post(url, {', '    message,', '}'];
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:2`', at(then, current));
        assert.equal(out.text, '`src/a.ts:2`');
        assert.deepEqual(out.ambiguous, ['FLOWS.md:1  src/a.ts:2']);
    });
    it('moves a bare anchor with its file, keeping its markup', () => {
        const then = ['alpha line', 'beta line', 'function run() {', 'const x = 1;', 'return x;', '}'];
        const current = ['header line', 'new line', ...then];
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:3` (**:4**) and `:3-4`', at(then, current));
        assert.equal(out.text, '`src/a.ts:5` (**:6**) and `:5-6`');
        assert.equal(out.moved, 3);
    });
    it('treats a dated doc as a snapshot', () => {
        assert.equal(isSnapshotDoc('docs/UX_AUDIT_2026-09-27.md'), true);
        assert.equal(isSnapshotDoc('FLOWS.md'), false);
    });
});
