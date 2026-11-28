/**
 * The glossary guard (UX plan U5, WA-2): `npm run check:glossary` is what CI runs; this file tests the guard.
 *
 * Three blocks. The first asserts the repo is clean and that the guard really reads what it says it reads (both dictionaries and the
 * Help, in both languages). The second asserts each retired word is caught in its language, and each right use is not (an ads
 * "campaign", a customer «العميل», an OAuth "client", "Monteur" inside a sentence). The third mutates ONE file at a time IN MEMORY
 * (`withFile` lays an override over the repo) and requires a finding that names the file and the line, that a stale allow-list entry
 * fails, and that the "help pending SA-08" entry is exactly what keeps the old Help green. A guard that was never shown to fail has
 * not been shown to work, and a mutation that matched nothing passes silently, so every mutation first asserts its anchor exists once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ALLOWED, DICT_FILES, HELP_FILE, RULES, cancelClashes, collectCopy, helpEntries, judge, scanPieces, scanRepo, violations } from './check-glossary.mjs';

const real = (p) => readFileSync(p, 'utf8');

/** The repo with one file's text replaced: `anchor` must occur exactly once, and is swapped for `replacement`. */
function withFile(path, anchor, replacement) {
    const src = real(path);
    const n = src.split(anchor).length - 1;
    assert.equal(n, 1, `${path}: anchor ${JSON.stringify(anchor)} occurs ${n} times, not once; the mutation would be a no-op`);
    const mutated = src.replace(anchor, () => replacement);
    assert.notEqual(mutated, src);
    return (p) => (p.endsWith(path) ? mutated : real(p));
}

const ids = (text, lang, where = 'x.y') => violations(text, lang, where).map((v) => v.rule);

