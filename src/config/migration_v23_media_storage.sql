-- Migration v23: media bytes move out of Postgres, into Supabase Storage.
--
-- `media_uploads.data` held every upload as BYTEA: 267MB of a 281MB database on a 500MB tier.
-- From here a row can name an object in the Storage bucket `media` instead:
--
--   storage_path  `<creator_id>/<id><ext>` inside the bucket. NULL on a legacy row, whose bytes
--                 are still in `data`.
--   size_bytes    the object's length, recorded at upload. It is the Content-Length the route
--                 sends and what the Settings card adds up. New BYTEA rows record it too.
--
-- The URL does not change. Every upload is still served as /api/uploads/<id> from this app's own
-- domain: TikTok only pulls from the URL prefix verified in its portal, and Meta already holds
-- these URLs. The route streams a Storage row's object and serves a legacy row's BYTEA as before.
--
-- A row always has its bytes somewhere: in `data`, in the object `storage_path` names, or in both
-- for the moment between scripts/migrate-media-to-storage.mjs verifying a copy and clearing
-- `data`. The CHECK holds that.
--
-- Deleting a row has to delete its object, and rows are deleted from three places: the media
-- retention sweep, the Studio when a render is replaced, and ON DELETE CASCADE from `creators`.
-- None of them can call Storage from inside their transaction, because a rollback would restore
-- rows whose objects are already gone. So the trigger queues the object's path in
-- `media_object_deletions` in the same transaction as the DELETE. The daily retention sweep then
-- removes queued objects from Storage, and keeps any it could not remove for the next run.
--
-- Rollout: `npm run migrate` BEFORE deploying. The upload route and every media read select the
-- new columns.
--
-- Idempotent.

ALTER TABLE media_uploads ALTER COLUMN data DROP NOT NULL;
ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS size_bytes BIGINT;

-- Dropped and re-added so a re-run is harmless. Checking it scans the heap, not the TOASTed
-- bytes, so it is quick even at this table's size.
ALTER TABLE media_uploads DROP CONSTRAINT IF EXISTS media_uploads_bytes_present;
ALTER TABLE media_uploads ADD CONSTRAINT media_uploads_bytes_present
    CHECK (data IS NOT NULL OR storage_path IS NOT NULL);

COMMENT ON COLUMN media_uploads.storage_path IS
    'Object path in the Supabase Storage bucket "media", <creator_id>/<id><ext>. NULL while the bytes are in data. See migration_v23.';
COMMENT ON COLUMN media_uploads.size_bytes IS
    'Length of the stored bytes, recorded at upload. See migration_v23.';

-- ── Objects waiting to be removed from Storage ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS media_object_deletions (
    storage_path TEXT PRIMARY KEY,
    queued_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    attempts     INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT
);

-- Deny-by-default, like every table since v11. The app connects as the owner, so this shuts out
-- a leaked anon key, not the app.
ALTER TABLE media_object_deletions ENABLE ROW LEVEL SECURITY;

-- search_path pinned to where every table here lives, which also keeps Supabase's security
-- advisor quiet about a mutable search_path.
CREATE OR REPLACE FUNCTION queue_media_object_deletion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = public
AS $$
BEGIN
    INSERT INTO media_object_deletions (storage_path)
    VALUES (OLD.storage_path)
    ON CONFLICT (storage_path) DO NOTHING;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS media_uploads_queue_object_deletion ON media_uploads;
CREATE TRIGGER media_uploads_queue_object_deletion
    AFTER DELETE ON media_uploads
    FOR EACH ROW
    WHEN (OLD.storage_path IS NOT NULL)
    EXECUTE FUNCTION queue_media_object_deletion();
