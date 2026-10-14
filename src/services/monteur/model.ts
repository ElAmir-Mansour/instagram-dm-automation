/**
 * The Monteur's model calls (the pick, the copy, the Editor, the Analyst) go through here: the
 * Studio's writer chain (`callModel` → `callGemini`, `STUDIO_MODELS` in order, never the DM bot's
 * model), JSON under a `responseSchema`, a capped answer, and a running count of what each call cost.
 *
 * A call with a `think` route goes to Claude on the Mac instead (think.ts, MONTEUR.md §6.3), and
 * never to Gemini: the tenant's `monteur.brain` is `claude_mac`. A call with an `api` route goes through the
 * AI providers layer (`tenant_monteur_think`, P32): the tenant's `monteur.brain` is `api`, which is for the
 * tenants the Mac is not for. Never to Gemini, and never to the Mac: no route falls back to another.
 *
 * The call is whatever `setModelCaller` last installed, so tests stand in for Gemini the same way
 * the Studio's do.
 */
import { log } from '../../utils/log.js';
import { generate } from '../aiProviders/generate.js';
import { callModel, type GeminiSchema, type ModelTurn } from '../studio/generate.js';
import { think, type ThinkRoute } from './think.js';

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

/**
 * Where a step's calls go when the brain is the AI providers layer: the tenant they are for, and charged to (`ai_usage`). Unlike a
 * `ThinkOn` it has no key: an API call is answered while the drain waits, so nothing has to be found again by a later one.
 */
export interface ApiOn {
    creatorId: string;
}

/** `{ api }` for a step that has one, and nothing otherwise, so a request that is not for the layer is the object it always was. */
export const viaApi = (api: ApiOn | undefined): { api?: ApiOn } => (api ? { api } : {});

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
    /** Set when the brain is Claude on the Mac: the call is a `monteur_think` job, and Gemini is never asked. */
    think?: ThinkRoute;
    /** Set when the brain is the AI providers layer: the call is `tenant_monteur_think`, and neither Gemini nor the Mac is asked. */
    api?: ApiOn;
}

/** One call, timed to fit before `deadline`, with its tokens added to `cost`. */
export async function ask(req: AskRequest, deadline: number, cost: CallCost): Promise<unknown> {
    // Two routes at once would be a step that does not know which brain it is on: neither is asked, and the Mac least of all.
    if (req.think && req.api) throw new MonteurModelError(`The ${req.purpose} call names both the Mac and the AI providers layer.`);
    // No deadline to fit: a think only reads and writes the queue, and the Mac answers in its own time.
    // `think` refuses a tenant that is not on `studio.mac_brain_tenants` (macBrain.ts) before it queues.
    if (req.think) return think(req.think, req, cost);
    if (req.api) return askApi(req, req.api, deadline, cost);
    const left = deadline - Date.now();
    if (left < MIN_CALL_MS) throw new MonteurModelError(`Out of time before the ${req.purpose} call.`);
    const { capMs, think: _think, api: _api, ...rest } = req;
    return callModel({
        ...rest,
        timeoutMs: Math.min(capMs, left),
        // The chain falls back through several models; the deadline bounds all of them together.
        deadline: Math.min(deadline, Date.now() + capMs),
        onUsage: (usage) => {
            cost.model = usage.model;
            cost.tokens_in += usage.tokensIn;
            cost.tokens_out += usage.tokensOut + usage.thinking;
            cost.thinking += usage.thinking;
            cost.calls += 1;
        },
    });
}

/**
 * One call through the AI providers layer, for the tenant: the same system prompt, turns and schema the step built (the Mac gets them
 * flattened into one prompt and as JSON Schema, which the layer does for a provider that needs it), answered in the call's own time
 * within the pass's deadline. The route, the budget and the `ai_usage` row are the layer's (`generate`): purpose
 * `tenant_monteur_think`, this tenant. An `AiError` goes up as it is: `no_provider` and `budget` say what to do, and `rate`, `server` and
 * `timeout` say they may pass (`retryable`), which the Editor's retry reads. There is no second provider, and no Mac.
 */
async function askApi(req: AskRequest, on: ApiOn, deadline: number, cost: CallCost): Promise<unknown> {
    const left = deadline - Date.now();
    if (left < MIN_CALL_MS) throw new MonteurModelError(`Out of time before the ${req.purpose} call.`);
    const result = await generate({
        purpose: 'tenant_monteur_think', creatorId: on.creatorId,
        system: req.system, user: req.turns, schema: req.schema,
        maxTokens: req.maxOutputTokens, timeoutMs: Math.min(req.capMs, left),
    });
    // The whole prompt, cached or not, as the Mac's answer is counted (think.ts `readThinkAnswer`).
    const tokensIn = result.usage.in + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0);
    cost.model = result.model;
    cost.tokens_in += tokensIn;
    cost.tokens_out += result.usage.out;
    cost.calls += 1;
    log('info', 'monteur.api_answered', {
        request: req.purpose, creator_id: on.creatorId, provider: result.provider, model: result.model, usage: { in: tokensIn, out: result.usage.out }, usd: result.usd,
    });
    return result.json;
}
