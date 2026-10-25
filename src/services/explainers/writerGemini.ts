/**
 * The fallback writer: Gemini on the server, with Google Search grounding (research.md R2b; the owner, 2026-10-25: "for the ai use our Claude or Gemini for
 * now"). It is an explicit exception to the house rule that video work never goes to Gemini, and it only runs when Claude on the Mac cannot write: the owner
 * chose Gemini in Settings, the Mac is signed out, or it has not picked the job up in ten minutes (writing.ts decides).
 *
 * Two calls, because the write step needs the numbered list of sources the research step found:
 *
 *   1. research   `tools: [{ google_search: {} }]`: the notes, in English. The sources are `groundingMetadata.groundingChunks`, plus the creator's own links.
 *                 Google gives each chunk as a redirect through vertexaisearch.cloud.google.com, which is no link to put in a first comment, so each is followed
 *                 once to the page it leads to. Inline `[n]` markers are put in the notes where `groundingSupports` say a source backs the text.
 *   2. write      the same system prompt as Claude's, in `notes` mode (no web tools: the notes and the numbered sources are the whole truth), with a JSON
 *                 `responseSchema` made from `writerSchema.json`. One repair round if the answer is not the object the schema describes.
 *
 * What the app does that the model is not trusted with: a source whose address is not in the numbered list is dropped (a model can invent a URL, and a script's
 * first comment must never carry one), the sources no scene cites are dropped and the scenes' `source_ids` renumbered to match, the first comment is rebuilt from
 * the sources that are left, and any address in a caption that is not one of them is removed. The result is checked by `parseWriterOutput` and by
 * `checkDraft` like Claude's, and applied through the same door (`completeJob`), with the draft marked `writer: 'gemini'`.
 *
 * The key is the platform's (`getGeminiKey`: the Operations screen's, then `GEMINI_API_KEY`), the models are the Studio's chain (`STUDIO_MODELS`), and a model
 * that answers 400, 404, 429, 500 or 503 hands over to the next, as generate.ts does. Free tier: Google Search grounding is NOT offered on the free tier for
 * Gemini 3 models (ai.google.dev/gemini-api/docs/pricing, read 2026-10-25: "Not available"; the paid tier has 5,000 free searches a month), so on a free key every
 * model refuses the research call and this fails, saying so, instead of writing from memory.
 */
import type { ExplainerWriterOutput } from '../../db/rows.js';
import { log } from '../../utils/log.js';
import { getGeminiKey, MISSING_GEMINI_KEY } from '../appSettings.js';
import { withoutArrayBounds, type GeminiSchema } from '../llm/geminiSchema.js';
import { STUDIO_MODELS } from '../studio/generate.js';
import { buildWriterInputs, writerSchema, type WriterRequest } from './prompt.js';
import { parseWriterOutput, schemaProblems } from './writerOutput.js';

/** A request to Gemini: the one call this file makes through the network, injected so no test reaches one. */
export type GeminiFetch = (url: string, init: {
    method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: 'manual' | 'follow';
}) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>;

/** Why a Gemini write failed, in words the owner reads (the explainer's `error`). Never holds the key. */
export class GeminiWriteError extends Error {
    constructor(message: string, readonly stage: 'key' | 'research' | 'write' | 'answer' | 'time') {
        super(message);
        this.name = 'GeminiWriteError';
    }
}

/** Statuses that hand a call to the next model: not available to this key (404), out of quota (429), overloaded (500, 503), or a refused request (400). */
const NEXT_MODEL_STATUSES: ReadonlySet<number> = new Set([400, 404, 429, 500, 503]);
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';
/** A call is not made with less than this left of the whole run. */
const MIN_CALL_MS = 8_000;
/** One call's own limit, and the whole run's (a Vercel function lives 300 s). */
const RESEARCH_TIMEOUT_MS = 100_000;
const WRITE_TIMEOUT_MS = 110_000;
export const GEMINI_RUN_BUDGET_MS = 250_000;
/** Redirects are followed one by one with this much time for all of them. */
const RESOLVE_TIMEOUT_MS = 6_000;
const RESOLVE_CONCURRENCY = 5;
/** The most sources one run keeps: the schema's, and what a first comment can list. */
const MAX_SOURCES = 20;

