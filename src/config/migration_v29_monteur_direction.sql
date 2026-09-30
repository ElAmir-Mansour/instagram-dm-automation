-- Migration v29: the Editor's human touches on each Monteur reel (MONTEUR.md §6.2).
--
--   clip_drafts.direction   ClipDirection (src/services/monteur/editor.ts): `{ cuts: [{ t, shot }],
--                           doodles: [{ t, shape, target }], freezes: [{ t, text }], transitions:
--                           [{ t, kind }], behind: [{ t, text }], emphasis: [t] }`, every `t` in
--                           seconds on the clip's own clock. Written once, by the pick sweep's
--                           Editor call, next to `edits`; sent in every `monteur_render` of the clip
--                           while `studio_settings.monteur.human` is on.
--
-- Nullable, no default: NULL is "no plan" — the setting off when the clip was cut, a failed Editor
-- call, or a clip cut before v29 — and such a clip renders exactly as before. The ADD is a
-- catalogue change, with no rewrite.
--
-- Rollout: `npm run migrate` BEFORE deploying. The sweep's clip insert writes the column, and every
-- clip route that re-renders selects it.
--
-- Idempotent.

ALTER TABLE clip_drafts ADD COLUMN IF NOT EXISTS direction JSONB;
