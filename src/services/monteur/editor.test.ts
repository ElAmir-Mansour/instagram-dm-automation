/**
 * The Editor's rules (MONTEUR.md §6.2) that code, not the prompt, holds: where an edit lands, what
 * an image asks the worker's free photo library for, and the per-clip limits. The call itself, and
 * what a failure does to a reel, are in sweep.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TranscriptWord } from '../../db/rows.js';
import { ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { EDITOR_SCHEMA, editorSystemPrompt, LIBRARY_TOPICS, MAX_IMAGES_PER_CLIP, MAX_QUERY, placeEdits } from './editor.js';

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
        assert.ok(system.includes('- image: a photo card over the video'));
        assert.ok(system.includes('- broll: a full-screen photo cutaway'));
        assert.ok(system.includes('Use 3-4 pictures per clip'));
        assert.doesNotMatch(system, /illustration|prompt:|generat/);
    });

    it('names `query`, not `prompt`, in the schema', () => {
        const item = (EDITOR_SCHEMA as unknown as { properties: { clips: { items: { properties: { edits: { items: { properties: Record<string, { description?: string }>; propertyOrdering: string[] } } } } } } })
            .properties.clips.items.properties.edits.items;
        assert.ok('query' in item.properties && !('prompt' in item.properties));
        assert.deepEqual((item.properties.query as unknown as { enum: string[] }).enum, [...LIBRARY_TOPICS], 'a library topic, from the fixed list');
        assert.deepEqual(item.propertyOrdering, ['line', 'word', 'kind', 'text', 'emoji', 'query', 'sfx']);
    });
});
