SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the DM path behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v39: the DM sales turn's switch and the state it keeps (docs/DM_SALES_PLAN.md S6). Idempotent. Safe to re-run.
--
-- Three groups of columns, none of which changes what any existing row does:
--
--   ai_agents.sales_mode          'off' | 'test' | 'on'. DEFAULT 'off', so every existing agent (the owner's included) answers exactly as it
--                                 did until somebody flips it in AI settings. `test` answers only the senders in the list below; everyone
--                                 else is answered the old way. `on` answers everyone. Read per DM (src/services/dmSales/mode.ts), and a
--                                 failed read (this migration not applied yet) is 'off'.
--   ai_agents.sales_test_senders  TEXT[]: the platform-scoped sender ids (the IGSID on Instagram) `test` answers. Plain text, as Meta
--                                 sends them: they are ids, and compared as strings.
--
--   conversations.*               what the sales turn knows about one person between messages (src/services/dmSales/store.ts):
--     stage             where the conversation is in the flow (STAGES in dmSales/types.ts). The CODE decides it (`nextStage`); the model only proposes.
--     last_intent       what the person's last message was (INTENTS), for the inbox and the funnel.
--     offer_id          the offer in play: an id from the creator's profile (`offers[].id`), as text. Not a foreign key: offers live in JSONB.
--     offers_linked     the offers whose link this conversation has been sent, and last_link_at when the latest went.
--     qualifier_turns   how many qualifying questions were asked (the flow allows two, then the bot must recommend).
--     abuse_strikes     insults so far: the first gets one calm line, the second pauses the bot.
--     last_inbound_at   when the person last wrote (the 24 h window the follow-up job reads, S9).
--     handoff_at, handoff_reason   when and why a person was asked to take over (S8 builds the notification on them).
--     opted_out_at      when they asked to be left alone. The bot is paused with it, and no follow-up is ever sent after it.
--     followups_sent    nudges sent (S9). source_campaign_id: the comment campaign that began the conversation (S10).
--
--   messages.ai_meta              JSONB on the bot's own rows: { intent, stage, next_action, offer_id, handoff_reason, engine, latency_ms, ... }.
--                                 NULL on every other row, and on every row written before this.
--
-- No existing row changes: each default is a constant, stored in the catalog and not written into the table. Every CHECK is dropped and
-- re-added so a re-run is harmless (`ADD COLUMN IF NOT EXISTS` with an inline CHECK would skip the CHECK on a column that exists). No table
-- is created, so there is nothing new to enable row level security on: the three tables below already have it (v11).
--
-- Rollout: `npm run migrate` BEFORE deploying. The DM path survives a database that is behind: the sales mode is read in its own
-- statement, and a failed read is logged `dm.sales_mode_read_failed` and answered 'off', which is the old path.

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS sales_mode VARCHAR(5) NOT NULL DEFAULT 'off';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS sales_test_senders TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_sales_mode_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_sales_mode_check CHECK (sales_mode IN ('off', 'test', 'on'));

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS stage VARCHAR(12) NOT NULL DEFAULT 'new';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_intent VARCHAR(24);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS offer_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS offers_linked TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_link_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS qualifier_turns SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS abuse_strikes SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS handoff_reason VARCHAR(16);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS opted_out_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followups_sent SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS source_campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_stage_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_stage_check
    CHECK (stage IN ('new', 'qualify', 'recommend', 'objection', 'link', 'follow_up', 'handoff', 'closed'));
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_handoff_reason_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_handoff_reason_check
    CHECK (handoff_reason IS NULL OR handoff_reason IN ('unsure', 'refund', 'complaint', 'wants_human', 'hot_lead', 'abuse'));

ALTER TABLE messages ADD COLUMN IF NOT EXISTS ai_meta JSONB;

COMMENT ON COLUMN ai_agents.sales_mode IS
    'The DM sales turn: ''off'' (the old path, the default), ''test'' (only sales_test_senders), ''on'' (everyone). docs/DM_SALES_PLAN.md S6.';
COMMENT ON COLUMN ai_agents.sales_test_senders IS
    'With sales_mode = test: the sender ids (IGSIDs on Instagram) the sales turn answers. Everyone else gets the old path.';
COMMENT ON COLUMN conversations.stage IS
    'The sales flow''s stage (new, qualify, recommend, objection, link, follow_up, handoff, closed). Decided by the code, not the model.';
COMMENT ON COLUMN messages.ai_meta IS
    'On a sales-turn reply: { intent, stage, next_action, offer_id, handoff_reason, engine, latency_ms, guard }. NULL elsewhere.';
