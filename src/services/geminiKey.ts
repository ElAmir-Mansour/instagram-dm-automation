/**
 * Checking a Gemini API key with Google before it replaces the one the platform runs on.
 *
 * Saving a key on the Operations screen swaps it in for every tenant's DM replies and for the
 * Studio at the same moment. A bad one would silence every bot mid-conversation, and the only
 * trace would be `ai.request_failed` lines in the logs. So nothing is saved until Google has
 * answered two questions:
 *
 *   1. Is this a key at all? `models.list` answers that for free: 400 for something that is not
 *      a key, 403 for a key whose project has the Generative Language API switched off.
 *   2. Can it run the models the DM bot actually uses? One tiny `generateContent` per model.
 *      This is the check that matters. Google now serves the 2.5 models only to users who have
 *      used them before, so a key from a new project can pass the first check and still be
 *      refused `gemini-2.5-flash` on every DM. It costs one request of that model's allowance
 *      per save, and saves are rare.
 *
 * A 429 on the second check means the key works and today's quota is spent. That key is
 * saved, with a warning: the quota comes back at midnight Pacific, and refusing would stop an
 * admin replacing a key that is broken in some other way.
 *
 * The key only ever travels in a header, and nothing here logs an error object: an axios error
 * carries its request config, which holds the key.
 */
import axios from 'axios';

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta';
const CHECK_TIMEOUT_MS = 20_000;

export type GeminiKeyCheck =
    /** Every model answered, or answered 429 (named in `quotaSpent`). */
    | { ok: true; quotaSpent: string[] }
    /** `status` is what the API should answer: 400 for a key Google refused, 502 if Google could not be asked. */
    | { ok: false; status: 400 | 502; error: string };

/** Google's own explanation, which is the useful part — "API key not valid", "not found for API version". */
function googleAnswer(err: unknown): { status: number | undefined; message: string } {
    const e = err as { response?: { status?: number; data?: { error?: { message?: string } } }; message?: string };
    return {
        status: e?.response?.status,
        message: e?.response?.data?.error?.message ?? e?.message ?? 'no answer',
    };
}

/** A 4xx other than 429 is Google saying no; anything else (429 on the free list call, 5xx, a timeout) is a retry. */
const isRefusal = (status: number | undefined): boolean =>
    status !== undefined && status >= 400 && status < 500 && status !== 429;

export async function checkGeminiKey(key: string, models: readonly string[]): Promise<GeminiKeyCheck> {
    const headers = { 'x-goog-api-key': key };

    try {
        await axios.get(`${GEMINI_API}/models?pageSize=1`, { headers, timeout: CHECK_TIMEOUT_MS });
    } catch (err) {
        const { status, message } = googleAnswer(err);
        if (isRefusal(status)) return { ok: false, status: 400, error: `Google refused this key: ${message}` };
        return {
            ok: false, status: 502,
            error: `Could not reach Google to check the key (${status ? `HTTP ${status}` : message}). Nothing was saved; try again.`,
        };
    }

    const quotaSpent: string[] = [];
    for (const model of models) {
        try {
            await axios.post(
                `${GEMINI_API}/models/${model}:generateContent`,
                { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] },
                { headers, timeout: CHECK_TIMEOUT_MS }
            );
        } catch (err) {
            const { status, message } = googleAnswer(err);
            if (status === 429) {
                quotaSpent.push(model);
                continue;
            }
            if (isRefusal(status)) {
                return { ok: false, status: 400, error: `This key cannot run ${model}, which the DM bot uses: ${message}` };
            }
            return {
                ok: false, status: 502,
                error: `Could not check ${model} with Google (${status ? `HTTP ${status}` : message}). Nothing was saved; try again.`,
            };
        }
    }
    return { ok: true, quotaSpent };
}
