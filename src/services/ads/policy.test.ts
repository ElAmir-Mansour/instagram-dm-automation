/**
 * The ads policy check is the gate between the owner's draft and Meta's review queue: a false
 * negative is a rejected ad (or a restricted ad account), a false positive is a tool that cries
 * wolf and gets ignored. So the tests pin three things — what is blocked and why, what is NOT
 * blocked (the compliant copy a course ad should be written in), and that dressing a phrase up
 * (tatweel, alef forms, diacritics, Arabic-Indic digits, zero-width characters) cannot get it past
 * the check — plus the contract the UI relies on: every finding's span points at the words the
 * person typed, in the ORIGINAL text.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    checkPolicy, POLICY_RULES, POLICY_VERSION,
    type PolicyFinding, type PolicyRuleId, type PolicySeverity,
} from './policy.js';

/** Findings for one text in a field called `f`. */
function check(text: string, field = 'f'): PolicyFinding[] {
    return checkPolicy({ [field]: text }).findings;
}

function ids(text: string): PolicyRuleId[] {
    return check(text).map(f => f.ruleId);
}

/** The one finding of `rule` in `text` — fails (with what was found) when there is none or several. */
function one(text: string, rule: PolicyRuleId): PolicyFinding {
    const hits = check(text).filter(f => f.ruleId === rule);
    assert.equal(hits.length, 1, `${JSON.stringify(text)}: expected exactly one ${rule}, got ${JSON.stringify(check(text).map(f => [f.ruleId, f.match]))}`);
    return hits[0]!;
}

describe('checkPolicy — what is blocked', () => {
    const BLOCKS: Array<[string, PolicyRuleId]> = [
        // income_figure
        ['اكسب 500$ يومياً', 'income_figure'],
        ['اربح ١٠٠٠ دولار شهريا', 'income_figure'],
        ['earn $500 a day', 'income_figure'],
        ['make $10k/month', 'income_figure'],
        ['احصل على 200 دولار في اليوم', 'income_figure'],
        ['اربح حتى 5000 ريال', 'income_figure'],
        ['اربح الف دولار', 'income_figure'],
        // passive_income
        ['دخل سلبي', 'passive_income'],
        ['حقق الدخل السلبي', 'passive_income'],
        ['دخل إضافي ثابت', 'passive_income'],
        ['الحرية المالية', 'passive_income'],
        ['build passive income', 'passive_income'],
        ['reach financial freedom', 'passive_income'],
        // get_rich
        ['ثراء سريع', 'get_rich'],
        ['الربح السريع', 'get_rich'],
        ['اصبح مليونيرا', 'get_rich'],
        ['أصبح مليونيراً', 'get_rich'],
        ['get rich', 'get_rich'],
        ['a get-rich-quick plan', 'get_rich'],
        ['become a millionaire', 'get_rich'],
        // no_effort
        ['بدون مجهود', 'no_effort'],
        ['بلا مجهود', 'no_effort'],
        ['اربح وأنت نائم', 'no_effort'],
        ['no effort needed', 'no_effort'],
        ['results without effort', 'no_effort'],
        ['make money while you sleep', 'no_effort'],
        ['easy money', 'no_effort'],
        // quit_job
        ['اترك وظيفتك', 'quit_job'],
        ['استقل من وظيفتك', 'quit_job'],
        ['بديل لراتبك', 'quit_job'],
        ['quit your job', 'quit_job'],
        ['replace your salary', 'quit_job'],
        ['fire your boss', 'quit_job'],
        // guaranteed
        ['مضمون 100%', 'guaranteed'],
        ['نتائج مضمونة', 'guaranteed'],
        ['ربح مضمون', 'guaranteed'],
        ['guaranteed results', 'guaranteed'],
        ['100% guaranteed', 'guaranteed'],
        ['risk-free', 'guaranteed'],
        ['Risk free', 'guaranteed'],
        // job_promise
        ['احصل على وظيفة', 'job_promise'],
        ['وظيفة مضمونة', 'job_promise'],
        ['توظيف مضمون', 'job_promise'],
        ['get hired', 'job_promise'],
        ['land a job', 'job_promise'],
        ['guaranteed job', 'job_promise'],
        // personal_attribute
        ['هل أنت عاطل عن العمل؟', 'personal_attribute'],
        ['هل أنت مديون؟', 'personal_attribute'],
        ['هل تعاني من الاكتئاب؟', 'personal_attribute'],
        ['are you in debt?', 'personal_attribute'],
        ['Are you unemployed?', 'personal_attribute'],
        ['Are you 35 years old?', 'personal_attribute'],
        ['do you suffer from anxiety', 'personal_attribute'],
        ['ديونك تثقل كاهلك', 'personal_attribute'],
        ['تخلص من بطالتك', 'personal_attribute'],
        ['clear your debt', 'personal_attribute'],
    ];

    for (const [text, rule] of BLOCKS) {
        it(`${JSON.stringify(text)} -> ${rule} (block)`, () => {
            const f = one(text, rule);
            assert.equal(f.severity, 'block');
            assert.equal(checkPolicy({ f: text }).blocked, true);
        });
    }
});

