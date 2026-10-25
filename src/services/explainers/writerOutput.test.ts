/**
 * Reading the writer's answer (writerOutput.ts): the small JSON Schema check, a port of the worker's, and `parseWriterOutput`, which holds an answer to the
 * contract's schema and gives back a typed, trimmed draft. Pure.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkDraft } from './spec.js';
import { validWriterOutput, writerScene } from './testFixtures.js';
import { assertCheckable, parseWriterOutput, schemaProblems } from './writerOutput.js';

describe('schemaProblems: the keywords the writer schema uses', () => {
    it('is empty for a value that fits, and for a schema of true', () => {
        assert.deepEqual(schemaProblems({ type: 'string', maxLength: 3 }, 'abc'), []);
        assert.deepEqual(schemaProblems(true, { anything: 1 }), []);
    });

    it('type: names what it was, and "a number" accepts an integer but "an integer" refuses 1.5', () => {
        assert.deepEqual(schemaProblems({ type: 'string' }, 7), ['the answer must be a string, not an integer']);
        assert.deepEqual(schemaProblems({ type: 'string' }, null), ['the answer must be a string, not null']);
        assert.deepEqual(schemaProblems({ type: 'string' }, ['x']), ['the answer must be a string, not an array']);
        assert.deepEqual(schemaProblems({ type: 'number' }, 3), []);
        assert.deepEqual(schemaProblems({ type: 'integer' }, 1.5), ['the answer must be an integer, not 1.5']);
        assert.deepEqual(schemaProblems({ type: 'boolean' }, 'true'), ['the answer must be a boolean, not a string']);
        assert.deepEqual(schemaProblems({ type: 'object' }, []), ['the answer must be an object, not an array']);
    });

    it('minLength and maxLength count code points, so an emoji is one character', () => {
        assert.deepEqual(schemaProblems({ type: 'string', maxLength: 2 }, '😀😀'), []);
        assert.deepEqual(schemaProblems({ type: 'string', maxLength: 2 }, '😀😀😀'), ['the answer is 3 characters; at most 2 are allowed']);
        assert.deepEqual(schemaProblems({ type: 'string', minLength: 2 }, ''), ['the answer is empty; at least 2 are needed']);
        assert.deepEqual(schemaProblems({ type: 'string', minLength: 2 }, 'a'), ['the answer is 1 character; at least 2 are needed']);
    });

    it('minItems and maxItems, with the items checked and named by index', () => {
        const schema = { type: 'array', minItems: 1, maxItems: 2, items: { type: 'integer', minimum: 0 } };
        assert.deepEqual(schemaProblems(schema, [0, 1]), []);
        assert.deepEqual(schemaProblems(schema, []), ['the answer has no items; at least 1 are needed']);
        assert.deepEqual(schemaProblems(schema, [0, 1, 2]), ['the answer has 3 items; at most 2 are allowed']);
        assert.deepEqual(schemaProblems(schema, [0, -1]), ['the answer[1] is -1; at least 0 is needed']);
        assert.deepEqual(schemaProblems(schema, [0, 'x']), ['the answer[1] must be an integer, not a string']);
    });

    it('required, properties and additionalProperties:false, with a path to the key', () => {
        const schema = { type: 'object', required: ['a'], additionalProperties: false, properties: { a: { type: 'string' }, b: { type: 'object', properties: { c: { type: 'string' } } } } };
        assert.deepEqual(schemaProblems(schema, { a: 'x' }), []);
        assert.deepEqual(schemaProblems(schema, {}), ['the answer is missing "a"']);
        assert.deepEqual(schemaProblems(schema, { a: 'x', z: 1 }), ['the answer has "z", which isn\'t allowed']);
        assert.deepEqual(schemaProblems(schema, { a: 'x', b: { c: 5 } }), ['b.c must be a string, not an integer']);
    });

    it('enum, const, pattern and maximum', () => {
        assert.deepEqual(schemaProblems({ enum: ['a', 'b'] }, 'c'), ['the answer must be one of "a", "b"']);
        assert.deepEqual(schemaProblems({ const: 3 }, 4), ['the answer must be 3']);
        assert.deepEqual(schemaProblems({ type: 'string', pattern: '^\\d+$' }, 'x1'), ['the answer doesn\'t match the pattern ^\\d+$']);
        assert.deepEqual(schemaProblems({ type: 'integer', maximum: 3 }, 4), ['the answer is 4; at most 3 is allowed']);
    });

    it('a schema of false allows nothing', () => {
        assert.deepEqual(schemaProblems(false, 1), ['the answer isn\'t allowed']);
    });

    it('stops listing at 200 problems: the rest are the same mistake again', () => {
        const problems = schemaProblems({ type: 'array', items: { type: 'string' } }, Array.from({ length: 500 }, () => 1));
        assert.ok(problems.length >= 200 && problems.length <= 201, String(problems.length));
    });
});

describe('assertCheckable', () => {
    it('refuses a keyword it does not enforce, anywhere in the schema: a check that ignored one would pass what the schema forbids', () => {
        assert.throws(() => assertCheckable({ type: 'object', anyOf: [] }), /uses "anyOf"/);
        assert.throws(() => assertCheckable({ type: 'object', properties: { a: { type: 'string', format: 'email' } } }), /properties\.a uses "format"/);
        assert.throws(() => assertCheckable({ type: 'array', items: { type: 'object', additionalProperties: { $ref: '#/x' } } }), /additionalProperties uses "\$ref"/);
        assert.throws(() => assertCheckable('string'), /not a JSON Schema/);
        assert.doesNotThrow(() => assertCheckable({ $schema: 'x', title: 't', description: 'd', type: 'object', additionalProperties: false, properties: {} }));
    });
});

describe('parseWriterOutput', () => {
    it('gives back a valid answer as a typed draft', () => {
        const parsed = parseWriterOutput(validWriterOutput(12));
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.output.scenes.length, 12);
        assert.deepEqual(parsed.output.scenes[0]!.source_ids, [0]);
        assert.equal(parsed.output.captions.youtube.title, 'Why AI answers with confidence');
        assert.equal(parsed.output.sources.length, 3);
        // And what it gives is a draft the rest of the pipeline accepts.
        assert.deepEqual(checkDraft(parsed.output, { tier: 'short', language: 'en' }).problems, []);
    });

    it('trims every string, so the limits are counted on what is stored', () => {
        const raw = validWriterOutput(12);
        raw.title = '  Why AI answers  ';
        raw.scenes[0] = writerScene(0, { narration: '  A sentence.  ', label: ' RAG ', brief: '  karim at a desk, wide shot  ', characters: [' karim ', '  '] });
        raw.sources[0]!.url = ' https://arxiv.org/abs/2005.11401 ';
        const parsed = parseWriterOutput(raw);
        assert.equal(parsed.ok, true);
        if (!parsed.ok) return;
        assert.equal(parsed.output.title, 'Why AI answers');
        assert.deepEqual([parsed.output.scenes[0]!.narration, parsed.output.scenes[0]!.label, parsed.output.scenes[0]!.brief], ['A sentence.', 'RAG', 'karim at a desk, wide shot']);
        assert.deepEqual(parsed.output.scenes[0]!.characters, ['karim'], 'a blank key is dropped');
        assert.equal(parsed.output.sources[0]!.url, 'https://arxiv.org/abs/2005.11401');
    });

    it('does not mutate the answer it was given', () => {
        const raw = validWriterOutput(12);
        const before = JSON.stringify(raw);
        parseWriterOutput(raw);
        assert.equal(JSON.stringify(raw), before);
    });

    const refused = (raw: unknown): string[] => {
        const parsed = parseWriterOutput(raw);
        assert.equal(parsed.ok, false);
        return parsed.ok ? [] : parsed.problems;
    };

    it('refuses what is not an object, naming it', () => {
        assert.deepEqual(refused('a script'), ['the answer must be an object, not a string']);
        assert.deepEqual(refused(null), ['the answer must be an object, not null']);
        assert.deepEqual(refused([]), ['the answer must be an object, not an array']);
    });

    it('refuses a missing field and an extra one, by name', () => {
        const { sources: _sources, ...noSources } = validWriterOutput(12);
        assert.deepEqual(refused(noSources), ['the answer is missing "sources"']);
        assert.deepEqual(refused({ ...validWriterOutput(12), extra: true }), ['the answer has "extra", which isn\'t allowed']);
    });

    it('refuses fewer than 10 scenes, a scene past its limits and fewer than 5 replies, each with its place', () => {
        assert.deepEqual(refused(validWriterOutput(9)), ['scenes has 9 items; at least 10 are needed']);
        const long = validWriterOutput(12);
        long.scenes[3] = writerScene(3, { narration: 'x'.repeat(301), label: 'y'.repeat(41) });
        assert.deepEqual(refused(long), [
            'scenes[3].narration is 301 characters; at most 300 are allowed',
            'scenes[3].label is 41 characters; at most 40 are allowed',
        ]);
        const few = validWriterOutput(12);
        few.replies = few.replies.slice(0, 4);
        assert.deepEqual(refused(few), ['replies has 4 items; at least 5 are needed']);
    });

    it('refuses a source id that is not a whole number from 0, and a boolean that is a string', () => {
        const raw = validWriterOutput(12);
        raw.scenes[1] = writerScene(1, { source_ids: [-1] });
        raw.scenes[2] = writerScene(2, { source_ids: [1.5] });
        raw.scenes[4] = writerScene(4, { continues: 'false' as unknown as boolean });
        assert.deepEqual(refused(raw), [
            'scenes[1].source_ids[0] is -1; at least 0 is needed',
            'scenes[2].source_ids[0] must be an integer, not 1.5',
            'scenes[4].continues must be a boolean, not a string',
        ]);
    });

    it('refuses an answer whose nested objects have a key the schema does not name', () => {
        const raw = validWriterOutput(12) as any;
        raw.captions.youtube.hashtags = '#x';
        raw.sources[0].doi = '10.1/x';
        assert.deepEqual(refused(raw), ['captions.youtube has "hashtags", which isn\'t allowed', 'sources[0] has "doi", which isn\'t allowed']);
    });
});
