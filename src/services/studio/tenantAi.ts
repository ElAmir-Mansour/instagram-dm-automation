/**
 * A tenant's Studio work on the AI providers layer (P32, docs/onboarding/06 and TENANT_ONBOARDING_PLAN.md D13).
 *
 * Three purposes exist for it, all on the operator's keys and all recorded per tenant in `ai_usage` (`aiProviders/generate.ts`):
 *
 *   `tenant_monteur_think`   the Monteur's pick, copy, Editor and Analyst: the `monteur.brain: 'api'` branch of `ask()` (monteur/model.ts)
 *   `tenant_infographic`     an infographic's page and caption, written on the server (studio/infographicWriter.ts), then a render-only job
 *   `tenant_studio`          the Studio's carousel writer, per call through `GenOptions.callModel` (this file, D13)
 *
 * **The owner's work does not move.** His Monteur and infographics think on his Mac, on his own plan, and his Studio writes with Gemini
 * (`callGemini`, the chain in `STUDIO_MODELS`). The layer refuses the Mac's two purposes for him (`MacBrainTenantRefused`), and this file
 * hands the Studio's `callModel` to nobody but a tenant who is not the owner: for the platform owner `writerOptionsFor` is `{}`, which is
 * `generateDraft(input, sources, ctx, {})`, the call as it was made before the layer existed.
 *
 * **Nothing falls back.** A tenant on the layer with no provider ready, or with a spent budget, gets a clear error that says so (409
 * `NEEDS_AI_PROVIDER`, 429 `AI_BUDGET_SPENT`, 503 `AI_UNAVAILABLE`...). It never gets the owner's Mac, and the Studio never quietly
 * returns to Gemini because the operator forgot a key.
 */
import { log } from '../../utils/log.js';
import { generate } from '../aiProviders/generate.js';
import { MacBrainTenantRefused } from '../aiProviders/route.js';
import { isAiError } from '../llm/errors.js';
import { MAC_BRAIN_TENANT } from '../macBrain.js';
import { getPlatformOwnerId } from '../tenant.js';
import { StudioError } from './common.js';
import type { CallModel, GenOptions } from './generate.js';

export const NEEDS_AI_PROVIDER = 'NEEDS_AI_PROVIDER';
export const AI_BUDGET_SPENT = 'AI_BUDGET_SPENT';
export const AI_PROVIDER_REJECTED = 'AI_PROVIDER_REJECTED';
export const AI_UNAVAILABLE = 'AI_UNAVAILABLE';
export const AI_ANSWER_UNUSABLE = 'AI_ANSWER_UNUSABLE';

/** What a tenant reads when the operator has no provider ready. Says where the fix is, and that the Mac was not tried. */
export const NEEDS_AI_PROVIDER_MESSAGE =
    'No AI provider is ready for this: the operator needs to save an API key in Operations → AI providers. Nothing was sent to the Mac.';

/**
 * What a route says about a failed layer call: the refusal as a `StudioError` (status, message, `code`) so the Studio routes answer it as
 * they answer every other one. `what` finishes the sentence "…could not write …". Anything that is not the layer's own error comes back
 * as it was (a database failure is the route's 500, not an AI problem).
 *
 *   no_provider        409  `NEEDS_AI_PROVIDER`    nobody can answer: a key to save
 *   budget             429  `AI_BUDGET_SPENT`      a limit is spent; the message says which, and when it resets
 *   auth, quota        503  `AI_PROVIDER_REJECTED` the operator's key or plan, not the tenant's: nothing the tenant can fix
 *   rate, server, timeout  503  `AI_UNAVAILABLE`   may pass: try again
 *   anything else      502  `AI_ANSWER_UNUSABLE`   the model answered something that cannot be used
 *   a Mac tenant       409  `MAC_BRAIN_TENANT`     the caller routed the owner onto the layer
 */
export function studioErrorFromAi(err: unknown, what: string): unknown {
    if (err instanceof StudioError) return err;
    if (err instanceof MacBrainTenantRefused) return new StudioError(409, err.message, undefined, MAC_BRAIN_TENANT);
    if (!isAiError(err)) return err;
    switch (err.kind) {
        case 'no_provider':
            return new StudioError(409, NEEDS_AI_PROVIDER_MESSAGE, undefined, NEEDS_AI_PROVIDER);
        case 'budget':
            return new StudioError(429, err.message, undefined, AI_BUDGET_SPENT);
        case 'auth':
        case 'quota':
            return new StudioError(503, `The AI provider refused the operator's key or plan, so nothing was written: the operator needs to check it in Operations → AI providers. (${err.message})`, undefined, AI_PROVIDER_REJECTED);
        case 'rate':
        case 'server':
        case 'timeout':
            return new StudioError(503, `The AI provider is busy or not answering, so ${what} was not written. Try again in a moment. (${err.message})`, undefined, AI_UNAVAILABLE);
        default:
            return new StudioError(502, `The AI could not write ${what}. Try again. (${err.message})`, undefined, AI_ANSWER_UNUSABLE);
    }
}

/** What `callGemini` allows an answer when the request does not say (generate.ts `MAX_OUTPUT_TOKENS`, sized for a whole carousel). */
const STUDIO_MAX_OUTPUT_TOKENS = 24_576;

/**
 * The Studio's `CallModel` through the layer, for one tenant: purpose `tenant_studio`, the route the operator saved for it (or the first
 * provider with a key, at `medium` effort). The system prompt, turns and schema are the ones the writer built, and its answer is the
 * parsed JSON, as `callGemini`'s is. The writer's own temperature and thinking budget are Gemini's dials and are not sent: the route's
 * effort is the dial here. The caller's `deadline` and `timeoutMs` bound the call, and the cost is reported through `onUsage` as Gemini's is.
 *
 * An `AiError` goes up as it is: it carries `retryable`, which the writer's retry reads (`callWithin`), and a message that says what
 * happened, which becomes the draft's `error`.
 */
export function layerCallModel(creatorId: string): CallModel {
    return async (req) => {
        const left = req.deadline === undefined ? req.timeoutMs : Math.min(req.timeoutMs, req.deadline - Date.now());
        const result = await generate({
            purpose: 'tenant_studio', creatorId,
            system: req.system, user: req.turns, schema: req.schema,
            maxTokens: req.maxOutputTokens ?? STUDIO_MAX_OUTPUT_TOKENS, timeoutMs: Math.max(1, Math.floor(left)),
        });
        req.onUsage?.({
            model: result.model,
            tokensIn: result.usage.in + (result.usage.cacheRead ?? 0) + (result.usage.cacheWrite ?? 0),
            tokensOut: result.usage.out,
            thinking: 0,
        });
        return result.json;
    };
}

/**
 * The options a Studio writer call is made with, for this tenant: none for the owner (his writer is Gemini, unchanged), the layer's
 * `callModel` for everyone else (D13).
 *
 * Who is the owner is a read that can fail. When it does the answer is "the call as it was", Gemini: the one thing a failed read must
 * never do is move the owner's Studio, and a tenant who is carried on Gemini for one call is what every tenant had before the layer.
 */
export async function writerOptionsFor(creatorId: string): Promise<GenOptions> {
    let owner: string | null;
    try {
        owner = await getPlatformOwnerId();
    } catch (err) {
        log('warn', 'studio.writer_owner_unreadable', { creator_id: creatorId, message: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
        return {};
    }
    if (owner === null || owner.toLowerCase() === creatorId.toLowerCase()) return {};
    return { callModel: layerCallModel(creatorId) };
}
