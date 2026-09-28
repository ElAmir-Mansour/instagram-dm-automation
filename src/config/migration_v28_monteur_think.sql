-- Migration v28: Claude on the Mac for the Monteur's model calls (MONTEUR.md §6.3).
--
-- With `studio_settings.monteur.brain = 'claude_mac'`, the pick, the Marketer, the Editor and the
-- Analyst are not Gemini calls from the app: each is a `monteur_think` job, which the Mac worker
-- answers with the claude CLI on the owner's Claude plan (src/services/monteur/think.ts).
--
--   payload  { request, try, step, purpose, model, system, user, schema, retired? }: `request` is
--            the call's stable id, `try` its attempt (1–4); a Retry of the source sets `retired`
--   result   { output, model, usage }: Claude's structured output, the model that answered, tokens
--
-- The unique index makes queueing a try idempotent (`ON CONFLICT DO NOTHING`), so two drains
-- asking at once cost one call, and it is also the lookup the sweep runs on every drain. Retired
-- tries fall out of it, so a Retry can ask again from try 1.
--
-- Rollout: `npm run migrate` BEFORE deploying. Nothing inserts the kind until a tenant's brain is
-- `claude_mac`, but the setting can be saved as soon as the deploy is live.
--
-- Idempotent.

-- Dropped and re-added so a re-run is harmless: v24's list, plus monteur_think.
ALTER TABLE studio_jobs DROP CONSTRAINT IF EXISTS studio_jobs_kind_check;
ALTER TABLE studio_jobs ADD CONSTRAINT studio_jobs_kind_check CHECK (kind IN (
    'scan_library', 'index_lesson', 'render_carousel',
    'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render',
    'monteur_think'
));

CREATE UNIQUE INDEX IF NOT EXISTS idx_studio_jobs_think_try
    ON studio_jobs ((payload->>'request'), ((payload->>'try')::int))
 WHERE kind = 'monteur_think' AND NOT (payload ? 'retired');
