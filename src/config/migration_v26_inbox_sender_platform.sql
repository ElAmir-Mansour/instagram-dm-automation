-- Migration v26: which network a conversation is on, and who wrote each message.
--
-- Two facts the inbox could not show (docs/UX_AUDIT_2026-09-27.md I8 and I4):
--
--   conversations.platform  'instagram' | 'facebook'. Written by the DM pipeline from the webhook
--                           body's `object` ('instagram' / 'page'); for a job queued before this
--                           shipped, from which of the tenant's two page ids the event was
--                           addressed to (src/webhook/messaging.ts, `dmPlatform`). A thread keeps
--                           the first platform it was given: the upsert COALESCEs.
--   messages.sender         'customer' (every inbound row), 'ai' (a Gemini reply), 'operator' (a
--                           manual reply from the inbox), 'automation' (reserved for campaign DMs
--                           and their public fallbacks, none of which are stored in `messages`
--                           today). NULL means "written before v26", and the inbox shows no tag.
--
-- Backfilled only where the answer is exact:
--   - an inbound row is by definition the customer's, so it gets 'customer';
--   - an outbound row cannot be told apart: an AI text reply and an operator's reply store the
--     same `{ "text": ... }` payload, so those stay NULL;
--   - a conversation gets a platform when its stored inbound events (`raw_payload`, until the
--     retention sweep clears it) were addressed to exactly one of its tenant's page ids and never
--     the other. Anything else stays NULL, and the next inbound DM on that thread fills it.
--
-- Rollout: `npm run migrate` BEFORE deploying. The DM pipeline and the inbox's manual reply write
-- both columns on every message; the reads (GET /api/conversations and its messages) tolerate the
-- columns being absent and answer NULL.
--
-- Idempotent.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS platform VARCHAR(20);
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_platform_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_platform_check
    CHECK (platform IS NULL OR platform IN ('instagram', 'facebook'));

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender VARCHAR(20);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_sender_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_check
    CHECK (sender IS NULL OR sender IN ('customer', 'ai', 'operator', 'automation'));

UPDATE messages SET sender = 'customer' WHERE direction = 'inbound' AND sender IS NULL;

UPDATE conversations c
   SET platform = CASE WHEN x.to_facebook > 0 THEN 'facebook' ELSE 'instagram' END
  FROM (
        SELECT m.conversation_id,
               COUNT(*) FILTER (WHERE m.raw_payload #>> '{recipient,id}' = cr.facebook_page_id)  AS to_facebook,
               COUNT(*) FILTER (WHERE m.raw_payload #>> '{recipient,id}' = cr.instagram_page_id) AS to_instagram
          FROM messages m
          JOIN conversations cv ON cv.id = m.conversation_id
          JOIN creators cr ON cr.id = cv.creator_id
         WHERE m.direction = 'inbound'
           AND m.raw_payload IS NOT NULL
         GROUP BY m.conversation_id
       ) x
 WHERE c.id = x.conversation_id
   AND c.platform IS NULL
   AND (x.to_facebook > 0) <> (x.to_instagram > 0);
