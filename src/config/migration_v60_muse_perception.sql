SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue every inbound DM (the claim INSERT) behind a long query on messages; LOCAL ends with the runner's per-file transaction
-- Migration v60: Meta Muse perception (src/services/perception/). Idempotent. Safe to re-run.
--
-- With the tenant's switches on, a DM with no words (a shared reel, a story mention, a photo, a voice note) is READ by Meta's models instead of getting one
-- fixed line, and the owner's published reels are watched once and remembered, so the agent can answer "do you have a video about X?" with the right one.
--
--   messages.perception   what the agent understood from one inbound message: { v, kind, status, reason, seen, transcript, about_owner, confidence,
--                         mention_summary, recall, model, stored_at, ms, usd } (src/services/perception/types.ts `Perception`). NULL means perception never ran
--                         for the row, which is every row there is today. Written once (`UPDATE ... WHERE id = $1 AND perception IS NULL`) and read back on a
--                         retry, so a retried job never pays for the same media twice. It holds a description or a transcript and NEVER the media. The row's
--                         `text` is overwritten in the same UPDATE with the readable text (the description line, or the bare transcript of a voice note), so
--                         history, later turns and the inbox all read it: that is the application's rule, not this file's.
--   reel_analyses         the video memory: one row per published reel of a tenant, filled in by the indexer, which watches each reel once (what was SEEN and said
--                         in it: summary, topics, on-screen text, key moments with seconds, hook, caption idea). Recall reads it; `permalink` is the only link
--                         recall may send. `ig_media_id` is unique per tenant when it is set (a partial unique index, below), so indexing a reel twice is one row.
--                         `status` is pending (queued), ok, or failed (the reason is in `result.error`, and tomorrow's run may try that reel again).
--
-- Deliberately NOT here: a column for the intent of an unmatched comment (`interactions.intent`) and the table of checked offer cards (`offer_cards`). Both
-- belonged to phases the build cut (comment intent, offer cards), so neither is created: a migration that adds them is written when, and only if, they are built.
-- No setting needs a migration either: the switches, the sender allow-list and the daily cap are `app_settings` rows (`muse.*.<tenant>`), and `ai_usage.purpose`
-- is plain text, so the new usage purposes (perception_dm, perception_voice, recall, reel_index) need no CHECK to widen.
--
-- `reel_analyses` is keyed by the tenant, cascades with it, and has row level security on, deny-by-default like every table (v11). Every query names `creator_id`.
--
-- Rollout: `npm run migrate` BEFORE the merge that reads the column: the DM path will SELECT `perception` and UPDATE it. Merging deploys at once. Until the
-- switches are turned on for a tenant (default off), nothing reads or writes either object.

-- ── What was understood from one inbound message ─────────────────────────────────────────────────────────────────────────────────────

-- Nullable with no default, so Postgres changes the catalog only and rewrites no row of the hot table.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS perception JSONB;

COMMENT ON COLUMN messages.perception IS
    'Meta Muse perception of an inbound message with no words: kind, status, reason, a description or transcript, confidence, model, cost. NULL = perception never ran. Never the media itself. See migration_v60.';

-- ── The video memory ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS reel_analyses (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- Instagram's id of the reel. NULL for a reel known only by its link; unique per tenant when set.
    ig_media_id TEXT,
    -- The only link recall may send for this reel.
    permalink   TEXT,
    -- When a YouTube copy exists, so recall can link it at the second (?t=).
    youtube_url TEXT,
    posted_at   TIMESTAMPTZ,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ok', 'failed')),
    -- { summary, topics[], seen_on_screen[], narration, key_moments[{ second, what }], hook_first_3s, hook_score, caption_ar, cover_second, cover_reason },
    -- or { error } when status is 'failed'. Empty while pending.
    result      JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- The model that watched it, how long that took (ms) and what it cost (USD).
    model       TEXT,
    ms          INT,
    usd         NUMERIC(12, 6),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One analysis per reel per tenant. A new table, so IF NOT EXISTS cannot keep an older, weaker index of the same name (migration v15's lesson).
CREATE UNIQUE INDEX IF NOT EXISTS idx_reel_analyses_creator_media ON reel_analyses (creator_id, ig_media_id) WHERE ig_media_id IS NOT NULL;

-- The library, newest first: what recall reads whole and the dashboard lists.
CREATE INDEX IF NOT EXISTS idx_reel_analyses_creator ON reel_analyses (creator_id, posted_at DESC);

ALTER TABLE reel_analyses ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE reel_analyses IS
    'The video memory: one row per published reel of a tenant, what was seen and said in it, filled in by the indexer. See migration_v60.';
