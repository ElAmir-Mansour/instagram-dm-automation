/**
 * The register guard (UX plan U5, SA-08): `npm run check:register` is what CI runs; this file tests the guard.
 *
 * Three blocks, in the shape of check-voice.test.mjs: the Help is clean; every dialect rule is caught (and the فصحى words that
 * look like them are not); and ONE planted sentence in the real Help source is a finding that names the section and the line.
 * A mutation that matched nothing passes silently, so each one first asserts its anchor occurs exactly once.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ALLOWED, HELP_FILE, MARKERS, dialectHits, helpArabic, judge, plain, scanHelp } from './check-register.mjs';

const source = readFileSync(HELP_FILE, 'utf8');
const rulesOf = (text) => dialectHits(text).map((h) => h.rule);

/** The Help source with `anchor` (exactly once) swapped for `replacement`. */
function mutate(anchor, replacement) {
    const n = source.split(anchor).length - 1;
    assert.equal(n, 1, `anchor ${JSON.stringify(anchor)} occurs ${n} times, not once; the mutation would be a no-op`);
    const mutated = source.replace(anchor, () => replacement);
    assert.notEqual(mutated, source);
    return mutated;
}

describe('the Arabic Help', () => {
    it('is فصحى: no dialect word, and every allowed use is still used', () => {
        const { findings, stale, pieces } = scanHelp(source);
        assert.deepEqual(findings.map((f) => `${f.file}:${f.line} [${f.rule}] ${f.word} in ${f.where}`), []);
        assert.deepEqual(stale, []);
        assert.ok(pieces.length > 2000, `reads the whole Help, not a sample (${pieces.length} strings)`);
    });

    it('reads the Arabic of every article, section title and group, and none of the English', () => {
        const pieces = helpArabic(source);
        assert.ok(pieces.some((p) => p.where === 'getting-started title'));
        assert.ok(pieces.some((p) => p.where.startsWith('getting-started#what')));
        assert.ok(pieces.some((p) => p.where === 'group start'));
        assert.ok(!pieces.some((p) => /^What it does$/.test(p.text)), 'the English twin is not scanned');
    });

    it('keeps its allow-list empty or justified: each entry names a place, a rule, a sentence and a reason', () => {
        for (const e of ALLOWED) assert.ok(e.where && e.rule && e.text && e.reason, JSON.stringify(e));
    });
});

