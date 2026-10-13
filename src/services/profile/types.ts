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
export const EMOJI_LEVELS = ['none', 'light', 'rich'] as const;
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
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];
export type Pronouns = (typeof PRONOUNS)[number];
export type OnCamera = (typeof ON_CAMERA)[number];
export type Domain = (typeof DOMAINS)[number];
export type ProfileTheme = InfographicTheme;

/** The comment automation an offer carries: what the owner's nine `COURSE_MAPPINGS` become. */
export interface OfferCampaign {
    match: MatchMode;
    keywords: string[];
    dm_template: string;
    public_replies: string[];
}

export interface Offer {
    id: string;
    kind: OfferKind;
    name: string;
    order_via: OrderVia;
    /** Required when `order_via` is 'url'. https only. */
    url: string;
    price: string;
    facts: string[];
    bullets: string[];
    keyword: string;
    primary: boolean;
    campaign?: OfferCampaign;
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
        address: string;
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
    dm: {
        knowledge: string;
        faq: FaqItem[];
        handoff: { when: string; message: string } | null;
        /** `days` are 0 (Sunday) to 6, `from` and `to` are 'HH:MM' in `identity.timezone`. */
        hours: { days: number[]; from: string; to: string } | null;
    };
    goals: { followers: number; views: number };
}

/** The profile's own top-level sections, in the order the type lists them. */
export const PROFILE_SECTIONS = [
    'schema', 'identity', 'language', 'offers', 'audience', 'voice', 'presenter', 'content', 'brand', 'socials', 'dm', 'goals',
] as const satisfies readonly (keyof CreatorProfile)[];
