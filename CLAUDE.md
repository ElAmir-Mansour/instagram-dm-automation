# AutoReply Pro — Instagram/Facebook automation

Express 5 + TypeScript + Postgres. Receives Meta webhooks, auto-replies to comments with
keyword-triggered DMs, answers DMs with Gemini, and publishes scheduled posts to Instagram
and Facebook. Single-tenant in practice. Deployed on Vercel serverless.

Live: <https://msg-response-auto.vercel.app> · Dashboard at `/dashboard`

---

## Commands

```bash
npm run start:dev     # local, port 3000 (reads .env)
npm run typecheck     # tsc --noEmit — the only check that exists
vercel --prod --yes   # deploy (no CI; Vercel is the only pipeline)
vercel env pull .env.local --environment=production   # inspect prod env
```

There is **no build step and no test suite**. TypeScript runs through `ts-node/esm` locally
and `@vercel/node` in production.

---

## Architecture

| File | Responsibility |
|---|---|
| `src/index.ts` | Express app, `/webhook` GET+POST. The entire comment/DM pipeline is inline in the POST handler (~430 lines) |
| `src/routes/api.ts` | Everything under `/api` — auth, stats, campaigns, scheduler, uploads, inbox, AI settings, token management, cron |
| `src/services/instagram.ts` | All Meta Graph API calls. `API_VERSION` lives here |
| `src/services/ai.ts` | Gemini DM replies with a structured-output schema |
| `src/middleware/auth.ts` | HMAC session tokens |
| `src/utils/signature.ts` | Webhook HMAC verification |
| `src/utils/arabic.ts` | Arabic normalisation for keyword matching |
| `dashboard/js/` | Vanilla-JS SPA, no bundler, globals + cache-busting |

**Two event paths, both entering at `POST /webhook`:**

- `entry.changes` → comments → keyword match against `campaigns` → private reply + public reply
- `entry.messaging` → DMs → Gemini → send

---

## Gotchas that have already cost hours

**The app receives webhooks from two different Meta apps.** The Facebook app sends
`object: "page"`; "Instagram API with Instagram Login" is a *separate app with its own ID and
secret* and sends `object: "instagram"`. Each signs with its own secret, so
`verifyMetaSignature` checks `META_APP_SECRET` **and** `INSTAGRAM_APP_SECRET`. Dropping either
silently 403s half your traffic.

**A webhook signature failure is invisible.** The 403 happens before anything touches the
database, so "signature rejected" and "no events arriving" look identical. Check the logs —
the rejection line reports how many secrets were tried.

**Meta only re-checks the verify token when a subscription changes.** Existing subscriptions
keep delivering forever even if the token is wrong or empty. Production once had
`META_VERIFY_TOKEN=""`, which broke *every* subscription change with an opaque
`Callback verification failed: HTTP 403` while existing webhooks kept working. The token now
also lives in `creators.webhook_verify_token`, editable from Settings with no redeploy.

**One callback URL per object type, app-wide.** The `instagram` object once pointed at an
unrelated project (`api.elharef.shop`), so Instagram comments never arrived while Facebook
worked fine. Check with:

```bash
GET /{app-id}/subscriptions?access_token={app-id}|{app-secret}
```

**Vercel hard-caps request bodies at 4.5MB.** `/api/upload` takes base64 JSON, so the real
ceiling is ~3.3MB of file — not the 10MB the UI claims. Rendered reels exceed this. Write
media straight to `media_uploads` over the Postgres connection instead; `/api/uploads/:id`
serves it publicly, which is what Meta needs since it cURLs the URL.

**Instagram thumbnails default to frame 0.** Any video fading up from black gets a black tile
in the profile grid. Always pass `cover_url` (or `thumb_offset` in ms). Also send
`share_to_feed: true` or reels never appear in the main feed.

**The cron runs once daily at 00:00 UTC** (`vercel.json`, a Hobby-plan limit). `scheduled_time`
is effectively day-granular. An external cron hitting `/api/cron/publish` would fix it.

