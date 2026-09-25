# Growth & SEO hub: the contract (v1)

"We don't have enough views or interactions." This is the product answer: a place in the dashboard that
**measures** what each post does, **explains** why, and turns that into **what to do next**, plus the
SEO and reach levers the platforms offer through their APIs. It's a SaaS feature, so every value is
per tenant and nothing is hardcoded to one creator.

State on 2026-09-25 (ElAmir's tenant): Instagram has 36 followers and 46 posts. Every post gets about 2
likes and 0 comments. Media and account insights are unreachable, because the Page token lacks
`instagram_manage_insights` (Graph error #10). Facebook Page insights need `read_insights`. TikTok
metrics need scopes the TikTok app doesn't have yet (`video.list`, `user.info.stats`).

## 1. Data: `src/config/migration_v22_growth.sql` (RLS on, idempotent)
```sql
post_insights (
  id uuid PK default gen_random_uuid(),
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('instagram','facebook','tiktok')),
  media_id text NOT NULL,              -- the platform's id; posts made outside the app count too
  scheduled_post_id uuid REFERENCES scheduled_posts(id) ON DELETE SET NULL,
  media_type text,                     -- REELS / CAROUSEL_ALBUM / IMAGE / VIDEO …
  permalink text, caption text, thumbnail_url text,
  published_at timestamptz,
  metrics jsonb NOT NULL DEFAULT '{}', -- { views, reach, likes, comments, saved, shares, total_interactions, follows, profile_visits, avg_watch_time_ms, ... }
  fetched_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (creator_id, platform, media_id)
)
account_insights_daily (
  creator_id uuid NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
  platform text NOT NULL,
  day date NOT NULL,
  metrics jsonb NOT NULL DEFAULT '{}', -- { followers, reach, views, accounts_engaged, profile_views, follows, unfollows, website_clicks }
  PRIMARY KEY (creator_id, platform, day)
)
growth_settings (
  creator_id uuid PRIMARY KEY REFERENCES creators(id) ON DELETE CASCADE,
  keywords text[] NOT NULL DEFAULT '{}',     -- search terms the audience types, e.g. «ذكاء اصطناعي», «برومبت»
  hashtag_sets jsonb NOT NULL DEFAULT '[]',  -- [{ name, tags: string[] }]
  competitors text[] NOT NULL DEFAULT '{}',  -- Instagram usernames, for Business Discovery
  audience jsonb NOT NULL DEFAULT '{}',      -- { countries: ['SA','AE','EG'], languages: ['ar'], timezone }
  updated_at timestamptz DEFAULT now()
)
```

## 2. Sync: `src/services/growth/*.ts`
- `syncInsights(creatorId)`:
  - Instagram: recent media (up to 100 or 90 days) and per-media insights. Account insights by day: reach, views, accounts_engaged, profile_views, follows_and_unfollows, and follower_count where the API allows it.
  - Facebook: Page posts and their insights, when the Page token allows.
  - TikTok: nothing until the scopes exist; the status says so.
  - Metric names follow the current Graph API version (`API_VERSION`). Read the official docs. `impressions`/`plays` are deprecated in favour of `views`; follow whatever the current docs say.
- Runs daily in the cron (next to `refreshAllConnections`). Also runs on demand with `POST /api/growth/sync`, rate-limited to once every 10 minutes per tenant.
- **Permission detection:** `debug_token` scopes. A missing permission is a status to show the operator, with the exact fix. It isn't an error to log on every run.

## 3. Operator API (session + `canOperate`, tenant-scoped)
| Route | Returns |
|---|---|
| GET `/api/growth/status` | `{ instagram: 'ok'\|'missing_permission'\|'not_connected', facebook: …, tiktok: 'unavailable'\|…, missing: string[], lastSync }` |
| POST `/api/growth/sync` | `{ synced: { instagram, facebook }, lastSync }` |
| GET `/api/growth/overview?days=28` | `{ kpis: { followers, followers_delta, reach, views, engagement_rate, saves, shares, profile_visits }, trend: { day, reach, views, followers }[], best_times: number[7][24], top_posts: PostInsight[], by_type: { type, posts, avg_views, avg_engagement }[] }`. Anything that isn't available is null, never faked. |
| GET `/api/growth/posts?days=90&sort=views` | `{ posts: PostInsight[] }`, where `PostInsight` = a post_insights row plus `engagement_rate` |
| POST `/api/growth/coach` | Gemini, using the Studio's writer model chain, reads the metrics, captions and settings and returns `{ summary, wins: string[], problems: string[], actions: { title, why, how, effort: 'low'\|'med'\|'high', impact: 'low'\|'med'\|'high' }[], experiments: { hypothesis, how, measure }[] }`, in the tenant's voice language. When there are no metrics, it still coaches from the post history and says the numbers are missing. |
| GET/PUT `/api/growth/settings` | `{ settings }`: keywords, hashtag_sets, competitors, audience |
| POST `/api/growth/keywords/suggest` | `{ topic }` → Gemini returns `{ keywords: { term, why }[], hashtags: string[] }` for the tenant's audience and language. Each suggestion is labelled as a suggestion, not search-volume data. |
| GET `/api/growth/competitors` | Instagram **Business Discovery** for each competitor username: `{ username, followers, media_count, recent: { permalink, like_count, comments_count, media_type, timestamp, caption }[], avg_engagement }[]`. Reports `missing_permission` if the token can't. |

## 4. Reach levers at publish time (only what the official APIs support; verify each in the docs)
- **Alt text** on image and carousel slides (`alt_text`), which is SEO for Instagram search. The Studio writes one per slide.
- **Collaborators** (`collaborators`: up to 3 usernames) for Collab posts, so they're shown to both audiences.
- **Trial reels** (`trial_params` with a graduation strategy), which show a reel to non-followers first. Offer it only if the Content Publishing API supports it for this account type.
- **Keywords:** the Studio writer puts 1–2 of the tenant's `keywords` naturally into the caption's first line, and into the on-slide text where it fits. Hashtags come from `hashtag_sets`.
- Every new field is optional, validated server-side, and stored in `scheduled_posts.platform_options`, or in a new column if cleaner (say which). If the API refuses a field for this account, the post still publishes without it and the row notes it.

## 5. Dashboard: the `#/growth` page («النمو والتسويق»)
- **Permission banner.** When `missing` isn't empty, a one-screen fix: regenerate the Meta token with `instagram_manage_insights`
  and `read_insights` (link the Help article; docs/TOKEN_GUIDE.md has the procedure).
- **KPI cards:** followers (with Δ), reach, views, engagement rate, saves, shares. **Trend chart** (inline SVG, no library).
- **Posts table:** sortable, with filters by type and platform, a thumbnail, and a "why it worked" tooltip from the coach.
- **Best times heatmap** (7×24), and **by type** (reels vs carousels vs images).
- **AI Growth Coach:** a Generate button showing summary, wins, problems, prioritised actions and experiments.
- **SEO tools:** the keyword list with Suggest, hashtag sets, and competitors with Business Discovery cards.
- In the composer and the Studio schedule panel: alt text per slide, collaborators, and a trial-reel toggle, each with a "Learn more".
- Help Center articles: "Growth & insights" and "Instagram & TikTok SEO".
