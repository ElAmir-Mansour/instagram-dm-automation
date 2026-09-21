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

export interface CampaignRow {
    id: string;
    creator_id: string | null;
    /** Null means the campaign applies to every post. */
    post_id: string | null;
    /** A comma-separated list, matched as substrings after Arabic normalisation. */
    trigger_keyword: string;
    dm_template: string;
    public_reply_template: string | null;
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
    /** UNIQUE where not null — the DM pipeline's idempotency claim. */
    meta_message_id: string | null;
    created_at: Timestamptz;
}

// ─── scheduled posts ────────────────────────────────────────────────────────────────────

export type SchedulePlatform = 'instagram' | 'facebook' | 'both';
export type ScheduleStatus = 'PENDING' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED';

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
    created_at: Timestamptz;
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
