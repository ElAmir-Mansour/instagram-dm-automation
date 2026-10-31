/**
 * Open weights against hosted (docs/specs/005-muse-sees US8, `--open-weights`): the same reel, watched by Muse Spark hosted by Meta and by Muse Spark Open served by Baseten, with the
 * same prompt, the same schema and the same limits, and what comes back read the same way. The video memory is built by one analysis of each reel; the question is whether the
 * open model's analysis is as good, and what it costs in time and tokens.
 *
 * Only the creator's OWN reel goes to Baseten, never a follower's message: the indexer reads the owner's public reels, and followers' DMs stay on Meta's hosted models.
 *
 * "As good" is read with checks a person can see, not a model's opinion: the answer is valid JSON in the schema; it holds at least five moments, in order, inside the reel; the hook score and the
 * cover second are in range; the caption and the narration are in Arabic, which is what the reel speaks; and each FACT the reel is known to hold (the 45-riyal meal, the one riyal paid, the developer
 * tools, the fix) is in the analysis somewhere. Latency is the call's wall time and tokens are the response's own. Hosted is priced from the table; the open model's partner credits have no
 * price here, so its cost is not invented.
 *
 * The prompt is this benchmark's own, written to the indexer's contract (contracts/perception.md §4). When the indexer lands its prompt can replace it here.
 */
import { scriptShares } from '../../dmSales/__evals__/dialect.js';
import { DEFAULT_PRICES } from '../../llm/cost.js';
import { AiError, isAiError } from '../../llm/errors.js';
import { generateJson, parseModelJson } from '../../llm/generate.js';
import { parseChatResponse } from '../../llm/adapters/chatCompletions.js';
import { postJson } from '../../llm/adapters/post.js';
import { strictSchemaFor } from '../../llm/adapters/strict.js';
import { requiredKeys, type LlmSchema } from '../../llm/schema.js';
import type { FetchLike } from '../../llm/types.js';
import { billingOf, Ledger } from './caller.js';
import type { LoadedMedia } from './cases.js';
import type { OpenWeightsSpec } from './types.js';

export const BASETEN_BASE_URL = 'https://inference.baseten.co/v1';
export const OPEN_MODEL = 'meta-models/muse-spark-open-1026';
export const HOSTED_MODEL = 'muse-spark-1.3';
/** The room a model that reasons first needs for an analysis this long (contracts/perception.md §4). */
export const ANALYSIS_MAX_TOKENS = 8_000;
export const ANALYSIS_TIMEOUT_MS = 120_000;

export const REEL_ANALYSIS_PROMPT = [
    'You are indexing one Instagram reel for its creator\'s video library, so that a follower\'s question about it can be answered later. Watch the whole reel: the picture, the on-screen text and code, the characters, and the speech.',
    'Report: summary (2 to 4 sentences, English); topics (short English tags); seen_on_screen (the text, code, diagrams and characters that are SHOWN, not said); narration (the speech, as close to word for word as you can, in the language spoken);',
    'key_moments (the moments worth jumping to, each with the second it starts at and what happens); hook_first_3s (what the first 3 seconds show and say); hook_score (1 to 10: how well the first 3 seconds stop a scroll);',
    'caption_ar (a short caption in Arabic); cover_second (the second whose frame makes the best cover); cover_reason (one sentence).',
    'If you are not sure of something, leave it out. Never guess.',
].join(' ');

/** The schema of the analysis: every field required, no union, so the same schema goes to either model. */
export const REEL_ANALYSIS_SCHEMA: LlmSchema = {
    type: 'OBJECT',
    properties: {
        summary: { type: 'STRING' },
        topics: { type: 'ARRAY', items: { type: 'STRING' } },
        seen_on_screen: { type: 'ARRAY', items: { type: 'STRING' } },
        narration: { type: 'STRING' },
        key_moments: { type: 'ARRAY', items: { type: 'OBJECT', properties: { second: { type: 'NUMBER' }, what: { type: 'STRING' } }, required: ['second', 'what'] } },
        hook_first_3s: { type: 'STRING' },
        hook_score: { type: 'INTEGER' },
        caption_ar: { type: 'STRING' },
        cover_second: { type: 'NUMBER' },
        cover_reason: { type: 'STRING' },
    },
    required: ['summary', 'topics', 'seen_on_screen', 'narration', 'key_moments', 'hook_first_3s', 'hook_score', 'caption_ar', 'cover_second', 'cover_reason'],
};

