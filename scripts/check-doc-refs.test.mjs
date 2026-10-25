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
import { checkDoc, isWorkerPath, reanchorDoc, refsOnLine } from './check-doc-refs.mjs';

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
    it('leaves the worker repo’s paths alone', () => {
        assert.deepEqual(check('FLOWS.md', 'the worker: `scripts/studio/explainerDraw.mjs:12`'), []);
    });
});

describe('reanchorDoc', () => {
    const then = ['a', 'function run() {', 'b'];
    const now = ['header', 'a', 'x', 'function run() {', 'b'];
    const io = (current) => ({ commitOfLine: () => 'c'.repeat(40), readAt: () => then, readNow: () => current });

    it('moves an anchor to where its line now is, and a range by the same offset', () => {
        const out = reanchorDoc('FLOWS.md', 'see `src/a.ts:2` and `src/a.ts:2-3`', io(now));
        assert.equal(out.text, 'see `src/a.ts:4` and `src/a.ts:4-5`');
        assert.equal(out.moved, 2);
        assert.deepEqual(out.gone, []);
    });
    it('leaves an anchor that still points at its line', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:2`', io(then));
        assert.equal(out.text, '`src/a.ts:2`');
        assert.equal(out.moved, 0);
    });
    it('reports an anchor whose line is gone, and leaves it as it is', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:2`', io(['a', 'b']));
        assert.equal(out.text, '`src/a.ts:2`');
        assert.deepEqual(out.gone, ['FLOWS.md:1  src/a.ts:2']);
    });
    it('does not touch an uncommitted line (blame has no commit for it)', () => {
        const out = reanchorDoc('FLOWS.md', '`src/a.ts:2`', { ...io(now), commitOfLine: () => '0'.repeat(40) });
        assert.equal(out.text, '`src/a.ts:2`');
    });
});
