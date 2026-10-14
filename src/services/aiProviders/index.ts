/**
 * The AI providers layer: what the onboarding draft, the proof samples and, later, a tenant's Studio, Monteur and infographic writers call
 * (docs/onboarding/06-ai-providers.md; P20c).
 *
 *   `src/services/llm/`            the library: provider adapters, wire formats, errors, schemas, prices. No state, no database.
 *   `src/services/aiProviders/`    this layer, built on it: the operator's settings (keys, routes, prices, budgets), `resolveRoute`,
 *                                  `ai_usage` and the budget that reads it, and `generate`, which does all of that around one call.
 *   `src/routes/adminAi.ts`        `/api/admin/ai/*`, the Operations card's API.
 *
 * It lives beside `llm/` and not in it because `llm/` is held clear of the database by a test (llm/schema.test.ts), so that loading a
 * schema or an adapter never loads the pool.
 *
 * Who calls it: the onboarding draft and proof (`onboarding_*`), the DM engine (`dm`), and, for a tenant who is not the owner, the Monteur
 * (`tenant_monteur_think`, the `monteur.brain: 'api'` branch of `ask()`, monteur/model.ts), infographics written on the server
 * (`tenant_infographic`, studio/infographicWriter.ts) and the Studio's carousel writer (`tenant_studio`, `GenOptions.callModel`,
 * studio/tenantAi.ts; plan D13). The owner's DM bot (`ai.ts`, Gemini), his Monteur and infographics (Claude Code on his Mac, on his own
 * plan) and his Studio (Gemini) keep the paths they have: the router refuses the Mac's two purposes for him, and nothing hands him the
 * Studio's `callModel`.
 */
export { generate, setAiCaller, setProviderFetch, estimateUsd, type AiCaller, type AiGenerateArgs, type AiGenerateResult } from './generate.js';
export { resolveRoute, pickRoute, assertNotMacBrainWork, MacBrainTenantRefused, type ResolvedRoute } from './route.js';
export { AI_PURPOSES, EVAL, isAiPurpose, KEY_TEST, MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type AiPurpose, type UsagePurpose } from './purposes.js';
export { BudgetRefused, getUsageSummary, type BudgetScope, type UsageSummary } from './usage.js';
export { loadAiSettings, type AiConfig, type Budgets, type KeyStatus } from './settings.js';
