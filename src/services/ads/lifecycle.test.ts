/** Duplicate (A5): the exact `/copies` params, and that a copy is always PAUSED. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { copyParams } from './lifecycle.js';

describe('copyParams', () => {
    it('is PAUSED and renamed as a copy with the key, deep', () => {
        assert.deepEqual(copyParams('k42', true), {
            deep_copy: true, status_option: 'PAUSED', rename_options: { rename_strategy: 'DEEP_RENAME', rename_suffix: ' · copy AR·k42' },
        });
    });
    it('renames only the top object when shallow, and is still PAUSED', () => {
        const p = copyParams('k1', false) as { deep_copy: boolean; status_option: string; rename_options: { rename_strategy: string } };
        assert.equal(p.deep_copy, false);
        assert.equal(p.status_option, 'PAUSED');
        assert.equal(p.rename_options.rename_strategy, 'ONLY_TOP_LEVEL_RENAME');
    });
});
