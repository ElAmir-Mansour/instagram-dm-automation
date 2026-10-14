/**
 * The Creator Profile (docs/onboarding/01 §1): one record per tenant that says who the creator is,
 * how they speak, what they sell and what the agents must never do. It is the source of truth the
 * Studio and Growth settings become *views* over (`views.ts`), so a fact lives in one place.
 *
 * Pure types and the closed lists the validator and the views share. Nothing here reads a database.
 */
import type { BrandKit, InfographicSocial, InfographicTheme } from '../studio/settingsTypes.js';

export type { InfographicSocial };

/** The Studio's display fonts, as the carousel kit names them. */
export type StudioDisplayFont = BrandKit['fonts']['display'];

// The closed lists are values, so the validator checks against the very ones the types come from.
export const LANGS = ['ar', 'en'] as const;
export const REGISTERS = ['msa', 'gulf', 'egyptian', 'levantine'] as const;
export const DIGITS = ['arabic-indic', 'latin'] as const;
export const SURFACES = ['dm', 'comments', 'carousel', 'reels', 'infographic', 'coach'] as const;
export const CONTENT_RULE_PRESETS = ['no_women_imagery'] as const;
export const KINDS = ['educator', 'coach', 'shop', 'agency', 'creator'] as const;
export const OFFER_KINDS = ['course', 'coaching', 'program', 'product', 'service', 'community', 'event', 'other'] as const;
export const ORDER_VIA = ['url', 'dm'] as const;
export const MATCH_MODES = ['substring', 'word'] as const;
export const LEVELS = ['beginner', 'intermediate', 'advanced', 'mixed'] as const;
/** Who an offer is pitched at (`Offer.sales.level`): 'any' when it asks for no prior experience and the owner assumes none. */
export const SALES_LEVELS = ['beginner', 'intermediate', 'advanced', 'any'] as const;
/** A piece of proof is a number the owner can point to, or something a named person said. */
export const PROOF_KINDS = ['stat', 'testimonial'] as const;
export const EMOJI_LEVELS = ['none', 'light', 'rich'] as const;
/** Who the Arabic lines address: a man, a woman, a group, or no one in particular (the pools are written for one reader). */
export const ADDRESS = ['masc', 'fem', 'plural', 'neutral'] as const;
export const PRONOUNS = ['he', 'she', 'they'] as const;
export const ON_CAMERA = ['face', 'voice', 'mixed'] as const;
export const DOMAINS = ['tech', 'general'] as const;
export const THEMES = ['dark', 'light'] as const;
/** The Studio's display fonts (`DISPLAY_FONTS` in studio/settings.ts, which this must match: a test holds them equal). */
export const FONTS = ['Cairo', 'Tajawal', 'IBM Plex Sans Arabic', 'Inter'] as const satisfies readonly StudioDisplayFont[];
/** The platforms a profile can link (`INFOGRAPHIC_SOCIALS` in studio/settings.ts; held equal by a test). */
export const SOCIALS = ['instagram', 'youtube', 'linkedin', 'x', 'tiktok', 'facebook', 'github'] as const satisfies readonly InfographicSocial[];

export type Lang = (typeof LANGS)[number];
export type ArabicRegister = (typeof REGISTERS)[number];
export type Digits = (typeof DIGITS)[number];
export type Surface = (typeof SURFACES)[number];
/** Each preset has canonical prompt text per purpose (05 §2), so a rule is a name, not a sentence. */
export type ContentRulePreset = (typeof CONTENT_RULE_PRESETS)[number];
export type CreatorKind = (typeof KINDS)[number];
export type OfferKind = (typeof OFFER_KINDS)[number];
export type OrderVia = (typeof ORDER_VIA)[number];
export type MatchMode = (typeof MATCH_MODES)[number];
export type AudienceLevel = (typeof LEVELS)[number];
export type SalesLevel = (typeof SALES_LEVELS)[number];
export type ProofKind = (typeof PROOF_KINDS)[number];
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];
export type Address = (typeof ADDRESS)[number];
export type Pronouns = (typeof PRONOUNS)[number];
export type OnCamera = (typeof ON_CAMERA)[number];
export type Domain = (typeof DOMAINS)[number];
export type ProfileTheme = InfographicTheme;

