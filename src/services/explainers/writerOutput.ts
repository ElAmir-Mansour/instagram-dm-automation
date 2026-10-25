/**
 * Reading the writer's answer (contracts/writer-output.schema.json): is it the object the schema describes, and what is it as a typed value.
 *
 * Two writers answer: Claude on the Mac, whose worker has already checked the answer against its own copy of the schema, and Gemini on the server, which
 * is given the schema as a hint and ignores most of it (`maxLength`, `minLength`, `minimum` are not in its subset). So the app checks the answer itself, with
 * the schema it ships (`writerSchema.json`), before anything is stored: a worker that is wrong, or a model that drifted, is a refusal here and never half a
 * draft in the database.
 *
 * `schemaProblems` is a small JSON Schema check, a port of the worker's `problemsWith` (aicourse-captions scripts/studio/explainerWrite.mjs) for the same
 * keyword subset, so the two sides say the same things about the same answer. It throws on a keyword it does not know (`assertCheckable`): a check that
 * ignored one would pass what the schema forbids.
 */
import type { ExplainerWriterOutput } from '../../db/rows.js';
import { writerSchema } from './prompt.js';

/** Keywords that explain a schema and constrain nothing. */
const ANNOTATIONS: ReadonlySet<string> = new Set(['$schema', '$id', 'title', 'description', 'default', 'examples']);
/** Keywords the check enforces. The worker's checker refuses any other, so a schema that uses one cannot be sent to it. */
const CONSTRAINTS: ReadonlySet<string> = new Set([
    'type', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'enum', 'const', 'pattern',
]);

/** The most problems one answer lists: the rest are the same mistake again. */
const MAX_PROBLEMS = 200;

type Schema = boolean | { [keyword: string]: unknown };

/** Throws when `schema` uses a keyword the check does not know. */
export function assertCheckable(schema: unknown, at = 'schema'): void {
    if (typeof schema === 'boolean') return;
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`${at} is not a JSON Schema`);
    const node = schema as Record<string, unknown>;
    for (const key of Object.keys(node)) {
        if (!ANNOTATIONS.has(key) && !CONSTRAINTS.has(key)) throw new Error(`${at} uses "${key}", which the schema check does not know`);
    }
    for (const [name, sub] of Object.entries((node.properties ?? {}) as Record<string, unknown>)) assertCheckable(sub, `${at}.properties.${name}`);
    if (node.items !== undefined) assertCheckable(node.items, `${at}.items`);
    if (node.additionalProperties !== undefined) assertCheckable(node.additionalProperties, `${at}.additionalProperties`);
}

type Kind = 'null' | 'array' | 'integer' | 'number' | 'string' | 'boolean' | 'object' | 'undefined' | 'bigint' | 'symbol' | 'function';
const kindOf = (value: unknown): Kind => {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
    return typeof value as Kind;
};
const matchesType = (type: string, value: unknown): boolean => {
    const kind = kindOf(value);
    return type === kind || (type === 'number' && kind === 'integer');
};
const article = (kind: string): string => (kind === 'null' ? kind : `${kind === 'object' || kind === 'array' || kind === 'integer' ? 'an' : 'a'} ${kind}`);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
/** JSON Schema counts a string's length in code points, so an emoji is one. */
const length = (text: string): number => [...text].length;
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * What is wrong with `value` against `schema`, as short sentences naming where (`scenes[3].narration`), in document order. An empty list is a fit.
 */
