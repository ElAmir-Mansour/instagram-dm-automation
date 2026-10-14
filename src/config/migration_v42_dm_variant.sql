SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the DM path behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v42: the A/B arm a DM conversation was given (docs/DM_SALES_PLAN.md S14). Idempotent. Safe to re-run.
--
--   conversations.sales_variant   'A' | 'B' | 'C' (VARIANT_IDS in src/services/dmSales/variants.ts): the wording arm of the owner's experiment this
--                                 conversation was assigned, for good. NULL on every conversation written before this, on every conversation of a
--                                 tenant that never ran an experiment, and on a conversation that was already under way when one started.
--                                 It is set by the sales turn, in the SAME statement that records the turn's reply, and only while it is NULL
--                                 (`COALESCE(sales_variant, ...)`): a later turn can never move it. The arm's texts and the experiment's weights are the
--                                 tenant's `app_settings` row `dm.variants.<creator id>`, so editing them needs no migration.
--
-- A slot id and not a name, so an arm renamed in the editor is still the same arm in the funnel. Plain text with no CHECK: the code owns the three
-- slots, and a later fourth would not need another ALTER.
--
-- No existing row changes: a nullable column with no default is catalog-only, so adding it rewrites nothing. No table is created, and `conversations`
-- has row level security since v11. No index: the funnel reads a tenant's conversations by `creator_id` as it does today.
--
-- Rollout: `npm run migrate` BEFORE deploying, as for every migration. The DM path survives a database that is behind: a tenant with no experiment
-- never touches the column (its statements are exactly the ones they were), and one WITH an experiment reads it in a statement of its own, logs
-- `dm.variant_unavailable`, and answers with the prompt it always had. The funnel's comparison reads it the same way and shows nothing instead of failing.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS sales_variant VARCHAR(8);

COMMENT ON COLUMN conversations.sales_variant IS
    'The A/B wording arm (A, B or C) this conversation was assigned by the sales turn, once and for good. NULL: never assigned. docs/DM_SALES_PLAN.md S14.';