describe('the dialect words the guard names', () => {
    // [rule, a dialect sentence, the same thing in فصحى]
    const CASES = [
        ['wesh', 'وش يسوّي لك التطبيق؟', 'ماذا يفعل لك التطبيق؟'],
        ['shlon', 'شلون أربط حسابي؟', 'كيف أربط حسابي؟'],
        ['leish', 'ليش ما وصل الرد؟', 'لماذا لم يصل الرد؟'],
        ['wein', 'وين أجد الرمز؟', 'أين أجد الرمز؟'],
        ['zay', 'يظهر زي الصورة', 'يظهر مثل الصورة'],
        ['eshan', 'اضغط عشان تحفظ', 'اضغط كي تحفظ'],
        ['haq', 'هذا الرابط حقك', 'هذا رابطك'],
        ['haq', 'ضع الرابط حق الدورة هنا', 'ضع رابط الدورة هنا'],
        ['want', 'العميل يبغى السعر', 'العميل يريد السعر'],
        ['want', 'اللي يبيله رابط يكتب الكلمة', 'من يريد رابطاً يكتب الكلمة'],
        ['elli', 'الرسالة اللي وصلتك', 'الرسالة التي وصلتك'],
        ['elli', 'ورد باللي كتبته', 'ورد بما كتبته'],
        ['mu', 'هذا مو مجاني', 'هذا ليس مجانياً'],
        ['yemdi', 'ما يمديك تعدّله', 'لا يمكنك تعديله'],
        ['shay', 'ما يوصلك شي', 'لا يصلك شيء'],
        ['bas', 'مرة واحدة بس', 'مرة واحدة فقط'],
        ['kaman', 'ويرد كمان على التعليق', 'ويردّ أيضاً على التعليق'],
        ['dem', 'هذي الخطوة مهمة', 'هذه الخطوة مهمة'],
        ['hal', 'اضغط على هالرسالة', 'اضغط على هذه الرسالة'],
        ['now', 'اضغط الحين', 'اضغط الآن'],
        ['later', 'جرّب بعدين', 'جرّب لاحقاً'],
        ['always', 'يعمل دايما', 'يعمل دائماً'],
        ['do', 'التطبيق يسوّي المطلوب', 'التطبيق يفعل المطلوب'],
        ['see', 'تشوف الحالة هنا', 'ترى الحالة هنا'],
        ['come', 'يجي الرد بعد دقيقة', 'يأتي الرد بعد دقيقة'],
        ['go', 'تروح الملفات إلى R2', 'تذهب الملفات إلى R2'],
        ['will-go', 'راح يوصلك تنبيه', 'سيصلك تنبيه'],
        ['instead', 'بدال الرد القديم', 'بدلاً من الرد القديم'],
        ['front', 'يقع ورا الصفحة', 'يقع وراء الصفحة'],
        ['again', 'اضغط مرة ثانية', 'اضغط مرة أخرى'],
        ['again', 'تُنفّذ مرة وحدة', 'تُنفّذ مرة واحدة'],
        ['we-you', 'حنا نحفظ الرمز', 'نحن نحفظ الرمز'],
        ['ala', 'اضغط ع الزر', 'اضغط على الزر'],
    ];
    for (const [rule, dialect, standard] of CASES) {
        it(`${rule}: caught in «${dialect}», not in «${standard}»`, () => {
            assert.ok(rulesOf(dialect).includes(rule), `${dialect} -> ${JSON.stringify(rulesOf(dialect))}`);
            assert.deepEqual(rulesOf(standard), [], standard);
        });
    }

    it('has a case for every rule except the ones that only widen another (nice, sure, little, much, sleep, dem-eg)', () => {
        const covered = new Set(CASES.map((c) => c[0]));
        const widen = new Set(['nice', 'sure', 'little', 'much', 'sleep', 'dem-eg']);
        assert.deepEqual(MARKERS.map((m) => m.id).filter((id) => !covered.has(id) && !widen.has(id)), []);
    });

    it('catches a word however it is written: diacritics, tatweel, hamza, a clitic in front', () => {
        assert.ok(rulesOf('وَشْ يسوّي').includes('wesh'));
        assert.ok(rulesOf('عـــشان').includes('eshan'));
        assert.ok(rulesOf('إيش هذا').includes('wesh'));
        assert.ok(rulesOf('وعشان').includes('eshan'));
        assert.ok(rulesOf('باللي كتبته').includes('elli'), 'a clitic in front of «اللي»');
    });

    it('does not fire on فصحى words that merely look like a marker', () => {
        for (const ok of [
            'سوى هذا لا يوجد غيره', // «سوى» (except) is not «سوّي»
            'لدي حساب بالفعل', // «لدي» is ل + دي, not «دي»
            'فوراً', // ف + ورا
            'قاعدة واحدة للمال', // «قاعدة» is a rule
            'حق الوصول محفوظ لصاحبه', // «حق» is a right
            'وصف الصورة وراء الشاشة', // «وراء» is not «ورا»
            'المشاركة تأتي مع الملف', // «مع», «تأتي»
            'يستطيع تغيير الذي يريده', // «الذي», «يريده»
            'ماذا فعل وكيف ولماذا وأين', // the فصحى question words
        ]) assert.deepEqual(rulesOf(ok), [], ok);
    });

    it('reads the folding: «اللى» and «اللي» are one word, «سوى» stays apart from «سوي»', () => {
        assert.ok(rulesOf('اللى وصلك').includes('elli'));
        assert.equal(plain('سوى'), 'سوى');
        assert.ok(rulesOf('سوي').includes('do'));
        assert.deepEqual(rulesOf('سوى'), []);
    });
});

describe('the guard catches a planted sentence in the real Help', () => {
    it('names the section, the line and the rule', () => {
        const mutated = mutate('ماذا يفعل لك أوتوريبلاي برو', 'وش يسوّي لك أوتوريبلاي برو');
        const { findings } = scanHelp(mutated);
        assert.ok(findings.length >= 1, 'a finding');
        const f = findings.find((x) => x.rule === 'wesh');
        assert.ok(f, JSON.stringify(findings.map((x) => x.rule)));
        assert.equal(f.where, 'getting-started summary');
        assert.ok(f.line > 0 && mutated.split('\n')[f.line - 1].includes('وش يسوّي'), `line ${f.line} is the planted one`);
    });

    it('does not read the English: the same planted word in an `en:` string is no finding', () => {
        const mutated = mutate("en: 'What AutoReply Pro does for you, and how to set up your account in the first ten minutes.'", "en: 'وش يسوّي لك'");
        assert.deepEqual(scanHelp(mutated).findings, []);
    });
});

describe('the allow-list', () => {
    const planted = { file: HELP_FILE, where: 'x#y', rule: 'wesh', word: 'وش', text: 'قال «وش يسوّي» حرفياً' };
    it('excuses one word in one place with a reason, and nothing else', () => {
        const entry = { where: 'x#y', rule: 'wesh', text: 'وش يسوّي', reason: 'a quoted example' };
        assert.deepEqual(judge([planted], [entry]).findings, []);
        assert.equal(judge([{ ...planted, where: 'z#y' }], [entry]).findings.length, 1, 'another section is still a finding');
        assert.equal(judge([{ ...planted, rule: 'elli', word: 'اللي' }], [entry]).findings.length, 1, 'another rule is still a finding');
    });
    it('goes stale, loudly: an entry that matches nothing is reported', () => {
        const entry = { where: 'x#y', rule: 'wesh', text: 'وش يسوّي', reason: 'a quoted example' };
        assert.deepEqual(judge([], [entry]).stale, [entry]);
    });
});
