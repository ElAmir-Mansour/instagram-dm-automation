/**
 * What a draft call answers (docs/onboarding/03 §3.6): two schemas, one for the creator's voice and one for
 * their business, run in parallel (§3.1).
 *
 * Written once, in the app's own `GeminiSchema` subset, like every other schema in `llm/`, so one object
 * serves every provider: `generateJson` sends it to Gemini as it is and to the others as JSON Schema
 * (`jsonSchemaFor`). Every property of every object is REQUIRED, so there are no optional fields and no
 * unions: strict structured output (OpenAI's, `strictify`) has nothing to reshape, Anthropic's
 * "too complex" limits (24 optional properties, 16 unions) are met at zero, and a field a model does not
 * know comes back as `""` (or `unknown` for a choice), never as a missing key. `strictDraftSchema` returns
 * what `strictify` makes of it, which is what the test holds equal to the schema.
 *
 * Every fact travels with where it came from (`Prov`): the id of the source, or `inferred`; an exact quote;
 * a confidence. `validateDraft` checks the quote against the source and demotes what fails.
 *
 * Array bounds (`minItems`, `maxItems`) are stated here, for the model's benefit and for `validateDraft`,
 * and stripped before a provider sees them (`withoutArrayBounds`): providers refuse most of them.
 *
 * What is NOT here is as deliberate as what is: no colour, no URL for a social account, no presenter, no
 * content rule, no "never mention", no hours, no handoff. Those are found by code or chosen by a person.
 */
import type { GeminiSchema } from '../llm/geminiSchema.js';
import { jsonSchemaFor, strictify, type JsonSchema } from '../llm/schema.js';
import { ADDRESS, DIGITS, DOMAINS, EMOJI_LEVELS, KINDS, LEVELS, OFFER_KINDS, REGISTERS } from '../profile/types.js';

/** A choice the model does not know is this word, not an empty string: an enum member must be a real word to every provider. */
export const UNKNOWN = 'unknown';

/** What the draft calls are run with (03 §2). No retries inside the call: those belong to `nextDraftStep`. */
export const DRAFT_MAX_TOKENS = 16_000;
export const DRAFT_TIMEOUT_MS = 150_000;

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

const str = (description?: string): GeminiSchema => ({ type: 'STRING', ...(description ? { description } : {}) });
const bool = (description?: string): GeminiSchema => ({ type: 'BOOLEAN', ...(description ? { description } : {}) });
const choice = (values: readonly string[], description?: string): GeminiSchema => ({ type: 'STRING', enum: [...values, UNKNOWN], ...(description ? { description } : {}) });
const list = (items: GeminiSchema, bounds: { min?: number; max?: number }, description?: string): GeminiSchema => ({
    type: 'ARRAY',
    items,
    ...(bounds.min !== undefined ? { minItems: bounds.min } : {}),
    ...(bounds.max !== undefined ? { maxItems: bounds.max } : {}),
    ...(description ? { description } : {}),
});
/** An object whose every property is required and whose order is fixed. */
const object = (properties: Record<string, GeminiSchema>, description?: string): GeminiSchema => ({
    type: 'OBJECT',
    properties,
    required: Object.keys(properties),
    propertyOrdering: Object.keys(properties),
    ...(description ? { description } : {}),
});

const PROV: Record<string, GeminiSchema> = {
    source: str('The id of the source that says it, or "inferred".'),
    evidence: str('An exact quote from that source, copied character for character; "" when the source is "inferred".'),
    confidence: { type: 'STRING', enum: [...CONFIDENCES], description: 'high only when a source says it outright.' },
};
/** A fact and its provenance. */
const field = (value: GeminiSchema, description?: string): GeminiSchema => object({ value, ...PROV }, description);
/** An object that is its own fact, with the same provenance beside its fields. */
const withProv = (properties: Record<string, GeminiSchema>, description?: string): GeminiSchema => object({ ...properties, ...PROV }, description);

// ─── The voice call ──────────────────────────────────────────────────────────────────────────