// ─── Two ways to ask ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Analysis {
    json: unknown;
    model: string;
    tokensIn: number;
    tokensOut: number;
    /** Dollars, or null when the model has no price here. */
    usd: number | null;
    ms: number;
    /** A request the endpoint refused as unknown was repeated without it. */
    note?: string;
}

/** Asks one model to analyse one reel. Throws an `AiError` for a call that failed. */
export type AnalyzeReel = (video: LoadedMedia) => Promise<Analysis>;

export interface AnalyzerOptions {
    apiKey: string;
    fetchImpl?: FetchLike;
}

/** Muse Spark hosted by Meta, through the same `generateJson` the product's indexer will call. */
export function hostedAnalyzer(o: AnalyzerOptions & { model?: string; ledger: Ledger }): AnalyzeReel {
    const model = o.model ?? HOSTED_MODEL;
    return async (video) => {
        const started = performance.now();
        const result = await generateJson({
            provider: 'meta', apiKey: o.apiKey, model, system: '', schema: REEL_ANALYSIS_SCHEMA, maxTokens: ANALYSIS_MAX_TOKENS, timeoutMs: ANALYSIS_TIMEOUT_MS, effort: 'low',
            user: [{ role: 'user', text: REEL_ANALYSIS_PROMPT, media: [{ kind: 'video', mime: video.mime, base64: video.bytes.toString('base64') }] }],
            ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        });
        const ms = performance.now() - started;
        const billing = billingOf(result, DEFAULT_PRICES);
        o.ledger.add({ role: 'analysis', provider: 'meta', model: result.model, usd: billing.usd, priced: billing.priced, tokensIn: billing.usage.in, tokensOut: billing.usage.out, cacheRead: billing.usage.cacheRead ?? 0, ms, ok: true });
        return { json: result.json, model: result.model, tokensIn: billing.usage.in + (billing.usage.cacheRead ?? 0), tokensOut: billing.usage.out, usd: billing.priced ? billing.usd : null, ms };
    };
}

/** The request body Baseten is sent. Exported so a test can hold it to the shape the endpoint was tried with. */
export function openRequestBody(video: LoadedMedia, model: string, withEffort: boolean): Record<string, unknown> {
    const schema = strictSchemaFor({ provider: 'meta', model, apiKey: '', schema: REEL_ANALYSIS_SCHEMA }, { objectRoot: true });
    return {
        model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: REEL_ANALYSIS_PROMPT },
                { type: 'video_url', video_url: { url: `data:${video.mime};base64,${video.bytes.toString('base64')}` } },
            ],
        }],
        max_tokens: ANALYSIS_MAX_TOKENS,
        response_format: { type: 'json_schema', json_schema: { name: 'reel_analysis', strict: true, schema } },
        ...(withEffort ? { reasoning_effort: 'low' } : {}),
    };
}

/**
 * Muse Spark Open on Baseten (OpenAI-compatible chat completions, video as a base64 `data:` URL). The key goes to Baseten's host and nowhere else; the request is the product's
 * request for the reel indexer, apart from the endpoint. A 400 that may be the `reasoning_effort` field is repeated once without it, and the row says so.
 */
export function openAnalyzer(o: AnalyzerOptions & { model?: string; baseUrl?: string }): AnalyzeReel {
    const model = o.model ?? OPEN_MODEL;
    const base = (o.baseUrl ?? BASETEN_BASE_URL).replace(/\/+$/, '');
    return async (video) => {
        const started = performance.now();
        let note: string | undefined;
        let data: unknown;
        for (const withEffort of [true, false]) {
            try {
                data = await postJson({
                    provider: 'custom', model, url: `${base}/chat/completions`, headers: { authorization: `Bearer ${o.apiKey}` }, body: openRequestBody(video, model, withEffort), key: o.apiKey,
                    signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_MS), ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
                });
                break;
            } catch (err) {
                if (withEffort && err instanceof AiError && err.kind === 'bad_request' && err.status === 400) {
                    note = 'refused reasoning_effort, so it was asked again without it';
                    continue;
                }
                throw err;
            }
        }
        const ms = performance.now() - started;
        const parsed = parseChatResponse(data, { provider: 'meta', model, apiKey: o.apiKey });
        if (parsed.stopReason !== 'end_turn') {
            throw new AiError({ kind: parsed.stopReason === 'max_tokens' ? 'max_tokens' : 'refusal', provider: 'custom', model, message: `Baseten stopped the answer (${parsed.stopReason}).`, key: o.apiKey });
        }
        const json = parseModelJson(parsed.text);
        if (!json) throw new AiError({ kind: 'bad_output', provider: 'custom', model, message: 'Baseten\'s answer is not valid JSON.', key: o.apiKey });
        return { json: json.value, model, tokensIn: parsed.usage.in + (parsed.usage.cacheRead ?? 0), tokensOut: parsed.usage.out, usd: null, ms, ...(note ? { note } : {}) };
    };
}

