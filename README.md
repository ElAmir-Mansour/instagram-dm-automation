# AutoReply Pro — Instagram/Facebook comment-to-DM automation

Self-hosted Instagram and Facebook automation on the official Meta Graph API. When someone
comments a trigger keyword on your post, the app sends them a DM and optionally replies
publicly. Inbound DMs are answered by Gemini. Scheduled posts publish to both platforms.

Express 5 + TypeScript + Postgres, deployed on Vercel serverless with an RTL-first Arabic
dashboard at `/dashboard`.

**Operating it:** [`RUNBOOK.md`](RUNBOOK.md) — the procedures, symptom-first.
**Proving it works end to end:** [`VERIFYING.md`](VERIFYING.md).
**Why it is shaped this way:** [`ARCHITECTURE.md`](ARCHITECTURE.md).
**What actually happens, hop by hop:** [`FLOWS.md`](FLOWS.md).
**The Carousel Studio, in depth (what a worker is, every setting, troubleshooting):** [`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md).
**TikTok, end to end:** [`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md).

---

## Features

- **Comment → DM automation** — keyword-triggered DMs via the Meta Graph API, with an optional
  public reply on the comment. When Meta won't deliver the DM (the person can't receive messages
  from Pages), the bot replies publicly instead: the campaign's link on Facebook, "link in bio" on
  Instagram
- **Instagram and Facebook** — Instagram comments/DMs and Facebook Page comments/Messenger,
  through one pipeline
- **Arabic-first keyword matching** — Hamza variants, Teh Marbuta, Yeh, diacritics and tatweel
  are normalised on both sides. Per-campaign `substring` or `word` matching
- **Post-specific targeting** — a campaign can be scoped to one post id or run globally
- **Durable job queue** — every webhook delivery is written to Postgres before Meta is
  acknowledged, then drained within a time budget. Retries with jittered backoff, a stale-claim
  reaper, and queue-level deduplication on top of row-level claims
- **Scheduled publishing** — images, videos, reels and carousels to Instagram, Facebook, or both,
  and to TikTok, with an atomic claim so overlapping runs cannot double-publish, and
  partial-publish recovery. A reel Instagram is still processing is held and published from the
  same container on the next sweep; a Facebook post that may already be live is never re-sent
- **Carousel posts** — 2 to 10 images as one Instagram and Facebook post (`post_type =
  'carousel'`), and 2 to 35 as a TikTok photo carousel. The count and the formats (JPEG for
  Instagram, JPEG or WebP for TikTok) are checked when the post is saved, not at publish time
- **TikTok** — videos and photo carousels, sent to the creator's TikTok inbox by default, or
  posted directly with Direct Post (`video.publish`) once it is switched on. Direct posts stay
  private ("Only me") until TikTok audits the app. See [`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md)
- **Carousel Studio** — turns course videos into branded carousels for Instagram, Facebook and
  TikTok. A worker on the creator's Mac indexes each lesson with Gemini and renders the slides
  with Remotion; the app writes the copy from the lesson's notes, checks it against the design's
  rules, and schedules it with its keyword → DM campaign. Per-account brand, voice, product and
  posting times. See [`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md)
- **Growth & SEO hub** (`#/growth`) — daily Instagram and Facebook insights (views, reach, the
  3-second skip rate, watch time, followers vs new people), best times from your own posts, an AI
  Growth Coach, keyword and hashtag tools, competitors via Business Discovery, and publish-time
  reach levers (alt text, collaborators, trial reels). See [`GROWTH.md`](GROWTH.md)
- **Media in Supabase Storage** — uploads live in a public Storage bucket, not in Postgres; every
  URL stays `/api/uploads/<id>` on the app's domain, which streams the file. Configured in
  Settings → Media storage
- **Gemini DM replies** — structured output, conversation history, per-thread bot toggle, and
  the automated-service disclosure Meta requires
- **Managed multi-tenancy** — `users`, `memberships`, identity-carrying sessions, per-tenant
  encrypted Meta tokens, a tenant switcher, and a cross-tenant admin surface
- **Send-rate protection** — per-tenant hourly quota, an app-wide pool ceiling, and a 24h
  per-recipient cap, all counted in Postgres rather than per-instance memory
- **Operable** — structured logs with request correlation, a migration ledger, a one-command
  read-only health check, and a live pipeline watcher

## Dashboard

At `/dashboard`. Overview, Campaigns, Analytics, Activity Log, Scheduled Posts, **Studio**
(the Carousel Studio: the lesson library, drafts and editor, plus its own Settings tab with the
brand kit, voice, product, posting times, library folder and workers), Inbox, AI Settings,
Settings — plus **Tenants** and **Users** for a platform admin.

---

## Setup

### Prerequisites