export const VOICE_SCHEMA: GeminiSchema = object({
    identity: object({
        display_name: field(str('How they name themselves or their brand, in their own spelling.')),
        kind: field(choice(KINDS, 'educator, coach, shop, agency or creator.')),
        role: field(str('An English noun phrase of two to four words, such as "fitness coach". No Arabic.')),
        niche: field(str('One line, in their words, about what they are known for.')),
        country: field(str('Two-letter ISO 3166-1 country code in capitals, such as SA; "" if no source says.')),
    }),
    language: object({
        primary: field(choice(['ar', 'en'], 'The language the posts are mostly written in.')),
        second: field(choice(['ar', 'en', 'none'], 'A second language they also post in, or none.')),
        register: field(choice([...REGISTERS, 'mixed'], 'For Arabic: msa (فصحى), gulf, egyptian, levantine, or mixed. The signals carry the counts; code makes the final decision.')),
        register_note: str('One short sentence on how they mix registers, or "".'),
        digits: field(choice(DIGITS, 'arabic-indic (٠١٢) or latin (012), whichever the posts use.')),
    }),
    audience: object({
        who: field(str('Who they speak to, in one or two sentences.')),
        level: field(choice(LEVELS, 'How much the audience already knows.')),
        pains: list(field(str('One problem the audience has.')), { max: 6 }, 'Up to 6 problems the audience has, each from the sources.'),
        goals: list(field(str('One thing the audience wants.')), { max: 6 }, 'Up to 6 things the audience wants, each from the sources.'),
    }),
    voice: object({
        tone_words: list(field(str('One word or short phrase for how they sound.')), { max: 5 }, 'Up to 5 words for their tone.'),
        guide: field(str('A paragraph on how this creator writes: sentence length, how they open and close, what they never do. Describe, do not imitate.')),
        emoji: field(choice(EMOJI_LEVELS, 'none, light or rich.')),
        address: field(choice(ADDRESS, 'Whom their Arabic lines address: masc, fem, plural or neutral.')),
        words_used: list(str('A word or short phrase they use often, exactly as they write it.'), { max: 20 }, 'Up to 20 words or phrases they actually use.'),
        samples: list(object({ post_id: str('The id of one of signals.candidates.'), why: str('Why this post shows their voice.') }), { min: 3, max: 5 }, '3 to 5 posts from signals.candidates, spread across their topics.'),
    }),
    pillars: list(
        withProv({ name: str('A recurring topic, a few words.'), description: str('One sentence on it.'), post_ids: list(str('A source id of a post about it.'), { max: 10 }) }),
        { min: 3, max: 7 },
        '3 to 7 recurring topics.',
    ),
    domain: field(choice(DOMAINS, 'tech if the content is about software, AI or technology; otherwise general.')),
});

// ─── The business call ───────────────────────────────────────────────────────────────────────

export const BUSINESS_SCHEMA: GeminiSchema = object({
    offers: list(
        withProv({
            name: str('What it is called.'),
            kind: choice(OFFER_KINDS, 'course, coaching, program, product, service, community, event or other.'),
            url: str('Its address, exactly as a source gives it, or "".'),
            price: str('Its price, exactly as a source writes it, or "".'),
            bullets: list(str('One selling point from the sources.'), { max: 6 }),
            facts: list(str('One short fact: duration, level, what is included.'), { max: 8 }),
            keyword: str('One short word a follower could comment to ask for it, or "".'),
        }),
        { max: 6 },
        'What they sell, most important first. Empty if the sources show nothing for sale.',
    ),
    dm_faq: list(
        withProv({
            question: str('A question customers ask.'),
            answer: str('The answer, only from what the sources say; "" if they do not say.'),
            needs_input: bool('true when the sources do not answer it.'),
        }),
        { max: 8 },
        'Questions customers are likely to ask, with answers only where the sources give them.',
    ),
    comment_keywords: list(
        withProv({
            keyword: str('A word followers can comment to get the offer by message.'),
            offer: str('The name of the offer it is for.'),
            already_used: bool('true if it is in signals.keywords_in_use.'),
        }),
        { max: 6 },
        'Comment trigger words, one per offer.',
    ),
    contact: object({
        whatsapp: field(str('A WhatsApp number or link exactly as a source gives it, or "".')),
        email: field(str('An email address exactly as a source gives it, or "".')),
    }),
    handoff_hint: field(str('When a person should take over from the assistant, in one sentence, or "".')),
});

export type DraftCall = 'voice' | 'business';

/** Both calls, in the order they are asked and shown. */
export const DRAFT_CALLS: readonly DraftCall[] = ['voice', 'business'];

export const DRAFT_SCHEMAS: Readonly<Record<DraftCall, GeminiSchema>> = { voice: VOICE_SCHEMA, business: BUSINESS_SCHEMA };

/** The schema as OpenAI's strict mode takes it. For a schema with every property required this changes nothing, which a test holds. */
export function strictDraftSchema(call: DraftCall): JsonSchema {
    return strictify(jsonSchemaFor(DRAFT_SCHEMAS[call]));
}

// ─── What comes back ─────────────────────────────────────────────────────────────────────────

export interface Prov {
    source: string;
    evidence: string;
    confidence: Confidence;
}
export type F<T> = { value: T } & Prov;
