/**
 * The schema a model answers in: the conversion from the app's own type, OpenAI's strict-mode
 * reshaping, and the undoing of it when the answer is read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { COACH_SCHEMA } from '../growth/coach.js';
import { KEYWORDS_SCHEMA } from '../growth/keywords.js';
import { LESSONS_SCHEMA } from '../monteur/analyst.js';
import { COPY_SCHEMA } from '../monteur/copy.js';
import { editorSchema } from '../monteur/editor.js';
import { PICK_SCHEMA } from '../monteur/pick.js';
import { toJsonSchema as thinkToJsonSchema } from '../monteur/think.js';
import { DRAFT_SCHEMA, PLAN_SCHEMA, SLIDE_SCHEMA, withoutArrayBounds as generateWithoutArrayBounds } from '../studio/generate.js';
import { MAX_OPTIONAL_PROPERTIES, MAX_UNION_PROPERTIES } from './adapters/anthropic.js';
import { toJsonSchema, withoutArrayBounds, type GeminiSchema } from './geminiSchema.js';
import { dropNulls, jsonSchemaFor, matchesRoot, rootKind, schemaComplexity, strictify, type JsonSchema } from './schema.js';

/** A schema with every shape strict mode has to deal with. */
const original: JsonSchema = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        subtitle: { type: 'string', description: 'Optional.' },
        mood: { type: 'string', enum: ['calm', 'bold'] },
        count: { type: 'integer' },
        author: { type: 'object', properties: { name: { type: 'string' }, handle: { type: 'string' } }, required: ['name'] },
        slides: {
            type: 'array',
            items: { type: 'object', properties: { text: { type: 'string' }, note: { type: 'string' } }, required: ['text'] },
        },
    },
    required: ['title'],
};

/** Every object inside a schema, to check a property of all of them at once. */
function objectsIn(node: unknown, found: Array<Record<string, any>> = []): Array<Record<string, any>> {
    if (Array.isArray(node)) node.forEach((n) => objectsIn(n, found));
    else if (node && typeof node === 'object') {
        const n = node as Record<string, any>;
        if (n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'))) found.push(n);
        Object.values(n).forEach((v) => objectsIn(v, found));
    }
    return found;
}

describe('jsonSchemaFor', () => {
    const gemini: GeminiSchema = {
        type: 'OBJECT',
        description: 'A thing',
        properties: {
            name: { type: 'STRING', description: 'its name' },
            kind: { type: 'STRING', enum: ['a', 'b'] },
            tags: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 1, maxItems: 5 },
            size: { type: 'INTEGER' },
        },
        required: ['name'],
        propertyOrdering: ['name', 'kind', 'tags', 'size'],
    };

    it('turns the app\'s Gemini schema into JSON Schema: lower-case types, closed objects, no Gemini-only fields', () => {
        assert.deepEqual(jsonSchemaFor(gemini), {
            type: 'object',
            description: 'A thing',
            properties: {
                name: { type: 'string', description: 'its name' },
                kind: { type: 'string', enum: ['a', 'b'] },
                tags: { type: 'array', items: { type: 'string' } },
                size: { type: 'integer' },
            },
            required: ['name'],
            additionalProperties: false,
        });
    });

    it('drops the array bounds structured output refuses', () => {
        assert.ok(!JSON.stringify(jsonSchemaFor(gemini)).includes('minItems'));
        assert.ok(!JSON.stringify(jsonSchemaFor(gemini)).includes('maxItems'));
    });

    it('does not touch the schema it was given', () => {
        const before = JSON.stringify(gemini);
        jsonSchemaFor(gemini);
        assert.equal(JSON.stringify(gemini), before);
    });

    it('hands a {json} schema through exactly as written, for every provider', () => {
        const raw = { type: 'object', properties: { x: { type: ['string', 'null'] } }, additionalProperties: true };
        assert.equal(jsonSchemaFor({ json: raw }), raw);
    });

    it('converts the app\'s real schemas without losing a property', () => {
        for (const schema of [DRAFT_SCHEMA, PLAN_SCHEMA]) {
            const json = jsonSchemaFor(schema) as Record<string, any>;
            assert.equal(json.type, 'object');
            assert.deepEqual(Object.keys(json.properties), Object.keys(schema.properties!));
            for (const o of objectsIn(json)) assert.equal(o.additionalProperties, false);
        }
    });
});

