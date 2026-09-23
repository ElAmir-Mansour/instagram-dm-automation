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

export interface ScheduledPostRow {
    id: string;
    creator_id: string | null;
    platform: SchedulePlatform | string;
    /**
     * `video`, not `reel`, for anything cross-posted: `publishFacebookPost` has no `reel`
     * branch and falls through to a text-only feed post with the media silently dropped.
     */
    post_type: string;
    caption: string | null;
    media_url: string | null;
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
    allow_duet?: boolean;
    allow_stitch?: boolean;
    brand_organic?: boolean;
    brand_content?: boolean;
    is_aigc?: boolean;
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
