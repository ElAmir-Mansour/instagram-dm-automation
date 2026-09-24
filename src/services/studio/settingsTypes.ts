/**
 * The Studio's per-tenant settings (STUDIO.md §10.2).
 *
 * The Studio serves any tenant, so nothing about one creator (brand, voice, product, links,
 * schedule, folder) is written into code or prompts: it all lives here, per tenant. A tenant
 * without a `studio_settings` row gets `defaultStudioSettings()`, which is deliberately neutral.
 */
import type { Carousel } from './carouselTypes.js';

export type BrandKit = {
    /** Shown in the UI. */
    name: string;
    /** The slide sign-off, e.g. "AGENTIC AI" · "بالعربي". */
    signature: { latin: string; local: string };
    /** Accents to rotate through, `#RRGGBB`. */
    palette: string[];
    colors: { ink: string; paper: string; muted: string };
    fonts: { display: 'Cairo' | 'Tajawal' | 'IBM Plex Sans Arabic' | 'Inter'; mono: 'JetBrains Mono' };
    direction: 'rtl' | 'ltr';
    /** One theme in v1; the field exists so more can be added. */
    theme: 'dark-grid';
};

export type VoiceProfile = {
    language: 'ar' | 'en';
    /** Free-text voice guide the writer follows. */
    guide: string;
    digits: 'arabic-indic' | 'latin';
    /**
     * Terms the writer must never use, e.g. a topic the course doesn't cover. Optional, and an
     * addition to §10.2: generated copy that uses one is sent back for repair and, failing that,
     * rejected. An operator's own edits aren't checked against it.
     */
    avoid?: string[];
};

export type ProductInfo = {
    /** e.g. "Agentic AI: الدليل العملي". */
    name: string;
    /** With the referral code. */
    url: string;
    /** Short facts usable on any slide, e.g. "٣٤ درس". */
    facts: string[];
    /** The ✅ lines of the DM. A line that doesn't open with an emoji or bullet gets "✅ ". */
    dmBullets: string[];
};

export type CtaConfig = {
    /** Caption line, with `{keyword}`: 'اكتب "{keyword}" بالتعليقات ويوصلك رابط الكورس بالخاص 📩'. */
    instagramAsk: string;
    /** Caption line: '📚 الكورس كامل بالعربي — رابطه في البايو 🔗'. */
    tiktokLine: string;
    /** With `{username}` `{question}` `{pitch}` `{url}` `{bullets}`. */
    dmTemplate: string;
    /** The last slide's words, per platform. */
    slide: {
        igAsk: string;
        igSub: string;
        save: string;
        ttHeadline: string;
        ttPill: string;
        ttSub: string;
        follow: string;
        swipe: string;
    };
};

/** e.g. `{ timezone: 'Asia/Riyadh', slots: ['13:00', '21:00'] }`. */
export type ScheduleConfig = { timezone: string; slots: string[] };

/** The folder the worker scans; `null` = not set. */
export type LibraryConfig = { root: string | null };

export type StudioSettings = {
    brand: BrandKit;
    voice: VoiceProfile;
    product: ProductInfo;
    cta: CtaConfig;
    schedule: ScheduleConfig;
    library: LibraryConfig;
    /** Carousels the tenant approved, used as few-shot examples; `null` = the built-in ones. */
    examples: Carousel[] | null;
};

/** A spread of accents that read on the dark-grid theme. */
export const DEFAULT_PALETTE: readonly string[] = [
    '#FFD60A', '#FF8A3D', '#22D39A', '#5B8CFF', '#FF6B6B', '#5EEAD4', '#F0ABFC',
    '#22C7F0', '#B06AFF', '#A3E635', '#FF5FA2', '#FFB020', '#FF3B5C',
];

/** Neutral settings: English, generic copy, the dark-grid theme, the default palette, no product. */
export function defaultStudioSettings(): StudioSettings {
    return {
        brand: {
            name: 'My Studio',
            signature: { latin: 'STUDIO', local: '' },
            palette: [...DEFAULT_PALETTE],
            colors: { ink: '#08080A', paper: '#FAFAFA', muted: '#8A8A93' },
            fonts: { display: 'Inter', mono: 'JetBrains Mono' },
            direction: 'ltr',
            theme: 'dark-grid',
        },
        voice: {
            language: 'en',
            digits: 'latin',
            guide: [
                'Clear, friendly and practical. Talk to one reader as "you".',
                'Short sentences. No hype, and no jargon without a plain-words explanation.',
                'Lead with the result the reader gets, then name the tool.',
            ].join('\n'),
            avoid: [],
        },
        product: { name: '', url: '', facts: [], dmBullets: [] },
        cta: {
            instagramAsk: 'Comment "{keyword}" and I\'ll DM you the link 📩',
            tiktokLine: '🔗 The full course is in my bio',
            dmTemplate: 'Hi {username} 👋\n\n{question}\n\n{pitch}\n\n{url}\n\n{bullets}\n\nAny questions? Just reply to this message.',
            slide: {
                igAsk: 'Comment below',
                igSub: 'and I\'ll DM you the link 📩',
                save: 'Save this post',
                ttHeadline: 'The full course',
                ttPill: 'Link in bio',
                ttSub: 'Tap the link on my profile 👆',
                follow: 'Follow for more',
                swipe: 'Swipe',
            },
        },
        schedule: { timezone: 'UTC', slots: ['12:00', '18:00'] },
        library: { root: null },
        examples: null,
    };
}
