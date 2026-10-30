/**
 * What AI work is for: the closed list of purposes a route can be saved for (docs/onboarding/06 §2, "Routing by purpose").
 *
 * A purpose names the job, not the model. The operator decides which provider and model answers each one (`ai.routing`); with
 * nothing saved the first provider that has a key does, at the effort below. Nothing here reads settings or the database.
 */
import type { ProviderId } from '../llm/registry.js';
import type { Effort } from '../llm/types.js';

export const AI_PURPOSES = [
    'onboarding_draft', 'onboarding_proof', 'tenant_studio', 'tenant_monteur_think', 'tenant_infographic', 'dm', 'dm_whatsapp', 'ads_draft', 'ads_review',
    // The four that only Meta's Muse models answer (docs/specs/005-muse-sees): what a word-less DM shows, which of the owner's reels a question is about,
    // what each reel says and shows, and what an unmatched comment wants. Nothing calls them until the perception PRs; a route for each is the operator's.
    'perception_dm', 'recall', 'reel_index', 'comment_intent',
] as const;
export type AiPurpose = (typeof AI_PURPOSES)[number];

export const isAiPurpose = (value: unknown): value is AiPurpose => typeof value === 'string' && (AI_PURPOSES as readonly string[]).includes(value);

/**
 * What `ai_usage.purpose` can say: a purpose, or one of two labels that route like a purpose and are not one (spend that belongs to no tenant):
 * `key_test`, the operator checking a key or pressing "Test" on a route, and `eval`, a run of the DM evaluation harness (docs/DM_SALES_PLAN.md
 * §11), which asks for the `dm` route with `usageAs: EVAL` so its spend is read apart from real conversations.
 *
 * And `transcribe`, speech to text for a WhatsApp voice note (`services/transcribe.ts`, docs/specs/001-whatsapp-agent T034). It is deliberately a
 * label and NOT an `AiPurpose`: the purposes are CHAT routes (a provider and a chat model the operator picks, shown in the routing table, resolved
 * by `pickRoute` to the first provider with a key at its chat default), and a speech model is none of that. Listed there it would show the
 * operator a row whose "Automatic" resolved to a chat model that cannot transcribe, and let a chat model be saved on it. Which providers may
 * serve it is not a routing choice but a privacy rule (only those whose terms forbid training: `TRANSCRIBE_PROVIDERS`).
 *
 * And `perception_voice`, a voice note heard by Meta's Muse Voice Transcribe (`/asr/transcribe`, billed by the hour of audio and not by tokens). A
 * label for the same reason as `transcribe`: a speech model is not a chat model, so there is no route to save and no row for it in the routing table.
 */
export const KEY_TEST = 'key_test';
export const EVAL = 'eval';
export const TRANSCRIBE = 'transcribe';
export const PERCEPTION_VOICE = 'perception_voice';
export type UsagePurpose = AiPurpose | typeof KEY_TEST | typeof EVAL | typeof TRANSCRIBE | typeof PERCEPTION_VOICE;

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
    // The same, for a WhatsApp chat.
    dm_whatsapp: 'low',
    // Ads A7: a campaign drafted from the owner's words or a post, and the daily review of running ads. A tenant's OWN key; the owner's
    // drafts never come here (they are Studio `ads_think` jobs on his Mac, ads/proposals/service.ts), and these are deliberately NOT in
    // MAC_BRAIN_PURPOSES, which means "refuse on the layer": a tenant on the Mac never asks the layer for them in the first place.
    ads_draft: 'medium',
    ads_review: 'medium',
    // The perception purposes are answered while a person waits, one short structured answer each, and Muse Spark always reasons first (limits.ts
    // floors its output at 4 000 tokens), so they think as little as a route lets them.
    perception_dm: 'low',
    recall: 'low',
    reel_index: 'low',
    comment_intent: 'low',
};

/** The effort of a `key_test` call: it asks for one word of JSON, so it asks for no thinking. */
export const KEY_TEST_EFFORT: Effort = 'low';

/**
 * The purposes that are Claude work the owner's Mac already does (`macBrain.ts`): the Monteur's thinking and the infographic writer.
 * The router refuses them for a tenant the Mac works for, so that his videos stay on the Mac and nothing of his is routed through the
 * operator's API key and billed (06 §2, "The owner's rules, enforced in code").
 */
export const MAC_BRAIN_PURPOSES: ReadonlySet<AiPurpose> = new Set<AiPurpose>(['tenant_monteur_think', 'tenant_infographic']);

/** The providers that may answer the Muse purposes: Meta alone (see `PURPOSE_PROVIDER_ALLOWLIST`), and for the reel indexer also Baseten, which hosts Meta's open model. */
const META_ONLY: readonly ProviderId[] = Object.freeze(['meta'] as const);
const META_ONLY_REASON = 'only Meta (Muse) is set up to answer this purpose.';
const REEL_INDEX_PROVIDERS: readonly ProviderId[] = Object.freeze(['meta', 'baseten'] as const);
const REEL_INDEX_REASON = 'only Meta (Muse), hosted by Meta or by Baseten, is set up to answer this purpose.';

/**
 * The providers whose terms forbid training on what is sent through their API: Anthropic, OpenAI and Groq (research R4). A WhatsApp customer's words
 * may go only to one of these (Meta's terms for the WhatsApp Business Platform bar letting its data train or improve a model; constitution VI).
 * Gemini is not here because the Gemini key is the DM bot's and may be a free-tier one, which Google may use to improve its products; OpenRouter
 * because the model behind it is whatever the operator picked and its provider's terms are not ours to vouch for; Custom because it is anyone's.
 */