describe('geminiSchema.ts', () => {
    it('is what monteur/think.ts and studio/generate.ts export, not a second copy of it', () => {
        assert.equal(thinkToJsonSchema, toJsonSchema);
        assert.equal(generateWithoutArrayBounds, withoutArrayBounds);
    });

    it('imports nothing, so loading a schema never loads the database pool', () => {
        const source = fs.readFileSync(new URL('./geminiSchema.ts', import.meta.url), 'utf8');
        assert.deepEqual(source.match(/^\s*(?:import|export)\b[^\n]*\bfrom\b[^\n]*$/gm) ?? [], []);
    });

    it('keeps every file of the library clear of the database, axios and the features built on it', () => {
        const dir = new URL('./', import.meta.url);
        const files = [...fs.readdirSync(dir), ...fs.readdirSync(new URL('./adapters/', import.meta.url)).map((f) => `adapters/${f}`)]
            .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testFetch.ts');
        assert.ok(files.length >= 10, files.join(', '));
        for (const file of files) {
            const imports = fs.readFileSync(new URL(file, dir), 'utf8').match(/^\s*(?:import|export)\b[^\n]*\bfrom\b\s*['"][^'"]+['"]/gm) ?? [];
            for (const line of imports) assert.doesNotMatch(line, /config\/db|['"]pg['"]|axios|studio\/|monteur\/|growth\/|appSettings/, `${file}: ${line}`);
        }
    });
});

describe('rootKind and matchesRoot', () => {
    it('reads what the answer\'s top level must be from either kind of schema', () => {
        assert.equal(rootKind({ type: 'OBJECT' }), 'object');
        assert.equal(rootKind({ type: 'ARRAY', items: { type: 'STRING' } }), 'array');
        assert.equal(rootKind({ type: 'STRING' }), undefined);
        assert.equal(rootKind({ json: { type: 'object' } }), 'object');
        assert.equal(rootKind({ json: { type: 'array', items: {} } }), 'array');
        assert.equal(rootKind({ json: { type: ['object', 'null'] } }), 'object');
        assert.equal(rootKind({ json: { properties: { a: {} } } }), 'object');
        assert.equal(rootKind({ json: { anyOf: [{ type: 'object' }, { type: 'array' }] } }), undefined);
    });

    it('checks a parsed answer against it loosely', () => {
        assert.equal(matchesRoot({ a: 1 }, 'object'), true);
        assert.equal(matchesRoot([1], 'object'), false);
        assert.equal(matchesRoot(null, 'object'), false);
        assert.equal(matchesRoot('text', 'object'), false);
        assert.equal(matchesRoot([1], 'array'), true);
        assert.equal(matchesRoot({}, 'array'), false);
        assert.equal(matchesRoot('anything', undefined), true);
    });
});

describe('strictify', () => {
    const strict = strictify(original) as Record<string, any>;

    it('lists every property of every object in required', () => {
        assert.deepEqual(strict.required, ['title', 'subtitle', 'mood', 'count', 'author', 'slides']);
        assert.deepEqual(strict.properties.author.required, ['name', 'handle']);
        assert.deepEqual(strict.properties.slides.items.required, ['text', 'note']);
    });

    it('closes every object, including those inside arrays', () => {
        const objects = objectsIn(strict);
        assert.equal(objects.length, 3);
        for (const o of objects) assert.equal(o.additionalProperties, false);
    });

    it('makes a property that was optional nullable, and leaves a required one exactly as it was', () => {
        assert.deepEqual(strict.properties.title, { type: 'string' });
        assert.deepEqual(strict.properties.subtitle, { type: ['string', 'null'], description: 'Optional.' });
        assert.deepEqual(strict.properties.count, { type: ['integer', 'null'] });
        assert.deepEqual(strict.properties.author.properties.name, { type: 'string' });
        assert.deepEqual(strict.properties.author.properties.handle, { type: ['string', 'null'] });
        assert.deepEqual(strict.properties.slides.items.properties.note, { type: ['string', 'null'] });
    });

    it('lets null through an optional enum by naming it in the enum, which `type` alone does not do', () => {
        assert.deepEqual(strict.properties.mood, { type: ['string', 'null'], enum: ['calm', 'bold', null] });
    });

    it('makes an optional object or array nullable too, keeping what is inside it strict', () => {
        assert.deepEqual(strict.properties.author.type, ['object', 'null']);
        assert.deepEqual(strict.properties.slides.type, ['array', 'null']);
        assert.deepEqual(strict.properties.slides.items.type, 'object');
    });

    it('returns a copy and leaves the schema it was given as it was', () => {
        const before = JSON.stringify(original);
        const out = strictify(original);
        assert.notEqual(out, original);
        assert.equal(JSON.stringify(original), before);
    });

    it('is a fixed point: strictifying a strict schema changes nothing', () => {
        assert.deepEqual(strictify(strict), strict);
    });

    it('handles optional unions and references', () => {
        const out = strictify({
            type: 'object',
            properties: {
                either: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
                already: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                ref: { $ref: '#/$defs/Pin' },
                bare: { enum: ['a', 'b'] },
            },
            $defs: { Pin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x'] } },
        }) as Record<string, any>;
        assert.deepEqual(out.properties.either.anyOf, [{ type: 'string' }, { type: 'integer' }, { type: 'null' }]);
        assert.deepEqual(out.properties.already.anyOf, [{ type: 'string' }, { type: 'null' }]);
        assert.deepEqual(out.properties.ref, { anyOf: [{ $ref: '#/$defs/Pin' }, { type: 'null' }] });
        assert.deepEqual(out.properties.bare, { anyOf: [{ enum: ['a', 'b'] }, { type: 'null' }] });
        assert.deepEqual(out.required, ['either', 'already', 'ref', 'bare']);
        // The definition the reference points at is strict as well.
        assert.deepEqual(out.$defs.Pin.required, ['x', 'y']);
        assert.equal(out.$defs.Pin.additionalProperties, false);
        assert.deepEqual(out.$defs.Pin.properties.y, { type: ['number', 'null'] });
    });

    it('refuses a map, an object whose additionalProperties is a schema, instead of quietly closing it into an empty object', () => {
        const map = { type: 'object', properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['labels'] };
        assert.throws(() => strictify(map), /free-form keys[^]*\/properties\/labels/);
        assert.throws(() => strictify({ type: 'object', additionalProperties: { type: 'number' } }), /free-form keys/);
        // Nested in an array of objects, and in a definition, it is found there too.
        assert.throws(() => strictify({ type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } } }), /items/);
        assert.throws(() => strictify({ type: 'object', properties: { a: { $ref: '#/$defs/M' } }, $defs: { M: { type: 'object', additionalProperties: { type: 'string' } } } }), /\$defs\/M/);
    });

    it('closes an object whose additionalProperties is absent, which is what strict mode asks, and the input is not touched', () => {
        const open = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
        assert.equal((strictify(open) as any).additionalProperties, false);
        assert.ok(!('additionalProperties' in open));
    });

    it('refuses additionalProperties: true, which says "and any other key": closing it would quietly drop them', () => {
        assert.throws(() => strictify({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }), /free-form keys \(additionalProperties is true\)/);
        assert.throws(() => strictify({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'string' } }, additionalProperties: true } } }), /properties\/a/);
    });

    it('refuses an object that lists no properties and does not say it is closed: it is free-form too', () => {
        assert.throws(() => strictify({ type: 'object' }), /free-form keys \(it lists no properties\) at \//);
        assert.throws(() => strictify({ type: 'object', properties: { blob: { type: 'object' } } }), /properties\/blob/);
        assert.throws(() => strictify({ type: 'array', items: { type: 'object', description: 'anything' } }), /items/);
        assert.throws(() => strictify({ type: ['object', 'null'] }), /free-form keys/);
    });

    it('lets an object that says it is closed and lists nothing be the empty object it is', () => {
        const out = strictify({ type: 'object', properties: { none: { type: 'object', additionalProperties: false } }, required: ['none'] }) as any;
        assert.deepEqual(out.properties.none, { type: 'object', additionalProperties: false, properties: {}, required: [] });
        // An empty `properties` is the same thing said the other way.
        assert.deepEqual((strictify({ type: 'object', properties: {} }) as any), { type: 'object', properties: {}, required: [], additionalProperties: false });
    });

    it('says type object for a node that has properties and no type', () => {
        const out = strictify({ properties: { a: { properties: { b: { type: 'string' } } }, c: { type: 'string' } }, required: ['c'] }) as any;
        assert.equal(out.type, 'object');
        assert.equal(out.properties.a.type[0], 'object');
        assert.deepEqual(out.properties.a.type, ['object', 'null']);
        assert.deepEqual(out.properties.a.properties.b, { type: ['string', 'null'] });
        assert.deepEqual(out.properties.a.required, ['b']);
        assert.deepEqual(out.required, ['a', 'c']);
    });

    it('is applied to the app\'s real schemas: every object closed, every property required', () => {
        for (const schema of [DRAFT_SCHEMA, PLAN_SCHEMA]) {
            for (const o of objectsIn(strictify(jsonSchemaFor(schema)))) {
                assert.equal(o.additionalProperties, false);
                assert.deepEqual([...(o.required ?? [])].sort(), Object.keys(o.properties ?? {}).sort());
            }
        }
    });
});

