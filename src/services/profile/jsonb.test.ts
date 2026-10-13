/**
 * `jsonb.ts`: the jsonb trip and the scrambler, moved out of `testSupport.ts` because the backfill's decisions depend on
 * them. Their behaviour is held by the lens-law and golden tests (which still import them through `testSupport.ts`);
 * what is held here is that the move is whole, and that it stays moved.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import * as jsonb from './jsonb.js';
import * as support from './testSupport.js';

const SRC = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Every .ts file under `dir`. */
function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));
}

describe('jsonb.ts', () => {
    it('testSupport re-exports the very same functions, so every test import still works', () => {
        for (const name of ['getAt', 'hasAt', 'setAt', 'scramble', 'jsonbReorder', 'throughJsonb'] as const) {
            assert.equal(typeof jsonb[name], 'function', name);
            assert.equal(support[name], jsonb[name], `${name} is re-exported, not copied`);
        }
    });

    it('no production module imports testSupport or testDb: the backfill and the parity script run from production modules', () => {
        const importers = walk(SRC)
            .filter((f) => !f.endsWith('.test.ts') && !/[\\/]test(Support|Db|Fixtures)\.ts$/.test(f))
            .filter((f) => /from '[^']*\/test(Support|Db)\.js'/.test(readFileSync(f, 'utf8')));
        assert.deepEqual(importers.map((f) => path.relative(SRC, f)), []);
    });

    it('the jsonb trip sorts keys by length and then bytes and keeps array order, and scramble overwrites only what the row has', () => {
        assert.deepEqual(Object.keys(jsonb.throughJsonb({ bb: 1, a: { zz: 1, y: [{ b: 1, aa: 2 }] }, ccc: 3 })), ['a', 'bb', 'ccc']);
        assert.deepEqual(Object.keys((jsonb.throughJsonb({ a: { zz: 1, y: 2 } }) as { a: object }).a), ['y', 'zz']);
        const row = { a: { b: 'x', c: [1] }, n: 5 };
        const out = jsonb.scramble(row, ['a.b', 'a.c', 'n', 'absent.path']);
        assert.deepEqual(out, { a: { b: 'JUNK:a.b', c: ['JUNK:a.c'] }, n: 7 });
        assert.deepEqual(row, { a: { b: 'x', c: [1] }, n: 5 }, 'the input is not changed');
    });
});