describe('checkPolicy — warnings', () => {
    it('«شهادة معتمدة» warns (it can turn the ad into an employment ad)', () => {
        const f = one('احصل على شهادة معتمدة', 'certificate');
        assert.equal(f.severity, 'warn');
        assert.equal(f.match, 'شهادة معتمدة');
        assert.equal(checkPolicy({ f: 'شهادة معتمدة' }).blocked, false, 'a warning alone does not block');
        assert.equal(one('شهادة معترف بها', 'certificate').severity, 'warn');
        assert.equal(one('Get certified today', 'certificate').severity, 'warn');
    });

    it('"limited time" with no date warns', () => {
        assert.equal(one('Enrol now, limited time only', 'limited_time').severity, 'warn');
        assert.equal(one('limited offer', 'limited_time').severity, 'warn');
        assert.equal(one('عرض لفترة محدودة', 'limited_time').severity, 'warn');
        assert.equal(one('سجّل لمدة محدودة', 'limited_time').severity, 'warn');
        assert.equal(one('عرض محدود', 'limited_time').severity, 'warn');
    });

    it('"limited time" is NOT a warning when a date is in the same field', () => {
        assert.deepEqual(ids('limited time, until 30 October'), []);
        assert.deepEqual(ids('لفترة محدودة حتى 30 أكتوبر'), []);
        assert.deepEqual(ids('Limited offer — ends 2026-10-30'), []);
        assert.deepEqual(ids('Limited time: offer valid until 30/10'), []);
        assert.deepEqual(ids('عرض محدود حتى ٣٠ أكتوبر'), []);
        assert.deepEqual(ids('عرض لفترة محدودة حتى الجمعة'), []);
    });

    it('a date in ANOTHER field does not excuse it', () => {
        const r = checkPolicy({ headline: 'لفترة محدودة', primaryText: 'حتى 30 أكتوبر' });
        assert.deepEqual(r.findings.map(f => [f.field, f.ruleId]), [['headline', 'limited_time']]);
    });

    it('a percentage is not a date', () => {
        assert.equal(one('خصم 20% لفترة محدودة', 'limited_time').severity, 'warn');
    });
});

describe('checkPolicy — compliant copy passes', () => {
    const PASSES = [
        'تعلّم بناء وكلاء الذكاء الاصطناعي خطوة بخطوة',
        'دورة عملية في Go للمبتدئين',
        'ابدأ رحلتك في البرمجة اليوم',
        'Learn to build AI agents step by step',
        'احصل على خصم 20% حتى 30 أكتوبر',
        'سجّل الآن',
        'مرحبًا! كيف يمكننا مساعدتك؟',
        'Hi! How can we help?',
        'ما الذي ستتعلمه في الدورة؟',
        'مشاريع عملية تبني بها محفظة أعمالك',
        'Build real projects and ship them',
        'السعر 50 دولار للدورة كاملة',
        'Pay $50 a month for the course',
        'اشترك بسعر 30 دولار شهريا',
    ];
    for (const text of PASSES) {
        it(`no findings: ${JSON.stringify(text)}`, () => {
            assert.deepEqual(check(text), []);
            const r = checkPolicy({ f: text });
            assert.equal(r.blocked, false);
        });
    }

    it('empty, null and undefined fields produce nothing', () => {
        const r = checkPolicy({ a: '', b: null, c: undefined, d: '   ' });
        assert.deepEqual(r, { version: POLICY_VERSION, blocked: false, findings: [] });
        assert.deepEqual(checkPolicy({}), { version: POLICY_VERSION, blocked: false, findings: [] });
    });
});

