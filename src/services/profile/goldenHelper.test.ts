/**
 * The golden helper's own contract (golden.ts): a net that quietly creates what it should compare
 * against, or reports a mismatch nobody can read, is worse than none.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { checkGoldenFile, goldenJsonText, goldenPath, updating } from './golden.js';

let dir: string;
let previous: string | undefined;
let previousCi: string | undefined;
const stderr = process.stderr.write;
beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'golden-helper-'));
    previous = process.env.UPDATE_GOLDEN;
    previousCi = process.env.CI;
    delete process.env.UPDATE_GOLDEN;
    // These tests run on CI, where CI is set: each decides for itself.
    delete process.env.CI;
    // `golden: wrote …` is for a person regenerating; here it is noise.
    process.stderr.write = (() => true) as typeof process.stderr.write;
});
afterEach(() => {
    process.stderr.write = stderr;
    rmSync(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.UPDATE_GOLDEN;
    else process.env.UPDATE_GOLDEN = previous;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
});

const message = (fn: () => void): string => {
    try { fn(); } catch (err) { return (err as Error).message; }
    return '';
};

describe('checkGoldenFile', () => {
    it('fails on a missing golden and does not create it', () => {
        const file = path.join(dir, 'new.txt');
        const msg = message(() => checkGoldenFile(file, 'anything'));
        assert.match(msg, /golden missing: .*new\.txt/);
        assert.match(msg, /UPDATE_GOLDEN=1/);
        assert.equal(existsSync(file), false, 'a missing file is a failure, never silently created');
    });

    it('passes on the same bytes, and fails on any other, including one trailing newline', () => {
        const file = path.join(dir, 'a.txt');
        writeFileSync(file, 'مرحبا\nسطر');
        checkGoldenFile(file, 'مرحبا\nسطر');
        assert.match(message(() => checkGoldenFile(file, 'مرحبا\nسطر\n')), /golden mismatch/);
        assert.match(message(() => checkGoldenFile(file, 'مرحبا\r\nسطر')), /golden mismatch/);
    });

    it('names the file and the first differing line and column, with the two lines', () => {
        const file = path.join(dir, 'b.txt');
        writeFileSync(file, 'one\ntwo\nthree');
        const msg = message(() => checkGoldenFile(file, 'one\ntwx\nthree'));
        assert.match(msg, /golden mismatch: .*b\.txt/);
        assert.match(msg, /first difference at line 2/);
        assert.match(msg, /@@ line 2, column 3 @@/);
        assert.match(msg, /^- "two"$/m);
        assert.match(msg, /^\+ "twx"$/m);
        assert.doesNotMatch(msg, /line 1,|line 3,/, 'equal lines are not shown');
    });

    it('makes a difference you cannot see (a trailing space) visible', () => {
        const file = path.join(dir, 'c.txt');
        writeFileSync(file, 'same\nend');
        assert.match(message(() => checkGoldenFile(file, 'same \nend')), /^\+ "same "$/m);
    });

    it('shows a length difference too, and caps how many lines it prints', () => {
        const file = path.join(dir, 'd.txt');
        writeFileSync(file, Array.from({ length: 30 }, (_, i) => `row ${i}`).join('\n'));
        const msg = message(() => checkGoldenFile(file, Array.from({ length: 31 }, (_, i) => `ROW ${i}`).join('\n')));
        assert.match(msg, /expected 30 lines .*got 31 lines/);
        assert.equal((msg.match(/^@@ /gm) ?? []).length, 6);
    });

    it('cuts a long line around the first character that differs', () => {
        const file = path.join(dir, 'e.txt');
        const line = 'x'.repeat(400);
        writeFileSync(file, line);
        const msg = message(() => checkGoldenFile(file, `${line.slice(0, 300)}Y${line.slice(301)}`));
        assert.match(msg, /column 301/);
        assert.ok(msg.length < 1200, 'a 400-char line is not printed twice in full');
        assert.match(msg, /…/);
    });

    it('refuses anything that is not text', () => {
        assert.match(message(() => checkGoldenFile(path.join(dir, 'f.txt'), undefined)), /not text/);
    });
});

describe('UPDATE_GOLDEN=1', () => {
    it('writes a new golden, rewrites a changed one, and then the comparison passes', () => {
        const fresh = path.join(dir, 'sub', 'g.txt');
        const stale = path.join(dir, 'stale.txt');
        writeFileSync(stale, 'first');
        process.env.UPDATE_GOLDEN = '1';
        checkGoldenFile(fresh, 'first');
        assert.equal(readFileSync(fresh, 'utf8'), 'first');
        checkGoldenFile(stale, 'second');
        assert.equal(readFileSync(stale, 'utf8'), 'second');
        delete process.env.UPDATE_GOLDEN;
        checkGoldenFile(stale, 'second');
        assert.match(message(() => checkGoldenFile(stale, 'first')), /golden mismatch/);
    });

    it('refuses to write one golden twice in a run with different bytes, and keeps the first', () => {
        // Path (a) and path (b) of a builder share a golden. Under UPDATE_GOLDEN=1 the later one would overwrite
        // the earlier and the files would come from whichever ran last: a disagreement must stop the run.
        const file = path.join(dir, 'twice.txt');
        process.env.UPDATE_GOLDEN = '1';
        checkGoldenFile(file, 'from path a');
        assert.match(message(() => checkGoldenFile(file, 'from path b')), /would be written twice in one run, with different bytes/);
        assert.equal(readFileSync(file, 'utf8'), 'from path a', 'the second write did not happen');
        // The same bytes again is the normal case (both paths agree) and is fine, however many times.
        checkGoldenFile(file, 'from path a');
        checkGoldenFile(file, 'from path a');
        assert.equal(readFileSync(file, 'utf8'), 'from path a');
    });

    it('also stops when the first write changed nothing, because the file already held those bytes', () => {
        const file = path.join(dir, 'already.txt');
        writeFileSync(file, 'same');
        process.env.UPDATE_GOLDEN = '1';
        checkGoldenFile(file, 'same');
        assert.match(message(() => checkGoldenFile(file, 'different')), /would be written twice/);
        assert.equal(readFileSync(file, 'utf8'), 'same');
    });

    it('does not touch the comparison when UPDATE_GOLDEN is not set: two different texts against one golden is just a mismatch', () => {
        const file = path.join(dir, 'plain.txt');
        writeFileSync(file, 'one');
        checkGoldenFile(file, 'one');
        assert.match(message(() => checkGoldenFile(file, 'two')), /golden mismatch/);
        assert.doesNotMatch(message(() => checkGoldenFile(file, 'two')), /written twice/);
    });

    it('is only the exact string "1", so a stray UPDATE_GOLDEN=0 or "true" cannot rewrite the net', () => {
        const file = path.join(dir, 'h.txt');
        writeFileSync(file, 'kept');
        for (const v of ['0', 'true', '']) {
            process.env.UPDATE_GOLDEN = v;
            assert.match(message(() => checkGoldenFile(file, 'changed')), /golden mismatch/, `UPDATE_GOLDEN=${JSON.stringify(v)}`);
        }
        assert.equal(readFileSync(file, 'utf8'), 'kept');
    });
});

describe('UPDATE_GOLDEN=1 on CI', () => {
    it('is an error that writes nothing, so a pipeline can never pass by rewriting the net', () => {
        const fresh = path.join(dir, 'ci-new.txt');
        const stale = path.join(dir, 'ci-stale.txt');
        writeFileSync(stale, 'kept');
        process.env.UPDATE_GOLDEN = '1';
        for (const ci of ['true', '1', 'yes']) {
            process.env.CI = ci;
            assert.match(message(() => checkGoldenFile(fresh, 'new')), /UPDATE_GOLDEN=1 with CI set/, `CI=${ci}`);
            assert.match(message(() => checkGoldenFile(stale, 'changed')), /UPDATE_GOLDEN=1 with CI set/, `CI=${ci}`);
            assert.throws(() => updating(), /never rewritten on CI/);
        }
        assert.equal(existsSync(fresh), false);
        assert.equal(readFileSync(stale, 'utf8'), 'kept');
    });

    it('still compares normally on CI when UPDATE_GOLDEN is not set, and CI=false or 0 means not CI', () => {
        const file = path.join(dir, 'ci-ok.txt');
        writeFileSync(file, 'same');
        process.env.CI = 'true';
        checkGoldenFile(file, 'same');
        assert.match(message(() => checkGoldenFile(file, 'other')), /golden mismatch/);
        process.env.UPDATE_GOLDEN = '1';
        for (const ci of ['false', 'FALSE', '0', '']) {
            process.env.CI = ci;
            assert.equal(updating(), true, `CI=${JSON.stringify(ci)}`);
        }
    });
});

describe('goldenJsonText and goldenPath', () => {
    it('writes two-space JSON with a newline, keys in the object\'s own order, and non-ASCII as it is', () => {
        const text = goldenJsonText({ z: 1, a: { y: 'مرحبا', b: [1, 2] } });
        assert.equal(text, '{\n  "z": 1,\n  "a": {\n    "y": "مرحبا",\n    "b": [\n      1,\n      2\n    ]\n  }\n}\n');
        assert.throws(() => goldenJsonText(undefined), /no JSON form/);
    });

    it('builds a path from a plain name only, per set', () => {
        assert.match(goldenPath('dm.system-instruction', 'txt'), /__golden__\/elamir\/dm\.system-instruction\.txt$/);
        assert.match(goldenPath('studio.system.english', 'txt', 'control'), /__golden__\/control-english\/studio\.system\.english\.txt$/);
        for (const bad of ['../x', 'a/b', 'A.b', '', 'x.', '.x', 'a b']) assert.throws(() => goldenPath(bad, 'txt'), /not a valid name/, bad);
    });
});
