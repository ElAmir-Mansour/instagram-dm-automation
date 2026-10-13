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
 * Nothing existing calls it yet. The owner's DM bot (`ai.ts`, Gemini), his Monteur, his infographics and his Studio keep the paths they have.
 */
export { generate, setAiCaller, setProviderFetch, estimateUsd, type AiCaller, type AiGenerateArgs, type AiGenerateResult } from './generate.js';
export { resolveRoute, pickRoute, assertNotMacBrainWork, MacBrainTenantRefused, type ResolvedRoute } from './route.js';
export { AI_PURPOSES, isAiPurpose, KEY_TEST, MAC_BRAIN_PURPOSES, PURPOSE_DEFAULT_EFFORT, type AiPurpose, type UsagePurpose } from './purposes.js';
export { BudgetRefused, getUsageSummary, type BudgetScope, type UsageSummary } from './usage.js';
export { loadAiSettings, type AiConfig, type Budgets, type KeyStatus } from './settings.js';