/**
 * The comment automation an offer carries: what the owner's nine `COURSE_MAPPINGS` become
 * (dashboard/js/pages/campaigns.js), field for field and byte for byte:
 *
 * - `name_match`  the mapping's key ('agentic ai', 'c#'): a lower-case substring of the course name.
 *                 The bulk import tries the keys in order and the first that the name contains wins,
 *                 so the order of `offers` is the order of the keys. Empty: matched by no course name.
 * - `keywords`    `triggerKeywords` (the campaign's `trigger_keyword`) split on `", "`, and joined
 *                 back on `", "`.
 * - `dm_template` `dmTemplate` as it is, `{url}` and `{username}` still in it.
 * - `public_replies`  `publicReplies` (the campaign's `public_reply_template`) split on `" | "`, and
 *                 joined back on `" | "`.
 * - `match`       the campaign's `match_mode`; the bulk import never sets one, so it is 'substring'.
 *
 * A keyword containing `", "` or a reply containing `" | "` would not survive that round trip, so the
 * text a person types into either list must not hold its own separator.
 */
export interface OfferCampaign {
    name_match: string;
    match: MatchMode;
    keywords: string[];
    dm_template: string;
    public_replies: string[];
}

export interface OfferSalesFaq {
    q: string;
    a: string;
}

export interface OfferSalesObjection {
    objection: string;
    answer: string;
}

export interface OfferSalesProof {
    kind: ProofKind;
    text: string;
    /** Where it comes from: the offer's own page, or a named person who agreed to be quoted. Required, so nothing is anonymous. */
    source: string;
}

/**
 * What the DM bot may say when it sells an offer (docs/DM_SALES_PLAN.md §5): the owner's own words about who the offer is for, what
 * it gives, the questions and objections people raise, and the proof he can point to. A person typed all of it; the bot quotes it and
 * invents nothing, and a field left empty is a fact the bot does not have.
 *
 *   for_whom            who it fits, and who it does not
 *   level               'any' until the owner says otherwise
 *   outcomes            what a person can do afterwards, one short line each
 *   faqs                questions about THIS offer (`dm.faq` holds the general ones)
 *   objections          what people say against it ("too expensive", "no time") and the owner's answer to each
 *   proof               real student counts, ratings and testimonials only, each with where it comes from
 *   price_note          one sentence on how the price behaves ("it moves with sales; the page shows today's")
 *   price_valid_until   'YYYY-MM-DD', or '' for none. **The bot states `Offer.price` only while this date has not passed**, and it
 *                       is the only thing that lets the bot say a price will end: no date, no number, no urgency
 *   currency            ISO 4217 ('USD', 'SAR'), or '' when the price text says it already
 *   image_url           a cover from the owner's own uploads, or ''. The model never picks an image
 *
 * Optional on an offer; once it is there every field is required (a reader fills a stored block's gaps from `blankSales()`, as it
 * does for a campaign). It is JSONB inside `creator_profiles`, so there is no migration. A reader older than this field would refuse
 * a profile that carries it, so the reader and the editor ship together and nothing writes it before they are live.
 */
export interface OfferSales {
    for_whom: string;
    level: SalesLevel;
    outcomes: string[];
    faqs: OfferSalesFaq[];
    objections: OfferSalesObjection[];
    proof: OfferSalesProof[];
    price_note: string;
    price_valid_until: string;
    currency: string;
    image_url: string;
}

export interface Offer {
    id: string;
    kind: OfferKind;
    name: string;
    order_via: OrderVia;
    /** Required when `order_via` is 'url'. http or https, as the Studio's product link is. */
    url: string;
    price: string;
    facts: string[];
    bullets: string[];
    keyword: string;
    primary: boolean;
    campaign?: OfferCampaign;
    /** What the DM bot may say when it sells this offer. Absent until the owner writes some. */
    sales?: OfferSales;
}

