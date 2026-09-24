/**
 * Row shapes for the tables this application reads.
 *
 * Why this file exists: `pool.query()` resolves to `QueryResult<any>`, so `result.rows[0].foo`
 * typechecks for every `foo` that has ever been imagined. `strict` and
 * `noUncheckedIndexedAccess` are both on in tsconfig.json, and they buy almost nothing on the
 * paths that matter, because every one of those paths starts at a `pool.query` or at a webhook
 * body typed `any`. That is the mechanism by which a file full of unchecked Meta JSON compiles
 * without a single complaint — and why `interactions.platform` could be written by the
 * application for months while existing in no migration.
 *
 * These types are hand-maintained against `schema.sql` and `src/config/migration_v*.sql`.
 * That is a real cost and worth naming: nothing enforces that they still match the database.
 * They are still worth having, because the failure mode they prevent — a renamed or misspelled
 * column read as `undefined` and silently written into a Meta API call — is the one this
 * codebase has actually suffered. A generated schema (pg-to-ts, kysely-codegen) would close
 * the gap properly and is recommended in ARCHITECTURE.md; it needs a live connection at build
 * time, which this project does not have in CI today.
 *
 * Convention: columns are optional here **only** when the column is genuinely nullable in the
 * database. Selecting a subset of columns is expressed at the call site with `Pick<>`, so the
 * type says which columns the query actually asked for.
 */
import type { Carousel } from '../services/studio/carouselTypes.js';

/** Postgres `TIMESTAMP WITH TIME ZONE` arrives as a Date through `pg`'s default parser. */
export type Timestamptz = Date;

// ─── creators ───────────────────────────────────────────────────────────────────────────

export interface CreatorRow {
    id: string;
    instagram_page_id: string | null;
    facebook_page_id: string | null;
    /** Stored `enc:v1:...` — always read through `src/services/tenant.ts`, never raw. */
    page_access_token: string;
    is_active: boolean;
    name: string | null;
    meta_user_id: string | null;
    token_status: string | null;
    token_last_checked_at: Timestamptz | null;
    token_error: string | null;
    webhook_verify_token: string | null;
    created_at: Timestamptz;
}

// ─── campaigns ──────────────────────────────────────────────────────────────────────────

/** How `trigger_keyword` is tested against a comment. See src/utils/arabic.ts. */
export type KeywordMatchMode = 'substring' | 'word';

export interface CampaignRow {
    id: string;
    creator_id: string | null;
    /** Null means the campaign applies to every post. */
    post_id: string | null;
    /** A comma-separated list, matched after Arabic normalisation per `match_mode`. */
    trigger_keyword: string;
    dm_template: string;
    public_reply_template: string | null;
    /**
     * v14. NOT NULL DEFAULT 'substring' in the database, so it is never absent on a row —
     * but a query that does not select it still yields `undefined`, which is why every
     * consumer goes through `normalizeMatchMode`.
     */
    match_mode: KeywordMatchMode;
    is_active: boolean;
    created_at: Timestamptz;
}

// ─── interactions ───────────────────────────────────────────────────────────────────────

export type InteractionStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED';

export interface InteractionRow {
    id: string;
    campaign_id: string | null;
    /** Backfilled by v12; written directly by the webhook since the tenancy pass. */
    creator_id: string | null;
    /** UNIQUE — this is the comment pipeline's idempotency claim. */
    comment_id: string;
    sender_username: string;
    post_id: string;
    status: InteractionStatus | string;
    error_log: string | null;
    platform: string | null;
    timestamp: Timestamptz;
}

// ─── conversations & messages ───────────────────────────────────────────────────────────

export interface ConversationRow {
    id: string;
    creator_id: string;
    instagram_user_id: string;
    status: string | null;
    is_bot_active: boolean;
    /** When the automated-service disclosure was last sent on this thread. */
    ai_disclosed_at: Timestamptz | null;
    last_message_at: Timestamptz | null;
    created_at: Timestamptz;
}

export type MessageDirection = 'inbound' | 'outbound';

