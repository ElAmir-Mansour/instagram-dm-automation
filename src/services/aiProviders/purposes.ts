/**
 * What AI work is for: the closed list of purposes a route can be saved for (docs/onboarding/06 §2, "Routing by purpose").
 *
 * A purpose names the job, not the model. The operator decides which provider and model answers each one (`ai.routing`); with
 * nothing saved the first provider that has a key does, at the effort below. Nothing here reads settings or the database.
 */
import type { Effort } from '../llm/types.js';

export const AI_PURPOSES = ['onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm'] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export const isAiPurpose = (value: unknown): value is AiPurpose => typeof value === 'string' && (AI_PURPOSES as readonly string[]).includes(value);

/**
 * What `ai_usage.purpose` can say: a purpose, or one of two labels that route like a purpose and are not one (spend that belongs to no tenant):
 * `key_test`, the operator checking a key or pressing "Test" on a route, and `eval`, a run of the DM evaluation harness (docs/DM_SALES_PLAN.md
 * §11), which asks for the `dm` route with `usageAs: EVAL` so its spend is read apart from real conversations.
 */
export const KEY_TEST = 'key_test';
export const EVAL = 'eval';
export type UsagePurpose = AiPurpose | typeof KEY_TEST | typeof EVAL;

/**
 * How hard each purpose thinks when its route does not say (06's table). Always sent explicitly: Opus 5.5's own default is medium,
 * so "left unset" would be a decision nobody made.
 */
export const PURPOSE_DEFAULT_EFFORT: Readonly<Record<AiPurpose, Effort>> = {
    onboarding_draft: 'high',
    onboarding_proof: 'medium',
    tenant_studio: 'medium',
    tenant_monteur_think: 'high',
    tenant_infographic: 'high',
    // A DM is answered while the person waits (target p50 under 10 s), so it thinks as little as the route lets it. Nothing calls it yet.
    dm: 'low',
};

/** The effort of a `key_test` call: it asks for one word of JSON, so it asks for no thinking. */
export const KEY_TEST_EFFORT: Effort = 'low';

/**
 * The purposes that are Claude work the owner's Mac already does (`macBrain.ts`): the Monteur's thinking and the infographic writer.
 * The router refuses them for a tenant the Mac works for, so that his videos stay on the Mac and nothing of his is routed through the
 * operator's API key and billed (06 §2, "The owner's rules, enforced in code").
 */
export const MAC_BRAIN_PURPOSES: ReadonlySet<AiPurpose> = new Set<AiPurpose>(['tenant_monteur_think', 'tenant_infographic']);