// ─── Reading an analysis ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface AnalysisCheck {
    name: string;
    pass: boolean;
    detail: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const arabicShare = (text: string): number => {
    const s = scriptShares(text);
    return s.letters === 0 ? 0 : s.arabic / s.letters;
};

/** Every string in the analysis, as one lower-case text: where a fact may be found. */
function allText(v: unknown): string {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(allText).join(' ');
    if (isObj(v)) return Object.values(v).map(allText).join(' ');
    return '';
}

/** The analysis against what is known of the reel. Pure: nothing here asks a model. */
export function checkAnalysis(spec: OpenWeightsSpec, json: unknown): { checks: AnalysisCheck[]; facts: { name: string; found: boolean }[] } {
    const checks: AnalysisCheck[] = [];
    const add = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail: pass ? '' : detail }); };
    const o = isObj(json) ? json : {};

    const required = requiredKeys(REEL_ANALYSIS_SCHEMA);
    const missing = required.filter((k) => !(k in o));
    add('valid_json', isObj(json) && missing.length === 0, isObj(json) ? `missing ${missing.join(', ')}` : 'not an object');

    const moments = Array.isArray(o.key_moments) ? o.key_moments : [];
    const seconds = moments.map((m) => (isObj(m) && typeof m.second === 'number' ? m.second : NaN));
    const ordered = seconds.every((s, i) => Number.isFinite(s) && s >= 0 && s <= spec.durationS + 1 && (i === 0 || s > seconds[i - 1]!));
    const worded = moments.every((m) => isObj(m) && typeof m.what === 'string' && m.what.trim() !== '');
    add('moments', moments.length >= 5 && ordered && worded, `${moments.length} moments${moments.length < 5 ? ' (at least 5)' : ''}${ordered ? '' : ', not in order or outside the reel'}${worded ? '' : ', one has no words'}`);

    add('hook_score', typeof o.hook_score === 'number' && Number.isInteger(o.hook_score) && o.hook_score >= 1 && o.hook_score <= 10, `hook_score is ${JSON.stringify(o.hook_score)}, not a whole number from 1 to 10`);
    add('cover_second', typeof o.cover_second === 'number' && o.cover_second >= 0 && o.cover_second <= spec.durationS, `cover_second is ${JSON.stringify(o.cover_second)}, not inside the ${spec.durationS} s reel`);
    const caption = typeof o.caption_ar === 'string' ? o.caption_ar : '';
    add('caption_ar', caption.trim() !== '' && arabicShare(caption) >= 0.5, 'the caption is empty or not mostly Arabic');
    const narration = typeof o.narration === 'string' ? o.narration : '';
    add('narration', narration.split(/\s+/).filter(Boolean).length >= 20 && arabicShare(narration) >= 0.5, 'the narration is under 20 words or not mostly Arabic');

    const text = allText(json).toLowerCase();
    const facts = spec.facts.map((f) => ({ name: f.name, found: f.any.some((w) => text.includes(w.toLowerCase())) }));
    return { checks, facts };
}

export interface AnalysisRun {
    label: string;
    model: string;
    status: 'ok' | 'failed';
    error: string | null;
    note: string | null;
    ms: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    usd: number | null;
    checks: AnalysisCheck[];
    facts: { name: string; found: boolean }[];
}

/** One model, one reel. A failure is a row that says so, never an exception that ends the benchmark. */
export async function analyse(label: string, model: string, run: AnalyzeReel, video: LoadedMedia, spec: OpenWeightsSpec, key: string): Promise<AnalysisRun> {
    try {
        const a = await run(video);
        const { checks, facts } = checkAnalysis(spec, a.json);
        return { label, model: a.model || model, status: 'ok', error: null, note: a.note ?? null, ms: a.ms, tokensIn: a.tokensIn, tokensOut: a.tokensOut, usd: a.usd, checks, facts };
    } catch (err) {
        const reason = isAiError(err) ? `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}` : (err instanceof Error ? err.message : String(err)).split(key).join('[key]').slice(0, 100);
        return { label, model, status: 'failed', error: reason, note: null, ms: null, tokensIn: null, tokensOut: null, usd: null, checks: [], facts: [] };
    }
}