// ─── The schema, as Gemini takes it ────────────────────────────────────────────────────────────

const GEMINI_TYPES: Readonly<Record<string, GeminiSchema['type']>> = {
    object: 'OBJECT', array: 'ARRAY', string: 'STRING', integer: 'INTEGER', number: 'NUMBER', boolean: 'BOOLEAN',
};

/** What a JSON Schema bound says in words, for a description: Gemini's subset has no `maxLength`, and a model told the limit keeps to it more often than not. */
function boundsSentence(node: Record<string, unknown>): string {
    const parts: string[] = [];
    if (typeof node.minLength === 'number' && node.minLength > 0) parts.push(`At least ${node.minLength} characters.`);
    if (typeof node.maxLength === 'number') parts.push(`At most ${node.maxLength} characters.`);
    const [min, max] = [node.minItems, node.maxItems];
    if (typeof min === 'number' && typeof max === 'number') parts.push(`Between ${min} and ${max} items.`);
    else if (typeof min === 'number') parts.push(`At least ${min} items.`);
    else if (typeof max === 'number') parts.push(`At most ${max} items.`);
    if (typeof node.minimum === 'number') parts.push(`At least ${node.minimum}.`);
    return parts.join(' ');
}

/**
 * The writer's JSON Schema as Gemini's `responseSchema`: upper-case types, `propertyOrdering` so the model writes the keys in the schema's order, and nothing the
 * subset does not have (`additionalProperties`, `maxLength`, `minimum`, `$schema`, `title`): what was a bound moves into the description, where the model reads it.
 * The array bounds are dropped at send time (`withoutArrayBounds`: Gemini 3 has answered a schema carrying them with a bare 400), and enforced on the answer.
 */
export function toGeminiSchema(node: unknown): GeminiSchema {
    const schema = (node && typeof node === 'object' ? node : {}) as Record<string, any>;
    const type = GEMINI_TYPES[String(schema.type)];
    if (!type) throw new Error(`toGeminiSchema: "${String(schema.type)}" is not a type Gemini's schema has.`);
    const description = [typeof schema.description === 'string' ? schema.description : '', boundsSentence(schema)].filter(Boolean).join(' ');
    const out: GeminiSchema = { type };
    if (description) out.description = description;
    if (Array.isArray(schema.enum)) out.enum = schema.enum.map(String);
    if (schema.properties && typeof schema.properties === 'object') {
        out.properties = Object.fromEntries(Object.entries(schema.properties as Record<string, unknown>).map(([key, sub]) => [key, toGeminiSchema(sub)]));
        out.propertyOrdering = Object.keys(out.properties);
        if (Array.isArray(schema.required)) out.required = [...schema.required as string[]];
    }
    if (schema.items) out.items = toGeminiSchema(schema.items);
    if (typeof schema.minItems === 'number') out.minItems = schema.minItems;
    if (typeof schema.maxItems === 'number') out.maxItems = schema.maxItems;
    return out;
}

/** The `responseSchema` the write call is sent: the writer's schema in Gemini's subset, without array bounds. */
export function writerResponseSchema(): GeminiSchema {
    return withoutArrayBounds(toGeminiSchema(writerSchema()));
}

// ─── Calling Gemini ────────────────────────────────────────────────────────────────────────────

interface CallArgs {
    fetch: GeminiFetch;
    key: string;
    models: readonly string[];
    purpose: 'research' | 'write' | 'repair';
    body: object;
    timeoutMs: number;
    deadline: number;
    now: () => number;
}

/** What one call to the models returned: Gemini's answer, and the model that gave it. */
interface Answered {
    data: any;
    model: string;
}

const errorText = (data: any, fallback: string): string => String(data?.error?.message ?? fallback).replace(/\s+/g, ' ').slice(0, 300);

