/**
 * An infographic written on the server, through the AI providers layer (P32, `tenant_infographic`).
 *
 * The owner's infographics are written by Claude Code on his Mac inside the render job (`write` in the payload): the worker asks, turns the
 * answer into the template's spec, renders it, and returns that spec with the files. A tenant's must not go through his plan, so for a
 * tenant the order is the other way round:
 *
 *   1. here, on the server: the same system prompt and user prompt (`writeSystemPrompt`, `writeUserPrompt`) and the same answer schema
 *      (`WRITE_SCHEMA`) go to whichever provider the operator routed `tenant_infographic` to, on the operator's key;
 *   2. the answer becomes the template's spec here (`answerToWritten`), exactly as the worker's `specFromAnswer` makes it;
 *   3. a render-only `render_infographic` job (a `spec`, no `write`) goes to the worker, which only draws it.
 *
 * So the worker needs no Claude, no plan and no change: a render-only job is what it has always done for an edit or the other theme.
 *
 * **One difference from the worker, and it is a loss of decoration, not of content.** The worker finds a column's `logo` and its `examples`'
 * logos in `simple-icons`, which is a dev dependency here (hundreds of kilobytes of paths a serverless function should not load). The
 * server therefore leaves `logo` out and gives every example as a name alone (`{title, hex: null, path: null}`), which the template
 * draws as text, as it does for AWS and Azure. Resolving the names on a render-only job is a worker change, not made here.
 */
import { generate } from '../aiProviders/generate.js';
import { withoutArrayBounds } from '../llm/geminiSchema.js';
import type { LlmSchema } from '../llm/schema.js';
import { isPlainObject, StudioError } from './common.js';
import {
    dirFor, MAX_EXAMPLES, parseReview, STEPS_PER_COLUMN, WRITE_SCHEMA, writeSystemPrompt, writeUserPrompt,
    type DiagramKind, type InfographicColumn, type InfographicExample, type InfographicReview, type InfographicSpec, type InfographicWriterContext, type Mini,
} from './infographicSpec.js';
import { AI_ANSWER_UNUSABLE, studioErrorFromAi } from './tenantAi.js';

/** The answer is JSON of a few thousand tokens; the layer raises this to what the route's model needs to think first (`limits.ts`). */
export const WRITE_MAX_TOKENS = 16_000;
/** One call, in the request that asked for it (the layer holds it to 150 s). */
export const WRITE_TIMEOUT_MS = 120_000;

/** Every object closed, which Anthropic's structured output requires of a schema it is given as plain JSON Schema. */
function closeObjects(node: unknown): unknown {
    if (Array.isArray(node)) return node.map(closeObjects);
    if (!isPlainObject(node)) return node;
    const out: Record<string, unknown> = Object.fromEntries(Object.entries(node).map(([k, v]) => [k, closeObjects(v)]));
    if (out.type === 'object') out.additionalProperties = false;
    return out;
}

/**
 * `WRITE_SCHEMA` as the layer takes it: plain JSON Schema (`{json}`), with the array bounds taken out (structured output refuses most
 * of them, as it does for Gemini's schema) and every object closed. The bounds are still said in the prompt and enforced here, in
 * `answerToWritten`: two or three columns, exactly three steps each.
 */
export function layerWriteSchema(): LlmSchema {
    return { json: closeObjects(withoutArrayBounds(WRITE_SCHEMA)) as Record<string, unknown> };
}

/** The answer cannot be drawn: what is wrong with it, in the words the operator reads. */
export class InfographicAnswerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InfographicAnswerError';
    }
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** A diagram as the model writes it (`{kind, icon?, label?}`) as the template's `MiniSpec` (the worker's `miniFrom`). */
function miniFrom(d: unknown): Mini {
    const o = isPlainObject(d) ? d : {};
    const kind = text(o.kind) as DiagramKind;
    if (kind === 'icon') return { kind, name: text(o.icon) || 'sparkles' };
    if (kind === 'docs' && text(o.label)) return { kind, badge: text(o.label) };
    if (kind === 'augment' && text(o.label)) return { kind, label: text(o.label) };
    return { kind };
}

/** A column's real examples, as names: duplicates and blanks dropped, at most `MAX_EXAMPLES` (the worker's `examplesFrom`, without the logos). */
function examplesFrom(names: unknown): InfographicExample[] {
    const seen = new Set<string>();
    const out: InfographicExample[] = [];
    for (const raw of Array.isArray(names) ? names : []) {
        const name = text(raw).slice(0, 40);
        if (!name || seen.has(name.toLowerCase())) continue;
        seen.add(name.toLowerCase());
        out.push({ title: name, hex: null, path: null });
        if (out.length === MAX_EXAMPLES) break;
    }
    return out;
}

