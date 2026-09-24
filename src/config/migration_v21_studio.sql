-- Migration v21: Carousel Studio. The contract is STUDIO.md at the repo root.
--
-- The course library, what is on screen in each lesson, the carousel drafts written from
-- them, each tenant's Studio settings, its workers, and the queue those workers drain. The worker only ever calls OUT to the app,
-- so nothing on the Mac is exposed to the internet: it polls `studio_jobs`, does the work that
-- needs the video files (scan, index with Gemini, render with Remotion) and posts results back.
--
-- `studio_jobs` is its own table rather than more kinds in `jobs` (v13), because the two
-- queues have nothing in common but the word. `jobs` is drained by this app, inline and by
-- the drain schedule, retries with backoff, and its rows are Meta events. A studio job is
-- claimed by a machine that may be off for a week, is kept alive by a heartbeat, and must
-- never be picked up by `/api/jobs/drain` — which has no handler for it and would quarantine
-- every one.
--
-- NUMERIC columns (`duration_s`, `t`) arrive through `pg` as strings; every reader casts them
-- with `::float8`.
--
-- Idempotent, like every migration here.

-- ── The course library ──────────────────────────────────────────────────────────────────
-- One row per video file. Upserted by `video_path` from a `scan_library` result and never
-- deleted by a scan: a file renamed on the Mac becomes a second row rather than taking the
-- first one's notes and moments with it.
CREATE TABLE IF NOT EXISTS course_lessons (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id     UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- "1.2", "8.3"; "I.1" for intro videos, "G.1" for the Gemini apps.
    lesson_no      TEXT NOT NULL,
    -- 1..9; NULL for intro and extras.
    section_no     INT,
    -- The folder name, e.g. "Chapter 8 - Local RAG lmstudio".
    section_title  TEXT,
    title          TEXT NOT NULL,
    -- Absolute, on the Mac. Meaningless to this server except as the worker's handle.
    video_path     TEXT NOT NULL,
    duration_s     NUMERIC,
    status         TEXT NOT NULL DEFAULT 'new',
    -- LessonNotes (STUDIO.md §3).
    notes          JSONB,
    indexed_at     TIMESTAMP WITH TIME ZONE,
    error          TEXT,
    created_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at     TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT course_lessons_status_check CHECK (status IN ('new', 'indexing', 'indexed', 'failed')),
    CONSTRAINT course_lessons_creator_video_path_key UNIQUE (creator_id, video_path)
);

-- What is on screen, and when. Replaced wholesale by each `index_lesson` result.
CREATE TABLE IF NOT EXISTS lesson_moments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lesson_id    UUID NOT NULL REFERENCES course_lessons(id) ON DELETE CASCADE,
    -- Seconds into the video.
    t            NUMERIC NOT NULL,
    description  TEXT NOT NULL,
    kind         TEXT NOT NULL,
    -- No annotation arrows or scribbles, nothing loading or blank: fit to be a slide's shot.
    clean        BOOLEAN NOT NULL DEFAULT TRUE,
    -- /api/uploads/<id>, a 480px JPEG. The media retention sweep keeps what this names.
    thumb_url    TEXT,
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT lesson_moments_kind_check CHECK (kind IN ('slide', 'ui', 'result', 'code', 'prompt', 'other'))
);

CREATE INDEX IF NOT EXISTS idx_lesson_moments_lesson ON lesson_moments (lesson_id);

