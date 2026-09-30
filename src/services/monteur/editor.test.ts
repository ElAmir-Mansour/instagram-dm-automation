/**
 * The Editor's rules (MONTEUR.md §6.2) that code, not the prompt, holds: where an edit lands, what
 * an image asks the worker's free photo library for, and the per-clip limits. The call itself, and
 * what a failure does to a reel, are in sweep.test.ts.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import type { GeminiSchema } from '../studio/generate.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import {
    anchorTime, directionsByClip, DOODLE_SHAPES, DOODLE_TARGETS, EDIT_KINDS, EDITOR_SCHEMA, editorSchema, echoesSpeech, editorSystemPrompt,
    HUMAN_TOUCHES_PROMPT, humanTouchesOn, ICON_NAMES, KIND_CAP, LIBRARY_TOPICS, MAX_IMAGES_PER_CLIP, MAX_QUERY, phrase, PHRASE_LIMITS,
    placeDirection, placeEdits, SHOTS, TALKING_HEAD_TOUCHES, TEACHING_SFX, TOUCH_CAP, TOUCH_LEAD_S, TOUCH_TAIL_S, TRANSITION_KINDS,
} from './editor.js';
import { toJsonSchema } from './think.js';

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
        assert.deepEqual(item.propertyOrdering, ['line', 'word', 'kind', 'text', 'meaning', 'items', 'emoji', 'icon', 'query', 'sfx']);
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
        // The icon names (about 1,150 characters) are in the prompt, not a schema enum: a big enum is an HTTP 400.
        // The human touches add about 1,200 (MONTEUR.md §6.2); without them the prompt is as it was.
        assert.ok(system.length < 8000, `the prompt runs daily: ${system.length} characters`);
        const plain = editorSystemPrompt({ ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, human: false } });
        assert.ok(plain.length < 6500, `without the human touches: ${plain.length} characters`);
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
        assert.deepEqual(PHRASE_LIMITS, {
            example: [4, 28], callout: [3, 24], step: [4, 28], term: [3, 24], meaning: [5, 32], side: [4, 26], takeaway: [5, 32], freeze: [2, 18], behind: [2, 16],
        });
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

describe('placeEdits — an icon is a line drawing from the worker\'s set', () => {
    const icon = (fields: Record<string, unknown>) => placeEdits([{ line: 1, word: 'خريطة', kind: 'icon', sfx: 'pop', ...fields }], LINES);

    it('keeps a known name, lowercased and trimmed, on its word, with the model\'s sound', () => {
        assert.deepEqual(icon({ icon: 'rocket' }), [{ t: 1, kind: 'icon', icon: 'rocket', sfx: 'pop' }]);
        assert.deepEqual(icon({ icon: '  Chart-Bar \n' }), [{ t: 1, kind: 'icon', icon: 'chart-bar', sfx: 'pop' }]);
        assert.deepEqual(icon({ icon: 'dna-2', sfx: 'none' }), [{ t: 1, kind: 'icon', icon: 'dna-2' }]);
    });

    it('drops an icon whose name is not in ICON_NAMES, or that has none', () => {
        for (const name of ['unicorn', 'rockets', 'user', 'woman', 'dna 2', '', '   ', null, 42, ['rocket'], undefined]) {
            assert.deepEqual(icon({ icon: name }), [], JSON.stringify(name));
        }
        assert.deepEqual(icon({ emoji: '🚀' }), [], 'an emoji is not an icon');
    });

    it('keeps an optional label of 1-3 words, and the icon without one that is longer', () => {
        assert.deepEqual(icon({ icon: 'brain', text: '  ذاكرة   النموذج ' }), [{ t: 1, kind: 'icon', icon: 'brain', text: 'ذاكرة النموذج', sfx: 'pop' }]);
        assert.deepEqual(icon({ icon: 'brain', text: 'كلمة واحدة اثنين ثلاثة' }), [{ t: 1, kind: 'icon', icon: 'brain', sfx: 'pop' }], 'four words');
        assert.deepEqual(icon({ icon: 'brain', text: 'ك'.repeat(25) }), [{ t: 1, kind: 'icon', icon: 'brain', sfx: 'pop' }], 'over 24 characters');
        assert.deepEqual(icon({ icon: 'brain', text: 42 }), [{ t: 1, kind: 'icon', icon: 'brain', sfx: 'pop' }]);
    });

    it('is not a picture: icons never count toward the four pictures a clip', () => {
        const edits = placeEdits([
            image('world map'), image('recipe', 2), image('laptop', 2), image('clock', 2),
            { line: 2, word: 'كتاب', kind: 'icon', icon: 'book', sfx: 'pop' },
        ], LINES);
        assert.equal(edits.length, 5);
        assert.equal(edits.filter((e) => e.kind === 'icon').length, 1);
    });

    it('holds the worker\'s list: 121 lower-case names, each once, and no person', () => {
        assert.equal(ICON_NAMES.length, 121);
        assert.equal(new Set(ICON_NAMES).size, ICON_NAMES.length);
        for (const name of ICON_NAMES) assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, name);
        for (const person of ['user', 'man', 'woman', 'girl', 'friends']) assert.ok(!(ICON_NAMES as readonly string[]).includes(person), person);
        assert.ok(EDIT_KINDS.includes('icon'));
    });

    it('is asked for in the prompt with its names and its sound, and is a plain string in the schema', () => {
        const system = editorSystemPrompt(ELAMIR_SETTINGS);
        assert.ok(system.includes("\n- icon: an animated line drawing of a concept or object when no photo fits and it's worth a picture (the video draws it on)."));
        assert.ok(system.includes(`icon: exactly one name from: ${ICON_NAMES.join(', ')}; text: an optional label, 1-3 words.`));
        assert.ok(system.includes('pop for an emoji, icon or step'));
        assert.ok(system.includes('Mix the kinds, icons included; never two of the same in a row'));
        const item = (EDITOR_SCHEMA as unknown as { properties: { clips: { items: { properties: { edits: { items: { properties: Record<string, { type: string; enum?: string[] }> } } } } } } })
            .properties.clips.items.properties.edits.items;
        assert.equal(item.properties.icon!.type, 'STRING');
        assert.equal(item.properties.icon!.enum, undefined, 'a 121-value enum would be an HTTP 400');
    });
});

// ─── The human touches (MONTEUR.md §6.2, 2026-09-30) ─────────────────────────────────────

/**
 * A 30-second clip: L1 «أهلا وسهلا» at 0.2 s (inside the first 0.8 s), L2 «عشرة أضعاف» at 5 s,
 * L3 «الخرافة الكبيرة» at 12 s, L4 «انتبه هنا» at 20 s, L5 «اكتب كلمة» at 27.5 s (inside the last 3.2 s).
 */
