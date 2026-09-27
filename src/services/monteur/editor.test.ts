/**
 * The Editor's rules (MONTEUR.md §6.2) that code, not the prompt, holds: where an edit lands, what
 * an image asks the worker's free photo library for, and the per-clip limits. The call itself, and
 * what a failure does to a reel, are in sweep.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import {
    EDIT_KINDS, EDITOR_SCHEMA, echoesSpeech, editorSystemPrompt, KIND_CAP, LIBRARY_TOPICS, MAX_IMAGES_PER_CLIP, MAX_QUERY, phrase,
    PHRASE_LIMITS, placeEdits, TEACHING_SFX,
} from './editor.js';

/** One clip's lines on its clock: L1 «خريطة العالم» at 1 s, L2 «كتاب وصفات» at 6 s. */
const LINES: { t: number; words: TranscriptWord[] }[] = [
    { t: 1, words: [[1, 1.4, 'خريطة'], [1.5, 2, 'العالم']] },
    { t: 6, words: [[6, 6.4, 'كتاب'], [6.5, 7, 'وصفات.']] },
];
const image = (query: unknown, line = 1) => ({ line, word: 'خريطة', kind: 'image', query, sfx: 'whoosh' });

describe('placeEdits — an image is a photo library query, never a generation prompt', () => {
    it('carries `query`, on the word it lands on, and nothing named prompt', () => {
        const [edit] = placeEdits([image('world map')], LINES);
        assert.deepEqual(edit, { t: 1, kind: 'image', query: 'world map', sfx: 'whoosh' });
        assert.deepEqual(placeEdits([{ line: 1, word: 'خريطة', kind: 'image', prompt: 'a flat illustration of a map' }], LINES), [],
            'an old-style prompt is not a query');
    });

    it('keeps letters, digits and spaces only, at most 40 characters, cut at a word', () => {
        const q = (raw: unknown) => placeEdits([image(raw)], LINES)[0]?.query;
        assert.equal(q('  robot-arm, 3D!  '), 'robot arm 3D');
        assert.equal(q('python\tsnake\n'), 'python snake');
        assert.equal(MAX_QUERY, 40);
        const long = q('office laptop on a wooden desk by a sunny window');
        assert.equal(long, 'office laptop on a wooden desk by a');
        assert.ok(long!.length <= MAX_QUERY);
        assert.equal(q('recipe book'), 'recipe book');
    });

    it('drops an image with no usable query: empty, Arabic only, or not text', () => {
        for (const raw of ['', '   ', '!!!', 'خريطة العالم', null, 42, ['map']]) {
            assert.deepEqual(placeEdits([image(raw)], LINES), [], JSON.stringify(raw));
        }
    });

    it('takes at most 4 pictures a clip, images and brolls together, by library topic', () => {
        const edits = placeEdits([image('world map'), image('recipe', 2), image('laptop', 2), { ...image('robot', 2), kind: 'broll' }, image('clock', 2)], LINES);
        assert.deepEqual(edits.map((e) => [e.kind, e.query]), [['image', 'world map'], ['image', 'recipe'], ['image', 'laptop'], ['broll', 'robot']]);
        assert.equal(MAX_IMAGES_PER_CLIP, 4);
    });

    it('takes a highlight with no text, and the newer sound families', () => {
        assert.deepEqual(placeEdits([{ line: 2, word: 'كتاب', kind: 'highlight', sfx: 'click' }, { line: 1, word: 'x', kind: 'emoji', emoji: '💡', sfx: 'pop' }], LINES).map((e) => [e.kind, e.sfx]),
            [['emoji', 'pop'], ['highlight', 'click']]);
    });

    it('leaves an emoji as it was: one emoji, drawn by the worker', () => {
        assert.deepEqual(placeEdits([{ line: 2, word: 'كتاب', kind: 'emoji', emoji: '📄', sfx: 'switch' }], LINES), [
            { t: 6, kind: 'emoji', emoji: '📄', sfx: 'switch' },
        ]);
    });
});

