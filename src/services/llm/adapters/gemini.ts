/**
 * Gemini's generateContent, asked for JSON.
 *
 * The request mirrors `callGemini` (studio/generate.ts), which has been answering in production:
 * `systemInstruction`, `contents`, and `generationConfig` with `responseMimeType:
 * 'application/json'` plus `responseSchema`. The key travels in `x-goog-api-key`, never the query
 * string, which lands in logs. The base URL is Google's, always: an operator's URL would be
 * somewhere to send the key.
 *
 * Checked against ai.google.dev and Google's SDK references on 2026-10-13, with findings that
 * shape the code:
 *
 *   - `responseJsonSchema` takes plain JSON Schema (unions, `additionalProperties`, nullable type
 *     arrays) where `responseSchema` takes only Gemini's OpenAPI-style subset. So a `GeminiSchema`
 *     goes as `responseSchema`, exactly as `callGemini` sends it, and a `{json}` schema goes as
 *     `responseJsonSchema`. Google now labels `responseSchema` and `responseMimeType` deprecated
 *     in favour of a `responseFormat` block, but they still work and `callGemini` depends on them;
 *     moving both callers together is a change for a day when they stop.
 *   - Thinking (generate-content/thinking): "Gemini 2.5 series models don't support
 *     `thinkingLevel`; use `thinkingBudget` instead", and for Gemini 3 `thinkingLevel` is the
 *     parameter while `thinkingBudget` is "accepted for backwards compatibility" and may perform
 *     unexpectedly. The Gemini 3 guide adds that sending both in one request is a 400. So Gemini 3
 *     gets a level, 2.5 gets a budget, and older models and names this code does not recognise get
 *     no `thinkingConfig` at all, which is always safe: the model thinks as it does by default.
 *   - Which levels a Gemini 3 model takes differs: 3.8 Flash refuses `minimal`, 3.1 Pro has no
 *     `minimal`, and the first Pro preview (`gemini-3-pro-preview`) takes only `low` and `high`
 *     (its row in the thinking-levels table of the Interactions API page; the generateContent
 *     page omits that model). `minimal` is never sent, and `medium` is raised to `high` there.
 *   - `maxOutputTokens` includes thinking, and `usageMetadata` counts thinking apart from the
 *     answer (`thoughtsTokenCount`), billed as output, so the two are added.
 */
import { totalUsage } from '../cost.js';
import { withoutArrayBounds } from '../geminiSchema.js';
import { isRawJsonSchema } from '../schema.js';
import type { Adapter, AdapterArgs, AdapterResult, Billed, Effort, FamilyAdapter, ProviderQuery, StopReason } from '../types.js';
import { prepareQuery } from './endpoint.js';
import { refuseMedia } from './media.js';
import { getJson, postJson } from './post.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Effort as a Gemini 2.5 thinking budget, in tokens. The budget is a target the model aims at and
 * counts against `maxOutputTokens`. Every value is inside the range of all three 2.5 models (Pro
 * 128–32768 and cannot be switched off, Flash 0–24576, Flash-Lite 512–24576).
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };

/** Effort as a Gemini 3 level. `minimal` is never sent (3.8 Flash refuses it), nor is anything above `high`. */
export const THINKING_LEVELS: Readonly<Record<Effort, 'low' | 'medium' | 'high'>> = {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** A budget leaves at least half of `maxOutputTokens` for the answer: a call is never retried, and one that thinks itself out of room is wasted. */
const MIN_BUDGET = 512;

/** The level for this Gemini 3 model: `gemini-3-pro-preview` has no `medium`, so it gets `high`, which is also its default. */
function levelFor(model: string, effort: Effort): 'low' | 'medium' | 'high' {
    const level = THINKING_LEVELS[effort];
    return level === 'medium' && /^(?:models\/)?gemini-3-pro(?:-|$)/i.test(model) ? 'high' : level;
}

/** `thinkingConfig` for this model and effort, or undefined where there is nothing safe to send. */
export function thinkingConfigFor(model: string, effort: Effort, maxTokens: number): Record<string, unknown> | undefined {
    const m = model.toLowerCase().match(/^(?:models\/)?gemini-(\d+)(?:\.(\d+))?/);
    if (!m) return undefined;
    const major = Number(m[1]);
    if (major >= 3) return { thinkingLevel: levelFor(model, effort) };
    if (major === 2 && m[2] === '5') {
        return { thinkingBudget: Math.max(MIN_BUDGET, Math.min(THINKING_BUDGETS[effort], Math.floor(maxTokens / 2))) };
    }
    return undefined;
}

export function buildGeminiRequest(a: AdapterArgs): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    // Only Meta is sent pictures and video here: a turn that carries any is refused before a request exists.
    refuseMedia(a);
    const turns = typeof a.user === 'string' ? [{ role: 'user' as const, text: a.user }] : a.user;
    const thinking = thinkingConfigFor(a.model, a.effort, a.maxTokens);
    const model = a.model.replace(/^models\//, '');
    return {
        url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
        // The key is here and nowhere else: not in the URL, not in the body.
        headers: { 'x-goog-api-key': a.apiKey },
        body: {
            ...(a.system.trim() ? { systemInstruction: { parts: [{ text: a.system }] } } : {}),
            contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
            generationConfig: {
                responseMimeType: 'application/json',
                ...(isRawJsonSchema(a.schema)
                    ? { responseJsonSchema: a.schema.json }
                    : { responseSchema: withoutArrayBounds(a.schema) }),
                maxOutputTokens: a.maxTokens,
                ...(thinking ? { thinkingConfig: thinking } : {}),
            },
        },
    };
}

/** Finish reasons that mean the model declined or was stopped, rather than finished. */
const REFUSAL_FINISH = /SAFETY|RECITATION|PROHIBITED|BLOCKLIST|SPII|LANGUAGE|ESCALATION|PUP_LIMITED/;

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0);

