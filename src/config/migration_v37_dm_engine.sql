SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the DM path behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v37: the DM engine switch (docs/DM_SALES_PLAN.md S3). Idempotent. Safe to re-run.
--
-- Two columns on `ai_agents`, both defaulting to what the bot has always done, so every existing row (the owner's included) reads as
-- "Gemini, today's call" until somebody flips it in AI settings:
--
--   ai_agents.engine           'gemini' | 'providers'   who writes the DM reply. `gemini` is `generateAiResponse`, untouched. `providers`
--                                                       goes through the AI providers layer with purpose `dm` (src/services/dmEngine.ts).
--   ai_agents.gemini_fallback  BOOLEAN                  when `providers` fails (no key, no route, a provider outage, a timeout, a spent
--                                                       budget), answer once with Gemini (true, the default) or send nothing and leave the
--                                                       message for a human (false). Read only when engine = 'providers'.
--
-- No existing row changes: a constant default is stored in the catalog, not written into the table. `ai_agents` is one row per tenant, so the
-- CHECK below scans a handful of rows. The constraint is dropped and re-added so a re-run is harmless (`ADD COLUMN IF NOT EXISTS` with an
-- inline CHECK would skip the CHECK on a column that exists).
--
-- Rollout: `npm run migrate` BEFORE deploying. The AI settings route writes both columns when the dashboard sends them. The DM path itself
-- survives a database that is behind: a failed read of the engine is logged `dm.engine_read_failed` and answered with Gemini.

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS engine VARCHAR(10) NOT NULL DEFAULT 'gemini';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS gemini_fallback BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_engine_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_engine_check CHECK (engine IN ('gemini', 'providers'));

COMMENT ON COLUMN ai_agents.engine IS
    'Who writes the DM reply: ''gemini'' (generateAiResponse, the original call) or ''providers'' (the AI providers layer, purpose dm). Default gemini.';
COMMENT ON COLUMN ai_agents.gemini_fallback IS
    'With engine = providers: when the layer fails, answer once with Gemini (true) or send nothing (false). Ignored when engine = gemini.';