/**
 * `generateContent` on each model in turn until one answers. The key goes in a header (never the query string, which lands in logs), and nothing logged holds
 * the request or the key. A model that answers 400, 404, 429, 500 or 503 hands over to the next; the last one's refusal is the call's.
 */
async function callModels(args: CallArgs): Promise<Answered> {
    let last = { status: 0, message: '' };
    for (const [i, model] of args.models.entries()) {
        const left = args.deadline - args.now();
        if (left < MIN_CALL_MS) throw new GeminiWriteError(`Out of time before trying ${model}${i ? ' (the models before it failed)' : ''}.`, 'time');
        let res: Awaited<ReturnType<GeminiFetch>>;
        try {
            res = await args.fetch(`${ENDPOINT}/${model}:generateContent`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': args.key }, body: JSON.stringify(args.body),
                signal: AbortSignal.timeout(Math.min(args.timeoutMs, left)),
            });
        } catch (err) {
            const timedOut = (err as { name?: string })?.name === 'TimeoutError' || (err as { name?: string })?.name === 'AbortError';
            log('error', 'explainer.gemini_request_failed', { purpose: args.purpose, model, timed_out: timedOut });
            throw new GeminiWriteError(timedOut ? `Gemini did not answer the ${args.purpose} call in time.` : 'Gemini could not be reached.', args.purpose === 'research' ? 'research' : 'write');
        }
        const raw = await res.text();
        let data: any = null;
        try {
            data = JSON.parse(raw);
        } catch {
            data = null;
        }
        if (!res.ok) {
            last = { status: res.status, message: errorText(data, raw.slice(0, 200)) };
            log('warn', 'explainer.gemini_request_refused', { purpose: args.purpose, model, http_status: res.status, gemini_status: data?.error?.status, message: last.message });
            if (NEXT_MODEL_STATUSES.has(res.status) && i < args.models.length - 1) continue;
            break;
        }
        if (data === null) throw new GeminiWriteError('Gemini answered something that is not JSON.', args.purpose === 'research' ? 'research' : 'write');
        return { data, model };
    }
    const stage = args.purpose === 'research' ? 'research' : 'write';
    throw new GeminiWriteError(`Gemini refused the ${args.purpose} call on every model it tried (HTTP ${last.status}: ${last.message}).`, stage);
}

/** The text of an answer: its parts that are not thoughts, joined. */
function textOf(data: any): string {
    const parts = data?.candidates?.[0]?.content?.parts;
    return Array.isArray(parts) ? parts.filter((p: any) => p && !p.thought && typeof p.text === 'string').map((p: any) => p.text).join('') : '';
}

/** Why there is no text: a safety block, or an answer cut short, said plainly. */
function emptyAnswerReason(data: any): string {
    const candidate = data?.candidates?.[0];
    const block = data?.promptFeedback?.blockReason;
    return `finishReason ${candidate?.finishReason ?? 'none'}, blockReason ${block ?? 'none'}`;
}

const usageOf = (data: any): { prompt: number; output: number; thinking: number } => ({
    prompt: Number(data?.usageMetadata?.promptTokenCount) || 0, output: Number(data?.usageMetadata?.candidatesTokenCount) || 0,
    thinking: Number(data?.usageMetadata?.thoughtsTokenCount) || 0,
});

// ─── Research: the notes and their sources ─────────────────────────────────────────────────────

/** A source Gemini's search found, or the creator gave: the address a reader can open. */
export interface GroundedSource {
    title: string;
    url: string;
    /** Whether the address is the page itself, and not Google's redirect to it (a redirect that could not be followed is kept: it still opens the page). */
    resolved: boolean;
    /** The creator's own link, which the search did not find: the notes say nothing about it. */
    given?: boolean;
}

/** What `groundingMetadata` says: the pages, which text each one backs, and what was searched. */
export interface Grounding {
    chunks: { uri: string; title: string }[];
    supports: { end: number; chunks: number[] }[];
    queries: string[];
}