export function parseGeminiResponse(data: any, asked: string): AdapterResult {
    const blockReason: string | undefined =
        typeof data?.promptFeedback?.blockReason === 'string' && data.promptFeedback.blockReason !== 'BLOCK_REASON_UNSPECIFIED'
            ? data.promptFeedback.blockReason
            : undefined;
    const candidate = data?.candidates?.[0];
    const finish: string | undefined = typeof candidate?.finishReason === 'string' ? candidate.finishReason : undefined;
    const parts: unknown[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
    // Thought summaries come back as parts flagged `thought`; they are not the answer.
    const text = parts
        .filter((p): p is { text: string } => !!p && !(p as any).thought && typeof (p as any).text === 'string')
        .map((p) => p.text)
        .join('');

    // A blocked prompt has no candidates at all; a blocked answer has a finishReason and no parts.
    const stopReason: StopReason = blockReason || (finish && REFUSAL_FINISH.test(finish)) ? 'refusal' : finish === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn';
    const detail = blockReason ? `blocked: ${blockReason}` : finish && finish !== 'STOP' ? `finishReason: ${finish}` : undefined;

    const usage = data?.usageMetadata;
    // The model asked for: `modelVersion` can carry a build suffix that no price table has.
    // Thinking is billed as output and counted apart from the candidates.
    const billed: Billed[] = [{ model: asked, in: count(usage?.promptTokenCount), out: count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount) }];
    return { text, usage: totalUsage(billed), billed, model: asked, stopReason, ...(detail ? { detail } : {}) };
}

export const geminiAdapter: Adapter = async (a) => {
    const request = buildGeminiRequest(a);
    const data = await postJson({
        provider: a.provider, model: a.model, key: a.apiKey, signal: a.signal, fetchImpl: a.fetchImpl, ...request,
    });
    return parseGeminiResponse(data, a.model);
};

/**
 * `GET /v1beta/models?pageSize=…` (ai.google.dev, models.list: `pageSize` up to 1000, default 50;
 * `models[].name` is `models/<id>`; `supportedGenerationMethods`). The key is in `x-goog-api-key`,
 * not the `?key=` the reference's own example uses: a URL lands in logs. A key check takes one
 * model, a list the largest page. Only models that can `generateContent` are listed: the rest
 * are embedding, image and speech models that cannot answer in JSON.
 */
function getModels(q: ProviderQuery, pageSize: number): Promise<unknown> {
    const { key, signal } = prepareQuery(q);
    return getJson({
        provider: q.provider, model: '', url: `${GEMINI_BASE_URL}/models?pageSize=${pageSize}`,
        headers: { 'x-goog-api-key': key },
        key, signal, fetchImpl: q.fetchImpl,
    });
}

function generativeModels(body: unknown): string[] {
    const list: any[] = Array.isArray((body as any)?.models) ? (body as any).models : [];
    const ids = list
        .filter((m) => typeof m?.name === 'string' && (!Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent')))
        .map((m) => (m.name as string).replace(/^models\//, ''))
        .filter(Boolean);
    return [...new Set(ids)];
}

export const geminiFamily: FamilyAdapter = {
    generate: geminiAdapter,
    listModels: async (q) => generativeModels(await getModels(q, 1000)),
    checkKey: async (q) => {
        await getModels(q, 1);
        return { ok: true };
    },
};
