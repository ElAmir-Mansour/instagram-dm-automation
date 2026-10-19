/**
 * The names the sidebar uses (UX overhaul US6: T113, T118; audit SH-02).
 *
 * «الحملات» read as an ad campaign, «إعدادات الذكاء الاصطناعي» did not say it was about DMs, and the assistant that answers them had two
 * names. The labels are copy, and copy drifts, so the new ones are pinned in both catalogues, the page title is pinned to the nav label
 * it belongs to (a page's title IS its `nav.<page>` string, `App.title`), and the one name for the assistant is pinned in the places a
 * person reads first: the navigation, every page title and every page subtitle.
 *
 * Loaded through `_harness.ts`, from the real catalogues.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

/** The labels the sidebar and the page titles carry now: [page, Arabic, English]. */
const LABELS: Array<[string, string, string]> = [
    ['overview', 'اليوم', 'Today'],
    ['inbox', 'الرسائل', 'Inbox'],
    ['campaigns', 'الردود التلقائية', 'Keyword replies'],
    ['ai_settings', 'مساعد الرسائل', 'DM assistant'],
    ['studio', 'الاستوديو', 'Studio'],
    ['posts', 'الجدولة', 'Scheduler'],
    ['analytics', 'النتائج', 'Results'],
    ['growth', 'النمو والتسويق', 'Growth'],
    ['settings', 'الإعدادات', 'Settings'],
    ['help', 'المساعدة', 'Help'],
    ['operations', 'التشغيل', 'Operations'],
    ['tenants', 'العملاء', 'Clients'],
    ['users', 'المستخدمون', 'Users'],
    ['jobs', 'طابور المهام', 'Job queue'],
    ['audit', 'سجل التدقيق', 'Audit log'],
    ['erasure', 'حذف بيانات شخص', 'Data erasure'],
];

/** What those pages were called, and must not be called in the navigation any more. */
const RETIRED: Array<[string, string, string]> = [
    ['overview', 'نظرة عامة', 'Overview'],
    ['inbox', 'صندوق الرسائل', 'DM Inbox'],
    ['campaigns', 'الحملات', 'Campaigns'],
    ['ai_settings', 'إعدادات الذكاء الاصطناعي', 'AI Settings'],
    ['posts', 'جدولة المنشورات', 'Posts Scheduler'],
    ['analytics', 'التحليلات', 'Analytics'],
    ['tenants', 'الحسابات', 'Tenants'],
];

const ar = loadDashboard({ lang: 'ar', app: true });
const en = loadDashboard({ lang: 'en', app: true });
const strings = (h: typeof ar, lang: 'ar' | 'en'): Record<string, string> => (h.I18N.strings as Json)[lang];

