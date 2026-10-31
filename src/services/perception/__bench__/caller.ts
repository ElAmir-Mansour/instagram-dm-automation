/**
 * How the benchmark calls a model: straight at the provider with a key it was handed, and through nothing that remembers.
 *
 * The AI providers layer (`aiProviders/generate.ts`) reads the operator's saved key and route from the database and writes an `ai_usage` row for every call. A
 * benchmark that is run by hand against the live Meta API must do neither (it "never writes to any database"), so it calls the layer BELOW that one, `generateJson`
 * (`llm/generate.ts`: a provider, a key and a model in, an answer out, nothing remembered), and prices what the response says it used with the same table the
 * layer uses (`llm/cost.ts`). Two stand-ins are made from it:
 *
 *   makeAiCaller    for `setAiCaller`: what `perceive()` calls when it asks for the purpose `perception_dm`. Only the purposes Meta alone answers, and the sales turn's
 *                   own `dm`, are routed, and all of them to Meta: a call for any other purpose is refused, so nothing unexpected is ever sent anywhere.
 *   makeEvalCaller  for the DM sales evaluation's seam (`EvalCaller`): the sales turn's draft, and the judge.
 *
 * Every call, a failed one that was billed included, is written to a `Ledger`: its case, role, tokens, dollars and time. The report's cost and latency are read from
 * what the responses reported, never estimated. The key is held only to build the `Authorization` header; every error message that can be shown has been scrubbed of it
 * (`AiError`), and `scrubKey` takes it out of anything else that is printed.
 */
import type { AiCaller, AiGenerateArgs, AiGenerateResult } from '../../aiProviders/generate.js';
import { PURPOSE_DEFAULT_EFFORT, PURPOSE_PROVIDER_ALLOWLIST, type AiPurpose } from '../../aiProviders/purposes.js';
import type { EvalCaller, ModelRequest, ModelResponse } from '../../dmSales/__evals__/types.js';
import { billedFromUsage, costOf, DEFAULT_PRICES, totalUsage, type PriceTable } from '../../llm/cost.js';
import { AiError, isAiError, scrub } from '../../llm/errors.js';
import { generateJson, type GenerateJsonResult } from '../../llm/generate.js';
import { minOutputTokens } from '../../llm/limits.js';
import type { ProviderId } from '../../llm/registry.js';
import type { Billed, Effort, FetchLike } from '../../llm/types.js';

// ─── The ledger ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LedgerCall {
    /** The case being run when the call was made: the benchmark runs one at a time. */
    caseId: string | null;
    /** What the call was for: `perception`, `reply`, `judge`, `analysis`. */
    role: string;
    provider: string;
    model: string;
    usd: number;
    /** False: a model with no price, charged at the table's ceiling. */
    priced: boolean;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    ms: number;
    ok: boolean;
}

export interface CaseTotals {
    usd: number;
    tokensIn: number;
    tokensOut: number;
    calls: number;
}

/** Every model call of a run, in order. */
export class Ledger {
    readonly calls: LedgerCall[] = [];
    /** The case in progress. Set by the arm before it starts one and cleared after. */
    current: string | null = null;

    add(call: Omit<LedgerCall, 'caseId'>): void {
        this.calls.push({ caseId: this.current, ...call });
    }

    /** What the case's own calls cost: perception and reply, never the judge's (which is reported apart). */
    totalsFor(caseId: string, roles?: readonly string[]): CaseTotals {
        const mine = this.calls.filter((c) => c.caseId === caseId && c.role !== 'judge' && (!roles || roles.includes(c.role)));
        return {
            usd: round(mine.reduce((n, c) => n + c.usd, 0)),
            tokensIn: mine.reduce((n, c) => n + c.tokensIn + c.cacheRead, 0),
            tokensOut: mine.reduce((n, c) => n + c.tokensOut, 0),
            calls: mine.length,
        };
    }

    /** What the calls of one role cost in all, for whatever is not a case (the memory arm's questions). */
    usdOf(role: string): number {
        return round(this.calls.filter((c) => c.role === role).reduce((n, c) => n + c.usd, 0));
    }

    /** What the judge cost in all. */
    judgeUsd(): number {
        return round(this.calls.filter((c) => c.role === 'judge').reduce((n, c) => n + c.usd, 0));
    }

    unpriced(): number {
        return this.calls.filter((c) => !c.priced).length;
    }
}

const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/** `text` with every key taken out, and nothing else changed: for what is printed, which may be a table. */
export function redactKeys(text: string, ...keys: readonly (string | null | undefined)[]): string {
    let out = String(text);
    for (const key of keys) if (key && key.length >= 8) out = out.split(key).join('[key]');
    return out;
}

/** `text` with the key taken out and the rest cleaned the way an error message is (one line, at most 240 characters): for a short reason that a provider's words may have reached. */
export function scrubKey(text: string, ...keys: readonly (string | null | undefined)[]): string {
    return scrub(redactKeys(text, ...keys));
}

// ─── One call ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Billing {
    billed: Billed[];
    usd: number;
    priced: boolean;
    usage: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
}

/** What a call was billed for, priced from the table: the response's own token counts, never an estimate. */
export function billingOf(result: Pick<GenerateJsonResult, 'billed' | 'usage' | 'model'>, prices: PriceTable): Billing {
    const billed = result.billed?.length ? result.billed : [billedFromUsage(result.model, result.usage)];
    const cost = costOf(billed, prices);
    return { billed: cost.billed, usd: cost.usd, priced: cost.priced, usage: totalUsage(cost.billed) };
}

interface Route {
    provider: ProviderId;
    model: string;
    effort: Effort;
}