describe('the repo', () => {
    it('breaks no rule, and no allow-list entry is stale', () => {
        const { findings, stale } = scanRepo('.');
        assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.where}`), []);
        assert.deepEqual(stale.map((e) => `${e.rule} ${e.key}`), []);
    });

    it('reads both dictionaries and the Help, in both languages', () => {
        const pieces = collectCopy('.');
        const count = (file, lang) => pieces.filter((p) => p.file === file && p.lang === lang).length;
        assert.ok(count(DICT_FILES.en, 'en') > 6000, 'the English dictionary');
        assert.ok(count(DICT_FILES.ar, 'ar') > 6000, 'the Arabic dictionary');
        assert.ok(count(HELP_FILE, 'en') > 1500, 'the English Help');
        assert.ok(count(HELP_FILE, 'ar') > 1500, 'the Arabic Help');
        assert.equal(count(DICT_FILES.en, 'ar') + count(DICT_FILES.ar, 'en'), 0, 'a dictionary is read in its own language only');
    });

    it('has the glossary words where the decision put them', () => {
        const dict = (file) => new Map(collectCopy('.').filter((p) => p.file === file).map((p) => [p.where, p.text]));
        const en = dict(DICT_FILES.en);
        const ar = dict(DICT_FILES.ar);
        assert.equal(en.get('nav.tenants'), 'Workspaces');
        assert.equal(ar.get('nav.tenants'), 'مساحات العمل');
        assert.equal(en.get('nav.campaigns'), 'Keyword replies');
        assert.equal(ar.get('nav.campaigns'), 'الردود التلقائية');
        assert.equal(en.get('nav.ads_campaigns'), 'Ad campaigns', 'ads keep the word campaign');
        assert.equal(ar.get('nav.ads_campaigns'), 'الحملات الإعلانية', 'and «حملة»');
        assert.equal(en.get('nav.monteur'), 'Reels');
        assert.equal(ar.get('nav.monteur'), 'الريلز');
        assert.equal(en.get('nav.activity'), 'Log');
        assert.equal(ar.get('nav.activity'), 'السجل');
        assert.equal(en.get('inbox.needsYou'), 'Needs you');
        assert.equal(ar.get('inbox.needsYou'), 'بحاجة إليك');
        assert.equal(ar.get('status.outcome.actionable'), 'بحاجة إليك', 'the Log outcome');
        assert.equal(ar.get('posts.group.attention'), 'بحاجة إليك', 'the Scheduler group');
        assert.equal(ar.get('meta.status.ok'), 'متصل');
    });
});

describe('what each rule catches', () => {
    const cases = [
        ['tenant', 'en', 'Create your first tenant'],
        ['tenant', 'en', 'Tenants'],
        ['tenant', 'ar', 'حساب المستأجر'],
        ['account-owner', 'en', 'Only the account owner can change this'],
        ['account-owner', 'ar', 'مالك الحساب وحده'],
        ['account-owner', 'ar', 'اطلب من صاحب الحساب'],
        ['client', 'en', 'Every client has a workspace'],
        ['campaign', 'en', 'Create a campaign'],
        ['campaign', 'ar', 'أنشئ حملة'],
        ['campaign', 'ar', 'افتح الحملات'],
        ['campaign', 'ar', 'للحملة'],
        ['agent', 'en', 'Test the AI agent here'],
        ['agent', 'ar', 'اختبار الوكيل'],
        ['agent', 'ar', 'كل الوكلاء يكتبون'],
        ['instagram', 'ar', 'حسابك على إنستغرام'],
        ['instagram', 'ar', 'انستغرام'],
        ['connected', 'ar', 'مربوط'],
        ['connected', 'ar', 'إنستجرام وفيسبوك مربوطان'],
        ['needs-you', 'ar', 'هذا يحتاج إليك'],
        ['needs-you', 'ar', 'تحتاج إليك: 3'],
        ['needs-you', 'ar', 'بانتظارك'],
        ['needs-you', 'ar', 'المحادثات التي احتاجت إليك'],
        ['log-name', 'en', 'Open the Activity Log'],
        ['log-name', 'ar', 'افتح سجل النشاط'],
    ];
    for (const [rule, lang, text] of cases) {
        it(`${rule} (${lang}): ${text}`, () => {
            const where = rule === 'client' && lang === 'ar' ? 'nav.tenants' : 'x.y';
            assert.ok(ids(text, lang, where).includes(rule), `${JSON.stringify(violations(text, lang, where))}`);
        });
    }

    it('catches the Arabic however it is spelled: hamza, diacritics, tatweel', () => {
        assert.ok(ids('مُسْتَأْجِر', 'ar').includes('tenant'));
        assert.ok(ids('يحتاج إِلَيْك', 'ar').includes('needs-you'));
        assert.ok(ids('انـــستغرام', 'ar').includes('instagram'));
    });

    it('keeps the rule set small and every rule explained', () => {
        assert.equal(RULES.length, 10);
        for (const r of RULES) assert.ok(r.use.length > 20, r.id);
    });
});

describe('what each rule lets through', () => {
    it('the glossary words themselves', () => {
        for (const [lang, text] of [
            ['en', 'Workspaces'], ['en', 'Keyword reply'], ['en', 'The assistant answers'], ['en', 'Needs you'], ['en', 'Reels'], ['en', 'Open the log'],
            ['ar', 'مساحة العمل'], ['ar', 'الردود التلقائية'], ['ar', 'المساعد يجيب'], ['ar', 'بحاجة إليك'], ['ar', 'متصل'], ['ar', 'إنستجرام'], ['ar', 'الريلز'], ['ar', 'افتح السجل'],
        ]) assert.deepEqual(violations(text, lang, 'x.y'), [], text);
    });

    it('a campaign in the ads key families', () => {
        assert.deepEqual(violations('Create an ad campaign', 'en', 'ads.camp.title'), []);
        assert.deepEqual(violations('Every active campaign is paused', 'en', 'settings.ads.pauseAll.title'), []);
        assert.deepEqual(violations('الحملات الإعلانية', 'ar', 'nav.ads_campaigns'), []);
        assert.deepEqual(violations('Create an ad campaign', 'en', 'adsCreate.title'), []);
        assert.ok(ids('Create a campaign', 'en', 'campaigns.createTitle').includes('campaign'), 'but not under the keyword replies');
    });

    it('«العميل» for the people who message you: only the keys where it meant a workspace are retired', () => {
        assert.deepEqual(violations('يمكنك الرد عندما يراسلك العميل من جديد', 'ar', 'errors.WHATSAPP_WINDOW_CLOSED.next'), []);
        assert.ok(ids('لكل عميل: هل الإعلانات مفعّلة', 'ar', 'page.admin_ads.subtitle').includes('client'));
        assert.deepEqual(violations('جماهير قوائم العملاء', 'ar', 'tenantLegal.scope.customer_lists'), []);
    });

    it('"Monteur" inside a sentence (only the page and tab names became "Reels")', () => {
        assert.deepEqual(violations('How the Monteur scored this moment', 'en', 'monteur.clip.scoresHint'), []);
        assert.ok(ids('Monteur', 'en', 'nav.monteur').includes('monteur-name'));
        assert.ok(ids('المونتير', 'ar', 'studio.tabs.monteur').includes('monteur-name'));
    });

    it('an English word is never read in an Arabic dictionary value, nor an Arabic one in an English value', () => {
        assert.deepEqual(violations('tenant', 'ar', 'x.y'), []);
        assert.deepEqual(violations('مربوط', 'en', 'x.y'), []);
    });

    it('a {placeholder} named tenant is a parameter, not copy', () => {
        assert.deepEqual(violations('Sign in to add {tenant}', 'en', 'invite.signInToAdd'), []);
    });
});

describe('the allow-list and the mutations', () => {
    it('covers the Help only with reasoned entries, each for one rule in one article, and none for everything', () => {
        const help = ALLOWED.filter((e) => e.file === HELP_FILE);
        assert.ok(help.length > 0 && help.length <= 8, `${help.length} Help entries`);
        for (const e of help) {
            assert.notEqual(e.rule, '*', 'no blanket entry for the Help');
            assert.match(e.key, /^help:[a-z-]+/);
            assert.ok(e.reason && e.reason.length > 20, e.key);
        }
        assert.ok(!help.some((e) => /pending/i.test(e.reason)), 'the "help pending SA-08" entry is gone');
    });

    it('the Help breaks no rule once the reasoned entries are applied, and every entry still covers something', () => {
        const { findings, stale } = scanRepo('.');
        assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.word}`), []);
        assert.deepEqual(stale, []);
    });

    it('a retired word planted in the Help is a finding that names the article', () => {
        const clean = { file: HELP_FILE, line: 1, where: 'help:a#b', lang: 'en', text: 'Open the Log.' };
        assert.deepEqual(judge(scanPieces([clean]), ALLOWED).findings, []);
        for (const [lang, text, rule] of [['en', 'Press New campaign.', 'campaign'], ['ar', 'اضغط حملة جديدة', 'campaign'], ['ar', 'الرابط مربوط', 'connected'], ['en', 'Try the Agent sandbox', 'agent']]) {
            const { findings } = judge(scanPieces([{ ...clean, lang, text }]), ALLOWED);
            assert.deepEqual(findings.map((f) => f.rule), [rule], text);
        }
    });

    it('does not read a link target: [[campaigns#how]] is an id, its label is copy', () => {
        const src = `const HelpContent = { groups: [], articles: [{ slug: 'a', group: 'g', icon: 'x', title: { ar: 'ع', en: 'T' }, summary: { ar: 'م', en: 'S' }, related: [], sections: [{ id: 's', title: { ar: 'ق', en: 'Sec' }, body: { ar: [], en: ['Read [[campaigns#how]] and [[campaigns#matching|how matching works]].'] } }] }] };`;
        const texts = helpEntries(src, 'x.js').map((e) => e.text).filter((t) => t.startsWith('Read'));
        assert.deepEqual(texts, ['Read  and how matching works.']);
        assert.deepEqual(scanPieces(helpEntries(src, 'x.js')), []);
    });

    it('reads Help strings by language and ignores ids, slugs and icons', () => {
        const src = `const HelpContent = { groups: [{ id: 'g', title: { ar: 'مجموعة', en: 'Group' } }], articles: [{ slug: 'tenant-slug', group: 'g', icon: 'tenant', title: { ar: 'عنوان', en: 'Title' }, summary: { ar: 'ملخص', en: 'Summary' }, related: [], sections: [{ id: 'tenant-id', title: { ar: 'قسم', en: 'Section' }, body: { ar: ['نص مربوط'], en: ['A tenant {code}', { ul: ['item'] }] } }] }] };`;
        const entries = helpEntries(src, 'x.js');
        assert.ok(entries.some((e) => e.lang === 'ar' && e.text === 'نص مربوط' && e.where === 'help:tenant-slug#tenant-id'));
        assert.ok(entries.some((e) => e.lang === 'en' && e.text === 'item'));
        const hits = scanPieces(entries).map((f) => [f.lang, f.rule]);
        assert.deepEqual(hits.sort(), [['ar', 'connected'], ['en', 'tenant']], 'slug, id and icon are not scanned');
    });

    it('MUTATION: putting a retired word back in the English dictionary fails with file and line', () => {
        const read = withFile(DICT_FILES.en, "'nav.tenants': 'Workspaces',", "'nav.tenants': 'Tenants',");
        const { findings } = scanRepo('.', read);
        assert.equal(findings.length, 1);
        assert.deepEqual([findings[0].file, findings[0].rule, findings[0].where], [DICT_FILES.en, 'tenant', 'nav.tenants']);
        assert.ok(findings[0].line > 0, 'it names the line');
    });

    it('MUTATION: putting «مربوط» or the other Instagram spelling back in the Arabic dictionary fails', () => {
        const a = scanRepo('.', withFile(DICT_FILES.ar, "'settings.health.connected': 'متصل.',", "'settings.health.connected': 'مربوط.',")).findings;
        assert.deepEqual(a.map((f) => [f.rule, f.where]), [['connected', 'settings.health.connected']]);
        const b = scanRepo('.', withFile(DICT_FILES.ar, "'common.instagram': 'إنستجرام',", "'common.instagram': 'إنستغرام',")).findings;
        assert.deepEqual(b.map((f) => [f.rule, f.where]), [['instagram', 'common.instagram']]);
    });

    it('MUTATION: «بانتظارك» as the status fails, in the Inbox chip', () => {
        const f = scanRepo('.', withFile(DICT_FILES.ar, "'inbox.needsYou': 'بحاجة إليك',", "'inbox.needsYou': 'بانتظارك',")).findings;
        assert.deepEqual(f.map((x) => [x.rule, x.where]), [['needs-you', 'inbox.needsYou']]);
    });

    it('MUTATION: «حملة» for a keyword reply fails, and «حملة» for an ad does not', () => {
        const f = scanRepo('.', withFile(DICT_FILES.ar, "'campaigns.new': 'ردّ تلقائي جديد',", "'campaigns.new': 'حملة جديدة',")).findings;
        assert.deepEqual(f.map((x) => [x.rule, x.where]), [['campaign', 'campaigns.new']]);
        assert.deepEqual(scanRepo('.', withFile(DICT_FILES.ar, "'nav.ads_campaigns': 'الحملات الإعلانية',", "'nav.ads_campaigns': 'حملات إعلانية',")).findings, []);
    });

    it('MUTATION: a stale allow-list entry fails, and the OAuth entry is what excuses the OAuth client', () => {
        const stale = judge([], [...ALLOWED, { file: DICT_FILES.en, rule: 'tenant', key: 'no.such.key', reason: 'x' }]).stale;
        assert.ok(stale.some((e) => e.key === 'no.such.key'));
        const oauth = ALLOWED.find((e) => e.key === 'settings.youtube.');
        assert.ok(oauth, 'the OAuth client entry exists');
        const repoWithout = scanRepo('.', undefined, ALLOWED.filter((e) => e !== oauth)).findings;
        assert.ok(repoWithout.length >= 5 && repoWithout.every((f) => f.where.startsWith('settings.youtube.')), 'and it is what excuses the OAuth client');
    });

    it('MUTATION: a destructive action labelled like Cancel fails, and the shipped labels do not', () => {
        assert.deepEqual(cancelClashes(collectCopy('.')), []);
        for (const [key, was] of [["'studio.workers.revoke': 'أبطِل',", "'studio.workers.revoke': 'ألغِ',"], ["'invites.revoke': 'أبطِل الرابط',", "'invites.revoke': 'ألغِ',"], ["'jobs.cancel': 'أوقِف المهمة',", "'jobs.cancel': 'ألغِ',"]]) {
            const f = scanRepo('.', withFile(DICT_FILES.ar, key, was)).findings;
            assert.deepEqual(f.map((x) => x.rule), ['cancel-clash'], key);
        }
        // a plain "cancel" that IS the way out is not destructive
        assert.deepEqual(cancelClashes([{ file: 'x', line: 1, where: 'common.cancel', lang: 'ar', text: 'ألغِ' }, { file: 'x', line: 2, where: 'foo.cancel', lang: 'ar', text: 'ألغِ' }]), []);
    });
});
