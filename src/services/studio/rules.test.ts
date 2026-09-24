import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Carousel, Slide } from './carouselTypes.js';
import { EXAMPLES, exampleShotNames } from './examples.js';
import { validateCarousel, usedShotNames } from './rules.js';

/** `n` Arabic letters: budget-sized text with no digits in it. */
const A = (n: number): string => 'ب'.repeat(n);

const SHOTS: ReadonlySet<string> = new Set(['m-a', 'm-b', 'm-c']);

/** A valid carousel that uses every slide kind once, so every per-kind rule has a target. */
function base(): Carousel {
    return {
        id: 'TestCarousel',
        accent: '#FFD60A',
        keyword: 'وكيل',
        slides: [
            { kind: 'cover', kicker: 'التحوّل', title: 'الدردشة ماتت', highlight: 'ماتت', subtitle: 'فرق يغيّر كل شي', shot: { name: 'm-a' } },
            { kind: 'point', n: 1, title: 'عنوان', body: 'نص', tip: 'نصيحة', shot: { name: 'm-b' } },
            { kind: 'list', title: 'قائمة', items: [{ icon: '🔎', text: 'أ', sub: 'ب' }, { text: 'ج' }, { text: 'د' }] },
            { kind: 'compare', title: 'مقارنة', left: { label: 'قبل', items: ['أ', 'ب'] }, right: { label: 'بعد', items: ['ج', 'د'] } },
            { kind: 'steps', title: 'خطوات', steps: [{ title: 'أ', body: 'ب' }, { title: 'ج' }, { title: 'د' }] },
            { kind: 'prompt', title: 'برومبت', label: 'انسخ البرومبت', prompt: 'حلّل [السوق] الآن', note: 'ملاحظة' },
            { kind: 'stat', value: '٣٤', label: 'درس', body: 'نص' },
            { kind: 'shot', title: 'لقطة', shot: { name: 'm-c' }, caption: 'تعليق' },
            { kind: 'cta', promise: 'في الكورس' },
        ],
        captions: {
            instagram: 'اكتب "وكيل" بالتعليقات ويوصلك رابط الكورس بالخاص 📩 #تقنية',
            tiktokTitle: 'الدردشة ماتت',
            tiktok: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗',
        },
    };
}

function slideOf<K extends Slide['kind']>(c: Carousel, kind: K): Extract<Slide, { kind: K }> {
    const s = c.slides.find((x) => x.kind === kind);
    assert.ok(s, `fixture has no ${kind} slide`);
    return s as Extract<Slide, { kind: K }>;
}

describe('validateCarousel: the approved carousels', () => {
    for (const ex of EXAMPLES) {
        it(`${ex.id} passes`, () => assert.deepEqual(validateCarousel(ex, exampleShotNames), []));
    }

    it('the fixture passes, so every failure below is the mutation alone', () => {
        assert.deepEqual(validateCarousel(base(), SHOTS), []);
    });
});

