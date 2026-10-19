SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue the DM path or a token refresh behind a long query; LOCAL ends with the runner's per-file transaction
-- Migration v50: WhatsApp as a messaging channel (docs/specs/001-whatsapp-agent, data-model.md; phase W1). Idempotent. Safe to re-run.
--
-- Schema only. Nothing in the code reads or writes anything below yet: the webhook, the ingest, the sender and the dashboard arrive in later
-- phases, each behind `ai_agents.whatsapp_mode`, which defaults to 'off'. So applying this migration changes what no existing row does, and a
-- deployment that is behind it (or ahead of it) behaves exactly as before. v50 and not v46: the dashboard UX work has reserved v45-v49, and a gap in
-- the numbering is harmless (v43 is already skipped): the runner orders by version number, not by contiguity.
--
-- Seven blocks:
--
--   1. The two platform CHECKs gain 'whatsapp':
--        conversations.platform          (v26, `conversations_platform_check`)         'instagram', 'facebook'  ->  + 'whatsapp'
--        platform_connections.platform   (v30, `platform_connections_platform_check`)  'tiktok', 'youtube'      ->  + 'whatsapp'
--      Each is dropped by its exact name and re-added, so a re-run replaces the list instead of keeping an older one (the v15 lesson: a statement
--      that matches on the NAME alone cannot tell a new definition from an old one, CLAUDE.md). `link_clicks.ua_class` is NOT touched: WhatsApp has no
--      in-app browser and its link fetcher is already classed 'preview', so a WhatsApp click is attributed through the link's conversation
--      platform (review M1).
--
--   2. platform_connections.settings   JSONB, the owner's choices for a connection: `{ allow_billable: false, free_tier_alert_at: 900 }` for WhatsApp.
--      The facts READ from Meta (waba_id, quality rating, ...) go in the existing `profile` (v44), never here.
--
--   3. ai_agents.whatsapp_mode / whatsapp_test_senders   the WhatsApp counterpart of v39's sales switch. 'off' (the default) stores inbound messages
--      and answers nobody, 'test' answers only the senders in the list, 'everyone' answers all of them (the API refuses it until the go-live gate).
--      The list holds BSUIDs or E.164 digits, as text: they are ids, compared as strings. One agent per tenant: persona, knowledge base and
--      offers are shared with Instagram and Facebook.
--
--   4. conversations.*   who the WhatsApp contact is, and how they arrived. The contact's id (the BSUID) goes in the existing `instagram_user_id`,
--      which cannot collide with a numeric IGSID or PSID, so `unique_creator_user` stays valid. The contact's WhatsApp profile name reuses `profile_name`
--      (v40): there is no `contact_name`.
--        wa_phone                 E.164 digits when Meta sends `wa_id`, else NULL. Never required.
--        wa_username              `contacts[].profile.username` when present.
--        wa_parent_user_id        the parent BSUID, when enabled.
--        entry_source             how the thread began, set on the first inbound only:
--                                 `{ kind: 'link'|'qr'|'ctwa'|'ig_bridge'|'ice_breaker'|'organic', ref?, ad_id?, ctwa_clid?, headline?, at }`.
--        free_window_expires_at   the end of a click-to-WhatsApp free-entry window. The 24 h window itself is `last_inbound_at` (v39).
--
--   5. messages.*   what happened to an outbound message, what it cost, and why an inbound one got no reply:
--        delivery_status    'sent' | 'delivered' | 'read' | 'played' | 'failed', outbound only: the latest status Meta reported. A `read` may
--                           arrive without a `delivered`, so there is no ordering constraint here: the code keeps it monotonic.
--        delivery_error_code / delivery_error   Meta's code (131047, 131026, ...) and its title or details, when a message failed.
--        pricing_category / pricing_type / billable   from the status webhook's `pricing` object.
--        no_reply_reason    inbound only, free text by design: the vocabulary (agent_off, not_test_sender, handed_off, window_closed, opted_out, billable_blocked,
--                           provider_unavailable, unsupported_type, failure) lives in code and grows without a migration. FR-027.
--        media_upload_id    the inbound media saved to our store. ON DELETE SET NULL: removing the upload (retention, erasure) never fails on, or
--                           deletes, the message that referenced it. The upload is PRIVATE: a later phase keeps it away from the public /api/uploads/:id.
--      Every column is nullable with no default, so adding it rewrites no row.
--
--   6. contact_consents   a new, append-only table: one row per grant or withdrawal of consent, with the exact wording, so the current state of a
--      contact is the latest row for (creator, contact, category). `creator_id` cascades with the tenant and `conversation_id` is SET NULL, so
--      neither the retention sweep (src/services/retention.ts) nor the erasure flow (src/services/erasure.ts) can fail on it by deleting a thread: the
--      evidence outlives the thread and is removed by the erasure flow on a deletion request.
--
--   7. channel_usage   a new monthly ledger, one row per bucket, which the free-replies meter and the cost estimate read. Written by an upsert on
--      the composite primary key. `creator_id` cascades with the tenant.
--
-- No existing row changes, and nothing is backfilled: every ADD COLUMN is nullable or has a constant default, which PostgreSQL stores in the
-- catalog without rewriting the table. The CHECKs are the one scan: re-adding the two platform CHECKs reads `conversations` and
-- `platform_connections` once to validate them, and both hold only the values the old CHECKs allowed, so it cannot fail. The lock_timeout above
-- bounds the wait for the lock, not that read; both tables are small.
-- Both new tables are created here, so each enables row level security here (v11's deny-by-default, no policies): a table that waits for a later
-- migration is open until that one is applied. migrations.test.ts fails for one that does not.
--
-- Rollout: `npm run migrate` BEFORE deploying, as for every migration. Everything that reads these columns ships after it.

-- ─── 1. The platform CHECKs ──────────────────────────────────────────────────────────────────

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_platform_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_platform_check
    CHECK (platform IS NULL OR platform IN ('instagram', 'facebook', 'whatsapp'));

ALTER TABLE platform_connections DROP CONSTRAINT IF EXISTS platform_connections_platform_check;
ALTER TABLE platform_connections ADD CONSTRAINT platform_connections_platform_check
    CHECK (platform IN ('tiktok', 'youtube', 'whatsapp'));

-- ─── 2. platform_connections.settings ────────────────────────────────────────────────────────

ALTER TABLE platform_connections ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ─── 3. The WhatsApp agent's switch ──────────────────────────────────────────────────────────

ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS whatsapp_mode TEXT NOT NULL DEFAULT 'off';
ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS whatsapp_test_senders TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_whatsapp_mode_check;
ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_whatsapp_mode_check CHECK (whatsapp_mode IN ('off', 'test', 'everyone'));

-- ─── 4. conversations: the WhatsApp contact ──────────────────────────────────────────────────

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_phone TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_username TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS wa_parent_user_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_source JSONB;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS free_window_expires_at TIMESTAMP WITH TIME ZONE;

-- ─── 5. messages: delivery, pricing, the reason for silence ──────────────────────────────────

ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error_code INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery_error TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pricing_category TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pricing_type TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS billable BOOLEAN;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS no_reply_reason TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_upload_id UUID;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_delivery_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_delivery_status_check
    CHECK (delivery_status IS NULL OR delivery_status IN ('sent', 'delivered', 'read', 'played', 'failed'));

-- The foreign key is added by name, apart from the column, so a column that already exists without it (a hand-made one) still ends up with it:
-- an inline REFERENCES on `ADD COLUMN IF NOT EXISTS` is skipped with the column.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_media_upload_id_fkey;
ALTER TABLE messages ADD CONSTRAINT messages_media_upload_id_fkey
    FOREIGN KEY (media_upload_id) REFERENCES media_uploads(id) ON DELETE SET NULL;

-- The SET NULL above looks messages up by media_upload_id for every upload the retention sweep deletes: without an index that is one scan of
-- `messages` per deleted upload. Partial, because almost every row has no media.
CREATE INDEX IF NOT EXISTS idx_messages_media_upload
    ON messages (media_upload_id) WHERE media_upload_id IS NOT NULL;

-- ─── 6. contact_consents ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS contact_consents (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- The thread it happened in. SET NULL: deleting a conversation (retention, erasure) must not fail on, or delete, the evidence.
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    -- 'whatsapp' | 'instagram' | 'facebook'. Not a CHECK: the list is the writer's, and a consent row must never be refused for its channel.
    platform        TEXT NOT NULL,
    -- The platform's id for the person: a BSUID, an IGSID or a PSID.
    contact_ref     TEXT NOT NULL,
    category        TEXT NOT NULL CHECK (category IN ('service', 'updates', 'marketing')),
    action          TEXT NOT NULL CHECK (action IN ('granted', 'withdrawn')),
    source          TEXT NOT NULL CHECK (source IN ('agent_offer', 'stop_phrase', 'user_preferences', 'owner', 'in_app_signup')),
    -- The exact text the person saw or sent.
    wording         TEXT,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- The current state is the newest row per (creator, contact, category): one index scan, newest first. A new table, so IF NOT EXISTS cannot
-- silently keep an older, weaker index of the same name (v15).
CREATE INDEX IF NOT EXISTS idx_contact_consents_contact
    ON contact_consents (creator_id, contact_ref, category, created_at DESC);

-- ─── 7. channel_usage ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS channel_usage (
    creator_id          UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    -- 'whatsapp'. The phone_number_id the usage was counted on goes in external_account_id.
    platform            TEXT NOT NULL,
    external_account_id TEXT NOT NULL,
    -- 'YYYY-MM', in the messaging account's timezone (platform_connections.profile.timezone).
    period              TEXT NOT NULL,
    -- Meta's pricing category and type (service, utility, marketing, ... / free_customer_service, free_entry_point, regular, ...).
    category            TEXT NOT NULL,
    pricing_type        TEXT NOT NULL,
    -- The recipient's calling-code market: 'EG', 'SA' or 'other'.
    market              TEXT NOT NULL,
    -- Delivered (or read) statuses, counted once per wamid.
    delivered           INTEGER NOT NULL DEFAULT 0,
    -- Of those, the ones Meta marked billable.
    billable            INTEGER NOT NULL DEFAULT 0,
    est_cost_usd        NUMERIC(10, 4) NOT NULL DEFAULT 0,
    PRIMARY KEY (creator_id, platform, external_account_id, period, category, pricing_type, market)
);

-- ─── RLS, deny by default, in the file that creates the tables ───────────────────────────────

ALTER TABLE contact_consents ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_usage    ENABLE ROW LEVEL SECURITY;

-- ─── Comments ────────────────────────────────────────────────────────────────────────────────

COMMENT ON COLUMN platform_connections.settings IS
    'The owner''s choices for this connection, e.g. WhatsApp { allow_billable, free_tier_alert_at }. Facts read from the platform live in profile. v50.';
COMMENT ON COLUMN ai_agents.whatsapp_mode IS
    'The WhatsApp agent: ''off'' (store inbound, answer nobody, the default), ''test'' (only whatsapp_test_senders), ''everyone'' (refused by the API until the go-live gate). v50.';
COMMENT ON COLUMN ai_agents.whatsapp_test_senders IS
    'With whatsapp_mode = test: the BSUIDs or E.164 digits the agent answers on WhatsApp. v50.';
COMMENT ON COLUMN conversations.wa_phone IS
    'WhatsApp: the contact''s phone number in E.164 digits when Meta sends wa_id, else NULL. Never required: the BSUID in instagram_user_id identifies the thread. v50.';
COMMENT ON COLUMN conversations.entry_source IS
    'How the thread began, set on the first inbound only: { kind: link|qr|ctwa|ig_bridge|ice_breaker|organic, ref?, ad_id?, ctwa_clid?, headline?, at }. v50.';
COMMENT ON COLUMN conversations.free_window_expires_at IS
    'WhatsApp: the end of the click-to-WhatsApp free-entry window, or NULL. With last_inbound_at it decides whether a free-form reply may be sent. v50.';
COMMENT ON COLUMN messages.delivery_status IS
    'Outbound WhatsApp: the latest status Meta reported (sent, delivered, read, played, failed). Kept monotonic by the code. v50.';
COMMENT ON COLUMN messages.no_reply_reason IS
    'Inbound WhatsApp: why the agent did not answer (agent_off, not_test_sender, handed_off, window_closed, opted_out, billable_blocked, provider_unavailable, unsupported_type, failure). v50.';
COMMENT ON COLUMN messages.media_upload_id IS
    'Inbound WhatsApp media saved to our store. Private: never served by the public upload route. SET NULL when the upload is deleted. v50.';
COMMENT ON TABLE contact_consents IS
    'Append-only record of consent granted or withdrawn per contact and category, with the exact wording. The current state is the newest row. v50.';
COMMENT ON TABLE channel_usage IS
    'Monthly messaging ledger per tenant, number, pricing bucket and market: delivered, billable and estimated cost. Feeds the free-replies meter. v50.';
