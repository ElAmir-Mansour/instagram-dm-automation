/**
 * Arms that wait for another PR (`optional.ts`): present means the file is there, absent says which file and who it waits for, and a module that is there and breaks is an error and
 * not an absence (so a half-merged module is never reported as one that has not landed).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findModule, loadOptional } from './optional.js';

describe('findModule', () => {
    it('looks for the .ts source first and then .js, under the root', () => {
        assert.equal(findModule('/r', 'src/x', (f) => f === '/r/src/x.ts'), '/r/src/x.ts');
        assert.equal(findModule('/r', 'src/x', (f) => f === '/r/src/x.js'), '/r/src/x.js');
        assert.equal(findModule('/r', 'src/x', () => true), '/r/src/x.ts');
        assert.equal(findModule('/r', 'src/x', () => false), null);
    });
});

describe('loadOptional', () => {
    it('is absent with a note that names the file and the PR it waits for, and imports nothing', async () => {
        let imports = 0;
        const loaded = await loadOptional('/r', 'src/services/perception/voice', 'P3, the voice notes', { exists: () => false, importer: async () => { imports++; return {}; } });
        assert.equal(loaded.present, false);
        assert.match((loaded as { why: string }).why, /src\/services\/perception\/voice\.ts is not in this checkout yet \(P3, the voice notes\)/);
        assert.equal(imports, 0);
    });

    it('is present with the module, imported through a file:// URL of the file that is there', async () => {
        const seen: string[] = [];
        const loaded = await loadOptional<{ hello: string }>('/r', 'src/x', 'P9', { exists: (f) => f.endsWith('.ts'), importer: async (url) => { seen.push(url); return { hello: 'there' }; } });
        assert.ok(loaded.present);
        if (loaded.present) {
            assert.equal(loaded.module.hello, 'there');
            assert.equal(loaded.file, '/r/src/x.ts');
        }
        assert.deepEqual(seen, ['file:///r/src/x.ts']);
    });

    it('throws when the file is there and breaks as it loads: that is a broken module, not one that has not landed', async () => {
        await assert.rejects(loadOptional('/r', 'src/x', 'P9', { exists: () => true, importer: async () => { throw new Error('SyntaxError in x'); } }), /SyntaxError in x/);
    });
});
