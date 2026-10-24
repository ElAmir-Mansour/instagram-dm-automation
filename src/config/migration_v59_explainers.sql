SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the publish sweep behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v59: illustrated explainers (src/services/explainers/). Idempotent. Safe to re-run.
--
-- A narrated video with one still picture per sentence, a recurring cartoon character and a label on each picture, made from a topic in
-- Studio → Explainers: Claude on the owner's Mac researches and writes the script, the Mac voices it, the app draws the pictures through a free image
-- provider, and the Mac renders a 9:16 and a 16:9 video with the chosen sound.
--
--   explainers         one video project: its topic and choices, the draft and the version of its narration, the audio, the rendered files and the
--                      posts it scheduled. `status` is the machine in src/services/explainers/state.ts (writing → draft → voicing → drawing → review →
--                      rendering → ready → scheduled, or failed at one of five steps). `job_id` is the studio job working on it: the result of any
--                      other job is dropped. `draft_version` moves with every writer result and every save of narration, and the audio is out of date
--                      when `audio.version` is another number.
--   explainer_scenes   one sentence each, in order: what is shown and said, its label, its picture brief, its place in the audio, and its pictures (the
--                      chosen one and the last three). `creator_id` repeats the explainer's tenant, so every query can name it.
--   image_allowance    what the image provider's free daily allowance has been used for, per provider and UTC day. Platform-wide, not per tenant: the
--                      provider account is the owner's. Units are estimated, never billed.
--
-- `studio_jobs` gains `not_before`: a pending job is claimable only once it has passed, so a paused drawing can queue its next `explainer_draw` for the
-- hour the allowance resets (jobs.ts CLAIM_SQL). Its default is NOW(), so every job that sets none is claimable at once, as it always was; the rows that
-- exist take the time of this migration, which has passed. `studio_jobs_kind_check` gains the four kinds below. The list is v55's plus them; no
-- migration since v55 widened it.
--
--   explainer_write    the script, written by Claude on the Mac (a Mac-brain job, macBrain.ts), with web research
--   explainer_voice    the narration voiced and timed on the Mac
--   explainer_draw     the Mac's loop around the server's draw-next route
--   explainer_render   the two videos and the cover, rendered on the Mac
--
-- `studio_settings.explainer` holds the look and sound (style, characters, voices, writer, music library). It is NOT one of the sections the Creator
-- Profile owns, so it is read and written as stored.
--
-- Row level security on, deny-by-default like every table (v11). Every table here is keyed by the tenant, except the allowance.
--
-- A scene's length (at least 1 s, which the voice step guarantees) is not a CHECK here: the times come from a worker that rounds floats, and a table
-- that refused 0.999 would refuse the whole voice result and every retry of it.
--
-- Rollout: `npm run migrate` BEFORE deploying: the claim reads `not_before` on every poll, and the settings read selects `explainer`. The feature is
-- dark until the platform admin switches it on for the owner (`explainers.enabled.<tenant>`), and no route exists yet.