export function groundingOf(data: any): Grounding {
    const meta = data?.candidates?.[0]?.groundingMetadata;
    const chunks: Grounding['chunks'] = Array.isArray(meta?.groundingChunks)
        ? meta.groundingChunks.map((c: any) => ({ uri: typeof c?.web?.uri === 'string' ? c.web.uri : '', title: typeof c?.web?.title === 'string' ? c.web.title : '' }))
        : [];
    const supports: Grounding['supports'] = Array.isArray(meta?.groundingSupports)
        ? meta.groundingSupports.flatMap((s: any) => {
            const end = s?.segment?.endIndex;
            const indices = Array.isArray(s?.groundingChunkIndices) ? s.groundingChunkIndices.filter((n: unknown) => Number.isInteger(n)) : [];
            return Number.isInteger(end) && end >= 0 && indices.length ? [{ end: end as number, chunks: indices as number[] }] : [];
        })
        : [];
    const queries: string[] = Array.isArray(meta?.webSearchQueries) ? meta.webSearchQueries.filter((q: unknown): q is string => typeof q === 'string').slice(0, 20) : [];
    return { chunks, supports, queries };
}

const isRedirect = (uri: string): boolean => {
    try {
        const url = new URL(uri);
        return url.hostname === 'vertexaisearch.cloud.google.com' || url.pathname.includes('/grounding-api-redirect/');
    } catch {
        return false;
    }
};

const isHttp = (uri: string): boolean => /^https?:\/\//i.test(uri);

/** An address as it is compared: no fragment, no trailing slash, lower-case scheme and host. */
export function normalizeUrl(uri: string): string {
    try {
        const url = new URL(uri);
        url.hash = '';
        const path = url.pathname.replace(/\/+$/, '');
        return `${url.protocol}//${url.host}${path}${url.search}`;
    } catch {
        return uri.trim();
    }
}

const hostOf = (uri: string): string => {
    try {
        return new URL(uri).hostname.replace(/^www\./, '');
    } catch {
        return uri;
    }
};