describe('checkPolicy — false positives that must not happen', () => {
    it('a discount is not income', () => {
        assert.deepEqual(ids('خصم 20%'), []);
        assert.deepEqual(ids('Save 20% today'), []);
        assert.deepEqual(ids('خصم 500 جنيه على الدورة'), []);
    });

    it('«الدخل إلى الدورة» is not «دخل سلبي»', () => {
        assert.deepEqual(ids('الدخل إلى الدورة'), []);
        assert.deepEqual(ids('دخل إلى الدورة سلبي'), []);
        assert.deepEqual(ids('دخلت الدورة'), []);
    });

    it('«مضمون الدورة» (the content of the course) is not a guarantee', () => {
        assert.deepEqual(ids('مضمون الدورة'), []);
        assert.deepEqual(ids('ما هو مضمون الدرس؟'), []);
    });

    it('English words are matched on word boundaries', () => {
        assert.deepEqual(ids('unguaranteed'), []);
        assert.deepEqual(ids('This is not unguaranteed'), []);
        assert.deepEqual(ids('a nonguaranteed thing'), []);
        assert.deepEqual(ids('the poor-performing query'), [], 'no "you" in front of the attribute word');
        assert.deepEqual(ids('software you in debt'), [], 'the trigger needs its own boundary too: "are you" inside a word');
        assert.equal(one('guaranteed', 'guaranteed').match, 'guaranteed');
    });

    it('Arabic words are matched on Arabic boundaries (JS \\b does not work for Arabic)', () => {
        assert.deepEqual(ids('أمضمونة'), []);
        assert.deepEqual(ids('مدخل سلبي'), [], '«مدخل» is not «دخل»');
        assert.deepEqual(ids('ابدون مجهود'), [], 'a longer word is not the phrase');
    });

    it('a price is not an earning', () => {
        assert.deepEqual(ids('بسعر 50 دولار شهريا'), []);
        assert.deepEqual(ids('only $50 per month'), []);
    });

    it('an attribute word without "you" is not addressing the person', () => {
        assert.deepEqual(ids('تعلم كيف تدير ميزانية الدين العام'), []);
        assert.deepEqual(ids('Our course on debt markets'), []);
    });
});

describe('checkPolicy — normalisation cannot be used to bypass it', () => {
    const BYPASSES: Array<[string, PolicyRuleId, string]> = [
        ['tatweel', 'income_figure', 'اكـــسب 500$ يوميـاً'],
        ['alef with hamza below', 'job_promise', 'إحصل على وظيفة'],
        ['alef with hamza above', 'job_promise', 'أحصل على وظيفة'],
        ['alef with madda', 'get_rich', 'آصبح مليونيرا'],
        ['diacritics', 'no_effort', 'بِدُونِ مَجْهُود'],
        ['Arabic-Indic digits', 'income_figure', 'اكسب ٥٠٠ دولار يوميا'],
        ['Persian digits', 'income_figure', 'اكسب ۵۰۰ دولار يوميا'],
        ['zero-width space inside a word', 'no_effort', 'بدو\u200Bن مجهود'],
        ['zero-width joiner and non-joiner', 'no_effort', 'بد\u200Dو\u200Cن مج\u200Bهود'],
        ['bidi marks', 'passive_income', '\u202Bدخل\u202C \u200Fسلبي'],
        ['byte order mark between words', 'passive_income', 'دخل\uFEFF سلبي'],
        ['mixed case', 'income_figure', 'EARN $500 A DAY'],
        ['mixed case phrase', 'passive_income', 'Passive Income'],
        ['ta marbuta spelled with heh', 'job_promise', 'احصل على وظيفه'],
        ['alef maksura spelled with yeh', 'job_promise', 'احصل علي وظيفة'],
        ['extra spaces and newlines', 'quit_job', 'quit\n\n  your    job'],
        ['non-breaking space', 'quit_job', 'quit\u00A0your\u00A0job'],
        ['Arabic percent sign', 'guaranteed', 'مضمون 100٪'],
        ['Farsi yeh and kaf', 'income_figure', 'اكسب 500$ یومیا'],
    ];

    for (const [name, rule, text] of BYPASSES) {
        it(`${name}: ${rule}`, () => {
            const f = one(text, rule);
            assert.equal(f.severity, 'block');
            assert.equal(text.slice(f.start, f.end), f.match);
        });
    }

    it('the finding covers the whole disguised phrase in the original text', () => {
        const tatweel = 'اكـــسب 500$ يوميـاً';
        const f = one(tatweel, 'income_figure');
        assert.equal(f.match, tatweel, 'including the tatweel inside the word and the tanween after it');
        const zw = 'بدو\u200Bن مجهود';
        assert.equal(one(zw, 'no_effort').match, zw);
        const dia = 'بِدُونِ مَجْهُود';
        assert.equal(one(dia, 'no_effort').match, dia);
    });
});

