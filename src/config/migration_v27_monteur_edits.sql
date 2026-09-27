-- Migration v27: the Editor's pro edits on each Monteur reel (MONTEUR.md §6.2).
--
--   clip_drafts.edits   ClipEdit[] (src/services/monteur/editor.ts): `[{ t, kind, text?, emoji?,
--                       prompt?, sfx? }]`, `t` in seconds on the clip's own clock. Written once, by
--                       the pick sweep's Editor call; sent in every `monteur_render` of the clip,
--                       the first and each re-render. `[]` is a reel without edits: a clip cut
--                       before v27, or one whose Editor call failed (a failed call never holds a
--                       reel back).
--
-- NOT NULL DEFAULT '[]': a constant default, so the ADD is a catalogue change and every existing
-- row reads as `[]` with no rewrite.
--
-- Rollout: `npm run migrate` BEFORE deploying. The sweep's clip insert writes the column, and the
-- Monteur page and every clip route select it.
--
-- Idempotent.

ALTER TABLE clip_drafts ADD COLUMN IF NOT EXISTS edits JSONB NOT NULL DEFAULT '[]'::jsonb;
