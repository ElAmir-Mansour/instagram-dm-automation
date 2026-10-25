/**
 * The Studio's per-tenant settings (STUDIO.md §10.2).
 *
 * The Studio serves any tenant, so nothing about one creator (brand, voice, product, links,
 * schedule, folder) is written into code or prompts: it all lives here, per tenant. A tenant
 * without a `studio_settings` row gets `defaultStudioSettings()`, which is deliberately neutral.
 */
import type { ExampleCarousel } from './carouselTypes.js';

export type BrandKit = {
    /** Shown in the UI. */
    name: string;
    /** The slide sign-off: the brand in Latin letters and in the tenant's own script, e.g. "MY BRAND" · "علامتي". */
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
     * Terms the writer must never use, e.g. a topic the product doesn't cover. Optional, and an
     * addition to §10.2: generated copy that uses one is sent back for repair and, failing that,
     * rejected. An operator's own edits aren't checked against it.
     */
    avoid?: string[];
};

export type ProductInfo = {
    /** e.g. "Twelve-week plan". */
    name: string;
    /** With the referral code. */
    url: string;
    /** Short facts usable on any slide, e.g. "٣٤ درس". */
    facts: string[];
    /** The ✅ lines of the DM. A line that doesn't open with an emoji or bullet gets "✅ ". */
    dmBullets: string[];
};