describe('the Editor prompt and schema', () => {
    it('asks for a free photo library query for an image, and says nothing of generating one', () => {
        const system = editorSystemPrompt(ELAMIR_SETTINGS);
        assert.ok(system.includes('- image: a photo card for a concrete object he names in passing, never for an abstract idea'));
        assert.ok(system.includes('- broll: a full-screen photo cutaway'));
        assert.ok(system.includes('At most 4 pictures per clip (example, image and broll together)'));
        assert.doesNotMatch(system, /illustration|prompt:|generat/);
    });

    it('names `query`, not `prompt`, in the schema', () => {
        const item = (EDITOR_SCHEMA as unknown as { properties: { clips: { items: { properties: { edits: { items: { properties: Record<string, { description?: string }>; propertyOrdering: string[] } } } } } } })
            .properties.clips.items.properties.edits.items;
        assert.ok('query' in item.properties && !('prompt' in item.properties));
        // No enum: 81 values in the schema made Gemini refuse the request (HTTP 400). The prompt lists them.
        assert.equal((item.properties.query as unknown as { enum?: string[] }).enum, undefined);
        assert.ok(editorSystemPrompt(ELAMIR_SETTINGS).includes(LIBRARY_TOPICS.join(', ')), 'the topics are in the prompt');
        assert.deepEqual(item.propertyOrdering, ['line', 'word', 'kind', 'text', 'meaning', 'items', 'emoji', 'query', 'sfx']);
    });

    it('keeps every enum small and every new field a plain string or a list of strings (a big enum is an HTTP 400)', () => {
        const item = (EDITOR_SCHEMA as unknown as { properties: { clips: { items: { properties: { edits: { items: { properties: Record<string, { type: string; enum?: string[]; items?: { type: string; enum?: string[] } }>; propertyOrdering: string[] } } } } } } })
            .properties.clips.items.properties.edits.items;
        assert.deepEqual(item.properties.kind!.enum, [...EDIT_KINDS]);
        for (const [name, prop] of Object.entries(item.properties)) {
            assert.ok((prop.enum?.length ?? 0) <= 16, `${name} has an enum of ${prop.enum?.length}`);
        }
        assert.equal(item.properties.meaning!.type, 'STRING');
        assert.deepEqual([item.properties.items!.type, item.properties.items!.items?.type, item.properties.items!.items?.enum], ['ARRAY', 'STRING', undefined]);
        assert.deepEqual([...item.propertyOrdering].sort(), Object.keys(item.properties).sort(), 'every property is ordered');
    });

    it('states the teaching rules, each teaching kind and when it is used, in one prompt', () => {
        const system = editorSystemPrompt(ELAMIR_SETTINGS);
        for (const rule of ['Show what he refers to', 'Guide the eye', 'Segment a procedure', 'pre-train a new term', 'close with one recap',
            'On time: each edit on the exact word', 'Redundancy: the captions already show every word', 'Coherence: every edit needs a reason']) {
            assert.ok(system.includes(rule), rule);
        }
        for (const kind of Object.keys(TEACHING_SFX)) assert.ok(system.includes(`\n- ${kind}: `), kind);
        assert.ok(system.includes('«مثال: مطعم»') && system.includes('never «هنا»'));
        assert.ok(system.includes('except steps and callouts'));
        assert.ok(system.includes('Never a woman or a girl'));
        assert.ok(system.length < 5200, `the prompt runs daily: ${system.length} characters`);
    });
});

/** A two-line clip on its clock: L1 «هنا هنضيف تعليمات جديدة» at 1 s, L2 «زي المطعم لما تطلب» at 6 s, L3 «في الآخر خلاص» at 12 s. */
const LESSON: { t: number; words: TranscriptWord[] }[] = [
    { t: 1, words: [[1, 1.3, 'هنا'], [1.3, 1.8, 'هنضيف'], [1.8, 2.4, 'تعليمات'], [2.4, 3, 'جديدة']] },
    { t: 6, words: [[6, 6.3, 'زي'], [6.3, 6.9, 'المطعم'], [6.9, 7.2, 'لما'], [7.2, 7.8, 'تطلب']] },
    { t: 12, words: [[12, 12.4, 'في'], [12.4, 12.9, 'الآخر'], [12.9, 13.5, 'خلاص']] },
];
const at = (line: number, word: string, rest: Record<string, unknown>) => ({ line, word, sfx: 'whoosh', ...rest });

