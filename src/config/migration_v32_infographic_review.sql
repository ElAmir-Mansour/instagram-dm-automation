-- Migration v32: the practitioner review of an infographic (src/services/studio/infographicSpec.ts).
--
-- After a post drew an expert correction ("image resizing happens on demand, not on upload",
-- 2026-10-13), Claude reviews each infographic as a senior engineer would before answering, and
-- returns the 2–3 comments experts are still most likely to post, each with a reply:
--
--   review   { objections: [{ comment, reply }] }, or NULL (written before v32, or none came back)
--
-- Shown on the infographic's card, so the owner has the answers ready when the comments come.
--
-- Rollout: `npm run migrate` BEFORE deploying: the list reads the column. Idempotent.

ALTER TABLE infographics ADD COLUMN IF NOT EXISTS review JSONB;