const CLIP_S = 30;
const TALK: { t: number; words: TranscriptWord[] }[] = [
    { t: 0.2, words: [[0.2, 0.6, 'أهلا'], [0.6, 1.2, 'وسهلا']] },
    { t: 5, words: [[5, 5.4, 'عشرة'], [5.4, 6, 'أضعاف.']] },
    { t: 12, words: [[12, 12.5, 'الخرافة'], [12.5, 13, 'الكبيرة']] },
    { t: 20, words: [[20, 20.4, 'انتبه'], [20.4, 21, 'هنا']] },
    { t: 27.5, words: [[27.5, 28, 'اكتب'], [28, 28.5, 'كلمة']] },
];
/** 50 one-word lines, L<n> at n seconds, in a 60-second clip: room to test every cap. */
const MANY: { t: number; words: TranscriptWord[] }[] = Array.from({ length: 50 }, (_, i) => ({ t: i + 1, words: [[i + 1, i + 1.5, `كلمة${i + 1}`]] as TranscriptWord[] }));
const direction = (raw: Record<string, unknown>, lines = TALK, length = CLIP_S) => placeDirection(raw, lines, length);
const EMPTY = { cuts: [], doodles: [], freezes: [], transitions: [], behind: [], emphasis: [] };

describe('placeDirection — every touch anchored as an edit is', () => {
    it('lands on its word’s start, else a word containing it, else its line’s start: anchorTime, the edits’ own rule', () => {
        const at = (word: string, line = 2) => direction({ emphasis: [{ line, word }] }).emphasis[0];
        assert.equal(at('أضعاف'), 5.4, 'the word (its trailing «.» ignored)');
        assert.equal(at('ضعاف'), 5.4, 'a word containing it');
        assert.equal(at('غائبة'), 5, 'no such word: the line’s start');
        assert.equal(at('عشرة', 99), undefined, 'no such line: dropped, never another line');
        assert.deepEqual(direction({ emphasis: [{ line: 99, word: 'كلمة1' }], cuts: [{ line: 0, word: 'كلمة1', shot: 'close' }] }, MANY, 60), EMPTY,
            'not even onto L1, whose word it names and which is inside the window');
        for (const [line, word] of [[2, 'أضعاف'], [3, 'الكبيرة'], [4, 'غائبة']] as const) {
            const [edit] = placeEdits([{ line, word, kind: 'punch', sfx: 'none' }], TALK);
            assert.equal(anchorTime({ line, word }, TALK), edit!.t, 'the same t as an edit on the same word');
        }
        assert.equal(anchorTime({ line: 0, word: 'x' }, TALK), null);
        assert.equal(anchorTime({ line: '2', word: 'عشرة' }, TALK), null, 'a line number, not text');
    });

    it('places each list with its own fields, t first, sorted by t', () => {
        const d = direction({
            emphasis: [{ line: 4, word: 'انتبه' }, { line: 2, word: 'عشرة' }],
            doodles: [{ line: 3, word: 'الخرافة', shape: 'cross', target: 'caption' }, { line: 2, word: 'أضعاف', shape: 'stars', target: 'head' }],
            transitions: [{ line: 3, word: 'الخرافة', kind: 'leak' }],
            cuts: [{ line: 3, word: 'الخرافة', shot: 'close' }, { line: 2, word: 'عشرة', shot: 'wide' }],
            freezes: [{ line: 2, word: 'أضعاف', text: '  عشرة   أضعاف! ' }],
            behind: [{ line: 4, word: 'انتبه', text: 'انتبه' }],
        });
        assert.deepEqual(d, {
            cuts: [{ t: 5, shot: 'wide' }, { t: 12, shot: 'close' }],
            doodles: [{ t: 5.4, shape: 'stars', target: 'head' }, { t: 12, shape: 'cross', target: 'caption' }],
            freezes: [{ t: 5.4, text: 'عشرة أضعاف!' }],
            transitions: [{ t: 12, kind: 'leak' }],
            behind: [{ t: 20, text: 'انتبه' }],
            emphasis: [5, 20],
        });
    });

    it('an answer with no touches, or not an object, is an empty plan', () => {
        assert.deepEqual(direction({ clip: 1, edits: [] }), EMPTY);
        for (const raw of [null, 42, 'x', [], { emphasis: 'x', cuts: {} }]) assert.deepEqual(direction(raw as never), EMPTY, JSON.stringify(raw));
        assert.deepEqual(direction({ emphasis: [null, 7, 'x', { word: 'عشرة' }] }).emphasis, [], 'items that anchor nowhere');
    });
});

