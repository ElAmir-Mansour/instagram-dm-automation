/**
 * Gemini's generateContent, asked for JSON.
 *
 * The request mirrors `callGemini` (studio/generate.ts), which has been answering in production:
 * `systemInstruction`, `contents`, and `generationConfig` with `responseMimeType:
 * 'application/json'` plus `responseSchema`. The key travels in `x-goog-api-key`, never the query
 * string, which lands in logs.
 *
 * Checked against ai.google.dev and Google's SDK references on 2026-10-13, with three findings
 * that shape the code:
 *
 *   - `responseJsonSchema` takes plain JSON Schema (unions, `additionalProperties`, nullable type
 *     arrays) where `responseSchema` takes only Gemini's OpenAPI-style subset. So a `GeminiSchema`
 *     goes as `responseSchema`, exactly as `callGemini` sends it, and a `{json}` schema goes as
 *     `responseJsonSchema`. Google now labels `responseSchema` and `responseMimeType` deprecated
 *     in favour of a `responseFormat` block, but they still work and `callGemini` depends on them;
 *     moving both callers together is a change for a day when they stop.
 *   - Gemini 3 takes `thinkingConfig.thinkingLevel`; `thinkingBudget` is accepted there only for
 *     compatibility, and sending both is a 400. Gemini 2.5 takes `thinkingBudget` and rejects a
 *     level. Older models and names this code does not recognise get no `thinkingConfig` at all,
 *     which is always safe: the model thinks as it does by default.
 *   - `maxOutputTokens` includes thinking, and `usageMetadata` counts thinking apart from the
 *     answer (`thoughtsTokenCount`), billed as output, so the two are added.
 */
import { postJson } from './post.js';
import { isRawJsonSchema } from '../schema.js';
import { withoutArrayBounds } from '../../studio/generate.js';
import type { Adapter, AdapterArgs, AdapterResult, Effort, StopReason } from '../types.js';

export const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * Effort as a Gemini 2.5 thinking budget, in tokens. The budget is a target the model aims at and
 * counts against `maxOutputTokens`. Every value is inside the range of all three 2.5 models (Pro
 * 128–32768 and cannot be switched off, Flash 0–24576, Flash-Lite 512–24576).
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: 24576 };

/** Effort as a Gemini 3 level. `minimal` is never sent (3.8 Flash and 3.1 Pro refuse it), nor is anything above `high`. */
export const THINKING_LEVELS: Readonly<Record<Effort, 'low' | 'medium' | 'high'>> = {
    low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high',
};

/** A budget leaves at least half of `maxOutputTokens` for the answer: a call is never retried, and one that thinks itself out of room is wasted. */
const MIN_BUDGET = 512;

/** `thinkingConfig` for this model and effort, or undefined where there is nothing safe to send. */
export function thinkingConfigFor(model: string, effort: Effort, maxTokens: number): Record<string, unknown> | undefined {
    const m = model.toLowerCase().match(/^(?:models\/)?gemini-(\d+)(?:\.(\d+))?/);
    if (!m) return undefined;
    const major = Number(m[1]);
    if (major >= 3) return { thinkingLevel: THINKING_LEVELS[effort] };
    if (major === 2 && m[2] === '5') {
        return { thinkingBudget: Math.max(MIN_BUDGET, Math.min(THINKING_BUDGETS[effort], Math.floor(maxTokens / 2))) };
    }
    return undefined;
}

export function buildGeminiRequest(a: AdapterArgs): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
    const turns = typeof a.user === 'string' ? [{ role: 'user' as const, text: a.user }] : a.user;
    const thinking = thinkingConfigFor(a.model, a.effort, a.maxTokens);
    const model = a.model.replace(/^models\//, '');
    return {
        url: `${(a.baseUrl || GEMINI_BASE_URL).replace(/\/+$/, '')}/models/${encodeURIComponent(model)}:generateContent`,
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
    return {
        text,
        usage: {
            input_tokens: count(usage?.promptTokenCount),
            // Thinking is billed as output and counted apart from the candidates.
            output_tokens: count(usage?.candidatesTokenCount) + count(usage?.thoughtsTokenCount),
        },
        // The model asked for: `modelVersion` can carry a build suffix that no price table has.
        model: asked,
        stopReason,
        ...(detail ? { detail } : {}),
    };
}

export const geminiAdapter: Adapter = async (a) => {
    const request = buildGeminiRequest(a);
    const data = await postJson({
        provider: a.provider, model: a.model, key: a.apiKey, signal: a.signal, fetchImpl: a.fetchImpl, ...request,
    });
    return parseGeminiResponse(data, a.model);
};
