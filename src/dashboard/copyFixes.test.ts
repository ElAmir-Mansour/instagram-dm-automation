/**
 * Copy that said something untrue, corrected (UX US1: T057; audit OV-39, PO-21, SE-15, AI-05, AI-03).
 *
 * Each of these strings made a claim the product no longer (or never) kept: Today's subtitle said "this morning" at any hour, Posts
 * said it publishes to two platforms when it publishes to four, Settings said "access tokens" over a page of a dozen cards, the DM
 * route's hint said nothing used it while the sales assistant does, and the sandbox said it tests "live" while it only runs plain
 * replies. The words are checked in BOTH catalogues, because a fix that lands in one language is the other language's lie.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard } from './_harness.js';

function words(lang: 'ar' | 'en') {
    return loadDashboard({ lang }).t;
}

describe('T057: the copy says what is true', () => {
    it('Today\'s subtitle is «ما يحتاجك الآن» / "What needs you now", at any hour', () => {
        assert.match(words('ar')('page.overview.subtitle'), /^ما يحتاجك الآن\.?$/);
        assert.match(words('en')('page.overview.subtitle'), /^What needs you now\.?$/);
        for (const lang of ['ar', 'en'] as const) assert.equal(/morning|الصباح/.test(words(lang)('page.overview.subtitle')), false, lang);
    });

    it('the Posts subtitle and its empty state name all four platforms, in both languages', () => {
        const names = { ar: ['إنستجرام', 'فيسبوك', 'تيك توك', 'يوتيوب'], en: ['Instagram', 'Facebook', 'TikTok', 'YouTube'] };
        for (const lang of ['ar', 'en'] as const) {
            const t = words(lang);
            for (const key of ['page.posts.subtitle', 'posts.emptyQueueBody']) {
                for (const name of names[lang]) assert.ok(t(key).includes(name), `${lang} ${key} names ${name}`);
            }
        }
    });

    it('the Settings subtitle names connections, appearance, notifications and storage', () => {
        const names = { ar: ['الاتصالات', 'المظهر', 'التنبيهات', 'التخزين'], en: ['Connections', 'appearance', 'notifications', 'storage'] };
        for (const lang of ['ar', 'en'] as const) {
            const said = words(lang)('page.settings.subtitle');
            for (const name of names[lang]) assert.ok(said.includes(name), `${lang} names ${name}`);
            assert.equal(/token|رموز الوصول/i.test(said), false, `${lang}: it is no longer "access tokens"`);
        }
    });

    it('the DM route\'s hint says who uses it: the sales assistant, and the engine when it is on AI providers', () => {
        const en = words('en')('ops.ai.purpose.dm.hint');
        assert.match(en, /sales assistant/i);
        assert.match(en, /AI providers/);
        assert.equal(/Nothing uses it/i.test(en), false, 'the old claim is gone');
        const ar = words('ar')('ops.ai.purpose.dm.hint');
        assert.ok(ar.includes('مساعد المبيعات'));
        assert.ok(ar.includes('مزوّدو الذكاء الاصطناعي'));
        assert.equal(ar.includes('لا يستخدمها شيء'), false);
    });

    it('the sandbox says it runs plain replies only, and that the sales assistant is not previewed there', () => {
        assert.match(words('en')('ai.sandboxDesc'), /plain replies only/);
        assert.match(words('en')('ai.sandboxDesc'), /sales assistant is not previewed/);
        assert.ok(words('ar')('ai.sandboxDesc').includes('الردود العادية فقط'));
        assert.ok(words('ar')('ai.sandboxDesc').includes('مساعد المبيعات'));
    });
});