/** [what, mutation, the problem it must produce] */
const CASES: [string, (c: Carousel) => void, string][] = [
    // Budgets, one per field, with the checker's message format.
    ['cover.kicker', (c) => { slideOf(c, 'cover').kicker = A(25); }, `slide 1 (cover).kicker: 25 > 24 «${A(25)}»`],
    ['cover.title', (c) => { const s = slideOf(c, 'cover'); s.title = A(35); s.highlight = A(3); }, 'slide 1 (cover).title: 35 > 34'],
    ['cover.subtitle', (c) => { slideOf(c, 'cover').subtitle = A(71); }, 'slide 1 (cover).subtitle: 71 > 70'],
    ['point.title', (c) => { slideOf(c, 'point').title = A(41); }, 'slide 2 (point).title: 41 > 40'],
    ['point.body', (c) => { slideOf(c, 'point').body = A(151); }, 'slide 2 (point).body: 151 > 150'],
    ['point.tip', (c) => { slideOf(c, 'point').tip = A(71); }, 'slide 2 (point).tip: 71 > 70'],
    ['list.title', (c) => { slideOf(c, 'list').title = A(37); }, 'slide 3 (list).title: 37 > 36'],
    ['list item text', (c) => { slideOf(c, 'list').items[1]!.text = A(37); }, 'slide 3 (list).items[1].text: 37 > 36'],
    ['list item sub', (c) => { slideOf(c, 'list').items[0]!.sub = A(61); }, 'slide 3 (list).items[0].sub: 61 > 60'],
    ['compare.title', (c) => { slideOf(c, 'compare').title = A(37); }, 'slide 4 (compare).title: 37 > 36'],
    ['compare left.label', (c) => { slideOf(c, 'compare').left.label = A(17); }, 'slide 4 (compare).left.label: 17 > 16'],
    ['compare right.label', (c) => { slideOf(c, 'compare').right.label = A(17); }, 'slide 4 (compare).right.label: 17 > 16'],
    ['compare item', (c) => { slideOf(c, 'compare').right.items[1] = A(31); }, 'slide 4 (compare).right.items[1]: 31 > 30'],
    ['steps.title', (c) => { slideOf(c, 'steps').title = A(37); }, 'slide 5 (steps).title: 37 > 36'],
    ['step title', (c) => { slideOf(c, 'steps').steps[2]!.title = A(29); }, 'slide 5 (steps).steps[2].title: 29 > 28'],
    ['step body', (c) => { slideOf(c, 'steps').steps[0]!.body = A(71); }, 'slide 5 (steps).steps[0].body: 71 > 70'],
    ['prompt.title', (c) => { slideOf(c, 'prompt').title = A(37); }, 'slide 6 (prompt).title: 37 > 36'],
    ['prompt.label', (c) => { slideOf(c, 'prompt').label = A(21); }, 'slide 6 (prompt).label: 21 > 20'],
    ['prompt.prompt', (c) => { slideOf(c, 'prompt').prompt = A(321); }, 'slide 6 (prompt).prompt: 321 > 320'],
    ['prompt.note', (c) => { slideOf(c, 'prompt').note = A(71); }, 'slide 6 (prompt).note: 71 > 70'],
    ['stat.value', (c) => { slideOf(c, 'stat').value = A(9); }, 'slide 7 (stat).value: 9 > 8'],
    ['stat.label', (c) => { slideOf(c, 'stat').label = A(41); }, 'slide 7 (stat).label: 41 > 40'],
    ['stat.body', (c) => { slideOf(c, 'stat').body = A(121); }, 'slide 7 (stat).body: 121 > 120'],
    ['shot.title', (c) => { slideOf(c, 'shot').title = A(41); }, 'slide 8 (shot).title: 41 > 40'],
    ['shot.caption', (c) => { slideOf(c, 'shot').caption = A(91); }, 'slide 8 (shot).caption: 91 > 90'],
    ['cta.promise', (c) => { slideOf(c, 'cta').promise = A(41); }, 'slide 9 (cta).promise: 41 > 40'],

    // Item counts.
    ['list with 2 items', (c) => { slideOf(c, 'list').items.pop(); }, 'slide 3 (list).items: 2 items, expected 3–5'],
    ['list with 6 items', (c) => { slideOf(c, 'list').items.push({ text: 'ه' }, { text: 'و' }, { text: 'ز' }); }, 'slide 3 (list).items: 6 items, expected 3–5'],
    ['compare with 1 item a side', (c) => { const s = slideOf(c, 'compare'); s.left.items.pop(); s.right.items.pop(); }, 'slide 4 (compare).left.items: 1 items, expected 2–4'],
    ['compare with 5 items a side', (c) => { const s = slideOf(c, 'compare'); s.left.items.push('ج', 'د', 'ه'); s.right.items.push('ج', 'د', 'ه'); }, 'slide 4 (compare).left.items: 5 items, expected 2–4'],
    ['compare sides differ', (c) => { slideOf(c, 'compare').right.items.push('ه'); }, 'slide 4 (compare): compare sides differ in length'],
    ['steps with 2', (c) => { slideOf(c, 'steps').steps.pop(); }, 'slide 5 (steps).steps: 2 items, expected 3–4'],
    ['steps with 5', (c) => { slideOf(c, 'steps').steps.push({ title: 'ه' }, { title: 'و' }); }, 'slide 5 (steps).steps: 5 items, expected 3–4'],

    // Slide structure.
    ['5 slides', (c) => { c.slides.splice(1, 4); }, 'slides: 5 items, expected 6–10'],
    ['11 slides', (c) => { c.slides.splice(1, 0, slideOf(c, 'point'), slideOf(c, 'point')); }, 'slides: 11 items, expected 6–10'],
    ['first slide not cover', (c) => { c.slides.shift(); c.slides.unshift({ kind: 'point', title: 'بداية' }); }, 'first slide must be cover'],
    ['last slide not cta', (c) => { c.slides.pop(); c.slides.push({ kind: 'point', title: 'نهاية' }); }, 'last slide must be cta'],
    ['highlight not in title', (c) => { slideOf(c, 'cover').highlight = 'غير موجود'; }, 'slide 1 (cover).highlight not in title'],

    // Digits.
    ['Latin digit before Arabic', (c) => { slideOf(c, 'point').title = '5 أخطاء'; }, 'slide 2 (point).title: Latin digit next to Arabic text «5 أخطاء»'],
    ['Latin digit after Arabic', (c) => { slideOf(c, 'list').items[0]!.sub = 'في 10 دقايق'; }, 'slide 3 (list).items[0].sub: Latin digit next to Arabic text'],

    // Captions and campaign fields.
    ['tiktokTitle over 90 UTF-16', (c) => { c.captions.tiktokTitle = A(89) + '🔒'; }, 'tiktokTitle 91 > 90 UTF-16'],
    ['instagram without the keyword', (c) => { c.captions.instagram = 'اكتب بالتعليقات #تقنية'; }, "instagram caption doesn't mention the keyword"],
    ['tiktok without the link-in-bio line', (c) => { c.captions.tiktok = 'الكورس كامل بالعربي'; }, 'tiktok caption is missing the link-in-bio line'],
    ['instagram over 2200', (c) => { c.captions.instagram = 'وكيل ' + A(2196); }, 'instagram caption 2201 > 2200'],
    ['tiktok over 4000', (c) => { c.captions.tiktok += A(4000); }, 'tiktok caption too long'],
    ['31 hashtags', (c) => { c.captions.instagram += ' #و'.repeat(30); }, '31 hashtags > 30'],
    ['accent #FFF', (c) => { c.accent = '#FFF'; }, 'accent "#FFF" is not #RRGGBB'],
    ['accent by name', (c) => { c.accent = 'red'; }, 'accent "red" is not #RRGGBB'],
    ['two-word keyword', (c) => { c.keyword = 'وكيل ذكي'; c.captions.instagram += ' وكيل ذكي'; }, 'keyword must be one word'],
    ['empty keyword', (c) => { c.keyword = ''; }, 'keyword must be one word'],
    ['unsafe id', (c) => { c.id = 'my carousel/..'; }, 'id "my carousel/.." must be ASCII letters'],

    // Shots are checked against the draft's own names.
    ['cover shot unknown', (c) => { slideOf(c, 'cover').shot = { name: 'chat-dead' }; }, 'slide 1 (cover).shot: unknown shot "chat-dead"'],
    ['point shot unknown', (c) => { slideOf(c, 'point').shot = { name: 'm-zzz' }; }, 'slide 2 (point).shot: unknown shot "m-zzz"'],
    ['shot slide unknown', (c) => { slideOf(c, 'shot').shot = { name: 'm-zzz' }; }, 'slide 8 (shot).shot: unknown shot "m-zzz"'],
    ['shot focus out of range', (c) => { slideOf(c, 'shot').shot = { name: 'm-c', focusX: 1.5 }; }, 'slide 8 (shot).shot.focusX: 1.5 is out of range'],
];