**Keyword matching is substring-based** — `normalizedCommentText.includes(normalizedKeyword)`
at `src/index.ts:438`. Short keywords are dangerous: `تم` matches inside اهتمام, تمام, يتم.

**`post_type` for cross-posting must be `video`, not `reel`.** `publishFacebookPost` doesn't
handle `reel` and silently falls through to a text-only feed post with no media.
`video` maps correctly to both `/videos` (FB) and a `REELS` container (IG).

---

## Known issues / tech debt

**Security — unresolved:** five files in `scratch/` hardcode the production Supabase
connection string *with the password*, and they are tracked in a **public** repo. The database
holds `creators.page_access_token` in plaintext, so this is a path to the Meta tokens. Rotate
the Supabase password, then untrack `scratch/` and read `process.env.DATABASE_URL`.
RLS is also disabled on all public tables (latent — no anon key is published yet).

**Single-tenant:** the schema has `creator_id` everywhere, but ~13 call sites resolve the
tenant as `SELECT id FROM creators WHERE is_active = true LIMIT 1`. `api.ts:634` updates
*every* active creator's token at once. Auth is one shared `DASHBOARD_PASSWORD` with no user
identity in the session token — multi-tenancy is a rewrite, not a change.

**No migration ledger.** `src/config/*.sql` are applied by hand or by two hardcoded scripts;
nothing records what ran. There is no single artifact describing the live schema. Both runner
scripts swallow errors and exit 0.

**`media_uploads` is `BYTEA` in Postgres** — currently ~40MB and growing with every video.
Supabase free tier is 500MB. This wants S3/R2/Supabase Storage. The table also has no
`creator_id` and is served unauthenticated by UUID.

**`src/utils/rateLimiter.ts` is imported but never called.** No send-rate protection exists.

**`/api/cron/publish` fails open** — if `CRON_SECRET` is unset the guard is skipped entirely.

---

## Workflows

**Publish a video to both platforms** — write the file into `media_uploads` directly (bypasses
the 4.5MB cap), insert a `scheduled_posts` row with `platform='both'`, `post_type='video'`,
`cover_url` set, then `GET /api/cron/publish` with `Authorization: Bearer $CRON_SECRET`.

**Debug "no events arriving"** — in order: (1) is the comment's keyword actually a substring
match? (2) `GET /{app-id}/subscriptions` — right callback URL? (3) does the verify-token
handshake return the challenge? (4) is `INSTAGRAM_APP_SECRET` set? A comment that matches no
campaign writes **no row at all**, so silence is not proof of a delivery failure.

**Check token health** — `GET /debug_token`. Current token is PAGE type, never expires, and
carries all 13 needed scopes including `instagram_manage_comments` and `pages_manage_engagement`.

**Run a migration** — paste the SQL into the Supabase SQL editor, or run it over the `pg`
connection. All migrations use `IF NOT EXISTS` and are idempotent.

---

## Related: the promo video pipeline

Reels are rendered **locally** with Remotion at `~/Desktop/AI Course/aicourse-captions/`
(`src/promo/`), then published through this app. Rendering never runs on Vercel — it needs
headless Chrome and minutes per video.

- `src/promo/scripts.ts` — all reel copy, clip framing (`zoom`/`focusX`/`focusY`) and
  `voDuration`. Edit here, not in the components
- Reels are cut to the voiceover: composition length derives from `voDuration`
- `out/promo/*.mp4` — 1080×1920, H.264, AAC 48kHz, faststart (Meta-compliant)
- `marketing/promo-reels-AR.md` — campaign plan, captions, DM copy
- `marketing/voiceover-script-AR.md` — the recording scripts

Course link (referral): `https://www.udemy.com/course/agentic-ai-arabic/?referralCode=02A626DDDA3FDAB6AB34`

---

## If this becomes a SaaS

The blocker is Meta, not code. Serving other people's accounts needs **Advanced Access**, which
requires **Business Verification plus per-permission App Review** for ~6 permissions including
`instagram_content_publish` and `pages_messaging`. Months of process with real rejection risk.
Sequence the product for one account first.