describe('checkPolicy — spans point into the ORIGINAL text', () => {
    it('start/end/match are consistent and cover the offending words', () => {
        const text = 'تعلّم Go معنا. اكسب 500$ يومياً الآن! وسجّل';
        const f = one(text, 'income_figure');
        assert.equal(f.match, 'اكسب 500$ يومياً');
        assert.equal(text.slice(f.start, f.end), f.match);
        assert.equal(f.start, text.indexOf('اكسب'));
    });

    it('spans survive text before the match that normalisation changes (tatweel, diacritics, spaces)', () => {
        const text = '  مَرْحَبـاً   بكم   \n  «مضمون 100%»  ';
        const f = one(text, 'guaranteed');
        assert.equal(f.match, 'مضمون 100%');
        assert.equal(text.slice(f.start, f.end), 'مضمون 100%');
    });

    it('spans work for text with astral characters and lower-case changes before the match', () => {
        const text = '😀 İSTANBUL 😀 Passive Income!';
        const f = one(text, 'passive_income');
        assert.equal(f.match, 'Passive Income');
        assert.equal(text.slice(f.start, f.end), f.match);
    });

    it('the span of a personal attribute covers «هل أنت» through the attribute', () => {
        const text = 'مرحبا. هل أنت عاطل عن العمل؟ تعلّم Go';
        const f = one(text, 'personal_attribute');
        assert.equal(f.match, 'هل أنت عاطل');
        assert.equal(text.slice(f.start, f.end), f.match);
    });

    it('a possessive attribute covers the word', () => {
        const f = one('ديونك تثقل كاهلك', 'personal_attribute');
        assert.equal(f.match, 'ديونك');
        assert.equal(f.start, 0);
        assert.equal(f.end, 5);
        assert.equal(one('your debt is growing', 'personal_attribute').match, 'your debt');
    });

    it('every finding of every sample has a coherent span', () => {
        const texts: Array<[string, number]> = [
            ['اكسب 500$ يومياً بدون مجهود ودخل سلبي', 3],
            ['EARN $500 A DAY. Quit your job! Guaranteed.', 3],
            ['هل أنت مديون؟ احصل على وظيفة. شهادة معتمدة. لفترة محدودة', 4],
            ['\u0640\u200B \u0640اك\u0640س\u0640ب\u200B ٥٠٠ دولار يوميـاً \u0640', 1],
        ];
        for (const [text, count] of texts) {
            const found = check(text);
            assert.equal(found.length, count, `${JSON.stringify(text)}: ${JSON.stringify(found.map(f => [f.ruleId, f.match]))}`);
            for (const f of found) {
                assert.ok(f.start >= 0 && f.end > f.start && f.end <= text.length, `${f.ruleId}: ${f.start}-${f.end}`);
                assert.equal(text.slice(f.start, f.end), f.match);
            }
        }
    });
});

