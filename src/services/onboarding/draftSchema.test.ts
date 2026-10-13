/**
 * The draft schemas against the library they must work with: strict JSON schema (OpenAI), Gemini's subset,
 * Anthropic's complexity limits, and `strictify`/`dropNulls`.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAnthropicRequest, MAX_OPTIONAL_PROPERTIES, MAX_UNION_PROPERTIES } from '../llm/adapters/anthropic.js';
import { buildChatRequest } from '../llm/adapters/chatCompletions.js';
import { buildGeminiRequest } from '../llm/adapters/gemini.js';
import { buildOpenAiRequest } from '../llm/adapters/openai.js';
import { toJsonSchema, withoutArrayBounds, type GeminiSchema } from '../llm/geminiSchema.js';
import { dropNulls, jsonSchemaFor, schemaComplexity, strictify } from '../llm/schema.js';
import type { AdapterArgs } from '../llm/types.js';
import { BUSINESS_SCHEMA, DRAFT_MAX_TOKENS, DRAFT_SCHEMAS, DRAFT_TIMEOUT_MS, strictDraftSchema, UNKNOWN, VOICE_SCHEMA, type DraftCall } from './draftSchema.js';
import { okBusiness, okVoice, schemaProblems } from './fixtures/draftAnswers.js';

const CALLS: DraftCall[] = ['voice', 'business'];
type Json = Record<string, any>;

/** Every object schema inside `node`, with the path to it. */
function objects(node: unknown, path = '$', found: Array<{ path: string; node: Json }> = []): Array<{ path: string; node: Json }> {
    if (Array.isArray(node)) node.forEach((n, i) => objects(n, `${path}[${i}]`, found));
    else if (node && typeof node === 'object') {
        const n = node as Json;
        if (n.type === 'object' || n.type === 'OBJECT') found.push({ path, node: n });
        for (const [k, v] of Object.entries(n)) objects(v, `${path}.${k}`, found);
    }
    return found;
}

const depth = (node: unknown): number => {
    if (Array.isArray(node)) return Math.max(0, ...node.map(depth));
    if (node && typeof node === 'object') return 1 + Math.max(0, ...Object.values(node).map(depth));
    return 0;
};