- Node.js 22+ (the test runner only expands globs in `--test` from 22)
- A PostgreSQL database (Supabase recommended)
- A Meta Developer App with Instagram Graph API configured
- A Vercel account for deployment

### 1. Clone and install

```bash
git clone https://github.com/ElAmir-Mansour/instagram-dm-automation.git
cd instagram-dm-automation
npm install
```

### 2. Environment

```bash
cp .env.example .env
```

Seven variables are **required** — the app refuses all traffic with a 503 naming the missing
one rather than serving with a missing secret (`src/config/env.ts`):

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. Use Supabase's pooler port (6543) |
| `META_VERIFY_TOKEN` | Webhook verification handshake |
| `META_APP_SECRET` | Facebook app's webhook signing secret |
| `INSTAGRAM_APP_SECRET` | **A different app's secret.** "Instagram API with Instagram Login" is a separate Meta app and signs its own webhooks |
| `GEMINI_API_KEY` | Gemini, for DM replies and the Studio. Now a fallback: a key a platform admin saves on **Operations → Gemini API key** takes over for every tenant, without a redeploy, and this variable is no longer required at boot |
| `DASHBOARD_PASSWORD` | Dashboard login, and the session-token signing key. Cannot be `admin` — that value is in this repo's public history |
| `CRON_SECRET` | Bearer guarding `/api/cron/publish` and `/api/jobs/drain`. `openssl rand -hex 32` |

Strongly recommended:

| Variable | Notes |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | 32 bytes hex (`openssl rand -hex 32`). Encrypts Meta tokens at rest. Not required at startup, but **required to save a token or create a tenant** |
| `RAW_PAYLOAD_RETENTION_DAYS` | Set to `30` to match what the published `/data-deletion` page promises. Unset means keep forever |

Optional knobs — logging, queue budgets, the app-wide rate ceiling — are documented inline in
`.env.example`.

### 3. Database

```bash
npm run migrate:status     # what would run
npm run migrate            # apply it
```

`schema.sql` runs first, then `src/config/migration_v*.sql` in version order. Every applied
file is recorded with a checksum in `schema_migrations`, each runs in its own transaction, and
a failure exits non-zero. All files are idempotent.

If your database already has the current schema but no ledger, `node scripts/migrate.mjs
--baseline` marks everything applied without running it.

Migrations run to `migration_v23_media_storage.sql`; `src/config/migrations.ts`
(`EXPECTED_MIGRATIONS`) is the canonical list. Apply them **before** deploying the code that
needs them.

### 4. Meta access token

You need a **permanent Page Access Token**.

```bash
# 1. Graph API Explorer → select your app → token type USER (not Page!)
# 2. Add every required scope → Generate Access Token
# 3. Exchange it:
node scripts/exchange-token.mjs YOUR_SHORT_LIVED_USER_TOKEN
```

Paste the result into the dashboard Settings page, which encrypts it on write. See
[`docs/TOKEN_GUIDE.md`](docs/TOKEN_GUIDE.md) for the manual route.

| Type | Lifespan | Source |
|---|---|---|
| Short-lived (User or Page) | ~1 hour | Graph API Explorer |
| Long-lived Page | 60 days | Exchange a short-lived Page token |
| **Permanent Page** | never expires | Exchange a **User** token → `/me/accounts` |

> **Common mistake:** generating a Page token directly in the Explorer and exchanging it only
> ever gets you 60 days. You must start from a **User** token.

> **Separately:** Meta lapses *data access* 90 days after the last re-authorisation, and when it
> does, reads fail while `/debug_token` still reports the token as valid. `scripts/diagnose.mjs`
> reports the date. Diarise it.

### 5. Run locally

```bash
npm run start:dev
```

- Dashboard: <http://localhost:3000/dashboard>
- Health: <http://localhost:3000/health>

### 6. Deploy

```bash
vercel --prod --yes
```

Set every environment variable in Vercel → Settings → Environment Variables. There is no build
step and no CI deploy step; Vercel is the only pipeline. `vercel rollback` reverts.

### 7. Webhooks

