/**
 * Both stylesheets must close every block they open.
 *
 * On 2026-09-27 a merge of main into feat/ux-wave-2 resolved a conflict between two blocks
 * appended at the end of styles.css, and git had factored their shared closing `}` into the
 * common suffix. One brace was lost: `.unsaved-note::before` stayed open, and the whole
 * Monteur section after it was parsed as nested inside that rule, so it matched nothing and
 * the Monteur screen shipped unstyled. Nothing else checks the CSS parses, since there is no
 * build step, so this is that check.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/** Brace depth over the CSS with comments and string literals removed. */
function unbalanced(css: string): { depth: number; firstNegativeLine: number | null } {
    const stripped = css
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, (m) => m.replace(/[^\n]/g, ' '));
    let depth = 0;
    let line = 1;
    let firstNegativeLine: number | null = null;
    for (const ch of stripped) {
        if (ch === '\n') line++;
        else if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth < 0 && firstNegativeLine === null) firstNegativeLine = line;
        }
    }
    return { depth, firstNegativeLine };
}

describe('stylesheets — every block closes', () => {
    for (const file of ['dashboard/css/styles.css', 'dashboard/css/tokens.css']) {
        it(`${file} opens and closes the same number of blocks`, () => {
            const { depth, firstNegativeLine } = unbalanced(readFileSync(file, 'utf8'));
            assert.equal(firstNegativeLine, null, `${file}: a '}' with nothing open at line ${firstNegativeLine}`);
            assert.equal(depth, 0, `${file}: ${depth} block(s) left open`);
        });
    }

    it('catches the exact damage that shipped: one rule left open', () => {
        assert.equal(unbalanced('.a { color: red;\n\n.b { color: blue; }').depth, 1);
        assert.equal(unbalanced('.a { content: "}"; }').depth, 0, 'a brace inside a string is not a block');
    });
});