export function schemaProblems(schema: unknown, value: unknown, at = 'the answer', out: string[] = []): string[] {
    if (schema === true || out.length >= MAX_PROBLEMS) return out;
    if (schema === false) {
        out.push(`${at} isn't allowed`);
        return out;
    }
    const node = schema as Exclude<Schema, boolean>;
    const types = node.type === undefined ? null : ([] as unknown[]).concat(node.type) as string[];
    if (types && !types.some((type) => matchesType(type, value))) {
        const got = kindOf(value) === 'number' ? String(value) : article(kindOf(value));
        out.push(`${at} must be ${types.map(article).join(' or ')}, not ${got}`);
        return out;
    }
    const allowed = node.enum as unknown[] | undefined;
    if (allowed && !allowed.some((e) => sameJson(e, value))) out.push(`${at} must be one of ${allowed.map((e) => JSON.stringify(e)).join(', ')}`);
    if (node.const !== undefined && !sameJson(node.const, value)) out.push(`${at} must be ${JSON.stringify(node.const)}`);
    if (typeof value === 'string') {
        const n = length(value);
        const min = node.minLength as number | undefined;
        const max = node.maxLength as number | undefined;
        if (min !== undefined && n < min) out.push(`${at} is ${n === 0 ? 'empty' : plural(n, 'character')}; at least ${min} are needed`);
        if (max !== undefined && n > max) out.push(`${at} is ${plural(n, 'character')}; at most ${max} are allowed`);
        if (node.pattern !== undefined && !new RegExp(node.pattern as string, 'u').test(value)) out.push(`${at} doesn't match the pattern ${node.pattern as string}`);
    }
    if (typeof value === 'number') {
        const min = node.minimum as number | undefined;
        const max = node.maximum as number | undefined;
        if (min !== undefined && value < min) out.push(`${at} is ${value}; at least ${min} is needed`);
        if (max !== undefined && value > max) out.push(`${at} is ${value}; at most ${max} is allowed`);
    }
    if (Array.isArray(value)) {
        const min = node.minItems as number | undefined;
        const max = node.maxItems as number | undefined;
        if (min !== undefined && value.length < min) out.push(`${at} has ${value.length === 0 ? 'no items' : plural(value.length, 'item')}; at least ${min} are needed`);
        if (max !== undefined && value.length > max) out.push(`${at} has ${plural(value.length, 'item')}; at most ${max} are allowed`);
        if (node.items !== undefined) value.forEach((item, i) => schemaProblems(node.items, item, `${at}[${i}]`, out));
    } else if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const where = at === 'the answer' ? '' : `${at}.`;
        for (const key of (node.required as string[] | undefined) ?? []) if (!Object.hasOwn(record, key)) out.push(`${at} is missing "${key}"`);
        const known = (node.properties ?? {}) as Record<string, unknown>;
        for (const [key, sub] of Object.entries(known)) if (Object.hasOwn(record, key)) schemaProblems(sub, record[key], `${where}${key}`, out);
        for (const key of Object.keys(record)) {
            if (Object.hasOwn(known, key)) continue;
            if (node.additionalProperties === false) out.push(`${at} has "${key}", which isn't allowed`);
            else if (node.additionalProperties && typeof node.additionalProperties === 'object') schemaProblems(node.additionalProperties, record[key], `${where}${key}`, out);
        }
    }
    return out;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/**
 * The answer as a typed draft, or why it is not one. Every string is trimmed: a space at the edge is never meant, and the limits are counted on the text
 * that is stored. A schema that cannot be read or checked is a throw (a broken copy of the contract), never a "problem with the answer".
 */
export function parseWriterOutput(raw: unknown): { ok: true; output: ExplainerWriterOutput } | { ok: false; problems: string[] } {
    const schema = writerSchema();
    assertCheckable(schema, 'writerSchema.json');
    const problems = schemaProblems(schema, raw);
    if (problems.length) return { ok: false, problems };
    const answer = raw as Record<string, any>;
    return {
        ok: true,
        output: {
            title: text(answer.title),
            scenes: (answer.scenes as Record<string, any>[]).map((scene) => ({
                narration: text(scene.narration),
                spoken: text(scene.spoken),
                label: text(scene.label),
                brief: text(scene.brief),
                characters: (scene.characters as string[]).map((key) => text(key)).filter(Boolean),
                continues: scene.continues === true,
                source_ids: [...(scene.source_ids as number[])],
            })),
            captions: {
                meta: text(answer.captions.meta),
                youtube: { title: text(answer.captions.youtube.title), description: text(answer.captions.youtube.description) },
                tiktok: text(answer.captions.tiktok),
            },
            first_comment: text(answer.first_comment),
            replies: (answer.replies as { q: string; a: string }[]).map((reply) => ({ q: text(reply.q), a: text(reply.a) })),
            sources: (answer.sources as { title: string; by: string; year: string; url: string }[]).map((source) => ({
                title: text(source.title), by: text(source.by), year: text(source.year), url: text(source.url),
            })),
        },
    };
}
