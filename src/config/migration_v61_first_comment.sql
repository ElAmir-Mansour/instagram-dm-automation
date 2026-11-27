SET LOCAL lock_timeout = '5s'; -- fail in 5 s rather than queue every publish sweep behind a long query on scheduled_posts; LOCAL ends with the runner's per-file transaction
-- Migration v61: the automatic first comment on a published post (src/services/firstComment.ts). Idempotent. Safe to re-run.
--
-- A post can carry a first comment (the numbered sources of an explainer, a link, the keyword prompt). Once the Meta row has really gone live, a
-- `post.first_comment` job posts it under the post on Instagram and on Facebook.
--
--   scheduled_posts.first_comment         the text to post, or NULL for none (every row there is today). At most 2,200 characters, Instagram's limit for a comment;
--                                         the application checks it first and answers 400, the CHECK is the net under it. A row that is not Instagram or Facebook never
--                                         carries one (the routes refuse it): TikTok has no such call here and YouTube's stored token has no comment scope.
--   scheduled_posts.first_comment_status  where each platform's comment stands: { instagram?: { status, id?, error?, at, attempt }, facebook?: { ... } }, status being
--                                         pending (queued, or waiting for the post to go live), sending (the call is in flight), posted (`id` is the comment's id) or failed
--                                         (`error` says why). NULL = nothing was ever queued for the row. Its own column, NOT `platform_options`, which is TikTok's
--                                         (v19, v22): a Meta row moved to tiktok by an edit must not hand TikTok a status object.
--
-- A failed comment never changes `scheduled_posts.status`: the post is already public. Nothing back-fills: a row that is already PUBLISHED, or already
-- queued, has first_comment NULL and nothing ever posts for it.
--
-- Rollout: `npm run migrate` BEFORE the merge: the Posts list is `SELECT *` and the publisher reads `first_comment` off the claimed row. Merging deploys at once.

-- Nullable with no default, so Postgres changes the catalog only and rewrites no row of the table the publish sweep scans every minute.
ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS first_comment TEXT
    CONSTRAINT scheduled_posts_first_comment_len CHECK (first_comment IS NULL OR char_length(first_comment) <= 2200);

ALTER TABLE scheduled_posts ADD COLUMN IF NOT EXISTS first_comment_status JSONB;

COMMENT ON COLUMN scheduled_posts.first_comment IS
    'The first comment to post under the post once it is live (Instagram and Facebook), max 2200 characters. NULL = none. See migration_v61.';
COMMENT ON COLUMN scheduled_posts.first_comment_status IS
    'Per platform: { instagram?: { status: pending|sending|posted|failed, id?, error?, at, attempt }, facebook?: {...} }. Never changes scheduled_posts.status. See migration_v61.';