export type CtaConfig = {
    /** Caption line, with `{keyword}`: 'Comment "{keyword}" and I\'ll DM you the link 📩'. */
    instagramAsk: string;
    /** Caption line: '🔗 Link in my bio'. */
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

/** e.g. `{ timezone: 'Europe/London', slots: ['12:00', '18:00'] }`. */
export type ScheduleConfig = { timezone: string; slots: string[] };

/** The folder the worker scans; `null` = not set. */
export type LibraryConfig = { root: string | null };

export type MonteurPlatform = 'instagram' | 'facebook' | 'tiktok' | 'youtube';

/**
 * The Monteur (MONTEUR.md §1): the folder it watches, when it runs, how much it cuts and where
 * the reels go. Times are wall-clock times in `schedule.timezone`, the tenant's one timezone.
 */
export type MonteurSource = 'folder' | 'course';
export type MonteurMode = 'review' | 'auto';
/**
 * Who makes the Monteur's model calls — the pick, the Marketer, the Editor and the Analyst:
 * Gemini, from this app, or Claude, on the Mac worker with the owner's Claude plan (MONTEUR.md §6.3), or `api`: whichever provider the
 * operator routed `tenant_monteur_think` to in Operations → AI providers, on the operator's API key (P32). `api` is for the tenants the
 * Mac is NOT for: the owner's work stays on his Mac whatever is stored (`effectiveBrain`, monteur/brain.ts), and a tenant the Mac works
 * for cannot save it. A tenant created from P32 on starts on `api`; one saved before it keeps what it has.
 */
export type MonteurBrain = 'gemini' | 'claude_mac' | 'api';
/**
 * How the worker renders a reel's edits (MONTEUR.md §6.2): 'classic', the dark cards, or 'paper'
 * (Ali Abdaal style: unfolding paper cards, paper letters, drawn icons, black-and-white b-roll).
 */
export type MonteurStyle = 'classic' | 'paper';

export type MonteurConfig = {
    /** Off = no daily run. Run now still works. */
    enabled: boolean;
    /**
     * Where a run takes its videos: new files in `folder`, or the course library's next lessons
     * (`course_lessons`, in lesson order) that have no source yet. `folder` is needed only for 'folder'.
     */
    source: MonteurSource;
    /** 'review': a rendered reel waits for Approve. 'auto': the drain approves it, as Approve would. */
    mode: MonteurMode;
    /**
     * 'claude_mac': every call is a `monteur_think` job for the Mac, and Gemini is never called for them.
     * 'api': every call goes through the AI providers layer, never to Gemini and never to the Mac.
     */
    brain: MonteurBrain;
    /** Sent to the worker as `brand.style` in every `monteur_render`. */
    style: MonteurStyle;
    /**
     * The Editor's human touches (MONTEUR.md §6.2): camera cuts, doodles, highlights, transitions,
     * freeze-frames. Off: the Editor isn't asked for them, and no render carries them.
     */
    human: boolean;
    /** Absolute, on the worker's machine; `null` = not chosen yet. */
    folder: string | null;
    /** 'HH:MM': the daily scan. */
    run_at: string;
    /** 1–10: new videos taken per run, oldest first. */
    videos_per_run: number;
    /** 1–5. */
    reels_per_video: number;
    /** At least one. Instagram and Facebook share one post; TikTok and YouTube are its siblings. */
    platforms: MonteurPlatform[];
    /** 1–4 'HH:MM' posting slots. */
    post_at: string[];
    /** 10–60. */
    min_seconds: number;
    /** 15–180, and more than `min_seconds`. */
    max_seconds: number;
};

export type InfographicSocial = 'instagram' | 'youtube' | 'linkedin' | 'x' | 'tiktok' | 'facebook' | 'github';
export type InfographicTheme = 'dark' | 'light';
export type InfographicPlatform = 'instagram' | 'facebook' | 'youtube';

/**
 * The personal brand an infographic is drawn in (v31). It is not `brand`, the carousels'
 * kit: an infographic carries the creator's own name, portrait and handles.
 */
export type InfographicConfig = {
    name: { ar: string; en: string };
    /** e.g. "example.dev": in the footer, in the accent. */
    site: string;
    /** e.g. "@example": beside the social icons. */
    handle: string;
    socials: InfographicSocial[];
    /** `#RRGGBB`. The dark page is this mixed into black; the light page's ink is it deepened. */
    primary: string;
    /** `#RRGGBB`. */
    accent: string;
    /** An upload of ours (`/api/uploads/<id>`), shown round and in black and white. Null: no portrait. */
    photo_url: string | null;
    /** For a new infographic. */
    theme: InfographicTheme;
    language: 'ar' | 'en';
    /** Where Schedule posts the MP4. At least one. */
    platforms: InfographicPlatform[];
};

export type ExplainerLanguage = 'ar' | 'en';
export type ExplainerLengthTier = 'short' | 'medium' | 'long';
/** Music under the voice (a track from the library), or sound effects only. */
export type ExplainerSoundMode = 'music' | 'sfx';
/**
 * Who writes the script (research.md R2b): Claude on the owner's Mac, with web research, or Gemini on the server, with Google Search
 * grounding. `writer_fallback` lets the app use Gemini by itself when the Mac cannot write.
 */
export type ExplainerWriter = 'claude_mac' | 'gemini';

/** A recurring figure. It is drawn from its `description`; `ref_*` is the approved picture sent with every draw that names it. */
export type ExplainerCharacter = {
    /** Lower-case letters, digits, `-` and `_`: what a scene's brief names it by. */
    key: string;
    name: string;
    /** English, for the image model. One that describes a woman or a girl is refused (the guard in explainers/spec.ts). */
    description: string;
    /** An upload of ours. Null until the owner has approved a picture. */
    ref_media_id: string | null;
    ref_url: string | null;
    approved_at: string | null;
};

/** A music track the owner has the rights to, uploaded to the media store. */
export type ExplainerTrack = {
    key: string;
    title: string;
    artist: string;
    media_id: string;
    url: string;
    license: string;
    /** The credit line, appended to every caption of a video that uses the track when `credit_required`. */
    credit: string;
    credit_required: boolean;
};

/**
 * The look of illustrated explainers (v59, src/services/explainers/): one section of the tenant's Studio settings, and NOT one the Creator
 * Profile owns (`STUDIO_PROFILE_PATHS`), so it is read and written as stored.
 */
export type ExplainerConfig = {
    /** The art direction every picture starts from. */
    style: string;
    characters: ExplainerCharacter[];
    /** The narrator, per language: a Gemini voice name (`EXPLAINER_VOICES` in settings.ts). */
    voices: { ar: string; en: string };
    /** Sent beside the text, never in it: the voice reads the text aloud. */
    voice_style: string;
    /** Words a second the narrator speaks, per language: turns a script's words into its estimated length. */
    pace: { ar: number; en: number };
    writer: ExplainerWriter;
    /** On: when the Mac cannot write (offline, signed out, no claim), Gemini writes. Off: the explainer waits for the Mac. */
    writer_fallback: boolean;
    /** `#RRGGBB`: the title at the top of the vertical video. */
    title_color: string;
    /** What a new explainer starts with. */
    defaults: { sound_mode: ExplainerSoundMode; subtitles: boolean; language: ExplainerLanguage; length_tier: ExplainerLengthTier };
    music: ExplainerTrack[];
};

export type StudioSettings = {
    brand: BrandKit;
    voice: VoiceProfile;
    product: ProductInfo;
    cta: CtaConfig;
    schedule: ScheduleConfig;
    library: LibraryConfig;
    /**
     * Carousels the tenant approved, used as few-shot examples (a `reference` one is another creator's, shown as a reference);
     * `null` = none of its own, and then the writer is shown none (`examplesFor`): there are no built-in examples.
     */
    examples: ExampleCarousel[] | null;
    monteur: MonteurConfig;
    infographic: InfographicConfig;
    /** v59. How illustrated explainers look and sound (src/services/explainers/). */
    explainer: ExplainerConfig;
};

/** The Monteur's defaults: off, no folder, one reel a day from one video, each reviewed. */
export function defaultMonteurConfig(): MonteurConfig {
    return {
        enabled: false,
        source: 'folder',
        mode: 'review',
        brain: 'gemini',
        style: 'classic',
        human: true,
        folder: null,
        run_at: '07:00',
        videos_per_run: 1,
        reels_per_video: 1,
        platforms: ['instagram', 'facebook', 'tiktok'],
        post_at: ['19:00'],
        min_seconds: 20,
        max_seconds: 45,
    };
}

/**
 * Neutral: no name, site, handles or portrait, so a tenant's infographic says nothing about
 * anyone until its brand is filled in. The colours are only a starting point.
 */
export function defaultInfographicConfig(): InfographicConfig {
    return {
        name: { ar: '', en: '' },
        site: '',
        handle: '',
        socials: [],
        primary: '#0E3B5C',
        accent: '#F2A33A',
        photo_url: null,
        theme: 'dark',
        language: 'en',
        platforms: ['instagram', 'facebook'],
    };
}

/**
 * Words a second, per language: Arabic 1.8, English 2.5. The estimate of a script's length (spec.ts) and the default of `ExplainerConfig.pace`.
 * Arabic was measured on 2026-10-25: gemini-3.8-flash-tts, voice ar-001-commercial-3, the default calm narrator style, 11 words in 6.3 s of speech
 * (1.75 words a second; it was 2.1 before the measurement).
 */
export const DEFAULT_EXPLAINER_PACE = { ar: 1.8, en: 2.5 } as const;

/**
 * Neutral, like every default here: no character (the owner approves his own), no music (the licence of a track is the owner's to state),
 * and no Arabic in it. Claude on the Mac writes unless the owner chooses Gemini, and Gemini steps in when the Mac cannot.
 */
export function defaultExplainerConfig(): ExplainerConfig {
    return {
        style: 'warm hand-painted gouache illustration, soft paper texture, beige, terracotta and olive palette, thin ink outlines, simple shapes',
        characters: [],
        voices: { ar: 'ar-001-commercial-3', en: 'Sadaltager' },
        voice_style: 'a calm, warm documentary narrator; clear, unhurried, curious',
        pace: { ...DEFAULT_EXPLAINER_PACE },
        writer: 'claude_mac',
        writer_fallback: true,
        title_color: '#FFD43B',
        defaults: { sound_mode: 'sfx', subtitles: true, language: 'ar', length_tier: 'short' },
        music: [],
    };
}

/** A spread of accents that read on the dark-grid theme. */
export const DEFAULT_PALETTE: readonly string[] = [
    '#FFD60A', '#FF8A3D', '#22D39A', '#5B8CFF', '#FF6B6B', '#5EEAD4', '#F0ABFC',
    '#22C7F0', '#B06AFF', '#A3E635', '#FF5FA2', '#FFB020', '#FF3B5C',
];

/**
 * Neutral settings: English, generic copy, the dark-grid theme, the default palette, no product. The call to action names nothing that
 * is sold (not "the course": that was the owner's, docs/onboarding/05 R18): a tenant that sells a course says so in its own settings.
 */
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
            tiktokLine: '🔗 Link in my bio',
            dmTemplate: 'Hi {username} 👋\n\n{question}\n\n{pitch}\n\n{url}\n\n{bullets}\n\nAny questions? Just reply to this message.',
            slide: {
                igAsk: 'Comment below',
                igSub: 'and I\'ll DM you the link 📩',
                save: 'Save this post',
                ttHeadline: 'Everything in one place',
                ttPill: 'Link in bio',
                ttSub: 'Tap the link on my profile 👆',
                follow: 'Follow for more',
                swipe: 'Swipe',
            },
        },
        schedule: { timezone: 'UTC', slots: ['12:00', '18:00'] },
        library: { root: null },
        examples: null,
        monteur: defaultMonteurConfig(),
        infographic: defaultInfographicConfig(),
        explainer: defaultExplainerConfig(),
    };
}