describe('placeDirection — the clip’s window: nothing in its first 0.8 s or last 3.2 s', () => {
    it('drops a touch that lands in the first 0.8 s or the last 3.2 s, of every kind', () => {
        assert.equal(TOUCH_LEAD_S, 0.8);
        assert.equal(TOUCH_TAIL_S, 3.2);
        const d = direction({
            emphasis: [{ line: 1, word: 'وسهلا' }, { line: 5, word: 'اكتب' }, { line: 2, word: 'عشرة' }],
            doodles: [{ line: 1, word: 'أهلا', shape: 'arrow', target: 'head' }],
            transitions: [{ line: 5, word: 'كلمة', kind: 'flash' }],
            cuts: [{ line: 1, word: 'أهلا', shot: 'close' }],
            freezes: [{ line: 5, word: 'اكتب', text: 'اكتب' }],
            behind: [{ line: 1, word: 'أهلا', text: 'أهلا' }],
        });
        assert.deepEqual(d, { ...EMPTY, emphasis: [5] }, 'L1 is at 0.2 and 0.6 s, L5 at 27.5 and 28 s: past 26.8');
    });

    it('keeps the window’s edges: 0.8 s, and length − 3.2 s', () => {
        const edge: { t: number; words: TranscriptWord[] }[] = [{ t: 0.79, words: [[0.79, 1, 'قبل']] }, { t: 0.8, words: [[0.8, 1, 'أول']] }, { t: 26.8, words: [[26.8, 27, 'آخر']] }, { t: 26.81, words: [[26.81, 27, 'بعد']] }];
        const ts = direction({ emphasis: [1, 2, 3, 4].map((line) => ({ line, word: '' })) }, edge).emphasis;
        assert.deepEqual(ts, [0.8, 26.8]);
        assert.deepEqual(direction({ emphasis: [{ line: 3, word: '' }] }, edge, 29).emphasis, [], 'the tail moves with the clip’s length');
    });

    it('a clip shorter than 4 s takes none', () => {
        assert.deepEqual(direction({ emphasis: [{ line: 1, word: '' }] }, [{ t: 1, words: [[1, 1.5, 'كلمة']] }], 3.9), EMPTY);
    });
});