export interface MessageRow {
    id: string;
    conversation_id: string;
    creator_id: string | null;
    direction: MessageDirection;
    message_type: string | null;
    text: string;
    payload: string | null;
    /**
     * The entire Meta event, kept forever with no retention policy until
     * `pruneRawPayloads` was added. Both a storage cost and a standing privacy exposure —
     * it holds message bodies and Meta user ids for people who never interacted again.
     */
    raw_payload: unknown | null;
    /** UNIQUE where not null — the DM pipeline's *dedupe* claim, not its progress marker. */
    meta_message_id: string | null;
    /**
     * v14. When the pipeline reached a terminal outcome for this inbound message: a reply
     * sent, the bot paused, the agent switched off, or a failure that retrying cannot fix.
     * NULL on an inbound row means the work is unfinished and a retry may pick it up.
     * Always NULL on outbound rows — they are the record of a reply, not a thing to answer.
     */
    handled_at: Timestamptz | null;
    /** v14. Visibility timeout for the re-entrant inbound claim. */
    reply_claimed_at: Timestamptz | null;
    /** v14. How many times the pipeline has claimed this inbound message. */
    reply_attempts: number;
    created_at: Timestamptz;
}

// ─── scheduled posts ────────────────────────────────────────────────────────────────────

/**
 * `both` means Instagram + Facebook — it predates TikTok and keeps that meaning. A TikTok post
 * is always its own row (`tiktok`), linked to its Meta sibling by `group_id` (v18).
 */
export type SchedulePlatform = 'instagram' | 'facebook' | 'both' | 'tiktok';

/**
 * `PROCESSING` and `IN_INBOX` arrived with TikTok (v18), whose publish is asynchronous:
 * `PROCESSING` — uploaded, TikTok still ingesting; `IN_INBOX` — delivered to the creator's
 * TikTok inbox, where they finish the post. There is no CHECK on the column, so these are the
 * vocabulary by convention — every reader that filters on status is listed in
 * migration_v18_tiktok.sql.
 */
export type ScheduleStatus = 'PENDING' | 'PUBLISHING' | 'PROCESSING' | 'IN_INBOX' | 'PUBLISHED' | 'FAILED';

/**
 * `carousel` (v20) is several images in `media_urls`: an Instagram CAROUSEL container, a
 * Facebook multi-photo feed post, or a TikTok photo post. On TikTok, `image` is a single-photo
 * post and `video` the only other type.
 */
export type SchedulePostType = 'image' | 'video' | 'reel' | 'story' | 'feed' | 'carousel';

export interface ScheduledPostRow {
    id: string;
    creator_id: string | null;
    platform: SchedulePlatform | string;
    /**
     * `video`, not `reel`, for anything cross-posted: `publishFacebookPost` has no `reel`
     * branch and falls through to a text-only feed post with the media silently dropped.
     */
    post_type: SchedulePostType | string;
    caption: string | null;
    /** For a carousel, always `media_urls[0]`, so readers that know only this column keep working. */
    media_url: string | null;
    /** v20. A carousel's images in slide order; NULL for every other row. */
    media_urls: string[] | null;
    cover_url: string | null;
    scheduled_time: Timestamptz;
    status: ScheduleStatus | string;
    error_log: string | null;
    published_post_id: string | null;
    attempts: number;
    claimed_at: Timestamptz | null;
    /** v18. Ties the rows one composer submission created (e.g. a `both` row and its `tiktok` sibling). */
    group_id: string | null;
    /** v18. TikTok's `publish_id`, written the moment the upload is initialised. */
    external_publish_id: string | null;
    /** v18. When the reconcile sweep last asked TikTok about a PROCESSING row. */
    status_checked_at: Timestamptz | null;
    /** v19. TikTok per-post options; NULL means inbox mode. See `TikTokPostOptions`. */
    platform_options: TikTokPostOptions | null;
    created_at: Timestamptz;
}

/**
 * What a TikTok row carries in `platform_options` (v19). Direct Post takes every choice TikTok's
 * editor would otherwise ask for up front, because there is no editor step.
 */
