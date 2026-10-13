/**
 * The app's own schema type and the two pure helpers every provider's schema is made with.
 *
 * They were born in `studio/generate.ts` (the type, `withoutArrayBounds`) and `monteur/think.ts`
 * (`toJsonSchema`), both of which import the database pool. Anything that wanted a schema, the
 * whole of `llm/` included, therefore loaded `pg` and risked an import cycle the day the Studio
 * itself calls through `llm/`. Here they depend on nothing, and the two original modules
 * re-export them, so every existing import path and every golden keeps working unchanged.
 */

/** Gemini's `responseSchema` subset (OpenAPI 3.0-ish, upper-case types). */
export type GeminiSchema = {
    type: 'OBJECT' | 'ARRAY' | 'STRING' | 'INTEGER' | 'NUMBER' | 'BOOLEAN';
    description?: string;
    enum?: string[];
    properties?: Record<string, GeminiSchema>;
    required?: string[];
    propertyOrdering?: string[];
    items?: GeminiSchema;
    minItems?: number;
    maxItems?: number;
};

/**
 * The schema as sent. Gemini 3 answers a schema carrying `minItems`/`maxItems` with a bare 400
 * "Request contains an invalid argument", so the bounds stay in our own schema — the
 * descriptions still state them to the model — and are enforced where they always really were:
 * `validateCarousel` and the repair rounds.
 */
export function withoutArrayBounds<T>(schema: T): T {
    if (Array.isArray(schema)) return schema.map((s) => withoutArrayBounds(s)) as T;
    if (!schema || typeof schema !== 'object') return schema;
    return Object.fromEntries(
        Object.entries(schema as Record<string, unknown>)
            .filter(([key]) => key !== 'minItems' && key !== 'maxItems')
            .map(([key, value]) => [key, withoutArrayBounds(value)]),
    ) as T;
}

/**
 * Gemini's `responseSchema` as JSON Schema, for `claude --json-schema`: types lower-cased,
 * `propertyOrdering` dropped (Gemini's own), and every object closed with `additionalProperties:
 * false`. The array bounds go too, as they do for Gemini (`withoutArrayBounds`): structured output
 * refuses most of them, and the code that reads the answer enforces them anyway.
 */
export function toJsonSchema(schema: GeminiSchema): Record<string, unknown> {
    const out: Record<string, unknown> = { type: schema.type.toLowerCase() };
    if (schema.description !== undefined) out.description = schema.description;
    if (schema.enum) out.enum = [...schema.enum];
    if (schema.items) out.items = toJsonSchema(schema.items);
    if (schema.properties) {
        out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)]));
    }
    if (schema.required) out.required = [...schema.required];
    if (schema.type === 'OBJECT') out.additionalProperties = false;
    return out;
}