export const NO_TRAINING_PROVIDERS: readonly ProviderId[] = Object.freeze(['groq', 'anthropic', 'openai'] as const);

/**
 * The purposes that may only be answered by certain providers (`pickRoute` enforces it). A route saved for one of them with another provider is
 * refused at save time and, if it got in some other way, at call time: the call is not made and the caller hands the conversation to a person.
 */
export const PURPOSE_PROVIDER_ALLOWLIST: Readonly<Partial<Record<AiPurpose, readonly ProviderId[]>>> = Object.freeze({
    dm_whatsapp: NO_TRAINING_PROVIDERS,
    // Meta's Muse models alone: they are the only ones in this layer that are sent a picture or a video (`LlmTurn.media`), and the library of reels
    // that `recall` reads is built by Muse too. NOT `NO_TRAINING_PROVIDERS`, which gates WhatsApp: adding Meta there would open WhatsApp to it.
    perception_dm: META_ONLY,
    recall: META_ONLY,
    // The one Muse purpose that may also run on Meta's open-weights model, served by Baseten: the reel indexer reads the owner's OWN published reels and nothing
    // a follower sent. That Baseten answers nothing else is the other direction of the same rule (`PROVIDER_PURPOSE_ALLOWLIST`), which is what keeps it true.
    reel_index: REEL_INDEX_PROVIDERS,
    comment_intent: META_ONLY,
});

/**
 * Why a purpose has an allow-list, in the words a refused route is told (`planAiPatch`): WhatsApp's is a privacy rule about training; the Muse
 * purposes' is that only Meta is set up for them. A purpose with an allow-list and no entry here is told the first sentence, as before.
 */
export const PURPOSE_ALLOWLIST_REASON: Readonly<Partial<Record<AiPurpose, string>>> = Object.freeze({
    perception_dm: META_ONLY_REASON,
    recall: META_ONLY_REASON,
    reel_index: REEL_INDEX_REASON,
    comment_intent: META_ONLY_REASON,
});

/**
 * The other direction of the allow-list: the purposes a PROVIDER may answer, for a provider that is not general-purpose. A provider with no entry may answer
 * any purpose its own list (`PURPOSE_PROVIDER_ALLOWLIST`) lets it.
 *
 * Baseten runs Meta's open-weights model (Muse Spark Open) for ONE job: the reel indexer, which watches the account owner's own published reels. The public
 * privacy page promises that no message, comment or follower data goes to Baseten, and an allow-list on `reel_index` alone cannot keep that promise: it says
 * which providers may answer a purpose, not which purposes a provider may answer, so a route saved for `dm` on Baseten, or `dm` left on "Automatic" with Baseten
 * the only provider that has a key, would send a customer's words there. So this is a deny: it is enforced where a route is saved (`planAiPatch`), where one is
 * chosen (`pickRoute`, for a saved route and for the default order alike) and where a call is made (`generate`), and a refusal in any of them names Baseten.
 */
export const PROVIDER_PURPOSE_ALLOWLIST: Readonly<Partial<Record<ProviderId, readonly AiPurpose[]>>> = Object.freeze({
    baseten: Object.freeze(['reel_index'] as const),
});

/** Whether `provider` may answer `purpose`: true for every provider that has no list of its own (`PROVIDER_PURPOSE_ALLOWLIST`). */
export function providerMayAnswer(provider: ProviderId, purpose: AiPurpose): boolean {
    const only = PROVIDER_PURPOSE_ALLOWLIST[provider];
    return !only || only.includes(purpose);
}

/** The words a refusal uses, for a provider that may answer only some purposes. `providerLabel` is the name the operator knows it by ("Baseten"). */
export function providerPurposeReason(providerLabel: string, provider: ProviderId): string {
    const only = PROVIDER_PURPOSE_ALLOWLIST[provider] ?? [];
    return `${providerLabel} may answer only ${only.join(', ')}: it runs Meta's open model on the account owner's own published reels, and what people send, comment or follow with never goes to it.`;
}

/**
 * A purpose with no route saved of its own answers on another purpose's saved route (`pickRoute`): WhatsApp replies on the `dm` route until the operator
 * saves one for `dm_whatsapp`. Only a SAVED route is borrowed: with neither saved, the default is the first allowed provider with a key.
 */
export const PURPOSE_ROUTE_FALLBACK: Readonly<Partial<Record<AiPurpose, AiPurpose>>> = Object.freeze({
    dm_whatsapp: 'dm',
});

/**
 * Meta sells each Muse Spark model twice: the Standard id, whose content Meta does not train on, and a `-contributor` twin that costs a fraction in
 * exchange for Meta's right to train on what it is sent (dev.meta.ai/docs/pricing-rate-limits). What people send this product is never offered to
 * that bargain, so an id ending `-contributor` is refused on every route: as a saved route, as a provider's default model (`planAiPatch`), and when
 * a call would use it (`pickRoute`). The one exception is an evaluation of made-up cases, which belongs to no tenant and is recorded as `eval`
 * (`allowContributor`, `generate`): nothing real is in it.
 */
export const isContributorModel = (model: string): boolean => /-contributor$/i.test(model.trim());
