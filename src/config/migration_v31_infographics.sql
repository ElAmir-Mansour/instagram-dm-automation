-- Migration v31: animated infographics in the Studio (src/services/studio/infographics.ts).
--
-- An infographic is a comparison ("RAG vs CAG vs KAG") drawn as an animated 4:5 page in the
-- tenant's personal brand. From a topic, one `render_infographic` job on the Mac worker has Claude
-- write it (the spec and a caption, on the owner's Claude plan) and renders it three ways: an MP4
-- (Instagram, Facebook, YouTube), a GIF (LinkedIn, X, anywhere) and a cover. A spec edited in the
-- dashboard, or a second theme, is a render job with the spec already in it.
--
--   status   writing → ready, or rendering → ready (an edit or a theme), failed, scheduled
--   render   { job_id, mp4_url, gif_url, cover_url, gif_width, gif_fps, model }
--   schedule { scheduled_time, group_id, row_ids }
--   job_id   the latest render job: an older job's result is dropped, not applied
--
-- `studio_settings.infographic` holds the brand the page is drawn in (name, site, handles,
-- colours, portrait) and where Schedule posts it.
--
-- Rollout: `npm run migrate` BEFORE deploying. Idempotent.

ALTER TABLE studio_settings ADD COLUMN IF NOT EXISTS infographic JSONB;

CREATE TABLE IF NOT EXISTS infographics (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id  UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    topic       TEXT NOT NULL,
    notes       TEXT,
    language    TEXT NOT NULL,
    theme       TEXT NOT NULL DEFAULT 'dark',
    status      TEXT NOT NULL,
    spec        JSONB,
    caption     TEXT,
    render      JSONB,
    schedule    JSONB,
    job_id      UUID,
    error       TEXT,
    created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT infographics_status_check CHECK (status IN ('writing', 'rendering', 'ready', 'failed', 'scheduled')),
    CONSTRAINT infographics_language_check CHECK (language IN ('ar', 'en')),
    CONSTRAINT infographics_theme_check CHECK (theme IN ('dark', 'light'))
);

CREATE INDEX IF NOT EXISTS idx_infographics_creator ON infographics (creator_id, created_at DESC);

ALTER TABLE infographics ENABLE ROW LEVEL SECURITY;

-- Dropped and re-added so a re-run is harmless: v28's list, plus render_infographic.
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN (
    'scan_library', 'index_lesson', 'render_carousel',
    'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render',
    'monteur_think',
    'render_infographic'
));