describe('validateCarousel: each rule catches its violation', () => {
    for (const [what, mutate, expected] of CASES) {
        it(what, () => {
            const c = base();
            mutate(c);
            const problems = validateCarousel(c, SHOTS);
            assert.ok(problems.some((p) => p.startsWith(expected)), `expected «${expected}» in:\n${problems.join('\n')}`);
        });
    }
});

describe('validateCarousel: what the checker allows', () => {
    it('allows Latin digits inside a Latin run', () => {
        const c = base();
        slideOf(c, 'point').title = 'جرّب Gemini 2.5 Pro';
        assert.deepEqual(validateCarousel(c, SHOTS), []);
    });

    it('only measures prompt.prompt and stat.value, as the checker does', () => {
        const c = base();
        slideOf(c, 'prompt').prompt = 'اكتب 3 منشورات عن [منتجي]';
        slideOf(c, 'stat').value = '5 دقائق';
        assert.deepEqual(validateCarousel(c, SHOTS), []);
    });

    it('counts an astral emoji as two UTF-16 units, so 88 letters + 🔒 is exactly 90', () => {
        const c = base();
        c.captions.tiktokTitle = A(88) + '🔒';
        assert.deepEqual(validateCarousel(c, SHOTS), []);
    });

    it('accepts a lowercase accent, as the checker\'s /i does', () => {
        const c = base();
        c.accent = '#ffd60a';
        assert.deepEqual(validateCarousel(c, SHOTS), []);
    });
});