-- ── Drafts ──────────────────────────────────────────────────────────────────────────────
-- A carousel from input to schedule. Every JSONB column is one of STUDIO.md's shapes:
--   input     DraftInput
--   carousel  Carousel (src/services/studio/carouselTypes.ts)
--   shots     { [name]: ShotSpec } — a slide's `shot.name` is a key in here
--   campaign  { keyword, variants, dm, create }
--   render    { ig, tt, rendered_at, job_id } — `job_id` is the render that produced it
--   schedule  { scheduled_time, meta_row_id, tiktok, tiktok_row_id, tiktok_public_done }
-- `render.ig` / `render.tt` name uploads the media retention sweep must keep.
CREATE TABLE IF NOT EXISTS carousel_drafts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    input       JSONB NOT NULL,
    carousel    JSONB,
    shots       JSONB,
    campaign    JSONB,
    render      JSONB,
    schedule    JSONB,
    error       TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT carousel_drafts_status_check
        CHECK (status IN ('generating', 'rendering', 'ready', 'scheduled', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_carousel_drafts_creator
    ON carousel_drafts (creator_id, created_at DESC);

-- ── The worker's queue ──────────────────────────────────────────────────────────────────
-- Claimed with FOR UPDATE SKIP LOCKED (no window function here, unlike `jobs`, so Postgres
-- allows it). A `claimed` row whose heartbeat is older than 15 minutes is claimable again,
-- and one that has been claimed three times is failed instead.
CREATE TABLE IF NOT EXISTS studio_jobs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id    UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL,
    payload       JSONB NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    progress      TEXT,
    claimed_at    TIMESTAMP WITH TIME ZONE,
    heartbeat_at  TIMESTAMP WITH TIME ZONE,
    attempts      INT NOT NULL DEFAULT 0,
    result        JSONB,
    error         TEXT,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT studio_jobs_kind_check CHECK (kind IN ('scan_library', 'index_lesson', 'render_carousel')),
    CONSTRAINT studio_jobs_status_check CHECK (status IN ('pending', 'claimed', 'done', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_studio_jobs_status ON studio_jobs (status, created_at);

-- ── Per-tenant settings (STUDIO.md §10) ─────────────────────────────────────────────────
-- The Studio is a feature for any tenant, so nothing about one creator (brand, voice, product,
-- links, posting times, folder) is in code or prompts. A tenant with no row gets the neutral
-- `defaultStudioSettings()`; each column is one section of `StudioSettings` and is merged over
-- those defaults on read, so a field added later needs no backfill.
CREATE TABLE IF NOT EXISTS studio_settings (
    creator_id  UUID PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
    brand       JSONB NOT NULL,
    voice       JSONB NOT NULL,
    product     JSONB NOT NULL,
    cta         JSONB NOT NULL,
    schedule    JSONB NOT NULL,
    library     JSONB NOT NULL,
    -- Carousel[] the tenant approved, used as few-shot examples. NULL = the built-in ones.
    examples    JSONB,
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ── Workers ─────────────────────────────────────────────────────────────────────────────
-- A worker's bearer token resolves its tenant: claims, uploads and results are all scoped to
-- it. Only the SHA-256 of the token is stored; the token is shown once, when it is created.
-- A tenant may have several (a Mac today, a hosted renderer later). Revoking sets
-- `revoked_at` rather than deleting, so the row still says who it was and when it last called.
CREATE TABLE IF NOT EXISTS studio_workers (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id    UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    token_hash    TEXT NOT NULL,
    last_seen_at  TIMESTAMP WITH TIME ZONE,
    created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    revoked_at    TIMESTAMP WITH TIME ZONE,
    CONSTRAINT studio_workers_token_hash_key UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_studio_workers_creator ON studio_workers (creator_id, created_at DESC);

-- Deny-by-default, like every other table since v11. The app connects as owner and bypasses it.
ALTER TABLE course_lessons   ENABLE ROW LEVEL SECURITY;
ALTER TABLE lesson_moments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE carousel_drafts  ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_jobs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_settings  ENABLE ROW LEVEL SECURITY;
ALTER TABLE studio_workers   ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE studio_jobs IS
    'Carousel Studio work for the Mac worker (scan, index, render). Not drained by /api/jobs/drain. See STUDIO.md.';
COMMENT ON TABLE carousel_drafts IS
    'Carousel Studio drafts; render.ig/tt name uploads the media retention sweep keeps. See migration_v21_studio.sql.';