describe('dropNulls', () => {
    it('takes out a null that stood in for an optional property', () => {
        const answer = { title: 'T', subtitle: null, mood: null, count: null, author: null, slides: null };
        assert.deepEqual(dropNulls(answer, original), { title: 'T' });
    });

    it('keeps a null on a property the original schema requires', () => {
        const schema = { type: 'object', properties: { a: { type: ['string', 'null'] } }, required: ['a'] };
        assert.deepEqual(dropNulls({ a: null }, schema), { a: null });
    });

    it('keeps real values, falsy ones included', () => {
        const answer = { title: '', subtitle: '', mood: 'calm', count: 0, author: null, slides: null };
        assert.deepEqual(dropNulls(answer, original), { title: '', subtitle: '', mood: 'calm', count: 0 });
        assert.deepEqual(dropNulls({ title: 'T', count: 0, slides: [] }, original), { title: 'T', count: 0, slides: [] });
    });

    it('goes into nested objects and the objects of an array', () => {
        const answer = {
            title: 'T',
            subtitle: null, mood: null, count: null,
            author: { name: 'Amir', handle: null },
            slides: [{ text: 'one', note: null }, { text: 'two', note: 'kept' }],
        };
        assert.deepEqual(dropNulls(answer, original), {
            title: 'T',
            author: { name: 'Amir' },
            slides: [{ text: 'one' }, { text: 'two', note: 'kept' }],
        });
    });

    it('undoes strictify: what comes back is what the original schema describes', () => {
        // What a strict-mode model answers: every key present, absent ones as null.
        const strictAnswer = {
            title: 'T', subtitle: null, mood: 'bold', count: 3,
            author: { name: 'Amir', handle: null },
            slides: [{ text: 'a', note: null }],
        };
        assert.deepEqual(dropNulls(strictAnswer, original), {
            title: 'T', mood: 'bold', count: 3, author: { name: 'Amir' }, slides: [{ text: 'a' }],
        });
    });

    it('follows a local $ref to find what is optional', () => {
        const schema = {
            type: 'object',
            properties: { pin: { $ref: '#/$defs/Pin' } },
            required: ['pin'],
            $defs: { Pin: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x'] } },
        };
        assert.deepEqual(dropNulls({ pin: { x: 1, y: null } }, schema), { pin: { x: 1 } });
    });

    it('finds the object branch of an optional union', () => {
        const schema = {
            type: 'object',
            properties: { author: { anyOf: [{ type: 'object', properties: { name: { type: 'string' }, handle: { type: 'string' } }, required: ['name'] }, { type: 'null' }] } },
        };
        assert.deepEqual(dropNulls({ author: { name: 'A', handle: null } }, schema), { author: { name: 'A' } });
        assert.deepEqual(dropNulls({ author: null }, schema), {});
    });

    it('leaves keys the schema does not know, and answers that are not objects, alone', () => {
        assert.deepEqual(dropNulls({ title: 'T', extra: null }, original), { title: 'T', extra: null });
        assert.equal(dropNulls('text', original), 'text');
        assert.equal(dropNulls(null, original), null);
        assert.deepEqual(dropNulls([1, null], { type: 'array', items: { type: 'integer' } }), [1, null]);
    });

    it('does not modify the answer it was given', () => {
        const answer = { title: 'T', subtitle: null };
        dropNulls(answer, original);
        assert.deepEqual(answer, { title: 'T', subtitle: null });
    });
});

describe('schemaComplexity', () => {
    it('counts properties that are not required, wherever they are', () => {
        assert.deepEqual(schemaComplexity({ type: 'object', properties: { a: {}, b: {} }, required: ['a'] }), { optional: 1, unions: 0 });
        // Of `original`: subtitle, mood, count, author, slides at the top; handle in author; note in each slide's items.
        assert.deepEqual(schemaComplexity(original), { optional: 7, unions: 0 });
    });

    it('counts across arrays, definitions and unions', () => {
        const schema = {
            type: 'object',
            properties: {
                list: { type: 'array', items: { type: 'object', properties: { x: {}, y: {} } } },
                pin: { $ref: '#/$defs/Pin' },
            },
            required: ['list', 'pin'],
            $defs: { Pin: { type: 'object', properties: { a: {}, b: {}, c: {} }, required: ['a'] } },
        };
        assert.deepEqual(schemaComplexity(schema), { optional: 4, unions: 0 });
    });

    it('counts union-typed properties: anyOf, and type arrays such as ["string", "null"]', () => {
        const schema = {
            type: 'object',
            properties: {
                a: { anyOf: [{ type: 'string' }, { type: 'integer' }] },
                b: { type: ['string', 'null'] },
                c: { type: 'string' },
                d: { type: ['string'] },
            },
            required: ['a', 'b', 'c', 'd'],
        };
        assert.deepEqual(schemaComplexity(schema), { optional: 0, unions: 2 });
    });

    it('sees what strictify adds: every optional property becomes a nullable one', () => {
        const before = schemaComplexity(original);
        const after = schemaComplexity(strictify(original));
        assert.equal(after.optional, 0);
        assert.equal(after.unions, before.optional);
    });
});

describe('the app\'s own schemas against Anthropic\'s limits', () => {
    // Anthropic refuses more than 24 optional properties or 16 union-typed ones in a request's
    // schema ("Schema is too complex for compilation"). These are every schema the app asks a
    // model to fill; the Studio's and the Monteur's will go to Anthropic for tenants.
    const schemas: Record<string, GeminiSchema> = {
        SLIDE_SCHEMA, DRAFT_SCHEMA, PLAN_SCHEMA, KEYWORDS_SCHEMA, COACH_SCHEMA, PICK_SCHEMA,
        EDITOR_SCHEMA_human: editorSchema(true), EDITOR_SCHEMA_machine: editorSchema(false), LESSONS_SCHEMA, COPY_SCHEMA,
    };

    it('has the limits the docs state', () => {
        assert.equal(MAX_OPTIONAL_PROPERTIES, 24);
        assert.equal(MAX_UNION_PROPERTIES, 16);
    });

    it('keeps every one at or under both limits', () => {
        for (const [name, schema] of Object.entries(schemas)) {
            const { optional, unions } = schemaComplexity(jsonSchemaFor(schema));
            assert.ok(optional <= MAX_OPTIONAL_PROPERTIES, `${name} has ${optional} optional properties`);
            assert.ok(unions <= MAX_UNION_PROPERTIES, `${name} has ${unions} union-typed properties`);
        }
    });

    it('pins the carousel schemas AT the limit: one more optional field on a slide breaks every Anthropic draft', () => {
        // 24 of 24, zero headroom. Adding an optional property to SLIDE_SCHEMA fails this test
        // first, which is the point: make the new field required, or raise it with Anthropic's limit.
        assert.equal(schemaComplexity(jsonSchemaFor(SLIDE_SCHEMA)).optional, 24);
        assert.equal(schemaComplexity(jsonSchemaFor(DRAFT_SCHEMA)).optional, 24);
        const largest = Math.max(...Object.values(schemas).map((s) => schemaComplexity(jsonSchemaFor(s)).optional));
        assert.equal(largest, MAX_OPTIONAL_PROPERTIES);
    });

    it('has no union types: the converter never produces one', () => {
        for (const [name, schema] of Object.entries(schemas)) assert.equal(schemaComplexity(jsonSchemaFor(schema)).unions, 0, name);
    });
});
