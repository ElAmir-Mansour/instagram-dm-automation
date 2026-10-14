-- Migration v36: prompt-cache tokens on ai_usage (docs/DM_SALES_PLAN.md S2). Idempotent. Safe to re-run.
--
-- Anthropic's prompt cache splits a prompt in three: the uncached remainder (`input_tokens`, which is what ai_usage.input_tokens has always
-- held), the tokens written to the cache (`cache_creation_input_tokens`, 1.25x the input price) and the tokens read from it
-- (`cache_read_input_tokens`, a tenth of the input price, a twentieth on Opus 5.5 and Sonnet 5.5). They are priced apart, so they are kept
-- apart: a total in input_tokens could not say whether the cache is working, and "two calls a minute apart show cache_read_tokens > 0" is
-- how the owner checks that it is.
--
--   ai_usage.cache_read_tokens, cache_write_tokens    INT NOT NULL DEFAULT 0, beside input_tokens and output_tokens
--
-- No existing row changes: a constant default is stored in the catalog, not written into the table, so adding the columns rewrites nothing,
-- and every call made before this (none asked for a cache) reads as zero cached tokens, which is true. `usd` already holds each row's price
-- (the cached rates included, from the call after this), so the budgets that sum it need no change.
--
-- Rollout: `npm run migrate` BEFORE deploying. `settleCall` writes both columns on every call it settles.

-- Locks `ai_usage` for the ADDs: fail in 5 s rather than queue a budget check (every AI call reserves a row first) behind a long query.
-- LOCAL ends with the runner's per-file transaction, so nothing sticks to a pooled connection.
SET LOCAL lock_timeout = '5s';

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_read_tokens INT NOT NULL DEFAULT 0;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS cache_write_tokens INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN ai_usage.input_tokens IS
    'Input billed at the full price. For Anthropic that is usage.input_tokens, the uncached remainder only, and cached input is in cache_read_tokens and cache_write_tokens.';
COMMENT ON COLUMN ai_usage.cache_read_tokens IS
    'Input served from the provider''s prompt cache (Anthropic cache_read_input_tokens), priced at a fraction of the input price. 0 when the call did not ask for caching.';
COMMENT ON COLUMN ai_usage.cache_write_tokens IS
    'Input written to the provider''s prompt cache (Anthropic cache_creation_input_tokens), priced at 1.25x the input price. 0 when the call did not ask for caching.';
