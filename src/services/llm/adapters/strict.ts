/**
 * What the two OpenAI-style families (Responses, Chat Completions) share about strict structured
 * output: the schema reshaped for `strict: true`, and the undoing of it on the way back.
 *
 * `strictify` (schema.ts) makes every property required and the optional ones nullable;
 * `dropNulls` takes those nulls out of the answer again, so the caller sees the shape it asked
 * for. The undoing works from the *original* JSON Schema, which is what says which keys were
 * optional, so `normalize` rebuilds it from the caller's schema rather than from what was sent.
 */
import { AiError } from '../errors.js';
import { providerName } from '../registry.js';
import { dropNulls, jsonSchemaFor, rootKind, strictify, type JsonSchema, type LlmSchema } from '../schema.js';
import type { AdapterArgs } from '../types.js';

/** The name of the schema in the request. Both APIs want one, `a-zA-Z0-9_-`, and nothing reads it back. */
export const SCHEMA_NAME = 'answer';

type StrictFor = Pick<AdapterArgs, 'provider' | 'model' | 'apiKey' | 'schema'>;

/**
 * The caller's schema as `strict: true` accepts it, or a `bad_request` that says what to change,
 * before anything is sent and billed. `objectRoot` is OpenAI's own rule (structured-outputs guide,
 * "Supported schemas": the root must be an object and must not be `anyOf`); a Chat Completions
 * endpoint behind OpenRouter, Groq or Custom may be any provider's, so it is left to answer for itself.
 */
export function strictSchemaFor(a: StrictFor, opts: { objectRoot: boolean }): JsonSchema {
    const refuse = (message: string) => new AiError({ kind: 'bad_request', provider: a.provider, model: a.model, message, key: a.apiKey });
    const schema = jsonSchemaFor(a.schema);
    // `rootKind` looks through a `null` in a type array, which strict mode does not: `["object", "null"]` at the top is a union.
    if (opts.objectRoot && (rootKind(a.schema) !== 'object' || Array.isArray(schema.type))) {
        throw refuse(
            `${providerName(a.provider)}'s strict structured output needs the answer to be a JSON object at the top level, not an array, a nullable object or a union. ` +
                'Wrap it, for example {"items": [...]}.',
        );
    }
    try {
        return strictify(schema);
    } catch (err) {
        throw refuse(err instanceof Error ? err.message : String(err));
    }
}

/**
 * The family's `normalize`: the nulls strict mode asked the model to write for optional fields,
 * taken out again. Chat Completions applies it in JSON-object mode too, where the nulls are the
 * model's own: for an optional field absent and `null` mean the same to `dropNulls`, and absent
 * is the reading every caller already handles.
 */
export function dropStrictNulls(json: unknown, schema: LlmSchema): unknown {
    return dropNulls(json, jsonSchemaFor(schema));
}
