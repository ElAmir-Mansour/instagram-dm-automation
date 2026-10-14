/**
 * The stand-in model for the CI dry run and the harness's own tests: canned answers, no key, no network, no database.
 *
 * `npm test` runs two of the golden conversations through the real prompt, schema, coerce and guard with this in place of a model, so
 * the harness itself is exercised on every push (docs/DM_SALES_PLAN.md §12, E1: "harness dry-run on 2 cases in CI with a stub caller").
 * `scripts/eval-dm-sales.mts --stub` runs the same two by hand. The answers are the ones a good model would give, so a dry run is green;
 * the tests then put a bad answer in their place (an invented price, a link, the wrong action) and see the run go red.
 */
import type { EvalCaller, ModelRequest, ModelResponse } from './types.js';

/** The two cases the dry run covers: one that asks the model about a price, one that must end in a link. */
export const DRY_RUN_CASES: readonly string[] = ['01-price-gulf', '05-link-now-gulf'];

/** A model's answer as the sales schema asks for it, in the schema's own order. */
export interface StubAnswer {
    intent: string;
    stage: string;
    next_action: string;
    offer_id: string;
    handoff_reason: string;
    text: string;
    quick_replies: { title: string; payload: string }[];
}

/** The answers, by case id and then by turn (the first turn is index 0). */
export const STUB_ANSWERS: Readonly<Record<string, readonly StubAnswer[]>> = {
    '01-price-gulf': [{
        intent: 'price', stage: 'recommend', next_action: 'recommend', offer_id: 'main', handoff_reason: 'none',
        text: 'هلا فيك! السعر الحالي يظهر في صفحة العرض ويتغير مع العروض. تبي أرسل لك الرابط؟',
        quick_replies: [],
    }],
    '05-link-now-gulf': [{
        intent: 'ready_to_buy', stage: 'link', next_action: 'send_link', offer_id: 'main', handoff_reason: 'none',
        text: 'تفضل، هذا هو الرابط. أي سؤال أنا موجود.',
        quick_replies: [],
    }],
};

/** What the stub's calls report: nothing was billed, and every call took the same time, so a dry run's report does not change between runs. */
const STUB_USAGE = { in: 4200, out: 90 } as const;
const STUB_LATENCY_MS = 800;

const respond = (json: unknown, model: string): ModelResponse => ({ json, model, usage: { ...STUB_USAGE }, usd: 0, priced: true, latencyMs: STUB_LATENCY_MS });

/**
 * A caller that answers each sales turn from `answers` (by `meta.case` and `meta.turn`, which counts from 1) and fails for a case it has
 * no answer for, which is what a harness bug looks like and must not be a pass. `onCall` sees every request: tests read what the
 * runner sent.
 */
export function stubSalesCaller(answers: Readonly<Record<string, readonly unknown[]>> = STUB_ANSWERS, onCall?: (request: ModelRequest) => void): EvalCaller {
    return async (request) => {
        onCall?.(request);
        if (request.meta.role !== 'sales') throw new Error('the stub sales caller was asked to judge');
        const answer = answers[request.meta.case]?.[request.meta.turn - 1];
        if (answer === undefined) throw new Error(`the stub has no answer for ${request.meta.case} turn ${request.meta.turn}`);
        return respond(answer, 'stub-model');
    };
}

/** A judge that scores every criterion 5. */
export function stubJudgeCaller(onCall?: (request: ModelRequest) => void): EvalCaller {
    return async (request) => {
        onCall?.(request);
        if (request.meta.role !== 'judge') throw new Error('the stub judge was asked to answer a customer');
        return respond({ notes: 'none (stub judge)', tone: 5, helpfulness: 5, no_pressure: 5, right_recommendation: 5 }, 'stub-judge');
    };
}
