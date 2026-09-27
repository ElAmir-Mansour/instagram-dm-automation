-- Migration v24: the Monteur. The contract is MONTEUR.md at the repo root.
--
-- The Monteur watches a folder on the creator's machine, finds the moments of each new video most
-- likely to spread, cuts them into reels and writes their captions; the creator approves each reel
-- into the existing scheduler. The Mac worker does everything that needs the video file (list the
-- folder, transcribe with whisper.cpp, render with Remotion) as Studio jobs; this app does the two
-- Gemini calls (the Monteur picks, the Marketer writes) and the weekly Analyst.
--
--   monteur_sources  one row per video file found in the folder, keyed by the worker's content key
--   clip_drafts      one row per reel cut from a source, from `rendering` to `scheduled`
--   studio_lessons   the Analyst's runs: the rules both prompts follow, learnt from past reels
--
-- plus a `monteur` settings section and four more `studio_jobs` kinds.
--
-- `monteur_sources.words` is the whole transcript, `[[t0, t1, "word"], ...]` in seconds. It can be
-- a megabyte for a long video, so no list query selects it, and it never reaches the dashboard.
--
-- NUMERIC columns (`duration`, `start_s`, `end_s`, `score`) arrive through `pg` as strings; every
-- reader casts them with `::float8`.
--
-- Rollout: `npm run migrate` BEFORE deploying. The Studio settings read selects `monteur`, and the
-- delete that every Studio render runs checks `clip_drafts`, so the Studio as a whole needs this.
--
-- Idempotent, like every migration here.

-- ── Settings and job kinds ───────────────────────────────────────────────────────────────
-- A JSONB section like the others, merged over the defaults on read. NULL until first saved.
ALTER TABLE studio_settings ADD COLUMN IF NOT EXISTS monteur JSONB;

-- Dropped and re-added so a re-run is harmless. Every existing row holds one of the old kinds.
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN (
    'scan_library', 'index_lesson', 'render_carousel',
    'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render'
));

-- Every worker poll asks "is today's scan queued?" per tenant and kind, and studio_jobs is never
-- pruned: this keeps that a lookup rather than a scan of the table.
CREATE INDEX IF NOT EXISTS idx_studio_jobs_creator_kind ON studio_jobs (creator_id, kind, created_at DESC);

-- ── Sources ──────────────────────────────────────────────────────────────────────────────
-- `content_key` is the worker's sha1 of the size, the first MiB and the last MiB: the same video
-- renamed or moved is the same source, and a file is never processed twice.
--   transcribing → transcribed → picking → rendering → done, or no_clips, or failed
-- `attempts` and `claimed_at` belong to the pick sweep: a claim older than 10 minutes is claimable
-- again, and the third failed attempt fails the source.
CREATE TABLE IF NOT EXISTS monteur_sources (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id   UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    content_key  TEXT NOT NULL,
    -- Absolute, on the worker's machine. Meaningless to this server except as the worker's handle.
    path         TEXT NOT NULL,
    name         TEXT NOT NULL,
    size_bytes   BIGINT,
    duration     NUMERIC,
    status       TEXT NOT NULL DEFAULT 'transcribing',
    -- [[t0, t1, "word"], ...], seconds with 2 decimals. Never sent to the dashboard.
    words        JSONB,
    -- { model, tokens_in, tokens_out, considered }: what the pick cost and saw, for the record.
    pick         JSONB,
    attempts     INT NOT NULL DEFAULT 0,
    claimed_at   TIMESTAMP WITH TIME ZONE,
    error        TEXT,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT monteur_sources_status_check
        CHECK (status IN ('transcribing', 'transcribed', 'picking', 'rendering', 'done', 'no_clips', 'failed')),
    CONSTRAINT monteur_sources_creator_content_key UNIQUE (creator_id, content_key)
);

CREATE INDEX IF NOT EXISTS idx_monteur_sources_creator ON monteur_sources (creator_id, created_at DESC);
-- The pick sweep's claim, which runs on every drain: only the rows it can take.
CREATE INDEX IF NOT EXISTS idx_monteur_sources_pickable
    ON monteur_sources (updated_at) WHERE status IN ('transcribed', 'picking');

-- ── Clips ────────────────────────────────────────────────────────────────────────────────
--   rendering → review → scheduled, or rejected, or failed; an edit to the burned-in words goes
--   back to rendering.
-- Every JSONB column is one of MONTEUR.md's shapes:
--   copy      ClipCopy: both captions, hashtags, keyword, variants, keyword_create, dm, alt_text
--   render    { video_url, tiktok_video_url, cover_url, duration, job_id, rendered_at } — `job_id` made it
--   schedule  { scheduled_time, meta_row_id, tiktok_row_id, campaign_id, tiktok_privacy }
--   scores    { hook, alone, payoff, send }, each 0–3: the Monteur's sub-scores (MONTEUR.md §6.1)
-- `text` is the clip's own words, for the 90-day dedupe; `topic` is its video's main idea.
-- The media `render` names (both videos and the cover) is kept by the retention sweep while the clip
-- is rendering, in review or scheduled. A rejected or failed clip's media is not.
CREATE TABLE IF NOT EXISTS clip_drafts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    source_id   UUID NOT NULL REFERENCES monteur_sources(id) ON DELETE CASCADE,
    -- 1 = the Monteur's best.
    rank        INT NOT NULL,
    status      TEXT NOT NULL,
    start_s     NUMERIC NOT NULL,
    end_s       NUMERIC NOT NULL,
    -- The on-screen hook, at most 60 characters.
    title       TEXT NOT NULL,
    -- The spoken opening line, from the transcript.
    hook        TEXT NOT NULL,
    why         TEXT,
    score       NUMERIC,
    topic       TEXT,
    -- promise, problem, intent or question: how the spoken start line opens.
    hook_type   TEXT,
    scores      JSONB,
    text        TEXT,
    copy        JSONB NOT NULL,
    render      JSONB,
    schedule    JSONB,
    error       TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT clip_drafts_status_check CHECK (status IN ('rendering', 'review', 'scheduled', 'rejected', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_clip_drafts_creator ON clip_drafts (creator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clip_drafts_source ON clip_drafts (source_id);

-- ── Lessons ──────────────────────────────────────────────────────────────────────────────
-- One row per Analyst run: inserted `running`, then `done` or `failed`. The latest `done` row feeds
-- the Monteur's and the Marketer's prompts.
--   lessons  [{ rule, evidence }], at most 10
--   basis    { posts, from, to, post_ids }: what the lessons were learnt from
CREATE TABLE IF NOT EXISTS studio_lessons (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    lessons     JSONB,
    summary     TEXT,
    basis       JSONB,
    model       TEXT,
    error       TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT studio_lessons_status_check CHECK (status IN ('running', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_studio_lessons_creator ON studio_lessons (creator_id, created_at DESC);

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE monteur_sources  ENABLE ROW LEVEL SECURITY;
ALTER TABLE clip_drafts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_lessons   ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE monteur_sources IS
    'Monteur: one row per video found in the watched folder, keyed by the worker''s content key. See MONTEUR.md.';
COMMENT ON TABLE clip_drafts IS
    'Monteur reels; render.video_url/cover_url name uploads the media retention sweep keeps while the clip is live. See migration_v24_monteur.sql.';
COMMENT ON TABLE studio_lessons IS
    'The Analyst''s runs: rules learnt from past reels, fed to the Monteur and Marketer prompts. See MONTEUR.md §8.';
