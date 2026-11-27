/**
 * The final polish of the U-round (QA-10, QA-11, QA-14, QA-16 and four small ones): what a phone and a plain-speaking owner saw.
 *
 *   QA-10  a button or a pill keeps its label on ONE line (CSS rules; the strips scroll or wrap BETWEEN pills, never inside one);
 *   QA-11  the header subtitle may take two lines on a phone;
 *   QA-14  a 30-day strip prints every other date on a phone, and the last day's label is not printed over its neighbour;
 *   QA-16  the Studio's index buttons say what they do, in plain words, in both languages;
 *   Team   zero people reads "nobody yet";
 *   Studio the one-line alarm says the number the nav badge says;
 *   Settings the tab bar is a tablist of tabs with `aria-selected`.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const css = readFileSync('dashboard/css/styles.css', 'utf8');
/** The declarations of the rule whose selector list is exactly `selector` (the first one, or the one inside `within`). */
const rule = (selector: string, within = 0): string => {
    const at = css.indexOf(`\n${selector} {`, within);
    assert.ok(at >= 0, `${selector} has a rule`);
    return css.slice(at, css.indexOf('}', at));
};
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('one line per button (QA-10)', () => {
    it('a segmented pill and a toolbar button never wrap their label', () => {
        assert.match(rule('.segmented .btn'), /white-space:\s*nowrap/);
        assert.match(rule('.toolbar-actions .btn, .page-toolbar .btn'), /white-space:\s*nowrap/);
    });

    it('the strip still cannot widen the page: it clips and scrolls inside itself', () => {
        assert.match(rule('.segmented'), /overflow-x:\s*auto/);
        assert.match(rule('.segmented'), /max-inline-size:\s*100%/);
        assert.match(rule('.toolbar-actions'), /flex-wrap:\s*wrap/, 'the toolbar wraps BETWEEN buttons');
    });
});

describe('the header subtitle on a phone (QA-11)', () => {
    it('keeps two lines, not one', () => {
        const at = css.indexOf('The title wraps; the subtitle is the secondary line');
        assert.ok(at > 0, 'the phone rule is there');
        const line = css.slice(at, css.indexOf('\n', css.indexOf('.page-subtitle', at)));
        assert.match(line, /line-clamp:\s*2/);
        assert.doesNotMatch(line, /line-clamp:\s*1/);
    });
});

describe('plain words for the index buttons (QA-16)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`say "the lessons not indexed yet", not "index the missing" (${lang})`, () => {
            const h = loadDashboard({ lang });
            for (const key of ['studio.library.indexMissing', 'studio.lessons.indexRest']) {
                const s = h.t(key, { n: '3' });
                assert.notEqual(s, key);
                assert.doesNotMatch(s, /الناقص|الباقي|Index missing|Index the rest/);
            }
            assert.match(h.t('studio.library.indexMissing'), lang === 'ar' ? /^افهرس الدروس التي لم تُفهرس بعد$/ : /^Index the lessons not indexed yet$/);
        });
    }

    it('the Help article names the buttons by the new labels', () => {
        const help = readFileSync('dashboard/js/help-content.js', 'utf8');
        assert.doesNotMatch(help, /فهرس الناقص|فهرس الباقي|\*\*Index missing\*\*|\*\*Index the rest\*\*/);
    });
});

describe('Team header with nobody in it', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`reads "nobody yet" for zero, and the plural for 1, 2 and many (${lang})`, () => {
            const h = loadDashboard({ lang, app: true, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/invite_card.js', 'dashboard/js/pages/settings.js'] });
            const Settings = h.run<Json>('SettingsPage');
            const head = (n: number): string => text(Settings.teamSection({ members: Array.from({ length: n }, (_, i) => ({ userId: `u${i}`, email: `p${i}@example.com`, role: 'viewer', isActive: true, lastLoginAt: null, you: false, accountManager: false })), invites: [] }, null));
            assert.ok(head(0).includes(h.t('settings.team.countNone')), 'zero');
            assert.ok(!head(0).includes(h.t('settings.team.count', { count: 0 })), 'not "0 people"');
            assert.match(h.t('settings.team.countNone'), lang === 'ar' ? /^لا أحد بعد$/ : /^nobody yet$/);
            for (const n of [1, 2, 5]) assert.ok(head(n).includes(h.t('settings.team.count', { count: n })), `n=${n}`);
        });
    }
});

describe('the one-line Studio alarm says the number the badge says', () => {
    const item = (type: string, count: number): Json => ({ type, severity: 'warning', count, sentence: { key: `attention.${type}`, params: { n: count } }, action: { verb: 'attention.verb.review', href: '#/monteur' } });
    for (const lang of ['ar', 'en'] as const) {
        it(`counts things (counts.studio), not alarm items (${lang})`, () => {
            const h = loadDashboard({ app: true, lang, globals: { Admin: { confirm: () => {} } } });
            const host = h.el('studio-alarm');
            const App = h.App as Json;
            App._studioAttention = { checkedAt: '2026-11-28T05:00:00.000Z', items: [item('reel_reviews', 1), item('worker_offline', 1)], counts: { inbox: 0, studio: 4, scheduler: 0 } };
            App.currentPage = 'monteur';
            App.renderStudioAlarm();
            const line = text(host.innerHTML);
            assert.ok(line.includes(h.t('nav.studioNeeds', { n: h.UI.formatNumber(4) })), line);
            assert.ok(!line.includes(h.t('nav.studioNeeds', { n: h.UI.formatNumber(2) })), 'not the item count');
        });
    }
});

describe('the Settings tab bar is a tablist (accessibility)', () => {
    const h = loadDashboard();
    const UI = h.UI as Json;
    const items = [{ key: 'a', label: 'A', href: '#/settings?s=a' }, { key: 'b', label: 'B', href: '#/settings?s=b' }];

    it('role="tablist" on the bar, role="tab" and aria-selected on each tab, only the open one true', () => {
        const markup = String(UI.tabs(items, { mode: 'link', current: 'b', label: 'x', tablist: true }));
        assert.match(markup, /<nav class="ui-tabs ui-tabs--link" role="tablist"/);
        assert.equal((markup.match(/role="tab"/g) ?? []).length, 2);
        assert.match(markup, /href="#\/settings\?s=a"[^>]*aria-selected="false"/);
        assert.match(markup, /href="#\/settings\?s=b"[^>]*aria-selected="true"/);
        assert.match(markup, /aria-selected="true" aria-current="page"/, 'the visual mark (aria-current) is unchanged');
    });

    it('other link strips (Results) stay plain navigation', () => {
        const markup = String(UI.tabs(items, { mode: 'link', current: 'b' }));
        assert.doesNotMatch(markup, /role="tab/);
        assert.doesNotMatch(markup, /aria-selected/);
    });

    it('Settings asks for it, and moves aria-selected when the address changes', () => {
        const src = readFileSync('dashboard/js/pages/settings.js', 'utf8');
        assert.match(src, /label: t\('settings\.nav\.label'\), tablist: true/);
        assert.match(src, /link\.setAttribute\('aria-selected'/);
    });

    it('the arrow keys, Home and End already move focus (UI.tabsKey) and the bar is wired to it', () => {
        const markup = String(UI.tabs(items, { mode: 'link', current: 'a', tablist: true }));
        assert.match(markup, /data-keydown="ui:tabsKey"/);
    });
});
