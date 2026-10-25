/**
 * No sales-based figure, anywhere the owner or a client can read (Ads Manager, FR-044).
 *
 * Sales happen on another website (a store, a learning platform). Meta cannot see them and neither can this app, so a "return on ad
 * spend" number would be invented. Nothing the dashboard ships may name one: not the two
 * dictionaries, not the Help Center, not any Ads page.
 *
 * Files are found by glob (every `dashboard/js/pages/ads*.js`), so an Ads page added later is
 * covered without touching this test. Help text that must explain WHY there is no such figure
 * words it without these terms («لا نعرض رقمًا يقارن الإنفاق بالمبيعات» / "we show no figure that
 * compares spend with sales").
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const JS = 'dashboard/js';
const PAGES = join(JS, 'pages');

const FORBIDDEN: Array<{ name: string; pattern: RegExp }> = [
    { name: 'ROAS', pattern: /roas/i },
    { name: 'return on ad spend', pattern: /return[\s-]+on[\s-]+ad[\s-]+spend/i },
    { name: 'العائد على الإنفاق', pattern: /العائد\s+على\s+الإنفاق/ },
    { name: 'العائد على الإعلان', pattern: /العائد\s+على\s+الإعلان/ },
];

/** The files that are read, relative to the repo root. */
function scanned(): string[] {
    const ads = readdirSync(PAGES)
        .filter((f) => /^ads.*\.js$/i.test(f))
        .sort()
        .map((f) => join(PAGES, f));
    return [join(JS, 'i18n.ar.js'), join(JS, 'i18n.en.js'), join(JS, 'help-content.js'), ...ads];
}

/** Every line of every scanned file that names a forbidden term, as `file:line: term`. */
function offences(): string[] {
    const out: string[] = [];
    for (const file of scanned()) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
            for (const { name, pattern } of FORBIDDEN) {
                if (pattern.test(line)) out.push(`${file}:${i + 1}: «${name}» in «${line.trim().slice(0, 100)}»`);
            }
        });
    }
    return out;
}

describe('no sales-based figure (FR-044)', () => {
    it('reads the dictionaries, the Help Center and every ads page', () => {
        const files = scanned();
        for (const needed of ['i18n.ar.js', 'i18n.en.js', 'help-content.js', join('pages', 'ads.js')]) {
            assert.ok(files.some((f) => f.endsWith(needed)), `${needed} is scanned`);
        }
    });

    it('the patterns catch what they are meant to', () => {
        const hits = (s: string): boolean => FORBIDDEN.some(({ pattern }) => pattern.test(s));
        for (const bad of ['ROAS', 'roas 3x', 'Return on ad spend', 'return-on-ad-spend', 'العائد على الإنفاق', 'العائد  على الإعلان']) {
            assert.ok(hits(bad), bad);
        }
        for (const ok of ['cost per conversation', 'لا نعرض رقمًا يقارن الإنفاق بالمبيعات', 'broad', 'Cross-sell']) {
            assert.equal(hits(ok), false, ok);
        }
    });

    it('no file names a return on ad spend, in any wording we forbid', () => {
        const found = offences();
        assert.deepEqual(found, [],
            `${found.length} line(s) name a sales-based figure the app cannot know (sales on another website are invisible to Meta and to us). `
            + 'Say there is no such figure without these words, e.g. “we show no figure that compares spend with sales”:\n' + found.join('\n'));
    });
});