describe('placeEdits — the teaching kinds', () => {
    it('places each on its word, with its fields and its own sound, whatever the model said', () => {
        const edits = placeEdits([
            at(2, 'المطعم', { kind: 'example', query: 'kitchen', text: 'مثال: مطعم', sfx: 'impact' }),
            at(1, 'هنا', { kind: 'callout', text: 'زر الإضافة' }),
            at(1, 'هنضيف', { kind: 'step', text: 'افتح التعليمات' }),
            at(3, 'في', { kind: 'step', text: 'احفظ وجرب' }),
            at(1, 'تعليمات', { kind: 'define', text: 'التعليمات', meaning: 'قواعد ثابتة لكل رد' }),
            at(2, 'لما', { kind: 'compare', items: ['رد عام', 'رد على مقاسك'] }),
            at(3, 'خلاص', { kind: 'recap', items: ['أضف تعليماتك مرة', 'الرد يلتزم بها'] }),
        ], LESSON);
        assert.deepEqual(edits, [
            { t: 1, kind: 'callout', text: 'زر الإضافة', sfx: 'click' },
            { t: 1.3, kind: 'step', text: 'افتح التعليمات', sfx: 'pop' },
            { t: 1.8, kind: 'define', text: 'التعليمات', meaning: 'قواعد ثابتة لكل رد', sfx: 'ding' },
            { t: 6.3, kind: 'example', text: 'مثال: مطعم', query: 'kitchen', sfx: 'whoosh' },
            { t: 6.9, kind: 'compare', items: ['رد عام', 'رد على مقاسك'], sfx: 'error' },
            { t: 12, kind: 'step', text: 'احفظ وجرب', sfx: 'pop' },
            { t: 12.9, kind: 'recap', items: ['أضف تعليماتك مرة', 'الرد يلتزم بها'], sfx: 'whoosh' },
        ]);
        assert.deepEqual(TEACHING_SFX, { example: 'whoosh', callout: 'click', step: 'pop', define: 'ding', compare: 'error', recap: 'whoosh' });
    });

    it("lets the model's 'none' silence one, but no other sound replaces its own", () => {
        const [quiet] = placeEdits([at(1, 'هنا', { kind: 'callout', text: 'زر الإضافة', sfx: 'none' })], LESSON);
        assert.deepEqual(quiet, { t: 1, kind: 'callout', text: 'زر الإضافة' });
        const [glitch] = placeEdits([at(1, 'هنا', { kind: 'define', text: 'RAG', meaning: 'يجاوب من ملفاتك', sfx: 'glitch' })], LESSON);
        assert.equal(glitch!.sfx, 'ding');
    });

    it('drops words over their limits rather than cutting them, and strips the ✗ ✓ the worker draws itself', () => {
        assert.equal(phrase('  ✅ رد   على مقاسك. ', PHRASE_LIMITS.side), 'رد على مقاسك');
        assert.equal(phrase('❌ Gemini بالإنجليزي', PHRASE_LIMITS.side), 'Gemini بالإنجليزي');
        assert.equal(phrase('واحد اثنين ثلاثة أربعة خمسة ستة', PHRASE_LIMITS.meaning), '', 'six words is not five');
        assert.equal(phrase('ك'.repeat(33), PHRASE_LIMITS.meaning), '', 'over 32 characters');
        assert.equal(phrase(42, PHRASE_LIMITS.step), '');
        assert.deepEqual(PHRASE_LIMITS, { example: [4, 28], callout: [3, 24], step: [4, 28], term: [3, 24], meaning: [5, 32], side: [4, 26], takeaway: [5, 32] });
        const dropped = placeEdits([
            at(1, 'هنا', { kind: 'callout', text: 'اضغط هنا على الزر الأزرق' }),
            at(1, 'تعليمات', { kind: 'define', text: 'التعليمات', meaning: 'هي القواعد التي يتبعها النموذج دائما' }),
            at(1, 'تعليمات', { kind: 'define', text: 'التعليمات' }),
            at(3, 'خلاص', { kind: 'recap', items: ['نقطة واحدة فقط'] }),
            at(2, 'زي', { kind: 'example', text: 'مثال: مطعم' }),
            at(2, 'زي', { kind: 'example', query: 'kitchen' }),
            at(1, 'هنا', { kind: 'step' }),
        ], LESSON);
        assert.deepEqual(dropped, []);
    });

    it('takes a compare of exactly two different sides, and a recap of its first three takeaways', () => {
        const compare = (items: unknown) => placeEdits([at(2, 'لما', { kind: 'compare', items })], LESSON);
        assert.equal(compare(['قبل', 'بعد']).length, 1);
        assert.deepEqual(compare(['واحد', 'اثنين', 'ثلاثة']), [], 'three sides are a list, not a contrast');
        assert.deepEqual(compare(['نفس الشيء', 'نفس الشيء']), []);
        assert.deepEqual(compare('قبل وبعد'), []);
        const [recap] = placeEdits([at(3, 'خلاص', { kind: 'recap', items: ['واحد', 'اثنين', 'ثلاثة', 'أربعة'] })], LESSON);
        assert.deepEqual(recap!.items, ['واحد', 'اثنين', 'ثلاثة']);
    });

    it('keeps one recap a clip, on its word or else the last line; two defines, two compares, five steps', () => {
        const recaps = placeEdits([
            at(99, 'x', { kind: 'recap', items: ['أ ب', 'ج د'] }),
            at(3, 'خلاص', { kind: 'recap', items: ['ه و', 'ز ح'] }),
        ], LESSON);
        assert.deepEqual(recaps.map((e) => [e.t, e.items]), [[12, ['أ ب', 'ج د']]], 'no such line: the last line, and never a second recap');
        assert.deepEqual(placeEdits([at(99, 'x', { kind: 'step', text: 'خطوة' })], LESSON), [], 'other kinds still need their line');
        const many = (kind: string, n: number, extra: Record<string, unknown>) =>
            placeEdits(Array.from({ length: n }, (_, i) => at(1, 'هنا', { kind, ...extra, text: `كلمة${i}` })), LESSON).length;
        assert.equal(many('define', 4, { meaning: 'معنى بسيط' }), 2);
        assert.equal(many('step', 7, {}), 5);
        assert.equal(placeEdits(Array.from({ length: 3 }, (_, i) => at(2, 'لما', { kind: 'compare', items: [`أ${i}`, `ب${i}`] })), LESSON).length, 2);
        assert.deepEqual(KIND_CAP, { recap: 1, define: 2, compare: 2, step: 5 });
    });

    it('makes a lone step a keyword: one step is no procedure', () => {
        assert.deepEqual(placeEdits([at(1, 'هنا', { kind: 'step', text: 'افتح الإعدادات' })], LESSON), [{ t: 1, kind: 'keyword', text: 'افتح الإعدادات', sfx: 'whoosh' }]);
        assert.deepEqual(placeEdits([at(1, 'تعليمات', { kind: 'step', text: 'تعليمات جديدة' })], LESSON), [], 'unless it repeats what he says');
        assert.deepEqual(placeEdits([at(1, 'هنا', { kind: 'step', text: 'افتح الإعدادات', sfx: 'none' })], LESSON), [{ t: 1, kind: 'keyword', text: 'افتح الإعدادات' }]);
        const two = placeEdits([at(1, 'هنا', { kind: 'step', text: 'افتح الإعدادات' }), at(2, 'زي', { kind: 'step', text: 'اكتب القاعدة' })], LESSON);
        assert.deepEqual(two.map((e) => e.kind), ['step', 'step']);
    });

    it('counts an example as one of the four pictures', () => {
        const pics = placeEdits([
            at(2, 'زي', { kind: 'example', query: 'kitchen', text: 'مثال: مطعم' }),
            at(1, 'هنا', { kind: 'image', query: 'laptop' }),
            at(1, 'هنا', { kind: 'broll', query: 'office' }),
            at(3, 'في', { kind: 'image', query: 'clock' }),
            at(3, 'خلاص', { kind: 'example', query: 'coffee', text: 'مثال: قهوة' }),
        ], LESSON);
        assert.deepEqual(pics.map((e) => e.query), ['laptop', 'office', 'kitchen', 'clock']);
    });
});