interface CallArgs {
    route: Route;
    apiKey: string;
    role: string;
    system: string;
    user: AiGenerateArgs['user'];
    schema: AiGenerateArgs['schema'];
    maxTokens: number;
    timeoutMs: number;
    cacheSystem?: boolean;
    fetchImpl: FetchLike | undefined;
    prices: PriceTable;
    ledger: Ledger;
}

/** One structured call, recorded. A failure that was billed is recorded too, and thrown as it came. */
async function call(a: CallArgs): Promise<{ result: GenerateJsonResult; billing: Billing; ms: number }> {
    // The layer raises a limit that is too small for a model that thinks first; the benchmark asks for what the product asks for.
    const maxTokens = Math.max(a.maxTokens, minOutputTokens(a.route.provider, a.route.model, a.route.effort));
    const started = performance.now();
    try {
        const result = await generateJson({
            provider: a.route.provider, apiKey: a.apiKey, model: a.route.model, system: a.system, user: a.user, schema: a.schema, maxTokens, timeoutMs: a.timeoutMs,
            effort: a.route.effort, ...(a.cacheSystem === true ? { cacheSystem: true } : {}), ...(a.fetchImpl ? { fetchImpl: a.fetchImpl } : {}),
        });
        const ms = performance.now() - started;
        const billing = billingOf(result, a.prices);
        a.ledger.add({
            role: a.role, provider: a.route.provider, model: result.model, usd: billing.usd, priced: billing.priced,
            tokensIn: billing.usage.in, tokensOut: billing.usage.out, cacheRead: billing.usage.cacheRead ?? 0, ms, ok: true,
        });
        return { result, billing, ms };
    } catch (err) {
        const ms = performance.now() - started;
        const billed = isAiError(err) ? (err.billed?.length ? err.billed : err.usage ? [billedFromUsage(err.model, err.usage)] : []) : [];
        const cost = costOf(billed, a.prices);
        const used = totalUsage(cost.billed);
        a.ledger.add({
            role: a.role, provider: a.route.provider, model: a.route.model, usd: cost.usd, priced: cost.priced, tokensIn: used.in, tokensOut: used.out, cacheRead: used.cacheRead ?? 0, ms, ok: false,
        });
        throw err;
    }
}

// ─── The two stand-ins ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface CallerOptions {
    apiKey: string;
    ledger: Ledger;
    fetchImpl?: FetchLike;
    prices?: PriceTable;
}

/** The purposes Meta alone answers, and the sales turn's own: the only ones the benchmark routes, all to Meta. */
const ROUTED: ReadonlySet<AiPurpose> = new Set<AiPurpose>(['dm', ...(Object.keys(PURPOSE_PROVIDER_ALLOWLIST) as AiPurpose[]).filter((p) => PURPOSE_PROVIDER_ALLOWLIST[p]?.every((id) => id === 'meta'))]);

/** What a purpose is called in the ledger. */
const ROLE_OF: Readonly<Partial<Record<AiPurpose, string>>> = { perception_dm: 'perception', dm: 'reply', recall: 'recall', reel_index: 'analysis' };

/**
 * `setAiCaller`'s stand-in. `perceive()` asks it for `perception_dm`: it goes to Meta at the model named here, at the effort the purpose defaults to (`low`), with the limit and
 * the deadline the caller sent. Nothing is looked up and nothing is recorded in a database.
 */
export function makeAiCaller(model: string, o: CallerOptions): AiCaller {
    return async (args: AiGenerateArgs): Promise<AiGenerateResult> => {
        if (!ROUTED.has(args.purpose)) {
            throw new AiError({ kind: 'no_provider', provider: 'meta', model, message: `The benchmark routes no call for the purpose "${String(args.purpose).slice(0, 40)}".`, key: o.apiKey });
        }
        const effort = args.effort ?? PURPOSE_DEFAULT_EFFORT[args.purpose];
        const { result, billing } = await call({
            route: { provider: 'meta', model, effort }, apiKey: o.apiKey, role: ROLE_OF[args.purpose] ?? args.purpose, system: args.system, user: args.user, schema: args.schema,
            maxTokens: args.maxTokens, timeoutMs: args.timeoutMs, ...(args.cacheSystem === true ? { cacheSystem: true } : {}), fetchImpl: o.fetchImpl ?? args.fetchImpl,
            prices: o.prices ?? DEFAULT_PRICES, ledger: o.ledger,
        });
        return {
            ...result, usage: billing.usage, billed: billing.billed, usd: billing.usd, priced: billing.priced, costSource: 'table', effort, route: 'saved',
            usageId: `benchmark-${o.ledger.calls.length}`,
        };
    };
}

export interface EvalCallerOptions extends CallerOptions {
    provider: ProviderId;
    model: string;
    effort: Effort;
    /** `reply` for the sales turn, `judge` for the judge. */
    role: 'reply' | 'judge';
}

/** The DM sales evaluation's seam: a request (the real prompt, the real schema) in, the model's JSON, its usage and its price out. Throws as `generateJson` does. */
export function makeEvalCaller(o: EvalCallerOptions): EvalCaller {
    return async (request: ModelRequest): Promise<ModelResponse> => {
        const { result, billing, ms } = await call({
            route: { provider: o.provider, model: o.model, effort: o.effort }, apiKey: o.apiKey, role: o.role, system: request.system, user: request.user, schema: request.schema,
            maxTokens: request.maxTokens, timeoutMs: request.timeoutMs, cacheSystem: request.cacheSystem, fetchImpl: o.fetchImpl, prices: o.prices ?? DEFAULT_PRICES, ledger: o.ledger,
        });
        return { json: result.json, model: result.model, usage: billing.usage, usd: billing.usd, priced: billing.priced, latencyMs: ms };
    };
}
