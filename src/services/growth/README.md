# Growth & SEO hub: server side

The contract is `GROWTH.md` at the repo root. This file records two things:
- §1: what the platforms' own docs say, checked on 2026-09-25;
- §2: what production actually answered on Graph API v26.0 the same day.

Where they disagree, §2 wins. **One invalid metric in a request fails the whole call** with (#100) "The value must be a valid insights metric", so a wrong name costs every metric beside it, not just itself.

The app calls `graph.facebook.com` with a Page token ("Instagram API with Facebook Login"), at `API_VERSION` (`v26.0` by default, `src/services/instagram.ts`). The Instagram reference pages render as v25.0, the newest version they document. The Facebook Page insights reference renders as v26.0.

## 1. API facts from the docs, with sources

### Instagram media insights: `GET /{ig-media-id}/insights?metric=…`

Source: https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights

- **FEED** (image, carousel album): `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions`, `follows`, `profile_visits`, `reposts`.
- **REELS**: `views`, `reach`, `likes`, `comments`, `saved`, `shares`, `total_interactions`, `ig_reels_avg_watch_time`, `ig_reels_video_view_total_time`, `reposts`, `reels_skip_rate`, `crossposted_views`, `facebook_views`.
- There are no insights for the children inside a carousel album. Data can be up to 48 hours late. An unavailable value is an empty dataset, not `0`.
- Deprecated, per the changelog (https://developers.facebook.com/docs/instagram-platform/changelog):
  - `impressions`, `plays`, `clips_replays_count`, `ig_reels_aggregated_all_plays_count`: from v22.0 (2025-01-21), and in every version from 2025-04-21. `views` replaces them.
  - `video_views`: from v21.0, and everywhere from 2025-01-08.
- **Permissions (Facebook Login):** `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement`.

### Instagram account insights: `GET /{ig-user-id}/insights`

Source: https://developers.facebook.com/docs/instagram-platform/api-reference/instagram-user/insights/

- Every interaction metric is `period=day`, `metric_type=total_value`. `reach` also takes `time_series`.
- **Breakdowns:**
  - `follow_type` on `reach`, `follows_and_unfollows`;
  - `follower_type` on `views`;
  - `media_product_type` on most metrics;
  - `contact_button_type` on `profile_links_taps`.
- **Under 100 followers:** `follower_count`, `online_followers` and `follows_and_unfollows` are not available. `follower_count` returns at most 30 days (changelog, 2020-11-10).
- The changelog lists `profile_views`, `website_clicks` and the other contact clicks as deprecated time series from 2025-01-08. Asked for as `total_value`, they still answer on v26.0 (§2).

### Business Discovery: `GET /{own-ig-user-id}?fields=business_discovery.username(X){…}`

Sources:
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery/
- https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/business-discovery

- **Permissions:** `instagram_basic`, `instagram_manage_insights`, `pages_read_engagement` (plus `ads_management`/`ads_read` when the Page role comes through Business Manager).
- Facebook Login only. The target must be a Business or Creator account. Age-gated accounts aren't returned.
- Fields: `followers_count`, `media_count`, `media{like_count, comments_count, media_type, permalink, timestamp, caption, view_count}`.
- There are no insights. Engagement can only be measured against followers.

### Content Publishing levers: `POST /{ig-user-id}/media`

Sources:
- https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
- https://developers.facebook.com/docs/instagram-platform/content-publishing/

| Parameter | Supported? | On which containers |
|---|---|---|
| `alt_text` | Yes (added 2025-03-24) | "up to 1000 character", "Only supported on a single image or image media in a carousel. Reels and stories are not supported." So: the image container, and each image child of a carousel |
| `collaborators` | Yes | "A list of up to 3 instagram usernames … For Feed image, Reels and Carousels only. Not supported for Stories." So: the image, the reel, or the carousel **parent** |
| `trial_params` | Yes (added 2025-12-03) | `{ graduation_strategy: 'MANUAL' \| 'SS_PERFORMANCE' }`, "The media_type must be REELS". `MANUAL` graduates from the app; `SS_PERFORMANCE` graduates automatically on performance |

- **Trial reel eligibility:** the docs set no condition beyond an Instagram professional account (Business or Creator), which is the only kind this API publishes for. So a refusal is treated as "not for this account": `createContainer` retries once without the levers, and the PUBLISHED row's `error_log` says which lever was dropped and why.
- **Limits:** 100 API-published posts per 24 hours, 400 containers per 24 hours, JPEG only.
- **Permission:** `instagram_content_publish`.
- None of the three was exercised against production: doing so means publishing a real post.

### Facebook Page and post insights: `read_insights`

Source: https://developers.facebook.com/docs/graph-api/reference/insights/ (renders as v26.0)

- **Post (lifetime):** `post_media_view`, `post_total_media_view_unique`, `post_clicks`, `post_reactions_by_type_total`, `post_video_views`, `post_activity_by_action_type`.
- **Deprecated above v25:** `post_impressions`, `post_impressions_unique`, `post_impressions_organic_unique`, `post_video_views_unique`.
- "By June 15, 2026, a number of the Page Insights metrics will be deprecated for all API versions" — the list isn't on the page.
- `since`/`until` cover at most 90 days.
- **Permissions:** `read_insights`, `pages_read_engagement`.

### Rate limits and batching

Sources:
- https://developers.facebook.com/docs/graph-api/overview/rate-limiting/
- https://developers.facebook.com/docs/graph-api/batch-requests/

- **Business Use Case limits:** Instagram 4800 × the account's impressions per 24 hours; Pages 4800 × engaged users.
- `X-App-Usage` and `X-Business-Use-Case-Usage` report usage as percentages. The sync (`GraphSession`) stops its optional calls past 80%.
- Throttle codes: 4, 17, 32, 613, 80001, 80002.
- A batch holds up to 50 requests. Each counts as its own call, but it's one round trip. An item that timed out comes back as `null`, and the sync treats it as a failure, not as empty.

### TikTok analytics: documented, not built

- `user.info.stats` (https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info): `follower_count`, `following_count`, `likes_count`, `video_count`.
- `video.list` (https://developers.tiktok.com/doc/tiktok-api-v2-video-list): `POST /v2/video/list/`, `max_count` ≤ 20, with a cursor.
  - It returns **public** videos only.
  - Fields: `id`, `create_time`, `cover_image_url`, `share_url`, `video_description`, `duration`, `title`, `like_count`, `comment_count`, `share_count`, `view_count`.
  - It has no reach or watch time.
- The TikTok app requests neither scope. Requesting an unapproved scope fails the whole authorisation (CLAUDE.md, "TikTok"). So `/api/growth/status` says `tiktok: 'unavailable'` and lists them in `tiktokMissing`.

## 2. Verified against production, v26.0, 2026-09-25 — the sets the sync uses

The coordinator probed these from the main checkout with the regenerated token: a PAGE token, never expiring, data access until 2026-12-24, carrying `instagram_manage_insights` and `read_insights`. The lists live in `mapping.ts`.

### Instagram

- **Media list:** `/{ig}/media?fields=id,media_type,media_product_type,timestamp,like_count,comments_count,permalink,caption,thumbnail_url,media_url`, paged. There were 46 media on the day.
- **REELS insights:** `views, reach, saved, shares, total_interactions, likes, comments, ig_reels_avg_watch_time, ig_reels_video_view_total_time`. All answer in one call. Both watch times are in ms.
- **FEED insights:** `views, reach, saved, shares, total_interactions, likes, comments, profile_visits, follows`. All answer in one call.
- **Value shape:** the value is `data[].values[0].value`, falling back to `data[].total_value.value`.
- **Account, per day:** `metric=…&period=day&metric_type=total_value&since&until` (a window of 30 days or less). These answer: `reach, views, accounts_engaged, total_interactions, likes, comments, saves, shares, profile_views, profile_links_taps, website_clicks`.
- **Splits:** results are in `total_value.breakdowns[0].results[].{dimension_values,value}`.
  - `breakdown=follow_type` → FOLLOWER / NON_FOLLOWER. It was asked for separately on `reach` and on `views`.
  - `breakdown=media_product_type` → REEL / POST / CAROUSEL_CONTAINER / STORY, asked for on `reach`.
  - On the day: reach 17 followers / 1704 non-followers, so 99% of reach comes from non-followers. `GET /overview` returns this as `audience_split` and `kpis.non_follower_reach_share`, and the coach reasons from it.
- **Under 100 followers:** `follower_count`, `follower_demographics`, `online_followers` and `follows_and_unfollows` return no data and no error.
  - The sync doesn't ask for them under 100 followers.
  - The overview gives the reason in `notes`: "Instagram shares this once the account has 100+ followers".
  - Followers come from the node's `followers_count` (36 on the day), recorded once per sync day.
- **Best times:** `online_followers` is empty, so `best_times` is the average views of the tenant's own posts by publish weekday and hour, in the tenant's timezone. `best_times_meta` and `notes.best_times` say so.

### Facebook

- **Page node:** `followers_count` and `fan_count` answer.
- **Page insights:** `/{page}/insights?metric=…&period=day&since&until`. These answer: `page_media_view` (views), `page_total_media_view_unique` (reach), `page_post_engagements`, `page_daily_follows_unique`, `page_views_total`, `page_follows`.
  - `page_follows` is a running total (118 on the day). It is stored as that day's `followers` and never summed.
  - Refused (#100): `page_impressions`, `page_impressions_unique`, `page_fans`.
- **Post list:** `/{page}/posts?fields=id,created_time,message,permalink_url,attachments{media_type,target{id}}`.
  - The sync adds `full_picture`, which `GET /api/posts/live` has always read from the same node.
  - `media_type` is `album` for a carousel and `video` for a reel.
- **Post insights:** these answer: `post_media_view, post_total_media_view_unique, post_clicks, post_reactions_by_type_total` (an object; summed into `likes`), and on video posts `post_video_views, post_video_avg_time_watched` (ms).
  - Refused (#100): `post_impressions_unique`, `post_engaged_users`.
  - `/{video}/video_insights` with `fb_reels_*` is refused. It isn't used.
  - `post_activity_by_action_type` is in the docs but wasn't verified, so it isn't requested. Facebook comments and shares stay null.

### When a name is refused anyway

`fetchInsights` (graph.ts) handles a #100 on a combined request like this:
1. It asks the first failed object for each metric on its own.
2. It asks every failed object again with the names that answered.
3. It reports the refused names.

The sync keeps them in `growth_settings.last_sync.unsupported`, keyed by `API_VERSION`. Later runs don't ask for them, and a version bump clears the list.

### The numbers the coach should expect for this tenant

- IG reels: a median of about 130 views and an average watch time of about 3.2s.
- Carousels: about 13–15 views, and a reach of 5–6.
- 7 reposts of one reel each got about 150 views.
- FB 28-day views were 7,843, about 3.3× Instagram's.

The coach's system prompt reasons about retention (the 3-second hook) when reach already comes from non-followers. It isn't told these numbers: it computes medians, reposts and the split from the tenant's own rows.

## 3. Operator steps

1. **Meta token:** already done on 2026-09-25. Next time, regenerate it by the procedure in `docs/TOKEN_GUIDE.md`, adding `instagram_manage_insights` and `read_insights` to the Graph API Explorer's list. `GET /api/growth/status` confirms them through `debug_token`.
2. **Migration:** run `npm run migrate` **before** deploying (v22). Every scheduled-post insert now names `meta_options`.
3. **Other people's accounts** need Advanced Access (App Review) for both permissions. The one-tenant setup works on Standard Access.
4. **TikTok analytics:** add `user.info.stats` and `video.list` in the TikTok portal before any code for them is built.
