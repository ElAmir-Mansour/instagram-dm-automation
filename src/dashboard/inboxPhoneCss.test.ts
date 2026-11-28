/**
 * The Inbox's phone block (R1-I15) must actually win. A rule in `@media (max-width: 860px)` loses to a base rule with the same selector that
 * comes LATER in the file (same specificity, later wins): that is how the phone `.chat-meta` padding never applied (live, 28 Nov: 8px 16px instead
 * of 4px 12px), so two chips wrapped and the log stayed under 400px. This test fails whenever a base rule after the block repeats a phone selector.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync('dashboard/css/styles.css', 'utf8');
const MARK = '/* One screen, one conversation (R1-I15)';

function phoneBlock(): { body: string; end: number } {
    const at = css.indexOf(MARK);
    assert.ok(at >= 0, 'the phone block is still marked');
    const open = css.indexOf('@media (max-width: 860px) {', at);
    const end = css.indexOf('\n}\n', open);
    return { body: css.slice(open, end), end };
}

describe('Inbox phone stylesheet (R1-I15)', () => {
    it('no base rule after the phone block repeats one of its selectors', () => {
        const { body, end } = phoneBlock();
        const selectors = [...body.matchAll(/^\s{4}([^@/\s{][^{]*?)\s*\{/gm)].map((m) => m[1]!.trim());
        assert.ok(selectors.length > 5, 'the block has its rules');
        const after = css.slice(end);
        const overridden = selectors.filter((s) => after.split('\n').some((line) => line.startsWith(`${s} {`)));
        assert.deepEqual(overridden, [], `a later base rule wins over these phone rules: ${overridden.join(', ')}`);
    });

    it('the chip row keeps its phone padding and drops the decorative icons', () => {
        const { body } = phoneBlock();
        assert.match(body, /\.inbox-layout \.chat-meta \{ padding: var\(--space-1\) var\(--space-3\); \}/);
        assert.match(body, /\.inbox-layout \.chat-meta \.chip > svg \{ display: none; \}/);
    });
});
