# AutoReply Pro

AutoReply Pro automates a creator's Instagram, Facebook, TikTok, YouTube and WhatsApp. It turns comments into DMs, answers messages with AI, publishes scheduled content, makes content in a Studio, measures growth and runs Meta ads. One deployment can serve several workspaces (tenants), each with its own accounts, people and settings.

Express 5, TypeScript and Postgres, on Vercel. Live: <https://msg-response-auto.vercel.app>. The dashboard is at `/dashboard`, in Arabic and English.

## What it does

- **Comment → DM campaigns:** a trigger word in a comment on an Instagram or Facebook post sends the commenter a DM and, if you want, a public reply. Arabic spellings are normalised. Matching is by `substring` (the default) or whole `word`.
- **AI replies to DMs:** Instagram and Messenger messages are answered by Gemini, or by Anthropic, OpenAI, OpenRouter, Groq or a custom endpoint when a workspace picks the providers engine. The optional sales mode adds offers, tracked links (`/r/<code>`), one follow-up inside Meta's 24-hour window, and a hand-off to a person.
- **Inbox and analytics:** read and answer conversations, pause the AI on one thread, see stats and an activity log, export the log as CSV.
- **WhatsApp:** connect a WhatsApp Business number (Cloud API). Messages are stored. For now the AI agent answers only the test senders you list: "everyone" is refused until a go-live check is built.
- **Scheduled publishing:** posts go to Instagram, Facebook, TikTok (inbox drafts, or Direct Post once switched on) and YouTube Shorts: images, videos, reels, carousels and, on Instagram, stories. What each platform accepts is checked when you save.
- **The Studio:** carousels made from course videos, the Monteur (reels cut from long videos), animated infographics, and illustrated explainers (only the platform owner's workspace can switch them on). A worker on the creator's Mac renders them. It lives in a separate private repository, `aicourse-studio`.
- **Growth hub:** daily Instagram and Facebook insights, best posting times, an AI coach, keyword and hashtag ideas, competitor look-ups, and reach options on posts (alt text, collaborators, trial reels).
- **Ads Manager:** Meta Marketing API boosts, message ads with a policy check, results, audiences, rules, lead ads (locked until a sign-off) and split tests, under a monthly spending cap. Ads are created paused. A platform admin switches it on per workspace.
- **Managed workspaces:** users with roles (owner, operator, viewer), a tenant switcher, invite links, a setup wizard, encrypted Meta tokens, and a platform-admin area for tenants, users, jobs, the audit log and data erasure.
- **Help Center:** step-by-step guides in Arabic and English, inside the dashboard (`#/help`).
- **Made to be operated:** a durable job queue, send-rate limits counted in Postgres, JSON logs with request ids, a migration ledger and read-only health scripts.

The dashboard menu: Today, Inbox, Keyword replies, DM assistant, Studio, Scheduler, Results, Growth, Ads, Settings and Help. Platform admins also see Operations, Clients, Client ads, Users, Job queue, Audit log and Data erasure. The routes are in `dashboard/js/app.js`.

## Where to read what

| If you are… | Read | It is for |
|---|---|---|
| a developer | [`FLOWS.md`](FLOWS.md) | How every flow works, hop by hop, with a `file:line` at each step, and where a flow can silently do nothing |
| | [`ARCHITECTURE.md`](ARCHITECTURE.md) | Why it is built this way: decisions and trade-offs |
| | [`DESIGN.md`](DESIGN.md) | UI tokens (colour, type, components) and the do's and don'ts |
| | [`STUDIO.md`](STUDIO.md), [`MONTEUR.md`](MONTEUR.md), [`GROWTH.md`](GROWTH.md) | The contracts for the Studio and its worker, the Monteur, and the Growth hub |
| | [`src/services/ads/README.md`](src/services/ads/README.md), [`src/services/growth/README.md`](src/services/growth/README.md) | The rules the Ads module keeps. What Meta's Graph API really answers for Growth |
| an operator | [`RUNBOOK.md`](RUNBOOK.md) | Start from a symptom, find the fix |
| | [`VERIFYING.md`](VERIFYING.md) | Prove once, end to end, that a real Meta event works |
| | [`docs/TOKEN_GUIDE.md`](docs/TOKEN_GUIDE.md) | Meta tokens: types, how to get a permanent one, what kills one, the ads token |
| | [`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md) | TikTok setup, review and operation |
| | [`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md) | The Carousel Studio and its Mac worker: every setting, cost and fix |
| | [`docs/ADS_GUIDE.md`](docs/ADS_GUIDE.md) | The Ads Manager for operators and clients |
| | [`docs/WHATSAPP_GUIDE.md`](docs/WHATSAPP_GUIDE.md) | WhatsApp setup and operation |
| an end user | The Help Center in the dashboard, `#/help` | Guides in Arabic and English. The text is in `dashboard/js/help-content.js` |
| legal or compliance | [`/privacy`](https://msg-response-auto.vercel.app/privacy), [`/terms`](https://msg-response-auto.vercel.app/terms), [`/data-deletion`](https://msg-response-auto.vercel.app/data-deletion) | The public pages. Their source is `public/privacy.html`, `public/terms.html` and `public/data-deletion.html` |

The maintainers also keep local notes and specs outside this public repository.

## How it runs

- **App:** one Express app (`src/index.ts`) on Vercel serverless (`vercel.json`, `@vercel/node`). There is no build step. No instance keeps state that the others need: sessions are signed tokens, and the send-rate counters are database rows.
- **Data:** Supabase Postgres, through its pooler (`src/config/db.ts`). Uploads go to Supabase Storage once Settings → Media storage is filled in, and stay in Postgres until then. Either way the URL is `/api/uploads/<id>`.
- **Work queue:** `POST /webhook` checks the signature, writes each event to the `jobs` table (`src/jobs/`), answers `200`, then drains the queue under `waitUntil` for up to 8 seconds (`src/webhook/ack.ts`). Unfinished jobs stay `pending`. Failed jobs are retried with backoff.
- **Publishing:** `GET /api/jobs/drain` and `GET /api/cron/publish` both publish due posts, so a scheduled post goes out at the first call after its time. With only the daily cron, that can be a day late.

| What calls the app | What it calls | How often |
|---|---|---|
| GitHub Actions, `.github/workflows/drain.yml` | `GET /api/jobs/drain` | Scheduled `*/5`, but GitHub starts it only every few hours |
| A small poller, `heroku-worker/` (a Heroku worker process) | `GET /api/jobs/drain`, and `POST /api/onboarding/drafts/sweep` for profile drafts | Every 60 seconds, in two loops |
| Vercel cron, `vercel.json` | `GET /api/cron/publish`: stale claims, retention, drain, publish, daily health checks and syncs | Daily at 00:00 UTC |
| The Mac worker | `POST /api/studio/worker/claim` | It polls for Studio jobs. Jobs wait while the Mac is off |

## Setup

### 1. Prerequisites

- Node.js 22 or newer. CI runs Node 22, and `npm test` gives glob patterns to `node --test`, which Node 20 reads as file names.
- A Postgres database. This project runs on Supabase. On Vercel, use its pooler address (port 6543).
- A Meta developer app, and a Vercel account.
- Serving accounts you do not own needs Meta Advanced Access (Business Verification and App Review). See [`RUNBOOK.md`](RUNBOOK.md) §8.3.

### 2. Install and configure

```bash
git clone https://github.com/ElAmir-Mansour/instagram-dm-automation.git
cd instagram-dm-automation
npm install
cp .env.example .env
```

Six variables are **required**. If one is missing, the app answers every request with `503` and names it (`src/config/env.ts`, `src/index.ts`).

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string. Use Supabase's pooler on Vercel: each instance opens its own connections |
| `META_VERIFY_TOKEN` | The webhook verification handshake. A token saved in Settings also works, with no redeploy |
| `META_APP_SECRET` | The Meta app's secret. It checks webhook signatures |
| `INSTAGRAM_APP_SECRET` | The second webhook signing secret: the "Instagram API with Instagram Login" app has its own. A webhook is accepted if it matches either. If one Meta app sends both kinds of event, put that app's secret in both variables |
| `DASHBOARD_PASSWORD` | The dashboard login. It cannot be `admin`. With `META_APP_SECRET` it signs session tokens, so changing either signs everyone out |
| `CRON_SECRET` | Bearer secret for the drain, cron and draft-sweep endpoints. `openssl rand -hex 32` |

Strongly recommended, and in `.env.example`:

| Variable | Notes |
|---|---|
| `TOKEN_ENCRYPTION_KEY` | 32 bytes as hex (`openssl rand -hex 32`). Encrypts Meta tokens at rest. The app starts without it, but you cannot save a token or create a tenant |
| `RAW_PAYLOAD_RETENTION_DAYS` | `30` matches the public `/data-deletion` page. Unset keeps raw event copies forever |

`META_APP_ID` is not needed to boot, but token extension, Connect with Facebook and the scripts below use it.

Values that belong to the whole platform are dashboard settings, not env vars. An env var is only a fallback (`src/services/appSettings.ts`). A platform admin enters AI provider keys under **Operations**. The TikTok and YouTube app credentials, Connect with Facebook, media storage and the public site details are under **Settings**. Secrets are stored encrypted.

`.env.example` documents the fallbacks `GEMINI_API_KEY`, `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `PUBLIC_BASE_URL` and `META_LOGIN_CONFIG_ID`, and the knobs `LOG_LEVEL`, `LOG_STACKS`, `WEBHOOK_QUEUE`, `JOB_INLINE_BUDGET_MS`, `JOB_WORKER_BUDGET_MS`, `META_API_VERSION` and `MEDIA_RETENTION_DAYS`. The code also reads some it does not list, such as `META_APP_HOURLY_LIMIT` (the app-wide hourly send ceiling), `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

### 3. Database

```bash
npm run migrate:status   # what would run
npm run migrate          # apply it
```

`schema.sql` runs first, then the files in `src/config/` in version order. The list the code expects is `EXPECTED_MIGRATIONS` in `src/config/migrations.ts`. Each file runs in its own transaction and is recorded with a checksum in `schema_migrations`. A failure exits non-zero. Run migrations **before** you merge code that needs them, because a merge deploys at once.

For a database that already has the current schema but no ledger, `node --env-file=.env scripts/migrate.mjs --baseline` marks **every** pending file as applied without running it. Use it only when that schema is really there.

### 4. Run locally

`npm run start:dev` serves <http://localhost:3000/dashboard> and <http://localhost:3000/health>.

### 5. Deploy and schedule

Import the repository into Vercel and add the environment variables there. Every merge to `main` then deploys production. For the GitHub Actions scheduler, add `CRON_SECRET` as a repository secret (`gh secret set CRON_SECRET`) and set the repository variable `BASE_URL` to your deployment, because `drain.yml` defaults to the live site. The poller in `heroku-worker/` reads `CRON_SECRET` and `DRAIN_BASE_URL`.

### 6. Connect Meta

Sign in at `/dashboard` with `DASHBOARD_PASSWORD`. On an empty database, create the first workspace on the **Clients** page (**New tenant**): by name, or with an Instagram Page id and a Page access token (`POST /api/admin/tenants`). A workspace connects its Page with **Connect with Facebook**, or by pasting a permanent Page access token in Settings. Connect with Facebook is off until a platform admin switches it on in Settings. It needs the public base URL (a Settings value, or `PUBLIC_BASE_URL`), and `/api/meta/callback` must be a Valid OAuth Redirect URI in your Meta app.

To make a permanent Page token, start from a **User** token. `node --env-file=.env scripts/exchange-token.mjs <short-lived user token>` swaps it for a long-lived User token, reads `/me/accounts` and prints each Page's token with its expiry. It needs `META_APP_ID` and `META_APP_SECRET`. Exchanging a Page token directly gives only 60 days ([`docs/TOKEN_GUIDE.md`](docs/TOKEN_GUIDE.md)).

Meta also ends a user's data access about 90 days after they last approved the app, while the token still reports valid. Settings shows the date, and `scripts/diagnose.mjs` warns 14 days before.

### 7. Webhooks

In the Meta app, set the callback URL to `https://<your-domain>/webhook` and the verify token to `META_VERIFY_TOKEN` (or the one saved in Settings). Subscribe these fields:

- object `page`: `feed`, `messages`, `messaging_postbacks`, `messaging_referrals`. Connect with Facebook subscribes each Page to these for you (`src/services/metaLogin.ts`)
- object `instagram`: `comments`, `messages` (what `scripts/diagnose.mjs` expects)
- `leadgen` on a Page, only while a platform admin has recorded a lead-ads sign-off

Meta checks the verify token again at every subscription change, and a wrong or empty token fails with an opaque `HTTP 403`. Run the handshake check in Settings before you save a change in Meta's console. There is one callback URL per object type for the whole app.

### 8. Check it

`node scripts/diagnose.mjs --url https://<your-domain>` is read-only. It reads the database named in your `.env` and the deployment at `--url` (the default is the live site). It exits `0` healthy, `1` warnings, `2` critical, `3` could not run. `node scripts/watch.mjs` follows one comment or DM through the pipeline, also read-only. [`VERIFYING.md`](VERIFYING.md) is the full proof.

## Development

```bash
npm run start:dev    # local server on port 3000, reads .env
npm run typecheck    # tsc --noEmit
npm test             # node --test through tsx
find dashboard -name '*.js' -print0 | xargs -0 -n1 node --check   # the dashboard has no build step
```

CI (`.github/workflows/ci.yml`) runs on every pull request and every push to `main`. It runs typecheck, tests, the dashboard syntax check, and these guards (run one with `npm run <name>`):

| Guard | What it protects |
|---|---|
| `check:assets` | The dashboard cache version (see Gotchas) |
| `check:icons` | Icons that depend on reading direction are mirrored in right-to-left pages, and only those |
| `check:icon-subset` | `dashboard/js/icons.js` is what `scripts/build-icons.mjs` writes |
| `check:hero3d`, `check:font`, `check:og`, `check:brand-icons` | The committed landing bundle, display font, share cards and icon set match their builders. Rebuild with `npm run build:hero3d`, `build:font`, `build:og` or `build:brand-icons` |
| `check:contrast` | Token colours keep WCAG AA contrast |
| `check:i18n` | Every English string has an Arabic one |
| `check:voice` | The words the product never says do not appear in dashboard or public text |

**Deploys:** every merge to `main` deploys production through Vercel's Git integration. There is no manual deploy step. Each pull request gets a preview deployment. `vercel rollback` goes back ([`RUNBOOK.md`](RUNBOOK.md) §9).

## API surface

Mounts are in `src/index.ts` and `src/routes/api.ts`. [`FLOWS.md`](FLOWS.md) walks what happens behind each. Roles inside a workspace are `viewer` < `operator` < `owner`, and a platform admin acts as owner everywhere. A session token goes in `Authorization: Bearer`.

| Mount | File | Who may call it | For |
|---|---|---|---|
| `/webhook` | `src/index.ts`, `src/webhook/` | Meta: verify token on `GET`, HMAC signature on `POST` | Comment, message and WhatsApp events go to the job queue |
| `/health`, `/r/:code` | `src/index.ts`, `src/routes/links.ts` | Anyone | Liveness and database check. Tracked links: redirect and count the click |
| `/`, `/privacy`, `/terms`, `/data-deletion`, `/pricing`, `/eid`, `/robots.txt`, `/sitemap.xml` | `src/index.ts`, `src/routes/seo.ts`, `public/` | Anyone | The public site and legal pages |
| `/dashboard` | `dashboard/` | Static files. Its API calls need a session | The dashboard |
| `/api/auth/login`, `/api/uploads/:id`, `/api/interactions/export` | `src/routes/api.ts` | Anyone. Login is throttled per IP. The CSV needs a one-time link | Password login. Stored media for Meta and TikTok to fetch. The CSV download |
| `/api/invites` | `src/routes/invites.ts` | Anyone holding an invite token | `peek` and `accept` an invite link |
| `/api/tiktok`, `/api/youtube`, `/api/meta` (the callback, webhook and deauthorize paths) | `tiktok.ts`, `youtube.ts`, `meta.ts` | The provider. Each proves itself: a single-use state with its cookie, or an HMAC | OAuth redirects and provider webhooks |
| `/api/studio/worker` | `src/routes/studio.ts` | The Mac worker, with a per-workspace Bearer token | Claim jobs, report progress, upload files |
| `/api/jobs/drain`, `/api/cron/publish`, `/api/onboarding/drafts/sweep` | `src/routes/api.ts` | Bearer `CRON_SECRET` | Schedulers only: see Gotchas |
| `/api/auth/me`, `/api/auth/switch-tenant`, `/api/auth/password` | `src/routes/api.ts` | Any session | Who am I, change workspace, change password |
| `/api/{stats,campaigns,interactions,posts,upload,conversations,dm/funnel,settings,health/tenant,attention,creators}` | `src/routes/api.ts` | Any member reads, `operator` writes, `owner` changes the Meta token and webhook token. Some settings are platform admin only | The core dashboard API |
| `/api/tiktok`, `/api/youtube` | `tiktok.ts`, `youtube.ts` | Members read, `owner` connects, platform admin saves the app keys | Connections and publishing options |
| `/api/meta` | `src/routes/meta.ts` | `owner` connects, `operator` runs the comment check, platform admin saves app settings | Connect with Facebook |
| `/api/whatsapp` | `src/routes/whatsapp.ts` | Members read, `owner` writes | Number, agent mode, billing, entry links |
| `/api/studio` | `src/routes/studio.ts` | `operator`. `owner` manages workers. Explainers also need a switch that only the platform owner's workspace can have | Carousels, Monteur, infographics, explainers |
| `/api/growth` | `src/routes/growth.ts` | `operator` | Insights, coach, keywords, competitors |
| `/api/profile`, `/api/dm/ice-breakers` | `profile.ts`, `iceBreakers.ts` | Profile: `operator` reads, `owner` writes. Ice breakers: `owner` | The creator profile. Instagram ice breakers |
| `/api/ads` | `src/routes/ads.ts` and the `ads*.ts` files | `viewer` reads, `owner` writes. Answers `404` until a platform admin switches ads on | The Ads Manager |
| `/api/onboarding` | `onboarding.ts`, `onboardingDrafts.ts` | `operator` reads, `owner` writes | The setup wizard and the profile draft |
| `/api/admin` | `src/routes/admin.ts` and `admin*.ts` | Platform admin only. Anyone else gets `404` | Tenants, users, invites, jobs, audit, erasure, AI providers, media storage |

## Gotchas

1. **Two webhook secrets.** A webhook is accepted if its signature matches `META_APP_SECRET` or `INSTAGRAM_APP_SECRET` (`src/utils/signature.ts`). A bad signature gets a `403` before anything is written, so it looks like "no events arriving". The log line `webhook.signature_rejected` says how many secrets were tried.
2. **Vercel caps a request body at 4.5 MB.** `POST /api/upload` takes base64 JSON, so its real limit is about 3.2 MB of file (`src/routes/api.ts`). Larger media goes by a signed direct upload to Storage (`/api/ads/uploads/sign`, `/api/studio/worker/uploads/sign`).
3. **`/api/uploads/:id` must answer `Range` with `206`.** Players and Meta fetch media in pieces. Without `206`, every piece streams the whole file, and Vercel's CDN does not answer ranged requests from its cache (`src/utils/byteRange.ts`). Check: `curl -H 'Range: bytes=0-1023' -D - -o /dev/null <upload url>` must show `206` and `content-length: 1024`.
4. **Bump the dashboard cache version on every dashboard change.** Every `?v=` in `dashboard/index.html` and `ASSET_VERSION` in `dashboard/js/app.js` must change together, or a returning browser mixes old and new files. `npm run check:assets` fails otherwise, and also holds the pages in `public/` to the same number.
5. **The drain and cron endpoints are not dry runs.** `GET /api/jobs/drain` runs the real handlers, so it sends real DMs and replies. `GET /api/cron/publish` publishes every due post to the live accounts.

## License

The server in this repository is MIT (see [`LICENSE`](LICENSE)). The Studio worker and the Monteur and infographic templates are in a separate private repository and are not open source.