describe('checkPolicy — every finding is explainable', () => {
    it('carries ruleId, severity, field, a bilingual explain and a bilingual rewrite', () => {
        const text = 'اكسب 500$ يومياً — دخل سلبي — بدون مجهود — اترك وظيفتك — مضمون 100% — احصل على وظيفة — ثراء سريع — '
            + 'هل أنت مديون؟ — هل أنت مبرمج؟ — شهادة معتمدة — لفترة محدودة';
        const result = checkPolicy({ 'iceBreakers.0.title': text });
        assert.deepEqual(
            [...new Set(result.findings.map(f => f.ruleId))].sort(),
            ['certificate', 'get_rich', 'guaranteed', 'income_figure', 'job_promise', 'limited_time', 'no_effort', 'passive_income', 'personal_attribute', 'quit_job', 'you_question'].sort(),
            'every rule fired once in this one text',
        );
        for (const f of result.findings) {
            assert.equal(f.field, 'iceBreakers.0.title');
            assert.ok(f.severity === 'block' || f.severity === 'warn');
            for (const side of [f.explain, f.rewrite]) {
                assert.ok(side.ar.trim().length > 10, `${f.ruleId} Arabic text`);
                assert.ok(side.en.trim().length > 10, `${f.ruleId} English text`);
                assert.match(side.ar, /\p{Script=Arabic}/u, `${f.ruleId} Arabic text is Arabic`);
                assert.doesNotMatch(side.en, /\p{Script=Arabic}/u, `${f.ruleId} English text is English`);
            }
        }
    });

    it('POLICY_RULES lists every rule with the same severity, explain and rewrite the findings carry', () => {
        const all: PolicyRuleId[] = [
            'income_figure', 'passive_income', 'get_rich', 'no_effort', 'quit_job', 'guaranteed', 'job_promise',
            'personal_attribute', 'you_question', 'certificate', 'limited_time',
        ];
        assert.deepEqual(POLICY_RULES.map(r => r.id).sort(), [...all].sort());
        const severity = (id: PolicyRuleId): PolicySeverity => POLICY_RULES.find(r => r.id === id)!.severity;
        for (const id of all) {
            const expected: PolicySeverity = id === 'you_question' || id === 'certificate' || id === 'limited_time' ? 'warn' : 'block';
            assert.equal(severity(id), expected, id);
        }
        const f = one('اكسب 500$ يومياً', 'income_figure');
        const rule = POLICY_RULES.find(r => r.id === 'income_figure')!;
        assert.deepEqual(f.explain, rule.explain);
        assert.deepEqual(f.rewrite, rule.rewrite);
    });

    it('explain and rewrite teach selling the skill, not the money', () => {
        const rule = POLICY_RULES.find(r => r.id === 'income_figure')!;
        assert.match(rule.rewrite.en, /step by step/i);
        assert.match(rule.rewrite.ar, /خطوة بخطوة/);
    });

    it('exports a version number', () => {
        assert.equal(POLICY_VERSION, 1);
        assert.equal(checkPolicy({ f: 'x' }).version, POLICY_VERSION);
    });
});

describe('checkPolicy — several fields', () => {
    it('findings carry the field they came from, in field order', () => {
        const r = checkPolicy({
            primaryText: 'تعلّم Go خطوة بخطوة',
            headline: 'اكسب 500$ يومياً',
            greeting: 'مرحبًا! كيف يمكننا مساعدتك؟',
            'iceBreakers.0.title': 'بدون مجهود',
            'iceBreakers.1.title': null,
            caption: 'Passive income',
        });
        assert.deepEqual(r.findings.map(f => [f.field, f.ruleId]), [
            ['headline', 'income_figure'],
            ['iceBreakers.0.title', 'no_effort'],
            ['caption', 'passive_income'],
        ]);
        assert.equal(r.blocked, true);
        for (const f of r.findings) {
            const source = ({ headline: 'اكسب 500$ يومياً', 'iceBreakers.0.title': 'بدون مجهود', caption: 'Passive income' } as Record<string, string>)[f.field];
            assert.equal(source!.slice(f.start, f.end), f.match);
        }
    });

    it('blocked is true if and only if a block finding exists', () => {
        const warnOnly = checkPolicy({ a: 'شهادة معتمدة', b: 'limited time' });
        assert.equal(warnOnly.findings.length, 2);
        assert.ok(warnOnly.findings.every(f => f.severity === 'warn'));
        assert.equal(warnOnly.blocked, false);

        const mixed = checkPolicy({ a: 'شهادة معتمدة', b: 'quit your job' });
        assert.equal(mixed.blocked, true);

        const clean = checkPolicy({ a: 'تعلم Go', b: 'سجّل الآن' });
        assert.equal(clean.blocked, false);
        assert.equal(clean.findings.length, 0);
    });

    it('the same text in two fields is reported once per field', () => {
        const r = checkPolicy({ a: 'دخل سلبي', b: 'دخل سلبي' });
        assert.deepEqual(r.findings.map(f => f.field), ['a', 'b']);
    });

    it('findings inside one field are ordered by position', () => {
        const text = 'مضمون 100% ثم اكسب 500$ يومياً ثم دخل سلبي';
        const starts = check(text).map(f => f.start);
        assert.deepEqual(starts, [...starts].sort((x, y) => x - y));
        assert.equal(starts.length, 3);
    });
});