CREATE TABLE IF NOT EXISTS explainers (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id         UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    status             TEXT NOT NULL
                       CHECK (status IN ('writing', 'draft', 'voicing', 'drawing', 'review', 'rendering', 'ready', 'scheduled', 'failed')),
    -- The step that failed, while status is 'failed' and only then: what Retry runs again.
    failed_step        TEXT CHECK (failed_step IN ('write', 'voice', 'draw', 'render', 'schedule')),
    -- The reason of the last failure or pause, in words the owner reads.
    error              TEXT,
    topic              TEXT NOT NULL,
    language           TEXT NOT NULL DEFAULT 'ar' CHECK (language IN ('ar', 'en')),
    -- short is 60-90 s, medium 3-5 min, long 10-15 min.
    length_tier        TEXT NOT NULL CHECK (length_tier IN ('short', 'medium', 'long')),
    sound_mode         TEXT NOT NULL CHECK (sound_mode IN ('music', 'sfx')),
    -- A track's key in studio_settings.explainer.music. Needed before a render when sound_mode is 'music'.
    music_track_id     TEXT,
    subtitles          BOOLEAN NOT NULL DEFAULT TRUE,
    notes              TEXT,
    -- [{ url }], at most ten, http or https.
    source_links       JSONB NOT NULL DEFAULT '[]'::jsonb,
    title              TEXT,
    -- { writer, captions, first_comment, replies, sources, est_seconds, warnings }
    draft              JSONB,
    draft_version      INT NOT NULL DEFAULT 0,
    rewrite_note       TEXT,
    -- { url, media_id, duration, voice, version, words_version, fallback }
    audio              JSONB,
    -- { "<scene position>": [[start, end, word], …] }, for the subtitles.
    words              JSONB,
    -- { vertical_url, horizontal_url, cover_url, duration, sound_mode, version, job_id }
    render             JSONB,
    -- { scheduled_time, group_id, row_ids }
    schedule           JSONB,
    -- The studio job working on it now. No foreign key: a swept job must not block, or be blocked by, the explainer.
    job_id             UUID,
    -- Set while drawing waits for the image provider's allowance to reset.
    draw_paused_until  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- A failure names its step, and only a failure does: without one Retry would not know where to go. (Not named explainers_failed_step_check:
    -- Postgres gives that name to the column's own CHECK above.)
    CONSTRAINT explainers_failure_names_step_check CHECK ((status = 'failed') = (failed_step IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_explainers_creator ON explainers (creator_id, created_at DESC);

ALTER TABLE explainers ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE explainers IS
    'Illustrated explainers: one narrated video project per row. The status machine is src/services/explainers/state.ts. See migration_v59.';

CREATE TABLE IF NOT EXISTS explainer_scenes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    explainer_id   UUID NOT NULL REFERENCES explainers(id) ON DELETE CASCADE,
    -- The explainer's tenant, so every query can name it.
    creator_id     UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- 0-based, renumbered when the owner saves the list.
    position       INT NOT NULL,
    narration      TEXT NOT NULL,
    spoken         TEXT NOT NULL,
    -- At most 4 words or a number; empty for no label.
    label          TEXT NOT NULL DEFAULT '',
    -- The picture brief for the image model, in English.
    brief          TEXT NOT NULL,
    -- Keys of studio_settings.explainer.characters.
    characters     TEXT[] NOT NULL DEFAULT '{}',
    -- Keeps the previous scene's picture.
    continues      BOOLEAN NOT NULL DEFAULT FALSE,
    -- Seconds into the audio, both set by the voice step or both null.
    start_s        NUMERIC,
    end_s          NUMERIC,
    -- { media_id, url, seed, provider, model, prompt_hash, at }
    picture        JSONB,
    -- The last three pictures, newest first.
    pictures       JSONB NOT NULL DEFAULT '[]'::jsonb,
    draw_status    TEXT NOT NULL DEFAULT 'pending' CHECK (draw_status IN ('pending', 'drawing', 'done', 'failed', 'skipped')),
    draw_error     TEXT,
    draw_note      TEXT,
    draw_attempts  INT NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT explainer_scenes_times_check
        CHECK ((start_s IS NULL AND end_s IS NULL) OR (start_s IS NOT NULL AND end_s IS NOT NULL AND start_s >= 0 AND end_s > start_s))
);

-- A new table, so IF NOT EXISTS cannot keep an older, weaker index of the same name (migration v15's lesson).
CREATE INDEX IF NOT EXISTS idx_explainer_scenes_explainer ON explainer_scenes (explainer_id, position);

ALTER TABLE explainer_scenes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE explainer_scenes IS
    'One sentence of an explainer: narration, label, picture brief, times in the audio and its pictures. See migration_v59.';

CREATE TABLE IF NOT EXISTS image_allowance (
    provider      TEXT NOT NULL,
    -- The UTC day.
    day           DATE NOT NULL,
    -- Estimated units used, never billed (about 110 a picture with one reference).
    units         NUMERIC NOT NULL DEFAULT 0,
    pictures      INT NOT NULL DEFAULT 0,
    -- When the provider said the free allocation was used up.
    exhausted_at  TIMESTAMPTZ,
    PRIMARY KEY (provider, day)
);

ALTER TABLE image_allowance ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE image_allowance IS
    'What the image provider''s free daily allowance has been used for, per provider and UTC day. Platform-wide. Rows older than 90 days are swept. See migration_v59.';

-- ── The Mac's queue ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_jobs ADD COLUMN IF NOT EXISTS not_before TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Dropped and re-added so a re-run is harmless: v55's list, plus the four explainer kinds.
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN (
    'scan_library', 'index_lesson', 'render_carousel',
    'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render',
    'monteur_think',
    'render_infographic',
    'ads_think',
    'explainer_write', 'explainer_voice', 'explainer_draw', 'explainer_render'
));

-- ── The look and sound ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

ALTER TABLE studio_settings ADD COLUMN IF NOT EXISTS explainer JSONB NOT NULL DEFAULT '{}';