describe('placeDirection — the caps and the enums', () => {
    const list = (n: number, extra: (i: number) => Record<string, unknown> = () => ({})) =>
        Array.from({ length: n }, (_, i) => ({ line: i + 1, word: `كلمة${i + 1}`, ...extra(i) }));

    it('holds each list to its cap: emphasis 12, doodles 8, transitions 5, cuts 16, freezes 2, behind 6', () => {
        assert.deepEqual(TOUCH_CAP, { emphasis: 12, doodles: 8, transitions: 5, cuts: 16, freezes: 2, behind: 6 });
        const d = direction({
            emphasis: list(20),
            doodles: list(20, () => ({ shape: 'circle', target: 'caption' })),
            transitions: list(20, () => ({ kind: 'whip' })),
            cuts: list(30, (i) => ({ shot: i % 2 ? 'close' : 'wide' })),
            freezes: list(20, () => ({ text: 'لحظة' })),
            behind: list(20, () => ({ text: 'كلمة' })),
        }, MANY, 60);
        assert.deepEqual(Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v.length])), TOUCH_CAP);
        assert.deepEqual(d.emphasis, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'the first ones, in time order');
    });

    it('never two of one list at the same moment', () => {
        const d = direction({
            emphasis: [{ line: 2, word: 'عشرة' }, { line: 2, word: 'عشرة' }, { line: 2, word: 'غائبة' }],
            doodles: [{ line: 2, word: 'عشرة', shape: 'circle', target: 'caption' }, { line: 2, word: 'عشرة', shape: 'stars', target: 'caption' }],
        });
        assert.deepEqual(d.emphasis, [5]);
        assert.deepEqual(d.doodles, [{ t: 5, shape: 'circle', target: 'caption' }], 'the first said wins');
    });

    it('a cut to the shot already on is no cut', () => {
        const d = direction({ cuts: list(6, (i) => ({ shot: ['wide', 'wide', 'close', 'close', 'close', 'wide'][i] })) }, MANY, 60);
        assert.deepEqual(d.cuts, [{ t: 1, shot: 'wide' }, { t: 3, shot: 'close' }, { t: 6, shot: 'wide' }]);
    });

    it('takes only the small enums, exactly as written', () => {
        assert.deepEqual([...DOODLE_SHAPES], ['circle', 'underline', 'arrow', 'stars', 'check', 'cross']);
        assert.deepEqual([...DOODLE_TARGETS], ['caption', 'head']);
        assert.deepEqual([...TRANSITION_KINDS], ['leak', 'flash', 'whip', 'glitch']);
        assert.deepEqual([...SHOTS], ['wide', 'close']);
        const at = { line: 2, word: 'عشرة' };
        for (const [shape, target] of [['Circle', 'caption'], ['circle ', 'caption'], ['heart', 'caption'], ['circle', 'face'], ['circle', undefined], [undefined, 'head'], [1, 'head']]) {
            assert.deepEqual(direction({ doodles: [{ ...at, shape, target }] }).doodles, [], JSON.stringify([shape, target]));
        }
        for (const kind of ['cut', 'Leak', '', null, 'fade']) assert.deepEqual(direction({ transitions: [{ ...at, kind }] }).transitions, [], String(kind));
        for (const shot of ['medium', 'Close', '', null]) assert.deepEqual(direction({ cuts: [{ ...at, shot }] }).cuts, [], String(shot));
        for (const shape of DOODLE_SHAPES) assert.equal(direction({ doodles: [{ ...at, shape, target: 'head' }] }).doodles.length, 1, shape);
        for (const kind of TRANSITION_KINDS) assert.equal(direction({ transitions: [{ ...at, kind }] }).transitions.length, 1, kind);
    });

    it('keeps a freeze’s or a behind’s text through phrase(): 1-2 words, within its characters, else the touch is dropped', () => {
        const freeze = (text: unknown) => direction({ freezes: [{ line: 3, word: 'الخرافة', text }] }).freezes;
        const behind = (text: unknown) => direction({ behind: [{ line: 3, word: 'الخرافة', text }] }).behind;
        assert.deepEqual(PHRASE_LIMITS.freeze, [2, 18]);
        assert.deepEqual(PHRASE_LIMITS.behind, [2, 16]);
        assert.deepEqual(freeze(' ❌ خرافة  '), [{ t: 12, text: 'خرافة' }], 'trimmed, the drawn mark stripped');
        assert.deepEqual(behind('الذكاء الاصطناعي'), [{ t: 12, text: 'الذكاء الاصطناعي' }], 'two words, 16 characters');
        for (const bad of ['ثلاث كلمات هنا', '', '   ', null, 7, ['خرافة'], 'ك'.repeat(19)]) assert.deepEqual(freeze(bad), [], JSON.stringify(bad));
        for (const bad of ['ثلاث كلمات هنا', 'ك'.repeat(17), undefined]) assert.deepEqual(behind(bad), [], JSON.stringify(bad));
    });
});

