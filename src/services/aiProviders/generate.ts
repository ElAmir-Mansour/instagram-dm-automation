/**
 * `generate`: one structured answer for a purpose, on whichever provider the operator routed it to, recorded and under budget
 * (docs/onboarding/06 §2). This is what the onboarding draft, the proof samples and, later, a tenant's Studio, Monteur and infographic
 * writers call. `generateJson` (generate.ts) is the layer below: a provider, a key and a model in, an answer out, nothing remembered.
 *
 * What `generate` adds, in order:
 *
 *   1. **Route.** The Mac guard, then `pickRoute`: the saved route for the purpose, else the first provider that has a key. No provider
 *      is `no_provider` (recorded as a refusal), and final.
 *   2. **Budget.** The call's worst-case cost is reserved in `ai_usage` under a lock, or the call is refused with `budget` (usage.ts).
 *      The provider is not asked. A reservation that cannot be made fails the call too.
 *   3. **Call.** `generateJson`, with the route's provider, the key and the route's effort. No retry and no second provider: the
 *      caller's state machine decides whether to try again (`AiError.retryable`).
 *   4. **Settle.** The reservation becomes the real row: tokens, dollars (the provider's own figure if it gave one, else the price
 *      table's), outcome, latency. A call that failed after being billed (refused, cut off, malformed) is charged what it used.
 *
 * It never logs a key, a prompt or an answer: a log line carries the purpose, provider, model, outcome, tokens, dollars and latency.
 *
 * `setAiCaller` swaps this whole function for a test of a caller (the draft state machine, the proof) that wants neither settings nor a
 * database; `setLlmCaller` swaps only the provider call underneath, for a test of this layer. `setProviderFetch` swaps the `fetch` every
 * provider request made through this layer uses: key checks, model lists and calls.
 */
import { log } from '../../utils/log.js';
import { UUID_PATTERN } from '../studio/common.js';
import { loadAiSettings } from './settings.js';
import { costOf, totalUsage, usdFor, type PriceTable } from '../llm/cost.js';
import { AiError, isAiError } from '../llm/errors.js';
import { generateJson, type GenerateJsonResult } from '../llm/generate.js';
import { minOutputTokens } from '../llm/limits.js';
import { isAiPurpose, type AiPurpose, type UsagePurpose } from './purposes.js';
import { assertNotMacBrainWork, pickRoute } from './route.js';
import type { LlmSchema } from '../llm/schema.js';
import type { Billed, Effort, FetchLike, LlmTurn } from '../llm/types.js';
import { billedOfError, recordCall, reserveCall, settleCall } from './usage.js';

export interface AiGenerateArgs {
    purpose: AiPurpose;
    /** The tenant the call is for and is charged to. Null: it belongs to no tenant (the operator's "Test" on a route). */
    creatorId: string | null;
    /** What `ai_usage.purpose` says when it is not `purpose`: `key_test` for the Test button, which routes like a purpose and is not one. */
    usageAs?: UsagePurpose;
    system: string;
    user: string | LlmTurn[];
    schema: LlmSchema;
    /** Caps the whole answer, thinking included. Raised to what the route's model needs to think and answer (`limits.ts`), never lowered. */
    maxTokens: number;
    /** One deadline for the call, in milliseconds (at most 150 000). */
    timeoutMs: number;
    /** Overrides the route's effort for this call. */
    effort?: Effort;
    /** For tests. Defaults to `setProviderFetch`'s, then the global `fetch`. */
    fetchImpl?: FetchLike;
}

export interface AiGenerateResult extends GenerateJsonResult {
    /** What the call cost, in US dollars. */
    usd: number;
    /** False: a model with no price, charged at the table's ceiling. */
    priced: boolean;
    /** Where `usd` came from: the provider's own figure, the price table, or each for a different model of one call. */
    costSource: 'provider' | 'table' | 'mixed';
    effort: Effort;
    /** Whether the provider was the saved route's or the first one with a key. */
    route: 'saved' | 'default';
    /** The `ai_usage` row, so a caller can keep it with what it made. */
    usageId: string;
}

let providerFetch: FetchLike | undefined;

/** Tests only: the `fetch` for every provider request made through this layer. Returns the previous one. */
export function setProviderFetch(next: FetchLike | undefined): FetchLike | undefined {
    const previous = providerFetch;
    providerFetch = next;
    return previous;
}

/** What the routes use for key checks and model lists, which are not `generate` calls. */
export const providerFetchImpl = (): FetchLike | undefined => providerFetch;

const isPositiveInteger = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

const badRequest = (message: string): AiError => new AiError({ kind: 'bad_request', provider: '', model: '', message });

/**
 * The most a call can cost: its whole `maxTokens` at the output price, on an input estimate. A character is at most half a token
 * (Arabic and code run about 2 to 3 characters a token, English 4), so the estimate is high on purpose. An unpriced model is estimated
 * at the table's ceiling, the same figure it will be charged.
 */
export function estimateUsd(args: Pick<AiGenerateArgs, 'system' | 'user' | 'schema'>, maxTokens: number, model: string, prices: PriceTable): { usd: number; priced: boolean } {
    const user = typeof args.user === 'string' ? args.user.length : args.user.reduce((n, turn) => n + turn.text.length, 0);
    const chars = args.system.length + user + JSON.stringify(args.schema).length;
    return usdFor({ in: Math.ceil(chars / 2), out: maxTokens }, model, prices);
}

function costSourceOf(billed: readonly Billed[]): AiGenerateResult['costSource'] {
    const sources = new Set(billed.map((b) => b.source));
    return sources.size === 1 && sources.has('provider') ? 'provider' : sources.has('provider') ? 'mixed' : 'table';
}