/** Where Google's redirect leads, by asking once and not following: the `Location` of the 3xx. Null when it will not say. */
async function followRedirect(uri: string, fetch: GeminiFetch, timeoutMs: number): Promise<string | null> {
    try {
        const res = await fetch(uri, { method: 'GET', headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
        const location = res.headers.get('location');
        return res.status >= 300 && res.status < 400 && location && isHttp(location) ? location : null;
    } catch {
        return null;
    }
}

/**
 * The sources of a grounded answer, one per distinct page, numbered from 0 in the order they first appear, and which source each chunk is. Google's redirects are
 * followed to the page (a few at a time, a few seconds for all), the creator's links are added after them when the search did not find them, and nothing is
 * invented: a chunk with no address is not a source.
 */
export async function groundedSources(
    grounding: Grounding, given: readonly string[], fetch: GeminiFetch
): Promise<{ sources: GroundedSource[]; chunkToSource: number[] }> {
    const resolved: (string | null)[] = grounding.chunks.map(() => null);
    const deadline = Date.now() + RESOLVE_TIMEOUT_MS;
    let next = 0;
    const worker = async (): Promise<void> => {
        while (next < grounding.chunks.length) {
            const i = next++;
            const uri = grounding.chunks[i]!.uri;
            if (!isHttp(uri)) continue;
            resolved[i] = isRedirect(uri) ? await followRedirect(uri, fetch, Math.max(500, deadline - Date.now())) : uri;
        }
    };
    await Promise.all(Array.from({ length: Math.min(RESOLVE_CONCURRENCY, grounding.chunks.length) }, worker));

    const sources: GroundedSource[] = [];
    const byUrl = new Map<string, number>();
    const chunkToSource = grounding.chunks.map((chunk, i): number => {
        if (!isHttp(chunk.uri)) return -1;
        const url = resolved[i] ?? chunk.uri;
        const key = normalizeUrl(url);
        const known = byUrl.get(key);
        if (known !== undefined) return known;
        sources.push({ title: chunk.title.trim() || hostOf(url), url, resolved: resolved[i] !== null });
        byUrl.set(key, sources.length - 1);
        return sources.length - 1;
    });
    for (const link of given) {
        const key = normalizeUrl(link);
        if (byUrl.has(key) || !isHttp(link)) continue;
        sources.push({ title: hostOf(link), url: link, resolved: true, given: true });
        byUrl.set(key, sources.length - 1);
    }
    return { sources: sources.slice(0, MAX_SOURCES), chunkToSource };
}

/** The last byte offset at or before `at` that is not inside a UTF-8 character. */
function boundary(bytes: Buffer, at: number): number {
    let i = Math.min(at, bytes.length);
    while (i > 0 && i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i--;
    return i;
}

/**
 * The notes with `[n]` after each stretch a source backs (n is the source's number, from 0): where `groundingSupports` end, which Gemini counts in UTF-8 bytes,
 * from the last to the first so the earlier offsets stay true. The notes are asked for in English, where bytes and characters are nearly the same.
 */
export function annotateNotes(notes: string, supports: Grounding['supports'], chunkToSource: readonly number[]): string {
    const byEnd = new Map<number, Set<number>>();
    for (const support of supports) {
        const numbers = support.chunks.map((chunk) => chunkToSource[chunk] ?? -1).filter((n) => n >= 0);
        if (!numbers.length) continue;
        const set = byEnd.get(support.end) ?? new Set<number>();
        for (const n of numbers) set.add(n);
        byEnd.set(support.end, set);
    }
    let bytes = Buffer.from(notes, 'utf8');
    for (const end of [...byEnd.keys()].sort((a, b) => b - a)) {
        const at = boundary(bytes, end);
        const marker = [...byEnd.get(end)!].sort((a, b) => a - b).map((n) => `[${n}]`).join('');
        bytes = Buffer.concat([bytes.subarray(0, at), Buffer.from(marker, 'utf8'), bytes.subarray(at)]);
    }
    return bytes.toString('utf8');
}

export const RESEARCH_SYSTEM = [
    'You are a careful research assistant for a creator who is about to write a narrated explainer video. Your only job is to find out what is true about the topic, on the web, and to report it as notes.',
    '- Use Google Search. Look for primary sources: the paper that reported the result, the standard or RFC, the official documentation, the maintainers\' or the company\'s own write-up. A news article, a listicle, a social post and a vendor\'s benchmark are weak: use them only to find the primary source.',
    '- Write the notes in English, as short bullet points. Each bullet is one concrete fact that a source states: who found it or says it (names, the organisation), the year, what was measured or shown, and the condition it depends on. Give numbers only as the source gives them.',
    '- Say what you could not verify, and leave it out. Never fill a gap from memory.',
    '- Cover, in this order: the problem or surprise that opens the topic; who found what, and when; how it works, in plain steps; the limits, the trade-offs and what experts argue about (so the script can survive expert comments); what a viewer should take away.',
    '- No introduction, no conclusion and no advice: only the notes.',
].join('\n');

export function researchUserPrompt(request: Pick<WriterRequest, 'topic' | 'notes' | 'language' | 'sourceLinks' | 'today'>): string {
    const lines = [
        `Topic: ${request.topic.trim()}`,
        `The video will be in ${request.language === 'ar' ? 'Arabic' : 'English'}: write your notes in English anyway.`,
    ];
    if (request.today) lines.push(`Today: ${request.today}`);
    if (request.notes?.trim()) lines.push('', `Notes from the creator (follow them):\n${request.notes.trim()}`);
    if (request.sourceLinks.length) {
        lines.push('', `The creator pointed to these pages. Search for them, and use them where they hold the primary information:\n${request.sourceLinks.map((url) => `- ${url}`).join('\n')}`);
    }
    return lines.join('\n');
}

export interface Researched {
    notes: string;
    sources: GroundedSource[];
    queries: string[];
    model: string;
}

async function research(args: {
    request: WriterRequest; fetch: GeminiFetch; key: string; models: readonly string[]; deadline: number; now: () => number;
}): Promise<Researched & { usage: ReturnType<typeof usageOf> }> {
    const { data, model } = await callModels({
        fetch: args.fetch, key: args.key, models: args.models, purpose: 'research', timeoutMs: RESEARCH_TIMEOUT_MS, deadline: args.deadline, now: args.now,
        body: {
            systemInstruction: { parts: [{ text: RESEARCH_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: researchUserPrompt(args.request) }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 },
        },
    });
    const text = textOf(data).trim();
    if (!text) throw new GeminiWriteError(`Gemini's research came back empty (${emptyAnswerReason(data)}).`, 'research');
    const grounding = groundingOf(data);
    const { sources, chunkToSource } = await groundedSources(grounding, args.request.sourceLinks, args.fetch);
    return { notes: annotateNotes(text, grounding.supports, chunkToSource), sources, queries: grounding.queries, model, usage: usageOf(data) };
}

// ─── Write: the script, from the notes ─────────────────────────────────────────────────────────

/** The numbered sources, as the writer is shown them (and nothing else it may cite). */
export function numberedSources(sources: readonly GroundedSource[]): string {
    return sources.map((s, n) => `[${n}] ${s.title} — ${s.url}${s.given ? ' (given by the creator; the research did not read it)' : ''}`).join('\n');
}

/** The user prompt of the write call: the request as Claude gets it, then the notes and the numbered sources. */
export function writeUserPromptWithNotes(userPrompt: string, researched: Pick<Researched, 'notes' | 'sources'>): string {
    return [
        userPrompt, '',
        'RESEARCH NOTES (in English; the numbers in square brackets are the numbers of the sources that back the text before them):',
        researched.notes, '',
        researched.sources.length ? `NUMBERED SOURCES (the only sources you may use):\n${numberedSources(researched.sources)}` : 'NUMBERED SOURCES: none were found. Write `sources` as an empty list and `source_ids` as empty lists, and say only what the notes say.',
    ].join('\n');
}

/** How many output tokens a script of the tier may take: 250 scenes of JSON are about 50,000. */
const OUTPUT_TOKENS = { short: 16_384, medium: 32_768, long: 65_536 } as const;

export interface GeminiWritten {
    written: ExplainerWriterOutput;
    model: string;
    /** What the run did, for the log and the job's result: never a draft's text. */
    report: { queries: number; sources_found: number; sources_kept: number; dropped_unknown_url: number; dropped_uncited: number; research_model: string; repaired: boolean };
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]»]+/gi;

/** Text with every address that is not in `allowed` taken out: a caption must not carry a link nobody found. */
export function scrubUrls(text: string, allowed: ReadonlySet<string>): string {
    return text.replace(URL_IN_TEXT, (found) => {
        const trimmed = found.replace(/[.,;:!?]+$/, '');
        return allowed.has(normalizeUrl(trimmed)) ? found : '';
    }).replace(/[ \t]+$/gm, '');
}

/** The first comment, rebuilt from the sources that are left (a model's own list may carry an address nobody found), in the video's language. */
export function firstCommentFor(language: 'ar' | 'en', sources: readonly { title: string; by: string; year: string; url: string }[], max = 1500): string {
    if (sources.length === 0) return '';
    const header = language === 'ar' ? 'المصادر:' : 'Sources:';
    const lines = sources.map((s, i) => {
        const label = [s.title, s.by && s.by !== s.title ? s.by : ''].filter(Boolean).join(' — ');
        return `${i + 1}. ${label}${s.year ? ` (${s.year})` : ''}\n${s.url}`;
    });
    let text = [header, ...lines].join('\n');
    while (text.length > max && lines.length > 1) {
        lines.pop();
        text = [header, ...lines].join('\n');
    }
    return text.slice(0, max);
}

/**
 * The answer with only what the numbered list allows. A source whose address is not in the list is dropped, and with it every `source_id` that named it; the
 * address of a source that stays is the list's own spelling; sources no scene cites are dropped (when any scene cites one) and the ids renumbered; the first
 * comment is rebuilt; an address in a caption that is not a kept source's is removed.
 */
export function onlyListedSources(
    output: ExplainerWriterOutput, list: readonly GroundedSource[], language: 'ar' | 'en'
): { output: ExplainerWriterOutput; droppedUnknown: number; droppedUncited: number } {
    const index = new Map(list.map((s, n) => [normalizeUrl(s.url), n]));
    const clip = (text: string, max: number): string => [...text].slice(0, max).join('');
    const answered = output.sources.map((source, k) => {
        const n = index.get(normalizeUrl(source.url));
        return n === undefined ? null : { k, source: { title: clip(source.title, 300), by: clip(source.by, 300), year: clip(source.year, 10), url: list[n]!.url } };
    });
    const droppedUnknown = answered.filter((a) => a === null).length;
    let kept = answered.filter((a): a is NonNullable<typeof a> => a !== null);
    const cited = new Set(output.scenes.flatMap((scene) => scene.source_ids));
    let droppedUncited = 0;
    if (kept.some((a) => cited.has(a.k))) {
        const before = kept.length;
        kept = kept.filter((a) => cited.has(a.k));
        droppedUncited = before - kept.length;
    }
    const renumber = new Map(kept.map((a, position) => [a.k, position]));
    const sources = kept.map((a) => a.source);
    const scenes = output.scenes.map((scene) => ({
        ...scene, source_ids: [...new Set(scene.source_ids.flatMap((id) => (renumber.has(id) ? [renumber.get(id)!] : [])))].sort((a, b) => a - b),
    }));
    const allowed = new Set(sources.map((s) => normalizeUrl(s.url)));
    const captions = {
        meta: scrubUrls(output.captions.meta, allowed),
        youtube: { title: scrubUrls(output.captions.youtube.title, allowed), description: scrubUrls(output.captions.youtube.description, allowed) },
        tiktok: scrubUrls(output.captions.tiktok, allowed),
    };
    return { output: { ...output, scenes, sources, captions, first_comment: firstCommentFor(language, sources) }, droppedUnknown, droppedUncited };
}

/** Said after a refused research call: on a free-tier key every Gemini 3 model refuses grounding, which looks like any other refusal and is not one. */
export const GROUNDING_HINT =
    ' Google Search grounding is not offered on every Gemini key: on the free tier it is not available for Gemini 3 models (ai.google.dev/gemini-api/docs/pricing), '
    + 'and a paid-tier key gets 5,000 free searches a month. Sign the Mac\'s Claude Code in so Claude writes, or use a paid-tier key.';

export interface GeminiWriteArgs {
    request: WriterRequest;
    /** Words a second from the settings. */
    pace?: number;
    /** Reaches Gemini; injected by the tests. */
    fetch?: GeminiFetch;
    /** The key, else the platform's (`getGeminiKey`). */
    key?: string;
    models?: readonly string[];
    now?: () => number;
    /** Told what the run is doing, so a heartbeat can say so. */
    onProgress?: (text: string) => Promise<void> | void;
}

const problemsPrompt = (problems: readonly string[]): string =>
    ['Your previous answer was checked and does not fit the schema:', ...problems.slice(0, 12).map((p) => `- ${p}`),
        '', 'Answer again with the whole corrected draft: fix every problem above and keep everything else as it was.'].join('\n');

/**
 * One explainer's script, written by Gemini: research with grounding, then write from the notes. Throws a `GeminiWriteError` that says what happened when a
 * step cannot be done; a draft that is written but breaks a rule (a closing line that is not a question, a woman in a brief) is not an error here: it goes through
 * `applyExplainerResult`, which flags it like Claude's.
 */
export async function writeWithGemini(args: GeminiWriteArgs): Promise<GeminiWritten> {
    const now = args.now ?? Date.now;
    const fetch = args.fetch ?? (globalThis.fetch as unknown as GeminiFetch);
    const key = args.key ?? (await getGeminiKey())?.key;
    if (!key) throw new GeminiWriteError(MISSING_GEMINI_KEY, 'key');
    const models = args.models ?? STUDIO_MODELS;
    const deadline = now() + GEMINI_RUN_BUDGET_MS;
    const language = args.request.language;

    await args.onProgress?.('Gemini is researching the topic on the web');
    const researched = await research({ request: args.request, fetch, key, models, deadline, now }).catch((err: unknown) => {
        if (err instanceof GeminiWriteError && err.stage === 'research' && /refused the research call/.test(err.message)) throw new GeminiWriteError(err.message + GROUNDING_HINT, 'research');
        throw err;
    });
    log('info', 'explainer.gemini_researched', {
        model: researched.model, queries: researched.queries.length, sources: researched.sources.length, notes_chars: researched.notes.length, ...researched.usage,
    });
    if (researched.sources.length === 0) {
        log('warn', 'explainer.gemini_no_sources', { model: researched.model, queries: researched.queries.length });
    }

    await args.onProgress?.('Gemini is writing the script from its notes');
    const inputs = buildWriterInputs(args.request, args.pace, 'notes');
    const userText = writeUserPromptWithNotes(inputs.user, researched);
    const responseSchema = writerResponseSchema();
    const write = (turns: { role: 'user' | 'model'; text: string }[], purpose: 'write' | 'repair') => callModels({
        fetch, key, models, purpose, timeoutMs: WRITE_TIMEOUT_MS, deadline, now,
        body: {
            systemInstruction: { parts: [{ text: inputs.system }] },
            contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            generationConfig: { responseMimeType: 'application/json', responseSchema, temperature: 0.5, maxOutputTokens: OUTPUT_TOKENS[args.request.tier] },
        },
    });
    const read = (data: any): unknown => {
        const text = textOf(data).trim();
        if (!text) throw new GeminiWriteError(`Gemini's script came back empty (${emptyAnswerReason(data)}).`, 'answer');
        try {
            return JSON.parse(text);
        } catch (err) {
            // A script cut off by the output limit is valid text and invalid JSON.
            throw new GeminiWriteError(`Gemini's script is not valid JSON (${(err as Error).message}; ${emptyAnswerReason(data)}).`, 'answer');
        }
    };

    let answered = await write([{ role: 'user', text: userText }], 'write');
    let raw = read(answered.data);
    let problems = schemaProblems(writerSchema(), raw);
    let repaired = false;
    if (problems.length) {
        // One repair, shown its own answer and what is wrong with it: the research is done, the fix is to the draft.
        log('warn', 'explainer.gemini_answer_repair', { model: answered.model, problems: problems.length });
        await args.onProgress?.('Gemini is fixing the script it wrote');
        repaired = true;
        answered = await write([
            { role: 'user', text: userText }, { role: 'model', text: JSON.stringify(raw) }, { role: 'user', text: problemsPrompt(problems) },
        ], 'repair');
        raw = read(answered.data);
    }
    const parsed = parseWriterOutput(raw);
    if (!parsed.ok) {
        throw new GeminiWriteError(`Gemini's script does not fit the schema${repaired ? ', even after one repair' : ''}: ${parsed.problems.slice(0, 6).join('; ')}.`, 'answer');
    }
    const { output, droppedUnknown, droppedUncited } = onlyListedSources(parsed.output, researched.sources, language);
    log('info', 'explainer.gemini_written', { model: answered.model, scenes: output.scenes.length, sources: output.sources.length, dropped_unknown_url: droppedUnknown, dropped_uncited: droppedUncited, repaired, ...usageOf(answered.data) });
    return {
        written: output, model: answered.model,
        report: {
            queries: researched.queries.length, sources_found: researched.sources.length, sources_kept: output.sources.length, dropped_unknown_url: droppedUnknown,
            dropped_uncited: droppedUncited, research_model: researched.model, repaired,
        },
    };
}
