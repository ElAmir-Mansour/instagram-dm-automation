SET LOCAL lock_timeout = '5s'; -- the FKs below lock `creators` and `conversations` (the webhook's hot tables): fail in 5 s rather than queue live requests behind a long query. LOCAL ends with the runner's per-file transaction, so nothing sticks to a pooled connection.
-- Migration v38: tracked links, `/r/:code` (docs/DM_SALES_PLAN.md §9, S7). Idempotent. Safe to re-run.
--
-- A DM that recommends a product carries a short link on OUR domain instead of the product's own address. `GET /r/:code` answers 302 to the
-- stored `target_url` exactly as it was stored (a referral or affiliate parameter in it survives), and counts the visit. That is how the funnel learns
-- "link sent" and "clicked" without asking Meta, which reports neither.
--
--   tracked_links   one row per link handed to a person: the code, the tenant, the offer it sells, where it goes, and the conversation
--                   it was sent in. One per (conversation, offer): sending the same offer again in the same conversation reuses the code.
--                   `conversation_id` is NULL for a link made outside a conversation (an operator's test link).
--   link_clicks     one row per visit: when, whether it was a person or a preview/prefetch (HEAD, a link-preview crawler, a speculative
--                   load), and a COARSE device class. Never an IP address, never the user-agent string: `ua_class` is a closed list,
--                   enforced here, so a full user-agent cannot be stored by mistake or by a later edit to the code.
--
-- Nothing reads or writes these tables until the route is called, and nothing calls `createTrackedLink` yet (S6 does, when a sales turn
-- sends a link), so deploying this changes no behaviour. No existing row or table is changed.
--
-- Erasure and retention, both by the schema rather than by remembering to:
--   * `tracked_links.conversation_id` and `tracked_links.creator_id` cascade, and `link_clicks.code` cascades from the link. Deleting a
--     conversation (the erasure tool, src/services/erasure.ts) or a tenant removes its links and every click on them, in the same
--     transaction, whatever deleted the row.
--   * `link_clicks` older than 180 days are pruned by the daily retention sweep (src/services/retention.ts). The links stay as long as
--     their conversation does: a person may tap a link in a DM months later, and it must still go where it went.
--
-- Both tables enable RLS in this same file (migrations.test.ts fails otherwise). The app connects as owner and bypasses RLS; it shuts out a
-- leaked anon key.
--
-- Rollout: `npm run migrate` BEFORE deploying. Until then `GET /r/:code` answers 503 (it cannot read the link), which is correct: no link
-- exists to be broken.

-- ─── 1. tracked_links ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tracked_links (
    -- 10+ characters of base62 from crypto.randomBytes (src/services/links.ts): unguessable, so the table is the only way to find a link.
    code            TEXT PRIMARY KEY CHECK (code ~ '^[0-9A-Za-z]{10,32}$'),
    creator_id      UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    -- The profile's `offers[].id` (at most 40 characters there). Free text: the offer lives in a JSONB profile, not in a table.
    offer_id        TEXT NOT NULL CHECK (char_length(offer_id) BETWEEN 1 AND 100),
    -- Served exactly as stored. http(s) only, and printable ASCII with no spaces: the wire form, so the Location header is the stored value.
    target_url      TEXT NOT NULL CHECK (target_url ~* '^https?://[!-~]+$'),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- One link per (conversation, offer). Partial: a link made outside a conversation has no pair to be unique over. A new table, so IF NOT
-- EXISTS cannot silently keep an older, weaker index of the same name (migration v15).
CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_links_conversation_offer
    ON tracked_links (conversation_id, offer_id) WHERE conversation_id IS NOT NULL;

-- The funnel counts a tenant's links over a period (S12).
CREATE INDEX IF NOT EXISTS idx_tracked_links_creator ON tracked_links (creator_id, created_at DESC);

-- ─── 2. link_clicks ──────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS link_clicks (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL REFERENCES tracked_links(code) ON DELETE CASCADE,
    clicked_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- TRUE: not a person's click. A HEAD request, a link-preview crawler (Meta, WhatsApp), a speculative prefetch, a script. The funnel's
    -- "clicked" counts the rows where this is FALSE.
    is_prefetch BOOLEAN NOT NULL DEFAULT FALSE,
    -- A closed list, and the only trace of the visitor's browser. src/services/links.ts LINK_CLICK_UA_CLASSES holds the same list, and a test
    -- fails when the two differ.
    ua_class    TEXT NOT NULL DEFAULT 'other'
                CHECK (ua_class IN ('instagram', 'facebook', 'ios', 'android', 'desktop', 'preview', 'bot', 'other'))
);

-- Per-link counts, and the cascade from a deleted link (without it every delete would scan the table).
CREATE INDEX IF NOT EXISTS idx_link_clicks_code ON link_clicks (code, clicked_at DESC);
-- The retention sweep: oldest first, a range scan.
CREATE INDEX IF NOT EXISTS idx_link_clicks_clicked_at ON link_clicks (clicked_at);

-- ─── 3. RLS, deny by default, in the file that creates the tables ────────────────────────────

ALTER TABLE tracked_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE link_clicks   ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE tracked_links IS
    'Short links on our own domain (GET /r/:code), one per (conversation, offer). target_url is served exactly as stored. Deleted with its conversation or tenant.';
COMMENT ON TABLE link_clicks IS
    'One row per visit to a tracked link: time, preview-or-person, coarse device class. No IP, no user-agent string. Pruned after 180 days, deleted with its link.';
COMMENT ON COLUMN link_clicks.is_prefetch IS
    'TRUE for HEAD, link-preview crawlers, speculative prefetches and scripts: not a person''s click.';