async function runGenerate(args: AiGenerateArgs): Promise<AiGenerateResult> {
    // What is wrong with the call itself, before a settings read or a row: nothing about it will be different next time.
    if (!isAiPurpose(args.purpose)) throw badRequest(`Unknown AI purpose "${String(args.purpose).slice(0, 40)}".`);
    if (args.creatorId !== null && !(typeof args.creatorId === 'string' && UUID_PATTERN.test(args.creatorId))) throw badRequest('creatorId must be a tenant id, or null.');
    if (!isPositiveInteger(args.maxTokens)) throw badRequest(`maxTokens must be a positive whole number, not ${String(args.maxTokens).slice(0, 20)}.`);
    if (!isPositiveInteger(args.timeoutMs)) throw badRequest(`timeoutMs must be a positive whole number of milliseconds, not ${String(args.timeoutMs).slice(0, 20)}.`);

    const label: UsagePurpose = args.usageAs ?? args.purpose;
    // The Mac guard first: a call that will not be made has no business loading a key.
    await assertNotMacBrainWork(args.purpose, args.creatorId);
    const { config, keys } = await loadAiSettings();

    let route;
    try {
        route = pickRoute(args.purpose, config, keys);
    } catch (err) {
        if (isAiError(err)) {
            await recordCall({ creatorId: args.creatorId, purpose: label, provider: 'none', model: '', outcome: err.kind, tokensIn: 0, tokensOut: 0, usd: 0, priced: true, elapsedMs: 0 });
            log('warn', 'ai.call_refused', { purpose: label, creator_id: args.creatorId, outcome: err.kind });
        }
        throw err;
    }

    const effort = args.effort ?? route.effort;
    // The caller sized `maxTokens` for the JSON it wants; the route's model may spend most of it thinking first.
    const maxTokens = Math.max(args.maxTokens, minOutputTokens(route.provider, route.model, effort));
    const estimate = estimateUsd(args, maxTokens, route.model, config.prices);

    let reservation;
    try {
        reservation = await reserveCall({
            creatorId: args.creatorId, purpose: label, provider: route.provider, model: route.model,
            estimateUsd: estimate.usd, priced: estimate.priced, budgets: config.budgets,
        });
    } catch (err) {
        if (isAiError(err)) log('warn', 'ai.call_refused', { purpose: label, creator_id: args.creatorId, provider: route.provider, model: route.model, outcome: err.kind });
        throw err;
    }

    const started = Date.now();
    let result: GenerateJsonResult;
    try {
        result = await generateJson({
            provider: route.provider, apiKey: keys.get(route.provider) ?? '', model: route.model,
            baseUrl: route.baseUrl, jsonMode: route.jsonMode,
            system: args.system, user: args.user, schema: args.schema, maxTokens, timeoutMs: args.timeoutMs, effort,
            fetchImpl: args.fetchImpl ?? providerFetch,
        });
    } catch (err) {
        const billed = isAiError(err) ? billedOfError(err) : [];
        const cost = costOf(billed, config.prices);
        const used = totalUsage(cost.billed);
        const outcome = isAiError(err) ? err.kind : 'bad_request';
        const elapsedMs = Date.now() - started;
        await settleCall(reservation, {
            outcome, provider: route.provider, model: (isAiError(err) && err.model) || route.model,
            tokensIn: used.in, tokensOut: used.out, usd: cost.usd, priced: cost.priced, elapsedMs,
        });
        log('warn', 'ai.call_failed', {
            purpose: label, creator_id: args.creatorId, provider: route.provider, model: route.model, effort, outcome,
            elapsed_ms: elapsedMs, usage_in: used.in, usage_out: used.out, usd: cost.usd,
        });
        throw err;
    }

    const billed: Billed[] = result.billed?.length ? result.billed : [{ model: result.model, in: result.usage.in, out: result.usage.out }];
    const cost = costOf(billed, config.prices);
    const used = totalUsage(cost.billed);
    const elapsedMs = Date.now() - started;
    await settleCall(reservation, {
        outcome: 'ok', provider: route.provider, model: result.model || route.model,
        tokensIn: used.in, tokensOut: used.out, usd: cost.usd, priced: cost.priced, elapsedMs,
    });
    log('info', 'ai.call', {
        purpose: label, creator_id: args.creatorId, provider: route.provider, model: result.model, effort, outcome: 'ok',
        elapsed_ms: elapsedMs, usage_in: used.in, usage_out: used.out, usd: cost.usd, priced: cost.priced,
    });
    return {
        ...result,
        usage: used,
        billed: cost.billed,
        usd: cost.usd,
        priced: cost.priced,
        costSource: costSourceOf(cost.billed),
        effort,
        route: route.source,
        usageId: reservation.id,
    };
}

export type AiCaller = (args: AiGenerateArgs) => Promise<AiGenerateResult>;

let aiCaller: AiCaller = runGenerate;

/**
 * Swaps `generate` itself (tests of whatever calls it). Returns the previous one, like `setLlmCaller`, so a test can put it back.
 * A stand-in sees the call as the caller made it: no route, no budget, no row.
 */
export function setAiCaller(next: AiCaller): AiCaller {
    const previous = aiCaller;
    aiCaller = next;
    return previous;
}

/** One structured answer for a purpose, from `runGenerate` or whatever `setAiCaller` put in its place. */
export function generate(args: AiGenerateArgs): Promise<AiGenerateResult> {
    return aiCaller(args);
}