describe('checkPolicy — personal attributes versus "you" questions', () => {
    it('«هل أنت مبرمج؟» is only a you_question warning', () => {
        const found = check('هل أنت مبرمج؟');
        assert.deepEqual(found.map(f => [f.ruleId, f.severity]), [['you_question', 'warn']]);
        assert.equal(found[0]!.match, 'هل أنت مبرمج؟');
        assert.equal(checkPolicy({ f: 'هل أنت مبرمج؟' }).blocked, false);
    });

    it('"Are you a developer?" is only a you_question warning', () => {
        const found = check('Are you a developer?');
        assert.deepEqual(found.map(f => [f.ruleId, f.severity]), [['you_question', 'warn']]);
        assert.equal(found[0]!.match, 'Are you a developer?');
    });

    it('«هل أنت مديون؟» is a block and has NO you_question on the same span', () => {
        const found = check('هل أنت مديون؟');
        assert.deepEqual(found.map(f => f.ruleId), ['personal_attribute']);
        assert.equal(found[0]!.severity, 'block');
        assert.equal(checkPolicy({ f: 'هل أنت مديون؟' }).blocked, true);
        assert.deepEqual(check('Are you broke?').map(f => f.ruleId), ['personal_attribute']);
    });

    it('a you_question next to (not on) a personal attribute is kept', () => {
        const found = check('هل أنت مبرمج؟ هل أنت مديون؟');
        assert.deepEqual(found.map(f => f.ruleId), ['you_question', 'personal_attribute']);
    });

    it('the attribute can be up to four tokens after «هل أنت»', () => {
        assert.deepEqual(check('هل أنت متعب من أن تكون مديونا').map(f => f.ruleId), ['personal_attribute']);
        assert.deepEqual(check('are you tired of being in debt?').map(f => f.ruleId), ['personal_attribute']);
        assert.deepEqual(check('are you ready to finally start learning how to pay off a debt?').map(f => f.ruleId), ['you_question']);
    });

    it('the attribute list covers health, religion, family status, age and money', () => {
        for (const text of [
            'هل أنت مفلس؟', 'هل أنت مريض؟', 'هل أنت مكتئب؟', 'هل أنت أعزب؟', 'هل أنت مطلق؟', 'هل أنت مسلم؟',
            'هل أنت من ذوي الإعاقة؟', 'هل عمرك 40 سنة؟', 'هل تعاني من السمنة؟', 'هل أنت فقير؟',
            'Are you divorced?', 'Are you a Christian?', 'Are you overweight?', 'Are you depressed?', 'Are you single?',
            'Are you disabled?', 'Do you suffer from depression?', 'Are you poor?', 'Are you bankrupt?',
        ]) {
            assert.ok(ids(text).includes('personal_attribute'), text);
            assert.ok(!ids(text).includes('you_question'), `${text}: no duplicate warning`);
        }
    });

    it('"you" + a topic word that is about wanting to learn is only a question, not an attribute claim', () => {
        assert.deepEqual(check('are you ready to learn about debt?').map(f => [f.ruleId, f.severity]), [['you_question', 'warn']]);
        assert.deepEqual(check('هل أنت مهتم بتعلم إدارة الديون؟').map(f => f.ruleId), ['you_question']);
    });

    it('findings keep the right spans when both rules fire in one field', () => {
        const text = 'هل أنت مبرمج؟ تعلّم. هل أنت عاطل؟';
        const found = check(text);
        assert.deepEqual(found.map(f => f.match), ['هل أنت مبرمج؟', 'هل أنت عاطل']);
    });
});

describe('checkPolicy — overlapping findings of one rule are merged', () => {
    it('two patterns hitting the same words give one finding', () => {
        // «اكسب 500$ يومياً» matches both the earn-verb and the amount-per-period shapes.
        assert.equal(check('اكسب 500$ يومياً').filter(f => f.ruleId === 'income_figure').length, 1);
        assert.equal(check('earn $500 a day').filter(f => f.ruleId === 'income_figure').length, 1);
        assert.equal(check('Guaranteed! guaranteed results').filter(f => f.ruleId === 'guaranteed').length, 2, 'separate words stay separate');
    });

    it('«ربح مضمون 100%» is one guarantee', () => {
        const found = check('ربح مضمون 100%').filter(f => f.ruleId === 'guaranteed');
        assert.equal(found.length, 1);
        assert.equal(found[0]!.match, 'ربح مضمون 100%');
    });
});
