/**
 * The Monteur's three Gemini calls (the pick, the copy, the Analyst) go through here: the Studio's
 * writer chain (`callModel` → `callGemini`, `STUDIO_MODELS` in order, never the DM bot's model),
 * JSON under a `responseSchema`, a capped answer, and a running count of what each call cost.
 *
 * The call is whatever `setModelCaller` last installed, so tests stand in for Gemini the same way
 * the Studio's do.
 */
import { callModel, type GeminiSchema, type ModelTurn } from '../studio/generate.js';

/** What a pass (one call, or a call and its repair) cost. `tokens_out` counts thinking too. */
export interface CallCost {
    model: string | null;
    tokens_in: number;
    tokens_out: number;
    thinking: number;
    calls: number;
}

export const emptyCost = (): CallCost => ({ model: null, tokens_in: 0, tokens_out: 0, thinking: 0, calls: 0 });

/**
 * A cost as log fields. Nested under `usage`, with no "token" in a key: the logger redacts every
 * key containing "token" (src/utils/log.ts), so `tokens_in: 1200` would log as "[redacted]".
 */
export const usageFields = (cost: CallCost): { model: string | null; calls: number; usage: { in: number; out: number; thinking: number } } => ({
    model: cost.model, calls: cost.calls, usage: { in: cost.tokens_in, out: cost.tokens_out, thinking: cost.thinking },
});

/** Below this, a call is not worth starting: it would be cut off before it answered. */
export const MIN_CALL_MS = 15_000;

export class MonteurModelError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MonteurModelError';
    }
}

export interface AskRequest {
    purpose: string;
    system: string;
    turns: ModelTurn[];
    schema: GeminiSchema;
    temperature: number;
    thinkingBudget: number;
    maxOutputTokens: number;
    /** This call's own ceiling; the pass's deadline may cut it shorter. */
    capMs: number;
}

/** One call, timed to fit before `deadline`, with its tokens added to `cost`. */
export async function ask(req: AskRequest, deadline: number, cost: CallCost): Promise<unknown> {
    const left = deadline - Date.now();
    if (left < MIN_CALL_MS) throw new MonteurModelError(`Out of time before the ${req.purpose} call.`);
    const { capMs, ...rest } = req;
    return callModel({
        ...rest,
        timeoutMs: Math.min(capMs, left),
        onUsage: (usage) => {
            cost.model = usage.model;
            cost.tokens_in += usage.tokensIn;
            cost.tokens_out += usage.tokensOut + usage.thinking;
            cost.thinking += usage.thinking;
            cost.calls += 1;
        },
    });
}
