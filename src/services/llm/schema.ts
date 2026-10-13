/**
 * The schema a model must answer in, for every provider.
 *
 * The app writes its schemas once, as Gemini's `responseSchema` subset (`GeminiSchema`: upper-case
 * types, no `additionalProperties`), because Gemini was the first model it spoke to. Everyone else
 * speaks JSON Schema, so a `GeminiSchema` is converted on the way out with the helpers the Monteur
 * already uses for `claude --json-schema`. A caller whose schema needs more than Gemini's subset
 * (unions, nullable fields) passes `{json}` instead and it goes to every provider as written.
 *
 * OpenAI's strict mode is the one provider that wants the schema reshaped further, and the
 * reshaping loses information: an optional field becomes a required one that may be `null`. So
 * `strictify` goes out and `dropNulls` comes back, and the caller sees the shape it asked for.
 */
import { toJsonSchema } from '../monteur/think.js';
import { withoutArrayBounds, type GeminiSchema } from '../studio/generate.js';

export type JsonSchema = Record<string, unknown>;

/** Either the app's own schema type, or plain JSON Schema for the cases it cannot express. */
export type LlmSchema = GeminiSchema | { json: JsonSchema };

export const isRawJsonSchema = (schema: LlmSchema): schema is { json: JsonSchema } => 'json' in schema;

/**
 * The schema as JSON Schema, for every provider that is not Gemini. A `GeminiSchema` loses its
 * array bounds first (`withoutArrayBounds`): structured output refuses most of them, and the code
 * that reads the answer enforces them anyway. A `{json}` schema is the caller's, untouched.
 */
export function jsonSchemaFor(schema: LlmSchema): JsonSchema {
    return isRawJsonSchema(schema) ? schema.json : toJsonSchema(withoutArrayBounds(schema));
}

/** What the answer's top level must be, when the schema says. */
export type RootKind = 'object' | 'array';

export function rootKind(schema: LlmSchema): RootKind | undefined {
    if (!isRawJsonSchema(schema)) return schema.type === 'OBJECT' ? 'object' : schema.type === 'ARRAY' ? 'array' : undefined;
    const types = (Array.isArray(schema.json.type) ? schema.json.type : [schema.json.type]).filter((t) => t !== 'null' && t !== undefined);
    if (types.length === 1 && (types[0] === 'object' || types[0] === 'array')) return types[0];
    return types.length === 0 && schema.json.properties ? 'object' : undefined;
}

export function matchesRoot(json: unknown, kind: RootKind | undefined): boolean {
    if (kind === 'array') return Array.isArray(json);
    if (kind === 'object') return typeof json === 'object' && json !== null && !Array.isArray(json);
    return true;
}

// ─── OpenAI strict mode ──────────────────────────────────────────────────────────────────────

type Node = Record<string, any>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The same schema, but `null` is also allowed. */
function nullable(schema: Node): Node {
    if (schema.type === 'null') return schema;
    if (typeof schema.$ref === 'string') return { anyOf: [schema, { type: 'null' }] };
    if (Array.isArray(schema.anyOf)) {
        const hasNull = schema.anyOf.some((b: unknown) => isNode(b) && b.type === 'null');
        return hasNull ? schema : { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] };
    }
    const types: unknown[] | undefined = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : undefined;
    // No `type` at all (a bare enum, `const`, `oneOf`): wrap it.
    if (!types) return { anyOf: [schema, { type: 'null' }] };
    if (types.includes('null')) return schema;
    const out: Node = { ...schema, type: [...types, 'null'] };
    // `type` alone does not let `null` through an `enum`: the enum has to name it.
    if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
    return out;
}