describe('navigation labels name the job, in both languages (T118, SH-02)', () => {
    it('are the new names, and are the page titles', () => {
        for (const [page, arabic, english] of LABELS) {
            assert.equal(ar.t(`nav.${page}`), arabic, `ar nav.${page}`);
            assert.equal(en.t(`nav.${page}`), english, `en nav.${page}`);
            assert.equal(ar.App.title(page), arabic, `the Arabic title of #/${page} is its nav label`);
            assert.equal(en.App.title(page), english, `the English title of #/${page} is its nav label`);
        }
    });

    it('no longer use the names that misled', () => {
        for (const [page, arabic, english] of RETIRED) {
            assert.notEqual(ar.t(`nav.${page}`), arabic, `ar nav.${page}`);
            assert.notEqual(en.t(`nav.${page}`), english, `en nav.${page}`);
        }
        // The two the audit named: a campaign is an ad, and "AI settings" does not say DMs.
        assert.match(ar.t('nav.ai_settings'), /الرسائل/);
        assert.match(en.t('nav.ai_settings'), /DM/);
    });

    it('has the four group headings, the Administration heading and the sentence a screen reader hears for its dot, in both', () => {
        const wanted: Record<string, [string, string]> = {
            'nav.group.today': ['اليوم', 'Today'],
            'nav.group.replies': ['الردود', 'Replies'],
            'nav.group.content': ['المحتوى', 'Content'],
            'nav.group.results': ['النتائج', 'Results'],
            'nav.group.admin': ['الإدارة', 'Administration'],
            'nav.adminAttention': ['يحتاج انتباهك', 'Needs your attention'],
            'results.tabs.numbers': ['الأرقام', 'Numbers'],
            'results.tabs.log': ['السجل', 'Log'],
        };
        for (const [key, [arabic, english]] of Object.entries(wanted)) {
            assert.equal(ar.t(key), arabic, `ar ${key}`);
            assert.equal(en.t(key), english, `en ${key}`);
        }
    });

    it('keeps every label short enough for a 268px sidebar, and every Arabic one a single plain phrase', () => {
        for (const [page, arabic, english] of LABELS) {
            assert.ok(arabic.length <= 20, `ar nav.${page} «${arabic}» is ${arabic.length} characters`);
            assert.ok(english.length <= 20, `en nav.${page} "${english}" is ${english.length} characters`);
            assert.equal(/[A-Za-z]/.test(arabic), false, `ar nav.${page}: no Latin word inside an Arabic label`);
        }
    });

    it('titles the pages that moved inside another screen as what they still are', () => {
        // Reels and infographics are Studio's tabs and the Log is Results' second view, but each is still a page with its own title.
        for (const page of ['monteur', 'infographics', 'activity']) {
            assert.ok(ar.t(`nav.${page}`) && ar.t(`nav.${page}`) !== `nav.${page}`, `ar nav.${page}`);
            assert.ok(en.t(`nav.${page}`) && en.t(`nav.${page}`) !== `nav.${page}`, `en nav.${page}`);
        }
        assert.equal(en.t('nav.activity'), 'Activity Log');
    });

    it('stops sending people to places by their old names', () => {
        const next = (h: typeof ar): string => h.t('errors.REEL_SCHEDULED.next');
        assert.equal(/Posts Scheduler/.test(next(en)), false);
        assert.equal(/جدولة المنشورات/.test(next(ar)), false);
        assert.match(next(en), /Scheduler/);
        assert.match(next(ar), /الجدولة/);
    });
});

describe('the assistant has one name where a person reads first (T113, SH-02)', () => {
    const keys = (lang: 'ar' | 'en'): string[] => Object.keys(strings(lang === 'ar' ? ar : en, lang))
        .filter((key) => /^nav\./.test(key) || /^page\.[a-z_]+\.subtitle$/.test(key) || key === 'roles.operator.what');

    it('is «المساعد» in Arabic: never «الوكيل», in the navigation, a page title, a page subtitle or the operator’s role', () => {
        const found = keys('ar');
        assert.ok(found.length > 40, `${found.length} keys scanned: the scan is reading the catalogue`);
        const dict = strings(ar, 'ar');
        const offenders = found.filter((key) => /الوكيل|وكيل/.test(String(dict[key])));
        assert.deepEqual(offenders, []);
    });

    it('is "the assistant" in English: never "agent", in the same places', () => {
        const found = keys('en');
        assert.ok(found.length > 40, `${found.length} keys scanned`);
        const dict = strings(en, 'en');
        const offenders = found.filter((key) => /\bagents?\b/i.test(String(dict[key])));
        assert.deepEqual(offenders, []);
    });

    it('says it about the two pages that are about it', () => {
        assert.match(ar.t('page.ai_settings.subtitle'), /المساعد/);
        assert.match(ar.t('page.inbox.subtitle'), /المساعد/);
        assert.match(en.t('page.ai_settings.subtitle'), /assistant/i);
        assert.match(en.t('page.inbox.subtitle'), /assistant/i);
        assert.match(ar.t('roles.operator.what'), /مساعد الرسائل/);
        assert.match(en.t('roles.operator.what'), /DM assistant/);
    });

    it('describes the Results page as what it is now: the replies’ numbers, not "analytics"', () => {
        assert.equal(/analytics|Analytics/.test(en.t('page.analytics.subtitle')), false);
        assert.equal(/التحليلات/.test(ar.t('page.analytics.subtitle')), false);
    });
});