describe('validateCarousel: malformed JSON is a problem, never a throw', () => {
    const garbage: [string, unknown, string][] = [
        ['null', null, 'carousel: must be an object'],
        ['no slides', { ...base(), slides: undefined }, 'slides: required'],
        ['an unknown slide kind', { ...base(), slides: [...base().slides.slice(0, 3), { kind: 'banner' }, ...base().slides.slice(3)] }, 'slide 4 (banner): unknown slide kind'],
        ['a null slide', { ...base(), slides: [...base().slides.slice(0, 3), null, ...base().slides.slice(3)] }, 'slide 4 (?): unknown slide kind'],
        ['list without items', { ...base(), slides: base().slides.map((s) => (s.kind === 'list' ? { kind: 'list', title: 'ق' } : s)) }, 'slide 3 (list).items: required'],
        ['a numeric title', { ...base(), slides: base().slides.map((s) => (s.kind === 'point' ? { ...s, title: 42 } : s)) }, 'slide 2 (point).title: required'],
        ['a numeric body', { ...base(), slides: base().slides.map((s) => (s.kind === 'point' ? { ...s, body: 42 } : s)) }, 'slide 2 (point).body: must be text'],
        ['compare without sides', { ...base(), slides: base().slides.map((s) => (s.kind === 'compare' ? { kind: 'compare' } : s)) }, 'slide 4 (compare): compare needs left and right'],
        ['a shot slide without a shot', { ...base(), slides: base().slides.map((s) => (s.kind === 'shot' ? { kind: 'shot', title: 'ل' } : s)) }, 'slide 8 (shot).shot: must be { name }'],
        ['no captions', { ...base(), captions: undefined }, 'captions.instagram: required'],
        ['a word as a list icon', { ...base(), slides: base().slides.map((s) => (s.kind === 'list' ? { ...s, items: [{ icon: 'نص', text: 'أ' }, { text: 'ب' }, { text: 'ج' }] } : s)) }, 'slide 3 (list).items[0].icon: must be one emoji'],
    ];
    for (const [what, value, expected] of garbage) {
        it(what, () => {
            const problems = validateCarousel(value as Carousel, SHOTS);
            assert.ok(problems.some((p) => p.startsWith(expected)), `expected «${expected}» in:\n${problems.join('\n')}`);
        });
    }

    it('does not mutate its input', () => {
        const c = base();
        slideOf(c, 'point').title = A(99);
        const before = structuredClone(c);
        validateCarousel(c, SHOTS);
        assert.deepEqual(c, before);
    });
});

describe('usedShotNames', () => {
    it('lists slide shots in order', () => {
        assert.deepEqual(usedShotNames(base()), ['m-a', 'm-b', 'm-c']);
    });
});