export type TikTokPrivacyLevel = 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR' | 'SELF_ONLY';
export interface TikTokPostOptions {
    mode: 'direct' | 'inbox';
    privacy_level?: TikTokPrivacyLevel;
    allow_comment?: boolean;
    /** Video only — a TikTok photo post has no duet or stitch, so photo rows never carry these. */
    allow_duet?: boolean;
    allow_stitch?: boolean;
    brand_organic?: boolean;
    brand_content?: boolean;
    /** Video only, like duet and stitch: TikTok's photo post has no AI-generated label to set. */
    is_aigc?: boolean;
    /**
     * Photo posts only (v20), either mode: TikTok's photo title, at most 90 UTF-16 units. Absent
     * means the caption's first line, worked out at publish time so a caption edit carries over.
     */
    title?: string;
    /** Photo posts, direct mode only (v20). Absent means true. */
    auto_add_music?: boolean;
    /** When the creator ticked "I agree to post this" — TikTok requires express consent. */
    consent_at?: string;
}

// ─── platform connections (v18) ─────────────────────────────────────────────────────────

export type ConnectionPlatform = 'tiktok';
export type ConnectionStatus = 'active' | 'invalid' | 'revoked';

export interface PlatformConnectionRow {
    id: string;
    creator_id: string;
    platform: ConnectionPlatform;
    /** TikTok `open_id` — per-app, and what TikTok webhooks identify the account by. */
    external_account_id: string;
    display_name: string | null;
    avatar_url: string | null;
    scopes: string[];
    /** `enc:v1:...`. Only ever read through src/services/tiktokConnections.ts. */
    access_token: string | null;
    access_expires_at: Timestamptz | null;
    /** `enc:v1:...`. May rotate on every refresh. */
    refresh_token: string | null;
    refresh_expires_at: Timestamptz | null;
    status: ConnectionStatus;
    last_error: string | null;
    last_refreshed_at: Timestamptz | null;
    refresh_claimed_at: Timestamptz | null;
    connected_by_user_id: string | null;
    created_at: Timestamptz;
    updated_at: Timestamptz;
}

export interface AppSettingRow {
    key: string;
    /** `enc:v1:...` when `is_secret`. */
    value: string | null;
    is_secret: boolean;
    updated_at: Timestamptz;
    updated_by: string | null;
}

/**
 * The app-wide counterpart of `rate_limit_counters` (v14).
 *
 * Meta's app-level limit is a pool shared by every tenant, so it cannot be counted per
 * creator — and `rate_limit_counters.creator_id` is NOT NULL with a foreign key, so there is
 * no sentinel row to use.
 */
export interface AppRateLimitCounterRow {
    bucket: string;
    window_start: Timestamptz;
    count: number;
}

// ─── media ──────────────────────────────────────────────────────────────────────────────

export interface MediaUploadRow {
    id: string;
    creator_id: string | null;
    filename: string;
    mime_type: string;
    /** BYTEA. See ARCHITECTURE.md — this is the row that should not be in Postgres. */
    data: Buffer;
    created_at: Timestamptz;
}

// ─── identity ───────────────────────────────────────────────────────────────────────────

export interface UserRow {
    id: string;
    email: string;
    password_hash: string;
    role: 'platform_admin' | 'user' | string;
    /** Bumping this invalidates every session token the user holds. */
    token_version: number;
    is_active: boolean;
    last_login_at: Timestamptz | null;
    created_at: Timestamptz;
}

export interface MembershipRow {
    user_id: string;
    creator_id: string;
    role: string;
    created_at: Timestamptz;
}

// ─── ai agents ──────────────────────────────────────────────────────────────────────────

export interface AiAgentRow {
    id: string;
    creator_id: string;
    is_active: boolean;
    system_prompt: string;
    knowledge_base: string | null;
    model: string | null;
    temperature: number | null;
}

// ─── Carousel Studio (v21) ──────────────────────────────────────────────────────────────
//
// The shapes STUDIO.md §3 names. They live here, beside the rows whose JSONB columns hold
// them, the way `TikTokPostOptions` lives beside `platform_options`. The generator
// (src/services/studio/generate.ts) is written against these too.

export type LessonStatus = 'new' | 'indexing' | 'indexed' | 'failed';

/** What a lesson teaches, as the worker's Gemini pass read it off the video. */
export interface LessonNotes {
    /** 2–4 sentences, Arabic. */
    summary: string;
    /** What it teaches, 3–10. `t` is seconds into the video. */
    points: { title: string; detail: string; t?: number }[];
    /** Prompts shown on screen, verbatim. */
    prompts: { text: string; t?: number }[];
    /** Products used, e.g. "NotebookLM". */
    tools: string[];
    demos: { title: string; result: string; t?: number }[];
}