In the [Meta Developer Console](https://developers.facebook.com/apps/):

1. Set the callback URL to `https://your-domain.vercel.app/webhook`
2. Set the verify token to match `META_VERIFY_TOKEN` (or `creators.webhook_verify_token`)
3. Subscribe to `feed`/`comments`, `messages`, `messaging_postbacks`

**Confirm the verify-token handshake succeeds *before* creating the subscription.** Meta only
re-checks the token when a subscription changes, and a wrong or empty token produces an opaque
`Callback verification failed: HTTP 403` while existing webhooks keep delivering. Note also
that there is **one callback URL per object type, app-wide** — changing it for one tenant
changes it for all of them.

### 8. Check it

```bash
node scripts/diagnose.mjs
```

Read-only. Reports deployment, security guards, webhook subscriptions, token health, event
flow, queue, publishing, rate limits, schema and storage. Exits `0` healthy, `1` warnings,
`2` critical, `3` could not run.

---

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # 548 tests across 110 suites, node:test via tsx
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, and `node --check` over `dashboard/` —
the dashboard has no build step, so that is its only guard against a syntax error blanking the
page.

---

## API reference

This is the surface. For what happens *behind* a route — the webhook pipeline, the publish
sweep, the auth chain — [`FLOWS.md`](FLOWS.md) walks each one hop by hop with a `file:line` at
every step.

Unauthenticated:

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness + database connectivity |
| `GET`/`POST` | `/webhook` | Meta verification handshake / event delivery |
| `GET` | `/privacy`, `/data-deletion` | Meta App Review compliance pages |
| `GET` | `/api/uploads/:id` | Serve stored media by UUID (Meta cURLs this during ingestion) |
| `POST` | `/api/auth/login` | Login — returns an HMAC session token |
| `POST` | `/api/invites/peek` | What an invite link is for (tenant, role, expiry); never uses the link up. The token is in the body, never the URL |
| `POST` | `/api/invites/accept` | Use a link: create the account (or add a signed-in one, or reset a password) and answer a session. Single-use, one atomic claim |
| `GET` | `/api/meta/callback` | Facebook Login for Business redirect target. Trusts only a single-use `state` that equals the cookie set by `POST /api/meta/connect`; answers with a redirect to the dashboard, never a token |
| `POST` | `/api/meta/deauthorize` | Meta's **Deauthorize Callback URL** (register it under Facebook Login, Settings): a person removed the app, and Meta posts a form with `signed_request`. Trusts only that request's HMAC-SHA256 (checked with every app secret before anything is read from it); disconnects the tenants whose `creators.meta_user_id` is that person's, exactly, and nobody else's (the owner's pasted-token connection has none). 403 for a bad signature, 200 when nothing matches |

Bearer `CRON_SECRET`:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/jobs/drain` | Drain the job queue. **Runs real handlers — sends real DMs** |
| `GET` | `/api/cron/publish` | Reap stale claims, retention sweep, backstop drain, then **publish every due post to the live accounts**; also refreshes the TikTok and YouTube tokens and rechecks every connected tenant's Meta token (a transient failure writes nothing) |
| `POST` | `/api/onboarding/drafts/sweep` | Advance the profile drafts nobody is working on (the backstop `heroku-worker` calls about every minute). Bearer `CRON_SECRET`, like the drain. Costs AI spend |

Session token required:

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/auth/me` | Session identity, role, tenant, available tenants, and `onboarding: { status, step, gated }`: whether this session is sent to the setup wizard |
| `GET` | `/api/onboarding` | The setup wizard's state: status, where to resume, each step's saved draft, the profile with its `version`, what activation still misses |
| `PUT` | `/api/onboarding/steps/:step` | Owner. Autosave a step's draft (`{ values }`, never touches the profile), mark it `done`/`skipped`, or note it is on screen |
| `POST` | `/api/onboarding/complete` | Owner. Finish the wizard (needs the six activation fields); idempotent |
| `POST` | `/api/auth/switch-tenant` | Act as another tenant |
| `GET` | `/api/stats`, `/api/stats/daily`, `/api/stats/hourly`, `/api/stats/campaigns` | Dashboard metrics |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/campaigns` | Campaign CRUD, including `match_mode` |
| `GET` | `/api/interactions` | Paginated activity log |
| `GET` | `/api/interactions/export` | CSV export, scoped to the acting tenant |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/posts/scheduled` | Scheduler CRUD |
| `GET` | `/api/posts/live` | Recent published posts from Meta |
| `POST` | `/api/upload` | Media upload (base64 JSON; ~3.3MB ceiling) |
| `GET`/`POST` | `/api/conversations`, `/api/conversations/:id/messages` | Inbox |
| `PUT` | `/api/conversations/:id/toggle-bot` | Pause or resume the AI on one thread |
| `GET`/`POST` | `/api/settings/token`, `/api/settings/token/status` | Token status and rotation |
| `GET`/`POST` | `/api/settings/ai` | AI agent configuration |
| `GET`/`POST` | `/api/settings/webhook-token` | Change the verify token with no redeploy |
| `GET` | `/api/meta/connection` | Is Connect with Facebook on, is the app set up, and this tenant's Meta connection (never a token) |
| `POST` | `/api/meta/connect` | Owner: mint a state and a cookie, return the Login dialog URL (`{ returnTo?, reconnect?, authType? }`). Refuses a tenant that is connected unless `reconnect` is true |
| `GET`/`POST` | `/api/meta/candidates`, `/api/meta/select` | Owner: the Pages waiting for a choice (names and ids, never a token) / choose one. The choice spends the pick and nulls its stored tokens |
| `POST` | `/api/meta/disconnect` | Owner: unsubscribe the Page from the webhook and delete the ids and the token. Needs `{ "confirm": true }` |
| `GET` | `/api/meta/comment-check` | Operator and up: has a `comment.process` job arrived for this tenant since it connected? A count and a time, never a comment (the setup wizard's "ask a friend to comment *test*") |
| `GET`/`POST` | `/api/onboarding/draft` | The tenant's profile draft (the wizard polls it every 3 s) / start one. Owner of the tenant, only while its onboarding is open |
| `POST` | `/api/onboarding/draft/advance` | Do the next steps of the draft (up to 270 s inside the request); the wizard fires it when the poll says `advanceable` |

Platform admin only (returns **404** to everyone else — the surface does not announce itself):

| Method | Path | Description |
|---|---|---|
| `GET`/`POST` | `/api/admin/tenants` | Cross-tenant health list / create a tenant |
| `PATCH` | `/api/admin/tenants/:id` | Rename or enable/disable |
| `GET`/`POST` | `/api/admin/users` | List / create a user, optionally with a membership |
| `POST` | `/api/admin/users/:id/revoke` | Invalidate every session that user holds |
| `POST` | `/api/admin/users/:id/memberships` | Grant or change a membership |
| `POST`/`GET` | `/api/admin/tenants/:id/invites` | Make an invite (or a password-reset link): the link comes back once / list a tenant's invites, without links |
| `POST` | `/api/admin/invites/:id/regenerate` | A new link for the same person; the old one stops working in the same step |
| `DELETE` | `/api/admin/invites/:id` | Revoke a link |
| `GET`/`PUT` | `/api/admin/onboarding-settings` | Invite lifetime, default role, "keep me signed in" length, sender name, WhatsApp text, default content rules |
| `GET`/`POST` | `/api/meta/app-settings` | Connect with Facebook: the on/off switch (default off) and the Login for Business configuration id, and what to register in Meta's dashboard |
| `GET`/`PUT` | `/api/admin/onboarding-settings` | Invite lifetime, default role, "keep me signed in" length, sender name, WhatsApp text, default content rules, the YouTube Data API key (never returned: `{set, source, last4}`) and the tenant whose Instagram reads other people's profiles |
| `GET`/`POST` | `/api/admin/tenants/:id/draft` | A tenant's profile draft: read it / start one (`force` makes a new one over a finished draft). The tenant comes from the path |
| `POST` | `/api/admin/tenants/:id/draft/advance` | Do the next steps of the draft (up to 270 s inside the request); **starts** the draft from the handle and site typed at creation when there is none |

---

## Gotchas

1. **Vercel is stateless.** Never use in-memory stores for sessions or counters. Sessions are
   HMAC-signed tokens; rate-limit counters live in Postgres, because a per-instance counter
   multiplies the real send rate by however many instances are warm.
2. **Work after the response can be frozen.** The webhook therefore writes every event to the
   `jobs` table *before* answering Meta, then drains within a budget. Anything unfinished stays
   `pending` instead of being silently lost, and `.github/workflows/drain.yml` calls
   `/api/jobs/drain` on a schedule so it does not wait for the next delivery. GitHub throttles
   scheduled workflows, so treat that interval as "frequent but not punctual"; the daily Vercel
   cron is the backstop that bounds the worst case at 24h.
3. **Token type matters.** Use PAGE tokens for API calls, not USER tokens.
4. **24-hour messaging window.** Meta only allows messaging within 24 hours of a user
   interaction.
5. **Two Meta apps, two signing secrets.** Dropping either silently 403s half your traffic —
   before anything touches the database, so it is indistinguishable from no events arriving.
6. **Substring matching is the default.** A short keyword fires inside unrelated words: `عيد`
   matches inside `سعيد`, `جو` inside `موجود`, `تم` inside `اهتمام`. Set `match_mode = 'word'`
   per campaign.
7. **`post_type` must be `video`, not `reel`**, for anything cross-posted to Facebook. Always
   set `cover_url` too, or Instagram uses frame 0 as the thumbnail.

> **Verified 2026-09-21: this is no longer the live configuration.** `GET /{META_APP_ID}/subscriptions` returns *both* the `instagram` and `page` objects under one app, so every event is signed with `META_APP_SECRET` and `INSTAGRAM_APP_SECRET` is vestigial. The dual-secret check in `verifyMetaSignature` stays — it costs nothing and this setup has changed before — but do not diagnose a silent comment path by suspecting that secret first. `diagnose.mjs` now derives this for itself and says so.


More, with the history behind each: [`RUNBOOK.md`](RUNBOOK.md) and `CLAUDE.md`.

## License

MIT