function strictifyNode(node: unknown): void {
    if (!isNode(node)) return;
    for (const defs of [node.$defs, node.definitions]) {
        if (isNode(defs)) Object.values(defs).forEach(strictifyNode);
    }
    if (Array.isArray(node.items)) node.items.forEach(strictifyNode);
    else strictifyNode(node.items);
    for (const union of [node.anyOf, node.oneOf, node.allOf]) {
        if (Array.isArray(union)) union.forEach(strictifyNode);
    }
    const isObject = node.type === 'object' || (Array.isArray(node.type) && node.type.includes('object')) || isNode(node.properties);
    if (!isObject) return;
    if (isNode(node.properties)) {
        const required = new Set<string>(Array.isArray(node.required) ? node.required : []);
        for (const [key, sub] of Object.entries(node.properties)) {
            strictifyNode(sub);
            if (!required.has(key) && isNode(sub)) node.properties[key] = nullable(sub);
        }
        node.required = Object.keys(node.properties);
    }
    node.additionalProperties = false;
}

/**
 * JSON Schema as OpenAI's `strict: true` accepts it: every property of every object is listed in
 * `required`, a property that was optional is made nullable instead, and every object is closed
 * with `additionalProperties: false`. Returns a copy; the schema it was given is not touched.
 * `dropNulls` undoes the optional-to-nullable half when the answer is read.
 */
export function strictify(schema: JsonSchema): JsonSchema {
    const copy = structuredClone(schema);
    strictifyNode(copy);
    return copy;
}

// ─── Undoing it ──────────────────────────────────────────────────────────────────────────────

/** A local `$ref` (`#/$defs/x`) followed to what it names; anything else comes back as it was. */
function resolve(node: unknown, root: Node): unknown {
    let at = node;
    for (let hops = 0; hops < 10 && isNode(at) && typeof at.$ref === 'string'; hops++) {
        if (!at.$ref.startsWith('#')) return at;
        let next: unknown = root;
        for (const part of at.$ref.slice(1).split('/').filter(Boolean)) {
            next = isNode(next) ? next[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined;
        }
        if (next === undefined) return at;
        at = next;
    }
    return at;
}

/** The part of a schema that describes an object (or array) value: the schema itself, or the one union branch that fits. */
function describing(schema: unknown, root: Node, value: Record<string, unknown> | unknown[]): Node | undefined {
    const node = resolve(schema, root);
    if (!isNode(node)) return undefined;
    const wantsArray = Array.isArray(value);
    const fits = (n: Node) => (wantsArray ? n.items !== undefined : isNode(n.properties));
    if (fits(node)) return node;
    for (const union of [node.anyOf, node.oneOf]) {
        if (!Array.isArray(union)) continue;
        const branches = union.map((b) => resolve(b, root)).filter((b): b is Node => isNode(b) && fits(b));
        if (branches.length <= 1 || wantsArray) return branches[0];
        // Several object shapes: the first that has a place for every key in the answer.
        const keys = Object.keys(value);
        return branches.find((b) => keys.every((k) => k in b.properties));
    }
    return undefined;
}

/**
 * Takes the nulls `strictify` put in back out of an answer. A key whose value is `null` and which
 * the *original* schema does not require is dropped, as if the model had left it out; a required
 * key keeps its `null` (and a schema that allows it keeps it). Works from the original schema,
 * not the strict one, because the original is what says which keys were optional. An optional
 * field the schema already allowed to be `null` loses an explicit `null` too: absent and `null`
 * are indistinguishable once strict mode has rewritten them, and absent is the safer reading.
 */
export function dropNulls(value: unknown, schema: JsonSchema, root: JsonSchema = schema): unknown {
    if (Array.isArray(value)) {
        const items = describing(schema, root, value)?.items;
        return isNode(items) ? value.map((v) => dropNulls(v, items, root)) : value;
    }
    if (!isNode(value)) return value;
    const shape = describing(schema, root, value);
    if (!shape) return value;
    const properties: Node = isNode(shape.properties) ? shape.properties : {};
    const required = new Set<string>(Array.isArray(shape.required) ? shape.required : []);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
        const known = key in properties;
        if (v === null && known && !required.has(key)) continue;
        out[key] = known ? dropNulls(v, properties[key], root) : v;
    }
    return out;
}
