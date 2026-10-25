/**
 * The words a picture is drawn from (T038, research.md R5): the order they come in, the rules every picture carries, the seed, and the guard that
 * refuses a woman or a girl BEFORE anything is sent to the provider.
 *
 * One deliberate difference from the plan: the people rule is POSITIVE. "Every person in the picture is a man or a boy" and not "no women or
 * girls", because a diffusion prompt that names what it must not draw can prime the model with it (the lead's change, 2026-10-25). The guard
 * still refuses a brief, a note or a character description that names a woman or a girl: that check is on OUR side of the provider.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExplainerError } from '../errors.js';
import { findFemaleSubject } from '../spec.js';
import {
    buildCandidatePrompt, buildScenePrompt, CANDIDATE_SIZE, MAX_CHARACTER_DESCRIPTION_CHARS, MAX_NOTE_CHARS, pictureSeed, promptHash, SCENE_SIZE,
    TEST_PROMPT, TEST_SIZE,
} from './prompt.js';

const STYLE = 'warm hand-painted gouache illustration, soft paper texture, beige and terracotta palette';
const KARIM = { key: 'karim', description: 'a curious young man with a round head, short dark hair, dot eyes, dark green sweater' };
const SAMIR = { key: 'samir', description: 'an old man with a white beard and round glasses' };

const refused = (field: string, word: string) => (err: unknown) =>
    err instanceof ExplainerError && err.code === 'EXPLAINER_PROMPT_REFUSED' && err.status === 422
    && err.params?.field === field && err.params?.word === word && err.message.includes(`«${word}»`);

describe('the sizes', () => {
    it('are 1024×576 for a scene, 448×448 for a candidate (so an approved one always fits under 512) and 256×256 for the test', () => {
        assert.deepEqual(SCENE_SIZE, { width: 1024, height: 576 });
        assert.deepEqual(CANDIDATE_SIZE, { width: 448, height: 448 });
        assert.deepEqual(TEST_SIZE, { width: 256, height: 256 });
        assert.ok(CANDIDATE_SIZE.width < 512 && CANDIDATE_SIZE.height < 512);
    });
});

describe('buildScenePrompt — the order', () => {
    const prompt = buildScenePrompt({ style: STYLE, characters: [KARIM, SAMIR], brief: 'Karim points at a stack of books while Samir watches.', note: 'Karim is smiling.' });
    const at = (needle: string | RegExp): number => {
        const found = typeof needle === 'string' ? prompt.indexOf(needle) : prompt.search(needle);
        assert.ok(found >= 0, `${String(needle)} is in the prompt:\n${prompt}`);
        return found;
    };

    it('is the style, then the characters named by image index, then the brief, then the note, then the fixed rules', () => {
        const order = [at(STYLE), at('image 0'), at('image 1'), at('Karim points at a stack of books'), at('Karim is smiling'), at('16:9')];
        assert.deepEqual(order, [...order].sort((a, b) => a - b), `in this order:\n${prompt}`);
    });

    it('names each character by the index of the reference picture it is sent as, in the order the scene lists them', () => {
        assert.match(prompt, /Image 0 is karim, a recurring character: a curious young man with a round head/);
        assert.match(prompt, /Image 1 is samir, a recurring character: an old man with a white beard/);
        assert.match(prompt, /Keep karim exactly as in image 0/);
        assert.match(prompt, /Keep samir exactly as in image 1/);
        assert.ok(at('Image 0') < at('Image 1'));
    });

    it('carries the fixed rules: 16:9, the top quarter left empty for the label, no text of any kind, no real faces', () => {
        assert.match(prompt, /16:9/);
        assert.match(prompt, /top quarter of the picture calm and empty/i);
        assert.match(prompt, /no text, letters, numbers or signage/i);
        assert.match(prompt, /no real people's faces/i);
    });

    it('states the people rule as what IS drawn, about humans only (a robot is not asked to be a man): every human is a man or a boy', () => {
        assert.match(prompt, /every human in the picture is a man or a boy/i);
        assert.doesNotMatch(prompt, /every person/i);
    });

    it('never names what it must not draw about people: no "no women", no "girls", no negation of a female word', () => {
        assert.doesNotMatch(prompt, /women|woman|girl|female|lady|ladies/i);
        assert.doesNotMatch(prompt, /\b(?:no|not|never|without|except|avoid)\b[^.\n]*\b(?:women|woman|girls?|female)\b/i);
    });

    it('passes its own guard: nothing in the fixed text trips the check that is run on the words of the owner', () => {
        assert.equal(findFemaleSubject(prompt), null);
        assert.equal(findFemaleSubject(buildScenePrompt({ style: STYLE, characters: [], brief: 'A lamp on a desk.' })), null);
    });
});

describe('buildScenePrompt — what is left out', () => {
    it('has no character section for a scene that names no character, and no note line without a note', () => {
        const prompt = buildScenePrompt({ style: STYLE, characters: [], brief: 'A glowing lightbulb above a stack of papers.' });
        assert.doesNotMatch(prompt, /image 0/i);
        assert.doesNotMatch(prompt, /recurring character/i);
        assert.doesNotMatch(prompt, /Change for this drawing/);
        assert.match(prompt, /^Style: warm hand-painted/);
        assert.match(prompt, /Scene: A glowing lightbulb above a stack of papers\./);
    });

    it('treats a blank note as no note, and a blank style as no style line', () => {
        const prompt = buildScenePrompt({ style: '   ', characters: [], brief: 'A lamp.', note: '   ' });
        assert.doesNotMatch(prompt, /Style:/);
        assert.doesNotMatch(prompt, /Change for this drawing/);
        assert.match(prompt, /^Scene: A lamp\./);
    });

    it('puts the note after the brief as a change to this drawing', () => {
        const prompt = buildScenePrompt({ style: STYLE, characters: [], brief: 'A man at a desk.', note: 'he is holding a book, smiling' });
        assert.match(prompt, /Scene: A man at a desk\.\nChange for this drawing: he is holding a book, smiling\n/);
    });

    it('is the same text for the same input: nothing in it depends on the clock or on chance', () => {
        const input = { style: STYLE, characters: [KARIM], brief: 'Karim reads.', note: null } as const;
        assert.equal(buildScenePrompt(input), buildScenePrompt({ ...input }));
    });
});

describe('buildScenePrompt — the guard', () => {
    const base = { style: STYLE, characters: [KARIM], brief: 'Karim reads a book at a desk.' };

    it('refuses a brief that names a woman or a girl: 422 EXPLAINER_PROMPT_REFUSED, the word and the field in the answer', () => {
        assert.throws(() => buildScenePrompt({ ...base, brief: 'A woman reads a book at a desk.' }), refused('brief', 'woman'));
        assert.throws(() => buildScenePrompt({ ...base, brief: 'Karim talks to his mother.' }), refused('brief', 'mother'));
        assert.throws(() => buildScenePrompt({ ...base, brief: 'Two GIRLS laugh.' }), refused('brief', 'GIRLS'));
    });

    it('refuses a redraw note that does: «she is smiling», and the same in Arabic', () => {
        assert.throws(() => buildScenePrompt({ ...base, note: 'she is smiling' }), refused('note', 'she'));
        assert.throws(() => buildScenePrompt({ ...base, note: 'فتاة تبتسم' }), refused('note', 'فتاة'));
    });

    it('refuses a character whose description names a woman or a girl, and says which character', () => {
        const err = (() => { try { buildScenePrompt({ ...base, characters: [KARIM, { key: 'lina', description: 'a young woman with a red scarf' }] }); } catch (e) { return e; } return null; })();
        assert.ok(err instanceof ExplainerError);
        assert.equal(err.code, 'EXPLAINER_PROMPT_REFUSED');
        assert.deepEqual(err.params, { field: 'character', character: 'lina', word: 'woman' });
        assert.match(err.message, /«lina»/);
    });

    it('checks the brief first, then the note, then the characters: one refusal at a time, the first it finds', () => {
        assert.throws(
            () => buildScenePrompt({ style: STYLE, characters: [{ key: 'lina', description: 'a woman' }], brief: 'A girl', note: 'she' }),
            refused('brief', 'girl')
        );
    });

    it('does not refuse what only looks like a female word: «human», «manual», «examples», «أمثلة»', () => {
        assert.doesNotThrow(() => buildScenePrompt({ ...base, brief: 'A human at a desk reads a manual with examples.', note: 'أمثلة كثيرة' }));
    });

    it('refuses an empty brief and a note over 300 characters: nothing to draw, or more than the field takes', () => {
        const empty = (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINER_PROMPT_REFUSED' && err.params?.field === 'brief';
        assert.throws(() => buildScenePrompt({ ...base, brief: '   ' }), empty);
        const long = (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINER_PROMPT_REFUSED' && err.params?.field === 'note';
        assert.equal(MAX_NOTE_CHARS, 300);
        assert.doesNotThrow(() => buildScenePrompt({ ...base, note: 'x'.repeat(300) }));
        assert.throws(() => buildScenePrompt({ ...base, note: 'x'.repeat(301) }), long);
    });
});

describe('buildCandidatePrompt', () => {
    it('is the style, then the character to design, then the rules for a reference picture: one figure, plain background, whole body', () => {
        const prompt = buildCandidatePrompt({ style: STYLE, description: KARIM.description });
        assert.ok(prompt.indexOf(STYLE) < prompt.indexOf(KARIM.description));
        assert.ok(prompt.indexOf(KARIM.description) < prompt.search(/no text, letters, numbers or signage/i));
        assert.match(prompt, /single recurring cartoon character/);
        assert.match(prompt, /plain light background/);
        assert.match(prompt, /every human in the picture is a man or a boy/i);
        assert.match(prompt, /no real people's faces/i);
        assert.doesNotMatch(prompt, /top quarter/i, 'a character sheet has no label to leave room for');
        assert.doesNotMatch(prompt, /women|woman|girl|female/i);
    });

    it('refuses a description that names a woman or a girl, before anything else: 422 EXPLAINER_PROMPT_REFUSED', () => {
        assert.throws(() => buildCandidatePrompt({ style: STYLE, description: 'a young woman with long hair' }), refused('description', 'woman'));
        // The guard reports the word as it was typed, with the conjunction «و» (and) that came attached to it.
        assert.throws(() => buildCandidatePrompt({ style: STYLE, description: 'رجل وبنت صغيرة' }), refused('description', 'وبنت'));
    });

    it('refuses an empty description and one longer than the 400 characters a character may have', () => {
        const bad = (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINER_PROMPT_REFUSED' && err.params?.field === 'description';
        assert.throws(() => buildCandidatePrompt({ style: STYLE, description: '  ' }), bad);
        assert.equal(MAX_CHARACTER_DESCRIPTION_CHARS, 400);
        assert.doesNotThrow(() => buildCandidatePrompt({ style: STYLE, description: 'x'.repeat(400) }));
        assert.throws(() => buildCandidatePrompt({ style: STYLE, description: 'x'.repeat(401) }), bad);
    });
});

describe('TEST_PROMPT', () => {
    it('draws no person at all, so the provider test needs no guard and primes nothing', () => {
        assert.equal(findFemaleSubject(TEST_PROMPT), null);
        assert.doesNotMatch(TEST_PROMPT, /person|people|man|boy|face/i);
    });
});

describe('pictureSeed', () => {
    const ID = '11111111-aaaa-4aaa-8aaa-111111111111';

    it('is derived from the explainer, the position and the attempt: the same three give the same seed, always', () => {
        assert.equal(pictureSeed(ID, 3, 0), pictureSeed(ID, 3, 0));
        assert.equal(pictureSeed(ID.toUpperCase(), 3, 0), pictureSeed(ID, 3, 0), 'an id is the same id in either case');
    });

    it('changes with each of the three, so a redraw (attempt + 1) is not the picture that was disliked', () => {
        const seeds = new Set([pictureSeed(ID, 3, 0), pictureSeed(ID, 3, 1), pictureSeed(ID, 3, 2), pictureSeed(ID, 4, 0), pictureSeed(ID, 2, 0), pictureSeed('22222222-bbbb-4bbb-8bbb-222222222222', 3, 0)]);
        assert.equal(seeds.size, 6);
    });

    it('is a whole number from 0 up to, not including, 2^31, whatever the input', () => {
        for (let position = 0; position < 300; position++) {
            for (const attempt of [0, 1, 7]) {
                const seed = pictureSeed(ID, position, attempt);
                assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 31, `${position}/${attempt}: ${seed}`);
            }
        }
    });

    it('does not confuse (position 1, attempt 23) with (position 12, attempt 3): the parts are separated', () => {
        assert.notEqual(pictureSeed(ID, 1, 23), pictureSeed(ID, 12, 3));
    });
});

describe('promptHash', () => {
    const base = { width: 1024, height: 576, references: ['aaa', 'bbb'] };

    it('is a stable SHA-256 of the prompt, the size and the references', () => {
        assert.match(promptHash('p', base), /^[0-9a-f]{64}$/);
        assert.equal(promptHash('p', base), promptHash('p', { ...base, references: ['aaa', 'bbb'] }));
    });

    it('changes with the prompt, the size, and the references and their order (the order is the image index)', () => {
        const hashes = new Set([
            promptHash('p', base), promptHash('q', base), promptHash('p', { ...base, width: 448 }), promptHash('p', { ...base, height: 448 }),
            promptHash('p', { ...base, references: ['bbb', 'aaa'] }), promptHash('p', { ...base, references: ['aaa'] }), promptHash('p', { ...base, references: [] }),
        ]);
        assert.equal(hashes.size, 7);
    });
});

describe('a scene with two characters or more (the pilot drew Karim twice and no robot, 2026-10-25)', () => {
    const ROBOT = { key: 'robot', description: 'a small friendly robot with a cream box head and one big round eye' };
    const two = buildScenePrompt({ style: STYLE, characters: [KARIM, ROBOT], brief: 'robot points at a paper strip while karim reads it' });
    const one = buildScenePrompt({ style: STYLE, characters: [KARIM], brief: 'karim reads a paper strip' });
    it('ties each image to the key the brief names', () => {
        assert.match(two, /Image 0 is karim, a recurring character: a curious young man/);
        assert.match(two, /Image 1 is robot, a recurring character: a small friendly robot/);
        assert.match(two, /Keep robot exactly as in image 1/);
    });
    it('asks for each character exactly once, looking like its own image, and only when there are two or more', () => {
        assert.match(two, /Each named character appears exactly once, looking like its own image and not like the other characters\./);
        assert.doesNotMatch(one, /Each named character appears exactly once/);
        assert.match(one, /every human in the picture is a man or a boy/i);
    });
});