export interface Presenter {
    name: string;
    pronouns: Pronouns;
    on_camera: OnCamera;
}

export interface FaqItem {
    q: string;
    a: string;
}

export interface CreatorProfile {
    schema: 1;
    identity: {
        display_name: { ar: string; en: string };
        brand_name: string;
        kind: CreatorKind | null;
        /** The English noun phrase the prompts use for them, 2-4 words: "tech educator". */
        role: string;
        /** One free line, in their own words. */
        niche: string;
        country: string | null;
        /** IANA. Empty until chosen; the Studio's view reads it as 'UTC'. */
        timezone: string;
    };
    language: {
        primary: Lang;
        /** Required when `primary` is 'ar'; kept (and ignored) when it is 'en'. */
        register: ArabicRegister | null;
        digits: Digits;
        /** A surface may speak another language, or another register, than the profile's. */
        surfaces: Partial<Record<Surface, { language?: Lang; register?: ArabicRegister }>>;
    };
    offers: Offer[];
    audience: {
        description: string;
        level: AudienceLevel | null;
        pains: string[];
        goals: string[];
        /** ISO 3166-1 alpha-2, upper case. */
        countries: string[];
        /** ISO 639, lower case: what the audience speaks, which is not the language the creator writes in. */
        languages: string[];
        /** Only the Growth heatmap's override. The tenant's own timezone is `identity.timezone`. */
        timezone?: string;
    };
    voice: {
        /** Verbatim, and it wins over everything else in `voice`. */
        guide: string;
        tone: string[];
        samples: string[];
        use_words: string[];
        avoid_words: string[];
        emoji: EmojiLevel;
        /** Who the Arabic lines address. The owner's pools address one man, so he is 'masc'. */
        address: Address;
    };
    presenter: Presenter | null;
    content: {
        domain: Domain;
        pillars: string[];
        /** Hard: in the prompt and in the validators that reject generated copy. */
        never_mention: string[];
        rules: ContentRulePreset[];
        custom_rules: string[];
    };
    brand: {
        primary: string;
        accent: string;
        font_display: StudioDisplayFont;
        logo_url: string | null;
        portrait_url: string | null;
        theme: ProfileTheme;
    };
    socials: {
        handle: string;
        site: string;
        platforms: InfographicSocial[];
        links: Partial<Record<InfographicSocial, string>>;
    };
    /**
     * The DM bot's own settings. Its knowledge base is not here: it stays where it is, an agent
     * setting (`ai_agents.knowledge_base`, unbounded), and is not a fact about the creator.
     */
    dm: {
        faq: FaqItem[];
        handoff: { when: string; message: string } | null;
        /** `days` are 0 (Sunday) to 6, `from` and `to` are 'HH:MM' in `identity.timezone`. */
        hours: { days: number[]; from: string; to: string } | null;
        /**
         * The voice of a direct message, when it is not the voice of a post (docs/DM_SALES_PLAN.md S6). `voice.guide` is tuned for
         * carousels and captions ("one point per slide", "the link is in the bio"), and a chat reply is none of that. When this is
         * set (not blank) the sales prompt uses it INSTEAD of `voice.guide`; when it is absent or blank it uses `voice.guide`, so a
         * profile that never typed one reads exactly as before. Optional, and absent until somebody types one: no stored profile,
         * no golden and no other prompt moves for it.
         */
        voice_guide?: string;
    };
    goals: { followers: number; views: number };
}

/** The profile's own top-level sections, in the order the type lists them. */
export const PROFILE_SECTIONS = [
    'schema', 'identity', 'language', 'offers', 'audience', 'voice', 'presenter', 'content', 'brand', 'socials', 'dm', 'goals',
] as const satisfies readonly (keyof CreatorProfile)[];