/** A `course_lessons` row. The contract calls it `LessonRow`, so it is named that here too. */
export interface LessonRow {
    id: string;
    creator_id: string;
    /** "1.2", "8.3"; "I.1" for intro videos, "G.1" for the Gemini apps. */
    lesson_no: string;
    section_no: number | null;
    section_title: string | null;
    title: string;
    /** Absolute, on the Mac. Only the worker can open it. */
    video_path: string;
    /** NUMERIC: select it as `duration_s::float8` or `pg` hands back a string. */
    duration_s: number | null;
    status: LessonStatus;
    notes: LessonNotes | null;
    indexed_at: Timestamptz | null;
    error: string | null;
    created_at: Timestamptz;
    updated_at: Timestamptz;
}

export type MomentKind = 'slide' | 'ui' | 'result' | 'code' | 'prompt' | 'other';

/** A `lesson_moments` row as the API and the generator see it (STUDIO.md §3 `Moment`). */
export interface Moment {
    id: string;
    lesson_id: string;
    /** Seconds into the video. NUMERIC: select it as `t::float8`. */
    t: number;
    description: string;
    kind: MomentKind;
    /** No annotation arrows or scribbles, nothing loading or blank. */
    clean: boolean;
    /** `/api/uploads/<id>`, a 480px JPEG. */
    thumb_url: string | null;
}

/** A still for a slide: which lesson, when, and how to frame it. 1 = the whole frame. */
export interface ShotSpec {
    lessonId: string;
    t: number;
    zoom: number;
    /** The point of the frame to centre on, 0..1. */
    focusX: number;
    focusY: number;
    desc?: string;
}

export type DraftAngle = 'auto' | 'tips' | 'steps' | 'mistakes' | 'compare' | 'prompt' | 'overview';

/** What the operator asked for. Stored as given, after validation, in `carousel_drafts.input`. */
export interface DraftInput {
    /** 0–3 lessons to ground the post in. */
    lessonIds: string[];
    /** Free-text topic; required when `lessonIds` is empty. */
    idea?: string;
    angle?: DraftAngle;
    /** 6–10, default 8. */
    slides?: number;
    /** Else suggested. */
    keyword?: string;
    /** `#RRGGBB`, else picked from the palette. */
    accent?: string;
}

/** The keyword → DM campaign a draft proposes. `create: false` reuses an active one. */
export interface DraftCampaign {
    keyword: string;
    variants: string[];
    dm: string;
    create: boolean;
}

/** Upload URLs in slide order: `ig` 1080×1350, `tt` 1080×1920. `job_id` is the render that made them. */
export interface DraftRender {
    ig: string[];
    tt: string[];
    rendered_at: string;
    job_id: string;
}

export type DraftTikTokIntent = 'none' | 'queue' | 'scheduled';

export interface DraftSchedule {
    scheduled_time: string;
    meta_row_id: string;
    tiktok: DraftTikTokIntent;
    tiktok_row_id: string | null;
    /** The operator's "made public on TikTok" tick — unaudited direct posts go out private. */
    tiktok_public_done: boolean;
}

export type DraftStatus = 'generating' | 'rendering' | 'ready' | 'scheduled' | 'failed';

export interface CarouselDraftRow {
    id: string;
    creator_id: string;
    status: DraftStatus;
    input: DraftInput;
    carousel: Carousel | null;
    /** Keyed by `ShotRef.name`; generated drafts name theirs `m-<momentId>`. */
    shots: Record<string, ShotSpec> | null;
    campaign: DraftCampaign | null;
    render: DraftRender | null;
    schedule: DraftSchedule | null;
    error: string | null;
    created_at: Timestamptz;
    updated_at: Timestamptz;
}

export type StudioJobKind = 'scan_library' | 'index_lesson' | 'render_carousel';
export type StudioJobStatus = 'pending' | 'claimed' | 'done' | 'failed';