describe('the draft schemas', () => {
    for (const call of CALLS) {
        const schema = DRAFT_SCHEMAS[call];

        it(`${call}: every object lists every property as required, so nothing is optional and nothing is missing`, () => {
            const all = objects(schema);
            assert.ok(all.length > 5);
            for (const { path, node } of all) {
                assert.deepEqual([...(node.required ?? [])].sort(), Object.keys(node.properties ?? {}).sort(), path);
                assert.deepEqual([...(node.propertyOrdering ?? [])], Object.keys(node.properties ?? {}), `${path}: a fixed order`);
            }
        });

        it(`${call}: converts for every provider that is not Gemini: closed objects, lower-case types, no array bounds`, () => {
            const json = jsonSchemaFor(schema);
            assert.equal(json.type, 'object');
            for (const { path, node } of objects(json)) assert.equal(node.additionalProperties, false, path);
            const text = JSON.stringify(json);
            assert.doesNotMatch(text, /minItems|maxItems|propertyOrdering|"OBJECT"|"STRING"|"ARRAY"/);
        });

        it(`${call}: strictify has nothing to change, so strict mode and the written schema are the same`, () => {
            assert.deepEqual(strictDraftSchema(call), jsonSchemaFor(schema));
            assert.deepEqual(strictify(jsonSchemaFor(schema)), jsonSchemaFor(schema));
        });

        it(`${call}: stays inside Anthropic's limits (${MAX_OPTIONAL_PROPERTIES} optional, ${MAX_UNION_PROPERTIES} unions): at zero`, () => {
            assert.deepEqual(schemaComplexity(jsonSchemaFor(schema)), { optional: 0, unions: 0 });
            assert.deepEqual(schemaComplexity(strictDraftSchema(call)), { optional: 0, unions: 0 });
        });

        it(`${call}: has no free-form object, no union and no nullable type`, () => {
            const text = JSON.stringify(strictDraftSchema(call));
            assert.doesNotMatch(text, /anyOf|oneOf|allOf|"null"|additionalProperties":true/);
        });

        it(`${call}: nests no deeper than a provider will take`, () => {
            assert.ok(depth(jsonSchemaFor(schema)) <= 20, `${depth(jsonSchemaFor(schema))}`);
        });

        it(`${call}: every choice has the word "unknown", because an enum member has to be a real word to every provider`, () => {
            const enums: Array<[string, string[]]> = [];
            const walk = (n: unknown, path: string): void => {
                if (Array.isArray(n)) return n.forEach((x, i) => walk(x, `${path}[${i}]`));
                if (n && typeof n === 'object') {
                    const o = n as Json;
                    if (Array.isArray(o.enum)) enums.push([path, o.enum]);
                    for (const [k, v] of Object.entries(o)) walk(v, `${path}.${k}`);
                }
            };
            walk(schema, '$');
            assert.ok(enums.length >= 3);
            for (const [path, values] of enums) {
                if (path.endsWith('.confidence.enum') || path.endsWith('.confidence')) assert.deepEqual(values, ['high', 'medium', 'low']);
                else assert.ok(values.includes(UNKNOWN), path);
                assert.ok(!values.includes(''), `${path}: no empty-string enum member`);
            }
        });

        it(`${call}: is accepted by every provider's request builder`, () => {
            const base: AdapterArgs = { provider: 'anthropic', apiKey: 'k', model: 'claude-opus-5-5', system: 's', user: 'u', schema, maxTokens: DRAFT_MAX_TOKENS, effort: 'high' };
            assert.doesNotThrow(() => buildAnthropicRequest(base));
            assert.doesNotThrow(() => buildOpenAiRequest({ ...base, provider: 'openai', model: 'gpt-6-astra' }));
            assert.doesNotThrow(() => buildGeminiRequest({ ...base, provider: 'gemini', model: 'gemini-3.8-flash' }));
            assert.doesNotThrow(() => buildChatRequest({ ...base, provider: 'openrouter', model: 'openrouter/auto' }));
            assert.doesNotThrow(() => buildChatRequest({ ...base, provider: 'custom', model: 'm', baseUrl: 'https://llm.example.com/v1' }));
            const gemini = buildGeminiRequest({ ...base, provider: 'gemini', model: 'gemini-3.8-flash' });
            assert.doesNotMatch(JSON.stringify(gemini.body), /minItems|maxItems/, 'Gemini 3 answers a schema with array bounds with a bare 400');
            const openai = buildOpenAiRequest({ ...base, provider: 'openai', model: 'gpt-6-astra' });
            assert.equal((openai.body as Json).text.format.strict, true);
        });

        it(`${call}: survives a round trip through strict mode's null-dropping unchanged`, () => {
            const answer = call === 'voice' ? okVoice() : okBusiness();
            assert.deepEqual(dropNulls(answer, jsonSchemaFor(schema)), answer);
        });
    }

    it('accepts an honest answer of each call, and says what is wrong with a dishonest shape', () => {
        assert.deepEqual(schemaProblems(okVoice(), jsonSchemaFor(VOICE_SCHEMA)), []);
        assert.deepEqual(schemaProblems(okBusiness(), jsonSchemaFor(BUSINESS_SCHEMA)), []);
        const broken = okVoice();
        broken.identity.kind.value = 'wizard';
        delete broken.language.primary;
        broken.pillars[0].extra = 1;
        const problems = schemaProblems(broken, jsonSchemaFor(VOICE_SCHEMA));
        assert.ok(problems.some((p) => p.includes('identity.kind.value')), problems.join('\n'));
        assert.ok(problems.some((p) => p.includes('language.primary is missing')));
        assert.ok(problems.some((p) => p.includes('pillars[0].extra is not allowed')));
    });

    it('keeps the array bounds in its own schema, for the model and for validateDraft, and strips them for the provider', () => {
        const samples = (VOICE_SCHEMA.properties!.voice!.properties!.samples as GeminiSchema);
        assert.deepEqual([samples.minItems, samples.maxItems], [3, 5]);
        assert.equal((VOICE_SCHEMA.properties!.pillars as GeminiSchema).minItems, 3);
        assert.equal((BUSINESS_SCHEMA.properties!.offers as GeminiSchema).maxItems, 6);
        assert.doesNotMatch(JSON.stringify(withoutArrayBounds(VOICE_SCHEMA)), /minItems|maxItems/);
        assert.doesNotMatch(JSON.stringify(toJsonSchema(VOICE_SCHEMA)), /minItems|maxItems/);
    });

    it('asks for no colour, no social link, no presenter, no rule and no hours: those are not the model\'s to say', () => {
        const text = JSON.stringify(jsonSchemaFor(VOICE_SCHEMA)) + JSON.stringify(jsonSchemaFor(BUSINESS_SCHEMA));
        for (const forbidden of ['colour', 'color', 'primary_colour', 'accent', 'logo', 'presenter', 'never_mention', 'rules', 'hours', 'timezone', 'socials', 'handle', 'image', 'photo']) {
            assert.ok(!new RegExp(`"${forbidden}"`, 'i').test(text), `${forbidden} must not be a property`);
        }
        assert.ok(!Object.keys(VOICE_SCHEMA.properties!).includes('brand'));
    });

    it('is called with the spec\'s limits: 16000 tokens and 150 seconds', () => {
        assert.equal(DRAFT_MAX_TOKENS, 16_000);
        assert.equal(DRAFT_TIMEOUT_MS, 150_000);
    });
});
