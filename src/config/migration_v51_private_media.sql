SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the upload route or the DM path behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v51: customer media is private (docs/specs/001-whatsapp-agent, phase W6, tasks T016; analysis review H4). Idempotent. Safe to re-run.
--
-- `media_uploads` is served PUBLICLY by its uuid: `GET /api/uploads/:id` is unauthenticated on purpose, because Meta and TikTok fetch post media
-- from it themselves, and the Storage bucket `media` is a public bucket. That is right for a post's image and wrong for what a customer sends
-- on WhatsApp (a voice note, a receipt, a screenshot of an error): a private person's file must not be one guessable-looking URL away from
-- anyone who holds the id.
--
--   is_private   TRUE for a customer's file. Every public read in src/services/storage.ts (`open`, `get`, `mimeTypes`) answers "no such
--                upload" for such a row, so `/api/uploads/:id` answers 404 for it exactly as for an id that does not exist. Only an explicit,
--                tenant-scoped read (`privateFor`) reaches it: the authenticated inbox route and the transcription. The erasure flow
--                (src/services/erasure.ts) deletes a contact's private uploads, and the v23 trigger queues each one's Storage object for removal.
--                Every existing row, and every upload the dashboard makes, stays FALSE: nothing that is served today stops being served.
--
-- A constant DEFAULT on `ADD COLUMN` is stored in the catalog, not written into every row (PostgreSQL 11+), so this rewrites nothing and holds its
-- lock for an instant, even on the largest table in the database. The lock_timeout above bounds the wait for that lock.
--
-- Nothing in the application depends on this being applied first for the PUBLIC route: storage.ts reads the column and, on `undefined_column`,
-- reads without it (no private row can exist before this migration), so a deployment ahead of the database serves every upload exactly as before.
-- WRITING a private upload needs the column and fails loudly without it. Rollout as for every migration: `npm run migrate` BEFORE deploying.

ALTER TABLE media_uploads ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN media_uploads.is_private IS
    'TRUE for a customer''s file (WhatsApp inbound media): never served by the public /api/uploads/:id, deleted with the contact. See migration_v51.';
