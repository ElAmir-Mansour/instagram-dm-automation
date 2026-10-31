/**
 * Open weights against hosted (docs/specs/005-muse-sees US8, `--open-weights`): the same reel, watched by Muse Spark hosted by Meta and by Muse Spark Open served by Baseten, with
 * the SAME request the video memory's indexer makes (`reelIndex.ts`: its system text, its prompt, its schema, its limit and its effort), and what comes back read the same way. The
 * memory is built by one analysis of each reel; the question is whether the open model's analysis is as good, and what it costs in time and tokens.
 *
 * Both go through `generateJson` (`llm/generate.ts`), which is what the providers layer calls once it has chosen a route, so the request that leaves is the one the indexer sends
 * and nothing else; the layer's own settings read and `ai_usage` row are what a benchmark leaves out. Only the creator's OWN reel is sent to Baseten, never a follower's message:
 * the indexer reads the owner's public reels, and followers' DMs stay on Meta's hosted models (`PROVIDER_PURPOSE_ALLOWLIST`: Baseten may answer `reel_index` alone).
 *
 * "As good" is read with checks a person can see, not a model's opinion: the product's own parser (`parseReelAnalysis`) accepts the answer; it holds at least four moments (the prompt asks
 * for four to ten), inside the reel; the hook score and the cover second are in range; the caption and the narration are in Arabic, which is what the reel speaks; and each FACT the
 * reel is known to hold (the 45-riyal meal, the one riyal paid, the developer tools, the fix) is in the analysis somewhere. Latency is the call's wall time; tokens and dollars are the
 * response's own, priced with the table in `llm/cost.ts` (Baseten's price for the open model is $1.25 and $4.25 a million, the same as hosted, and its partner credits pay it).
 */
import { scriptShares } from '../../dmSales/__evals__/dialect.js';
import { DEFAULT_PRICES } from '../../llm/cost.js';
import { isAiError } from '../../llm/errors.js';
import { generateJson } from '../../llm/generate.js';
import type { FetchLike } from '../../llm/types.js';
import { ANALYSIS_TIMEOUT_MS, parseReelAnalysis, REEL_ANALYSIS_SCHEMA, REEL_INDEX_PROMPT, REEL_INDEX_SYSTEM, REEL_MAX_TOKENS } from '../reelIndex.js';
import { billingOf, scrubKey, type Ledger } from './caller.js';
import type { LoadedMedia } from './cases.js';
import type { OpenWeightsSpec } from './types.js';

export const HOSTED_MODEL = 'muse-spark-1.3';
export const OPEN_MODEL = 'meta-models/muse-spark-open-1026';

export interface Analysis {
    json: unknown;
    model: string;
    /** Everything the prompt cost in tokens, cached input included. */
    tokensIn: number;
    tokensOut: number;
    usd: number;
    /** False: a model with no price in the table, charged at its ceiling. */
    priced: boolean;
    ms: number;
}

/** Asks one model to analyse one reel. Throws an `AiError` for a call that failed. */
export type AnalyzeReel = (video: LoadedMedia) => Promise<Analysis>;

export interface AnalyzerOptions {
    provider: 'meta' | 'baseten';
    model: string;
    apiKey: string;
    ledger: Ledger;
    fetchImpl?: FetchLike;
}

/** What the indexer sends for a reel, with the video as base64 in the one user turn: exported so a test can hold it to the indexer's own constants. */
export function indexerRequest(video: LoadedMedia): { system: string; user: { role: 'user'; text: string; media: { kind: 'video'; mime: string; base64: string }[] }[] } {
    return { system: REEL_INDEX_SYSTEM, user: [{ role: 'user', text: REEL_INDEX_PROMPT, media: [{ kind: 'video', mime: video.mime, base64: video.bytes.toString('base64') }] }] };
}

/** One model, asked as the indexer asks it. The key goes to that provider's own host through the adapter and nowhere else. */
export function reelAnalyzer(o: AnalyzerOptions): AnalyzeReel {
    return async (video) => {
        const started = performance.now();
        const { system, user } = indexerRequest(video);
        const result = await generateJson({
            provider: o.provider, apiKey: o.apiKey, model: o.model, system, user, schema: REEL_ANALYSIS_SCHEMA, maxTokens: REEL_MAX_TOKENS, timeoutMs: ANALYSIS_TIMEOUT_MS, effort: 'low',
            ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        });
        const ms = performance.now() - started;
        const billing = billingOf(result, DEFAULT_PRICES);
        o.ledger.add({
            role: 'analysis', provider: o.provider, model: result.model, usd: billing.usd, priced: billing.priced, tokensIn: billing.usage.in, tokensOut: billing.usage.out,
            cacheRead: billing.usage.cacheRead ?? 0, ms, ok: true,
        });
        return { json: result.json, model: result.model, tokensIn: billing.usage.in + (billing.usage.cacheRead ?? 0), tokensOut: billing.usage.out, usd: billing.usd, priced: billing.priced, ms };
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

/** The fewest moments the prompt's "4 to 10" accepts. */
export const MIN_MOMENTS = 4;

/** What the model said, against what is known of the reel. Pure: nothing here asks a model. */
export function checkAnalysis(spec: OpenWeightsSpec, json: unknown): { checks: AnalysisCheck[]; facts: { name: string; found: boolean }[] } {
    const checks: AnalysisCheck[] = [];
    const add = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail: pass ? '' : detail }); };
    const o = isObj(json) ? json : {};

    add('usable', parseReelAnalysis(json) !== null, 'the product\'s own parser finds nothing usable in it');

    const moments = Array.isArray(o.key_moments) ? o.key_moments : [];
    const seconds = moments.map((m) => (isObj(m) && typeof m.second === 'number' ? m.second : NaN));
    const inside = seconds.every((s) => Number.isFinite(s) && s >= 0 && s <= spec.durationS + 1);
    const worded = moments.every((m) => isObj(m) && typeof m.what === 'string' && m.what.trim() !== '');
    add('moments', moments.length >= MIN_MOMENTS && inside && worded, `${moments.length} moments${moments.length < MIN_MOMENTS ? ` (at least ${MIN_MOMENTS})` : ''}${inside ? '' : ', one is outside the reel'}${worded ? '' : ', one has no words'}`);

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
    ms: number | null;
    tokensIn: number | null;
    tokensOut: number | null;
    usd: number | null;
    checks: AnalysisCheck[];
    facts: { name: string; found: boolean }[];
}

/** One model, one reel. A failure is a row that says so, never an exception that ends the benchmark. The key is taken out of anything said about it. */
export async function analyse(label: string, model: string, run: AnalyzeReel, video: LoadedMedia, spec: OpenWeightsSpec, key: string): Promise<AnalysisRun> {
    try {
        const a = await run(video);
        const { checks, facts } = checkAnalysis(spec, a.json);
        return { label, model: a.model || model, status: 'ok', error: null, ms: a.ms, tokensIn: a.tokensIn, tokensOut: a.tokensOut, usd: a.priced ? a.usd : null, checks, facts };
    } catch (err) {
        const reason = isAiError(err) ? `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}` : scrubKey(err instanceof Error ? err.message : String(err), key).slice(0, 100);
        return { label, model, status: 'failed', error: reason, ms: null, tokensIn: null, tokensOut: null, usd: null, checks: [], facts: [] };
    }
}