describe('placeEdits — redundancy: a keyword never repeats the words being said', () => {
    it('drops a keyword that is word for word what he says around it, prefixes and all', () => {
        assert.equal(echoesSpeech('تعليمات جديدة', LESSON, 1.8), true);
        assert.equal(echoesSpeech('بالتعليمات الجديدة', LESSON, 1.8), true, 'a ب or ال in front is the same words');
        assert.equal(echoesSpeech('المطعم', LESSON, 6.3), true);
        assert.equal(echoesSpeech('تعليمات جديدة', LESSON, 12), false, 'said too long ago to be on the captions now');
        assert.equal(echoesSpeech('قواعد ثابتة', LESSON, 1.8), false);
        assert.equal(echoesSpeech('جديدة تعليمات', LESSON, 1.8), false, 'not the same run of words');
        const edits = placeEdits([
            at(1, 'تعليمات', { kind: 'keyword', text: 'تعليمات جديدة' }),
            at(1, 'تعليمات', { kind: 'keyword', text: 'قواعد لكل رد' }),
        ], LESSON);
        assert.deepEqual(edits.map((e) => e.text), ['قواعد لكل رد']);
    });

    it('never applies to a tool, a step or a term, which name what he says on purpose', () => {
        const edits = placeEdits([
            at(1, 'تعليمات', { kind: 'tool', text: 'تعليمات' }),
            at(1, 'تعليمات', { kind: 'step', text: 'تعليمات جديدة' }),
            at(2, 'تطلب', { kind: 'step', text: 'تطلب' }),
            at(1, 'تعليمات', { kind: 'define', text: 'تعليمات', meaning: 'قواعد ثابتة' }),
        ], LESSON);
        assert.deepEqual(edits.map((e) => e.kind), ['tool', 'step', 'define', 'step']);
    });
});
