/**
 * Every routable page names itself. `App.title(page)` reads `nav.<page>` and `App.subtitle(page)` reads `page.<page>.subtitle`,
 * and a missing key renders the raw key ("nav.ads_tests") in the header, in the tab title and in the browser history: it passes
 * the key-parity guard (`check:i18n`) because nothing names the key statically. So this reads the route table itself.
 *
 * A page added later (the Brand Kit's `brand`, say) is covered the moment its entry is in `App.pages`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const APP = readFileSync('dashboard/js/app.js', 'utf8');

/** Routable entries of `App.pages`: a page module that is not `routable: false` and not an `aliasOf` old address. */
function routablePages(source: string = APP): string[] {
    const start = source.indexOf('    pages: {');
    const end = source.indexOf('ASSET_VERSION', start);
    assert.ok(start > 0 && end > start, 'App.pages not found in app.js');
    const names: string[] = [];
    for (const line of source.slice(start, end).split('\n')) {
        const m = /^ {8}([a-z_0-9]+): \{(.*)\},?\s*$/.exec(line);
        if (!m) continue;
        if (/routable:\s*false/.test(m[2]!) || /aliasOf/.test(m[2]!)) continue;
        names.push(m[1]!);
    }
    return names;
}

function dictionary(file: string, lang: 'en' | 'ar'): Record<string, string> {
    const ctx: Record<string, unknown> = {};
    ctx.globalThis = ctx;
    vm.runInNewContext(readFileSync(file, 'utf8'), ctx);
    return (ctx.I18N_DICT as Record<string, Record<string, string>>)[lang]!;
}

/**
 * Routable pages that legitimately have no title of their own. EMPTY on purpose: every page, detail pages and Help included,
 * draws its header from these two keys. Add a name here only with the reason, never to silence a missing key.
 */
const NO_TITLE_NEEDED: Record<string, string> = {};

describe('page titles', () => {
    const pages = routablePages();
    const en = dictionary('dashboard/js/i18n.en.js', 'en');
    const ar = dictionary('dashboard/js/i18n.ar.js', 'ar');

    it('finds the route table', () => {
        for (const p of ['overview', 'studio', 'ads_tests', 'help', 'tenant_detail']) assert.ok(pages.includes(p), `${p} should be routable`);
        assert.ok(!pages.includes('invite') && !pages.includes('ads_builder'), 'routable:false modules are not pages');
        assert.ok(pages.length > 30, `only ${pages.length} pages found`);
    });

    for (const [lang, dict] of [['en', en], ['ar', ar]] as const) {
        it(`every routable page has nav.<page> and page.<page>.subtitle in ${lang}`, () => {
            const missing: string[] = [];
            for (const p of pages) {
                if (p in NO_TITLE_NEEDED) continue;
                for (const key of [`nav.${p}`, `page.${p}.subtitle`]) {
                    if (typeof dict[key] !== 'string' || !dict[key]!.trim()) missing.push(key);
                }
            }
            assert.deepEqual(missing, [], `missing in ${lang}: ${missing.join(', ')}`);
        });
    }

    it('the allowlist names only real pages', () => {
        for (const p of Object.keys(NO_TITLE_NEEDED)) assert.ok(pages.includes(p), `${p} is not a routable page`);
    });
});