describe('directionsByClip — by C<n>, on each clip’s own clock', () => {
    it('gives each clip its plan by number, and null to a clip the answer skipped', () => {
        const raw = { clips: [{ clip: 2, emphasis: [{ line: 1, word: 'كلمة1' }] }, { clip: 1, emphasis: [{ line: 2, word: 'عشرة' }] }] };
        assert.deepEqual(directionsByClip(raw, [TALK, MANY, TALK], [CLIP_S, 60, CLIP_S]), [{ ...EMPTY, emphasis: [5] }, { ...EMPTY, emphasis: [1] }, null]);
        assert.deepEqual(directionsByClip(null, [TALK], [CLIP_S]), [null]);
    });

    it('holds each clip to its own length', () => {
        const raw = { clips: [{ clip: 1, emphasis: [{ line: 4, word: 'انتبه' }] }, { clip: 2, emphasis: [{ line: 4, word: 'انتبه' }] }] };
        assert.deepEqual(directionsByClip(raw, [TALK, TALK], [CLIP_S, 22]).map((d) => d!.emphasis), [[20], []], '20 s is past 22 − 3.2');
    });
});

describe('the Editor prompt and schema — the human touches', () => {
    const OFF = { ...ELAMIR_SETTINGS, monteur: { ...ELAMIR_SETTINGS.monteur, human: false } };
    const clipItem = (schema: GeminiSchema) => schema.properties!.clips!.items!;

    it('asks for them, with the rules, when monteur.human is on (the default), and not when it is off', () => {
        assert.equal(ELAMIR_SETTINGS.monteur.human, true);
        assert.equal(humanTouchesOn(ELAMIR_SETTINGS), true);
        assert.equal(humanTouchesOn(OFF), false);
        const on = editorSystemPrompt(ELAMIR_SETTINGS);
        assert.ok(on.includes(`\n${HUMAN_TOUCHES_PROMPT}\n`));
        for (const rule of [
            'emphasis: 6-12 caption words that carry the meaning', 'doodles: 4-8 hand-drawn marker doodles', 'a cross on a myth, a check on the truth',
            'transitions: 3-5, each at a change of section', 'leak for a new chapter, flash for a reveal, whip for a fast change, glitch for a tech or signal moment',
            'Talking-head clips only (a person speaking to camera, portrait); leave cuts, freezes and behind empty for a screen recording',
            'switching at a sentence\'s start every 3-7 seconds, close on the key lines', 'freezes: at most 2 freeze-frames', 'behind: 3-6 big words',
            'vary them, nothing on a fixed rhythm; invent nothing',
        ]) assert.ok(on.includes(rule), rule);
        assert.match(on, /^You are the editor of short vertical reels cut from a creator's lessons, screen-recorded or spoken to camera\./);
        const off = editorSystemPrompt(OFF);
        assert.ok(!off.includes('Human touches') && !off.includes('doodle') && !off.includes('emphasis'));
        assert.match(off, /^You are the editor of short vertical reels cut from a creator's screen-recorded lessons\./, 'the prompt as it was');
        assert.equal(off, on.replace(`\n${HUMAN_TOUCHES_PROMPT}`, '').replace("creator's lessons, screen-recorded or spoken to camera", "creator's screen-recorded lessons"));
    });

    it('puts six optional lists next to each clip’s edits, in order, each anchored on line and word', () => {
        const item = clipItem(EDITOR_SCHEMA);
        assert.deepEqual(item.propertyOrdering, ['clip', 'edits', 'emphasis', 'doodles', 'transitions', 'cuts', 'freezes', 'behind']);
        assert.deepEqual([...item.propertyOrdering!].sort(), Object.keys(item.properties!).sort());
        assert.deepEqual(item.required, ['clip', 'edits'], 'the touches are optional');
        const fields: Record<string, string[]> = { emphasis: [], doodles: ['shape', 'target'], transitions: ['kind'], cuts: ['shot'], freezes: ['text'], behind: ['text'] };
        for (const [key, extra] of Object.entries(fields)) {
            const list = item.properties![key]!;
            assert.equal(list.type, 'ARRAY', key);
            const touch = list.items!;
            assert.deepEqual(touch.propertyOrdering, ['line', 'word', ...extra], key);
            assert.deepEqual(touch.required, ['line', 'word', ...extra], key);
            assert.deepEqual([...touch.propertyOrdering!].sort(), Object.keys(touch.properties!).sort(), key);
            assert.equal(touch.properties!.line!.type, 'INTEGER');
            for (const [name, prop] of Object.entries(touch.properties!)) assert.ok((prop.enum?.length ?? 0) <= 6, `${key}.${name}: a big enum is an HTTP 400`);
        }
        assert.deepEqual(item.properties!.doodles!.items!.properties!.shape!.enum, [...DOODLE_SHAPES]);
        assert.deepEqual(item.properties!.doodles!.items!.properties!.target!.enum, [...DOODLE_TARGETS]);
        assert.deepEqual(item.properties!.transitions!.items!.properties!.kind!.enum, [...TRANSITION_KINDS]);
        assert.deepEqual(item.properties!.cuts!.items!.properties!.shot!.enum, [...SHOTS]);
        assert.equal(item.properties!.freezes!.items!.properties!.text!.enum, undefined);
        assert.deepEqual([...TALKING_HEAD_TOUCHES], ['cuts', 'freezes', 'behind']);
    });

    it('has none of them when monteur.human is off: the schema as it was', () => {
        const item = clipItem(editorSchema(false));
        assert.deepEqual(item.propertyOrdering, ['clip', 'edits']);
        assert.deepEqual(Object.keys(item.properties!), ['clip', 'edits']);
        assert.deepEqual(item.properties!.edits, clipItem(EDITOR_SCHEMA).properties!.edits, 'the same edits either way');
        assert.deepEqual(editorSchema(true), EDITOR_SCHEMA);
    });

    it('converts for Claude on the Mac: enums kept, every object closed, no propertyOrdering', () => {
        const json = toJsonSchema(EDITOR_SCHEMA) as { properties: { clips: { items: { properties: Record<string, { type: string; items: Record<string, unknown> & { properties: Record<string, { type: string; enum?: string[] }> } }>; required: string[] } } } };
        const clip = json.properties.clips.items;
        assert.deepEqual(clip.required, ['clip', 'edits']);
        assert.deepEqual(clip.properties.doodles!.items, {
            type: 'object',
            properties: {
                line: { type: 'integer', description: 'the n of the line, L<n>' },
                word: { type: 'string', description: 'the exact word in that line it lands on' },
                shape: { type: 'string', enum: [...DOODLE_SHAPES] },
                target: { type: 'string', enum: [...DOODLE_TARGETS] },
            },
            required: ['line', 'word', 'shape', 'target'],
            additionalProperties: false,
        });
        assert.deepEqual(clip.properties.cuts!.items.properties.shot, { type: 'string', enum: ['wide', 'close'] });
        assert.deepEqual(clip.properties.emphasis!.items.required, ['line', 'word']);
        assert.ok(!JSON.stringify(json).includes('propertyOrdering'));
    });
});

describe('migration v29', () => {
    const sql = readFileSync(new URL('../../config/migration_v29_monteur_direction.sql', import.meta.url), 'utf8');
    it('adds clip_drafts.direction, nullable and idempotent', () => {
        const statements = sql.split('\n').filter((l) => !l.startsWith('--') && l.trim());
        assert.deepEqual(statements, ['ALTER TABLE clip_drafts ADD COLUMN IF NOT EXISTS direction JSONB;']);
    });
});