export interface ScanLibraryPayload { root: string }
export interface IndexLessonPayload { lessonId: string; video_path: string; lesson_no: string; title: string }
/**
 * Each shot carries its lesson's `video_path`, so the worker needs no second lookup. `brand`,
 * `cta` and `facts` are the tenant's settings at the moment the render was queued (v1.1): the
 * templates read every colour, font and CTA word from them, never from constants.
 */
export interface RenderCarouselPayload {
    draftId: string;
    carousel: Carousel;
    shots: Record<string, ShotSpec & { video_path: string }>;
    brand: BrandKit;
    cta: CtaSlideWords;
    facts: string[];
}

export interface StudioJobRow {
    id: string;
    creator_id: string;
    kind: StudioJobKind;
    payload: ScanLibraryPayload | IndexLessonPayload | RenderCarouselPayload;
    status: StudioJobStatus;
    progress: string | null;
    claimed_at: Timestamptz | null;
    /** Moved by every progress call. A claim older than 15 minutes by this is claimable again. */
    heartbeat_at: Timestamptz | null;
    attempts: number;
    result: unknown;
    error: string | null;
    created_at: Timestamptz;
    updated_at: Timestamptz;
}

// ── Per-tenant Studio settings (STUDIO.md §10) ──
// Nothing about one creator is in code. `defaultStudioSettings()` (src/services/studio/settings.ts)
// is the neutral fallback; each tenant's row is merged over it section by section.

export type StudioDisplayFont = 'Cairo' | 'Tajawal' | 'IBM Plex Sans Arabic' | 'Inter';

export interface BrandKit {
    /** Shown in the UI. */
    name: string;
    /** The slide sign-off, e.g. "AGENTIC AI" · "بالعربي". */
    signature: { latin: string; local: string };
    /** Accents to rotate through, `#RRGGBB`. */
    palette: string[];
    colors: { ink: string; paper: string; muted: string };
    fonts: { display: StudioDisplayFont; mono: 'JetBrains Mono' };
    direction: 'rtl' | 'ltr';
    /** One theme in v1; the field exists so more can be added. */
    theme: 'dark-grid';
}

export interface VoiceProfile {
    language: 'ar' | 'en';
    /** Free-text voice guide the writer follows. */
    guide: string;
    digits: 'arabic-indic' | 'latin';
    /** Words and topics the writer must never use, e.g. an unpublished section. */
    avoid?: string[];
}

export interface ProductInfo {
    name: string;
    /** With any referral code. */
    url: string;
    /** Short facts usable on slides, e.g. "٣٤ درس". */
    facts: string[];
    /** The ✅ lines in the DM. */
    dmBullets: string[];
}

/** The last slide's words, per platform. */
export interface CtaSlideWords {
    igAsk: string;
    igSub: string;
    save: string;
    ttHeadline: string;
    ttPill: string;
    ttSub: string;
    follow: string;
    swipe: string;
}

export interface CtaConfig {
    /** The Instagram caption's ask, with `{keyword}`. */
    instagramAsk: string;
    /** The TikTok caption's line, e.g. link in bio. */
    tiktokLine: string;
    /** With `{username}` `{question}` `{pitch}` `{url}` `{bullets}`. */
    dmTemplate: string;
    slide: CtaSlideWords;
}

/** Local posting times (`HH:MM`) in an IANA timezone. */
export interface ScheduleConfig { timezone: string; slots: string[] }

/** The folder the worker scans. Null until the tenant sets it. */
export interface LibraryConfig { root: string | null }

export interface StudioSettings {
    brand: BrandKit;
    voice: VoiceProfile;
    product: ProductInfo;
    cta: CtaConfig;
    schedule: ScheduleConfig;
    library: LibraryConfig;
    /** Carousels the tenant approved, as few-shot examples; null = the built-in ones. */
    examples: Carousel[] | null;
}

export interface StudioSettingsRow extends StudioSettings {
    creator_id: string;
    updated_at: Timestamptz;
}

export interface StudioWorkerRow {
    id: string;
    creator_id: string;
    name: string;
    /** SHA-256 hex of the token. The token itself is shown once and never stored. */
    token_hash: string;
    last_seen_at: Timestamptz | null;
    created_at: Timestamptz;
    revoked_at: Timestamptz | null;
}