export interface WrittenInfographic {
    spec: InfographicSpec;
    caption: string;
    review: InfographicReview | null;
}

/**
 * The template's spec, the caption and the review from the model's answer, as the worker makes them (`specFromAnswer`, `reviewFrom`):
 * `dir` from the language, `title` from the names, each diagram's `icon`/`label` as `name`/`badge`/`label`. Throws an
 * `InfographicAnswerError` saying why for what the worker refuses (not 2 or 3 columns, not three steps, a column with no name, no
 * caption). Whatever else is wrong (a line over its budget, a caption that misses a column) is not thrown: it is `specProblems` and
 * `captionProblems` on the stored row, shown to the operator, as it is for the owner's.
 */
export function answerToWritten(answer: unknown, language: 'ar' | 'en'): WrittenInfographic {
    if (!isPlainObject(answer)) throw new InfographicAnswerError('it is not an object');
    const cols = answer.columns;
    if (!Array.isArray(cols) || cols.length < 2 || cols.length > 3) throw new InfographicAnswerError('it needs 2 or 3 columns');
    const columns = cols.map((c: unknown, i: number): InfographicColumn => {
        const o = isPlainObject(c) ? c : {};
        const steps = Array.isArray(o.steps) ? o.steps : [];
        if (steps.length !== STEPS_PER_COLUMN) throw new InfographicAnswerError(`column ${i + 1} has ${steps.length} steps, not ${STEPS_PER_COLUMN}`);
        const name = text(o.name);
        if (!name) throw new InfographicAnswerError(`column ${i + 1} has no name`);
        const examples = examplesFrom(o.examples);
        return {
            name,
            ...(examples.length ? { examples } : {}),
            hero: miniFrom(o.hero),
            kind: text(o.kind),
            note: text(o.note),
            steps: steps.map((s: unknown) => {
                const step = isPlainObject(s) ? s : {};
                return { mini: miniFrom(step.diagram), title: text(step.title), desc: text(step.desc) };
            }),
        };
    });
    const sub = text(answer.subtitle);
    const accent = text(answer.accent);
    const caption = text(answer.caption);
    if (!caption) throw new InfographicAnswerError('it wrote no caption');
    return {
        spec: {
            dir: dirFor(language),
            title: columns.map((c) => c.name),
            subtitle: accent && sub.includes(accent) ? { text: sub, accent } : { text: sub },
            columns,
        },
        caption,
        review: parseReview(answer.review),
    };
}

export interface ServerWriteArgs {
    creatorId: string;
    topic: string;
    notes: string | null;
    language: 'ar' | 'en';
    /** Words the tenant's voice never uses (`voice.avoid`). */
    avoid: readonly string[];
    /** What the writer's prompt reads of the tenant: their role, domain and Arabic register (`infographicContext`). */
    ctx: InfographicWriterContext;
}

export interface ServerWritten extends WrittenInfographic {
    /** The model that answered, the provider it was on, what the call cost, and the `ai_usage` row that records it. */
    model: string;
    provider: string;
    usd: number;
    usageId: string;
}

/**
 * One infographic and its caption, written through the layer for the tenant (purpose `tenant_infographic`, charged to them). A layer
 * failure comes back as the `StudioError` a route sends (`studioErrorFromAi`): 409 with no provider, 429 with a spent budget, 503 when the
 * provider is down or refuses the operator's key, 502 for an answer that cannot be used. Never the Mac, never another provider.
 */
export async function writeInfographicOnServer(a: ServerWriteArgs): Promise<ServerWritten> {
    let result;
    try {
        result = await generate({
            purpose: 'tenant_infographic', creatorId: a.creatorId,
            system: writeSystemPrompt(a.language, a.ctx),
            user: writeUserPrompt({ topic: a.topic, notes: a.notes, language: a.language, avoid: a.avoid }),
            schema: layerWriteSchema(),
            maxTokens: WRITE_MAX_TOKENS, timeoutMs: WRITE_TIMEOUT_MS,
        });
    } catch (err) {
        throw studioErrorFromAi(err, 'this infographic');
    }
    try {
        return { ...answerToWritten(result.json, a.language), model: result.model, provider: result.provider, usd: result.usd, usageId: result.usageId };
    } catch (err) {
        if (err instanceof InfographicAnswerError) {
            throw new StudioError(502, `The AI's answer is not an infographic (${err.message}). Try again.`, undefined, AI_ANSWER_UNUSABLE);
        }
        throw err;
    }
}
