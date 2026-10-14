/**
 * What the harness's tests share: the golden conversations, a case built on the spot, a model's answer with one field changed, and the
 * facts a fixture's prompt is checked against. Imported by tests only, so `npm test` does not run it and nothing in the app reads it.
 */
import { buildSalesPrompt } from '../prompt.js';
import { loadCases } from './cases.js';
import { resolveFixture } from './fixtures.js';
import { STUB_ANSWERS, type StubAnswer } from './stub.js';
import type { EvalCase, EvalTurn, FixtureName, TurnExpectation } from './types.js';

let cached: EvalCase[] | undefined;

/** The fifteen conversations, loaded once and checked against the fixtures' offers, as the real run loads them. */
export function allCases(): EvalCase[] {
    cached ??= loadCases(undefined, (fixture) => new Set(resolveFixture(fixture).ctx.offers.map((o) => o.id)));
    return cached;
}

export function caseById(id: string): EvalCase {
    const found = allCases().find((c) => c.id === id);
    if (!found) throw new Error(`no case ${id}`);
    return found;
}

/** A case made on the spot: messages with what each must satisfy. */
export function adhoc(turns: readonly (string | [string, TurnExpectation])[], over: Partial<EvalCase> = {}): EvalCase {
    const list: EvalTurn[] = turns.map((t) => (typeof t === 'string' ? { user: t, expect: {} } : { user: t[0], expect: t[1] }));
    return { id: '99-adhoc', title: 'ad hoc', fixture: 'owner-ar', writes: 'gulf', turns: list, ...over };
}

/** A good answer to the price question, with fields changed. */
export function answer(over: Partial<StubAnswer> = {}): StubAnswer {
    return { ...STUB_ANSWERS['01-price-gulf']![0]!, ...over };
}

/** The facts a fixture's prompt is checked against: what the guard knows the model was shown. */
export function claimsOf(fixture: FixtureName): ReturnType<typeof buildSalesPrompt>['claims'] {
    const f = resolveFixture(fixture);
    return buildSalesPrompt({ persona: f.persona, knowledge: f.knowledge, ctx: f.ctx, timezone: f.timezone, now: f.now }).claims;
}
