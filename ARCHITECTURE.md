# AutoReply Pro — architecture: what runs where, and why

**Status:** reconciled against `main` on 2026-10-25 (`9300c3e`), when CI ran 16,274 tests. The first version of this file
(2026-09-21) was an assessment of a much smaller app, written while the hardening and tenancy branches merged; the branch
names that survive in §2–§9 are how those decisions were made, not where the code is.
**Audience:** whoever changes the system next. `FLOWS.md` walks each path hop by hop with a `file:line` at every step;
`README.md` maps every doc. This file says *why* the pieces are shaped as they are.

> This file lives at the repository root because `docs/` is mostly local-only (`.gitignore`), and this needs to be
> reviewable in a pull request.

**Citations name the symbol.** Line numbers rot (on 2026-10-25, 65% of FLOWS.md's had moved), so code is cited as a path and
a function or constant, with a line only where the line itself is the point.

---

## 0. The system today

### 0.1 Where things run

```
  Meta: Instagram, Facebook, WhatsApp, Marketing API        TikTok        Google (YouTube)
        │ webhooks                  ▲ Graph calls              ▲               ▲
        ▼                           │                          │               │
 ┌───────────────────── Vercel: one Express 5 app (@vercel/node, no build step) ─────────────────────┐
 │ POST /webhook ─► `jobs` (enqueue) ─► 200 ─► drainInline under waitUntil                           │
 │ /api/* (api.ts + the routers it mounts) · /dashboard (vanilla-JS SPA) · public pages · /r/:code   │
 │ GET /api/jobs/drain: the queue, due posts, and the sweeps · GET /api/cron/publish: once a day     │
 └──────┬─────────────────────────────┬──────────────────────────────┬──────────────────────────────┘
        │ pg, pooler :6543, max 3     │ Storage API                  │ HTTPS
        ▼                             ▼                              ▼
  Supabase Postgres             Supabase Storage              Gemini (the owner's DM bot) · the AI providers
  jobs, studio_jobs,            `media` (public),             layer (Anthropic, OpenAI, Gemini, OpenRouter,
  tenants, everything           `media-private`               Groq, Custom) · Cloudflare Workers AI (pictures)
                                                              · Telegram, Resend (alerts) · Groq/OpenAI (voice)

  Callers of /api/jobs/drain: the Heroku worker (every ~60 s) · GitHub Actions (every few hours) · Vercel cron (daily)

  The Mac render worker (repo aicourse-studio, launchd on the owner's Mac): claims `studio_jobs` over HTTPS
  (/api/studio/worker/*) → Remotion + ffmpeg renders, whisper.cpp, and the Claude CLI on the owner's plan (the "Mac brain")
```

Three things here are not the app: the **Heroku worker** (`heroku-worker/`, one file, no database access) and the **GitHub
workflow** only call the drain route on a timer (§2.3), and the **Mac worker** is a separate repository that the app never
calls; it polls the app. Everything the app knows lives in one Postgres database and one Storage project.

### 0.2 The subsystems

| Subsystem | Code | Walked in | Operator guide |
|---|---|---|---|
| Comment → DM automation | `src/webhook/comments.ts`, `src/services/matching.ts` | FLOWS §1 | Help → campaigns |
| DM bot: Gemini or the providers layer, plus the sales mode | `src/webhook/messaging.ts`, `src/services/ai.ts`, `src/services/dmEngine.ts`, `src/services/dmSales/` | FLOWS §2 | Help |
| The job queue | `src/jobs/` | FLOWS §5 | `RUNBOOK.md` |
| Scheduled publishing: Instagram, Facebook, TikTok, YouTube | `publishDuePosts` in `src/routes/api.ts`, `src/services/tiktokPublish.ts`, `src/services/youtubePublish.ts` | FLOWS §3, §6 | `docs/TIKTOK_GUIDE.md` |
| Tenancy, sessions, onboarding, creator profiles | `src/services/tenant.ts`, `src/middleware/auth.ts`, `src/services/onboarding/`, `src/services/profile/` | FLOWS §4, §9 | — |
| Meta Connect (Facebook Login for Business) | `src/services/metaLogin.ts`, `src/routes/meta.ts` | FLOWS §8 | `docs/TOKEN_GUIDE.md` |
| Studio and the Mac worker: carousels, the Monteur, infographics, explainers | `src/services/studio/`, `src/services/monteur/`, `src/services/explainers/` | FLOWS §7, §13 | `STUDIO.md`, `MONTEUR.md`, `docs/STUDIO_GUIDE.md` |
| The AI providers layer | `src/services/llm/` (no database), `src/services/aiProviders/` | FLOWS §7.1 | — |
| WhatsApp agent | `src/webhook/whatsappInbound.ts`, `src/services/whatsapp*.ts` | FLOWS §10 | `docs/WHATSAPP_GUIDE.md` |
| Ads Manager (A1–A12) | `src/services/ads/` (its own README) | FLOWS §11, §12, §7.5–§7.9 | `docs/ADS_GUIDE.md` |
| Growth hub | `src/services/growth/` | — | `GROWTH.md` |

### 0.3 What changed since the first assessment

From 2026-09-21 to 2026-10-25 the app went from about 550 tests and migration v15 to about 16,000 tests and v59 (54 ledger
entries). The decisions that changed the shape of the system, each with its record in §8:

- **The inline drain runs under `waitUntil`** (ADR-9), so a DM is answered in seconds, not minutes.
- **The queue is drained every minute** by the Heroku worker, and GitHub's schedule finally runs (§2.3).
- **Media moved to Supabase Storage** behind the `MediaStore` seam (ADR-3, amended), with a private bucket for customers' files.
- **Claude on the owner's Mac is the owner's only** (ADR-10); every other tenant's AI work goes through **the providers layer**
  on its own keys (ADR-11).
- **Ads spend obeys one money rule**, and no Graph call is made inside a database transaction (ADR-12).
- **Pictures are drawn by the app, on Cloudflare's free tier**, under an allowance reserved before each call (ADR-13).
- Four platforms (Instagram, Facebook, TikTok, YouTube) plus WhatsApp, a Studio with four tabs of generated content, the Ads
  Manager, onboarding with creator profiles, and the growth hub. §0.2 lists where each lives.

---

## 1. Current state: what is well-factored, and what is not

Being specific, because "it's fine" and "it looks fine" are different claims.

### Genuinely good seams

**`src/services/matching.ts`** is still the model the rest of the codebase should follow. It is a pure function over rows,
the webhook passes a query result straight in, and its tests exercise the ordering rules and the Arabic-Indic-digit case that
would silently break discount campaigns. The dashboard's dry run (`POST /api/campaigns/try`) decides with the same function
rather than a copy.

**`src/services/http.ts`** is a correct, small abstraction: one client, one timeout, one retry policy, and an explicit
distinction between transient and permanent Meta errors (`PERMANENT_CODES`, `isPermanentMetaError`: 190 = dead token,
200 = missing permission, 10903 = recipient blocked DMs). `RetryOptions.creates` encodes the rule learned the hard way: a call
that creates a public post is never retried once it may have landed.

**`src/config/crypto.ts`** is well-reasoned, and the reasoning is written down. The transparent-plaintext-read design
(`decryptSecret` returns unprefixed values unchanged) is what made encryption deployable without a migration window (ADR-7).

**`scripts/migrate.mjs`** and `src/config/migrations.ts` (`EXPECTED_MIGRATIONS`, asserted against the directory by a test):
a ledger, a checksum-drift warning, one transaction per file, and a non-zero exit on failure.

**`src/services/llm/`** is held clear of the database by a test (`llm/schema.test.ts`), so loading an adapter never loads the
pool, and every provider call takes an injected `fetch`. The same discipline shows in the ads proposals' ports
(`src/services/ads/proposals/ports.ts`), the split tests' `StudyPorts` and the explainers' `ImageProvider`: the parts that call
out are swappable in tests without a network.

**`src/webhook/errors.ts`, `meta-payload.ts`** are small, pure, and tested.

### Seams that are notional

**`src/services/tenant.ts` is still two modules in one file.** One half resolves "the one active creator" (`getActiveCreatorId`,
cached per warm instance in `cachedId`); the other resolves "the tenant this request acts as" (`resolveTenant`). A legacy
shared-password session still lands on `getActiveCreatorId()`, so "which tenant" has two answers until those sessions go (§6.3).
The `creator_id IS NULL` fallback in the tenant predicates is gone: a read-only audit found no NULL rows, and nothing in
`src/` outside the tests matches it any more.

**`src/routes/api.ts` is 4,832 lines.** Stage 5's split happened for everything new: the dashboard API is now `api.ts` plus
the routers it mounts (ads, studio, WhatsApp, YouTube, TikTok, onboarding, profile, growth, the `/r/` links, invites, Meta
Connect, ice breakers, admin…). But the original core (auth, cron and drain, uploads, stats, campaigns, scheduler, inbox, AI
settings, token management) still lives in one file and one router, and its mount order is load-bearing: `requireAuth`, then
`requireLiveSession`, then the admin router, then `resolveTenant`, with the login, the scheduler routes (drain, daily cron,
drafts sweep, each behind `requireCronSecret`), `/uploads/:id` and the one-time CSV export link deliberately above the auth
boundary. Any further split must keep that order explicit.

**`src/webhook/comments.ts` and `messaging.ts` are decomposed but not layered.** Each function still does normalisation,
tenant resolution, writes, quota checks, Meta calls and status bookkeeping in one pass, and the sales turn
(`src/services/dmSales/turn.ts`) added a second such pipeline beside the first. Their tests stub `pool.query` and `metaHttp`
(`comments.test.ts`, `messaging.test.ts`), which beats a live account but ties each test to the SQL text; the "decide" and
the "do" are still one function.

### The `any` boundary

`tsconfig.json` sets `strict`, `noUncheckedIndexedAccess` and `noUnusedLocals`. They buy less than they appear to on the paths
that matter, because those paths start at a value typed `any`: webhook bodies (`planJobs(body: any)`,
`processWebhookBody(body: any)`) and the 62 raw `pool.query()` calls left in `api.ts`, which resolve to `QueryResult<any>`.
The typed helpers (`queryOne`, `queryRows`, `queryCount` in `src/db/query.ts`) and the row types (`src/db/rows.ts`) close it
wherever they are used, which is most code written since September; ADR-4 is why they are hand-written.

---

## 2. The serverless fit

This is the deep question, so it gets the most space.

### 2.1 What was wrong

`src/index.ts` (pre-change) did:

```
verify signature → res.sendStatus(200) → await processWebhookBody(body)
```

with a comment correctly labelling it a stopgap. Two distinct constraints were being traded
against each other:

- **Meta's webhook timeout is ~20s**, and redelivers on timeout. A Gemini call is 2-8s
  (`GEMINI_TIMEOUT_MS` in `ai.ts` caps it at 30s), plus one or more Meta sends with retries and backoff
  (`withRetry` in `http.ts`, up to 3 retries at 0.5/1/2s base with jitter). A batch of several DMs
  comfortably exceeds 20s.
- **Vercel freezes the invocation after the response.** Work after `res.send()` is not
  guaranteed to run. Vercel's Fluid Compute changes this somewhat, but "somewhat" is not a
  foundation.

Answering late meant redelivery storms. Answering early meant silent loss. Both were chosen at
different times; neither is correct, because **the problem is not where the 200 goes, it is
that the work only ever existed in memory.**

The failure is invisible by construction. A DM abandoned mid-Gemini leaves an inbound
`messages` row (written by `claimInbound` in `messaging.ts`, before the AI call) with no outbound partner.
There is no error, no retry, no alert. It looks exactly like a customer who was never
answered because the bot was off.

### 2.2 What the webhook does now

Write the intent down, *then* acknowledge, then work under `waitUntil`:

```
verify signature → enqueue each event to `jobs` → res.sendStatus(200) → drainInline() under waitUntil (budgeted)
```

> This document says *why* the pipeline is shaped this way. For the same path hop by hop with a
> `file:line` at every step, see [`FLOWS.md`](FLOWS.md).

- `planJobs` (`src/webhook/router.ts`) is a pure function from one webhook body to a list of
  jobs. It cannot throw on a malformed body — tested against seven malformed shapes — because
  it runs before Meta is acknowledged and an exception there is a 500, and a 500 is a
  redelivery storm.
- Enqueue is one fast `INSERT` per event, well inside any timeout.
- `drainInline` (`src/jobs/drain.ts`) then does the common case immediately with an 8s budget,
  inside `acknowledgeThenRun` (`src/webhook/ack.ts`), which sends the 200 and hands the work to
  `waitUntil` so Vercel keeps the instance alive until it settles (ADR-9). Anything it never
  claimed stays `pending`; anything it claimed and did not reach goes back to `pending` (FLOWS §5.5).
- If the enqueue fails for any reason, the webhook falls back to the exact pre-change inline
  path (`processWebhookBody`, `src/index.ts`). `WEBHOOK_QUEUE=off` takes that path on purpose, as a
  rollback switch. The queue is additive; it cannot make things worse.

The worst case moves from *silently lost forever* to *still pending*. That is the whole point.

### 2.3 Who drains the queue (checked 2026-10-25)

Four callers, all safe to overlap because both claims are atomic (`jobs` by its `status` guard, `scheduled_posts` by its own):

| Caller | Interval | State |
|---|---|---|
| The webhook, after its 200 (`drainInline`, jobs only) | every delivery | on |
| **The Heroku worker** (`heroku-worker/worker.mjs`, ~$7/month), `GET /api/jobs/drain` and the onboarding drafts sweep | every ~60 s | **running**: both routes appear every ~62 s in Vercel's logs |
| GitHub Actions (`.github/workflows/drain.yml`, free) | asked for `*/5`, delivered every 2–4.5 h | green on schedule |
| Vercel cron (`vercel.json` → `/api/cron/publish`, Hobby plan) | once a day, 00:00 UTC | on; also the daily maintenance |

The history is worth keeping, because both mistakes in it came from reading a configuration instead of measuring it:

- **The GitHub workflow existed for weeks and never once succeeded.** `CRON_SECRET` was not a repository secret, so every
  scheduled run failed in its first seconds, which reads as "configured" in the Actions tab. Adding the secret on 2026-09-22
  was the whole fix. And the number in the cron expression is not the number you get: GitHub throttles scheduled workflows,
  and on this repository they arrive hours apart, not five minutes.
- **The Heroku worker had been scaled to zero** on the belief that the free schedule made it unnecessary. It was scaled back to
  1 on 2026-09-22, and verified by measurement rather than by the dyno count: three probe jobs inserted straight into the queue
  were claimed after 15 s, 26 s and 61 s, the spread a 60 s poll gives.

The worker is the caller that makes a minute-accurate schedule honest, so the dashboard's `PostsPage.FREQUENT_SWEEP` is tied to
it: scale the worker to zero and that flag must go back to `false` (`heroku-worker/README.md`). The daily Vercel cron remains the
backstop, so the worst case is bounded at 24 h, which was always the point of the queue. FLOWS §3.2 has the routes, the guard
and the response shape.

### 2.4 The cron and `scheduled_time`

The once-daily cron made `scheduled_time` day-granular despite the UI offering minutes: a genuine product lie, until the
drain route started calling `publishDuePosts()` too and the Heroku worker began calling the drain every minute. With the worker
on, a due post goes out within about a minute.

That fixed the symptom without the structural change this section proposed: a scheduled post is still a row the sweep finds,
not a `publish.post` job with `run_after = scheduled_time`. `publishDuePosts` (`src/routes/api.ts`) has its own atomic claim,
stale-claim reaper (on the daily cron, 15 minutes) and attempt cap (5), which the job runner duplicates. Moving it onto the queue
is still a handler extraction rather than a rewrite, and still not done (§7 Stage 2, §9).

---

## 3. Data layer

### 3.1 Media: Supabase Storage behind `MediaStore` (v23, v51)

This section used to say `media_uploads` is `BYTEA` and should not be. It was 267 MB of a 281 MB database on the 500 MB tier
by the time it moved, and every Meta ingestion pulled the bytes through the Postgres pool. Since migration v23, new uploads are
objects in the Supabase Storage bucket `media` whenever Storage is configured (Settings → Media storage); `getMediaStore()`
(`src/services/storage.ts`) picks `SupabaseStorageMediaStore` or the legacy `PostgresMediaStore` per call, and a legacy row keeps
serving from `data` until `scripts/migrate-media-to-storage.mjs` moves it. The seam (ADR-3) is what made this a one-module change.

What did not change, on purpose: **every file is still served as `/api/uploads/<id>` from this app's own domain.** TikTok pulls
photos only from the URL prefix verified in its portal, and Meta already holds these URLs on posts, so the object's own Supabase
URL is never handed out; the route streams it through. Two consequences followed:

- **A ranged request must be answered with a 206 and only that piece** (`parseByteRange`, `src/utils/byteRange.ts`). Vercel's CDN
  does not serve a ranged request from cache, and players and Meta's fetchers ask in pieces, so a route that ignored `Range` sent
  a whole reel per piece: 18.6 GB of the Hobby plan's 10 GB of Fast Origin Transfer in three days of October 2026.
- **Bodies never pass through a function on the way in either** where they can be large. Vercel caps a request body at 4.5 MB,
  so the ads builder and the Monteur's worker get a signed upload URL and PUT straight to Storage; only a metadata row is written
  through the app.

**Customers' files are private** (v51): a WhatsApp voice note or receipt is `is_private`, stored in the private bucket
`media-private`, and the public route answers 404 for it. Only a caller that names its tenant (`privateFor`) can read it.

### 3.2 `messages.raw_payload` retention

Every inbound DM writes the entire Meta event as JSONB, and before the sweep below it stayed there forever. Two problems:

- **Cost.** It is several times the size of the columns beside it, in the same 500MB tier.
- **Privacy, and a compliance gap.** It is a permanent record of what individual people wrote,
  with their Meta user ids, long after they stopped interacting. The app publishes a
  `/data-deletion` page (`public/data-deletion.html`) promising deletion, as Meta's Platform Terms require.
  A deletion that clears `messages.text` and leaves `raw_payload` holding the same text has
  deleted nothing. **That was the mechanism by which the published promise was untrue** — the
  most serious non-security issue in the first assessment.

`src/services/retention.ts` implements the sweep. It clears only `raw_payload`; `text`,
`direction` and `created_at` are what the inbox and `ai.ts`'s history window read and are
never touched. It is **opt-in** (`RAW_PAYLOAD_RETENTION_DAYS` unset = no-op) because nulling a
column is irreversible on a live account (ADR-5). The published `/data-deletion` page promises 30 days.

**It is set in production now:** `vercel env ls production` lists `RAW_PAYLOAD_RETENTION_DAYS`, added about 2026-09-21. Vercel
stores it as a secret, so its value cannot be read back from here; the daily cron's `cron.retention_sweep` line
(`rawPayloadsCleared`) is the way to confirm it is doing something. The same sweep deletes `done` jobs after 7 days, media no
post needs any more, and the onboarding drafts' fetched text.

### 3.3 Connection pooling

`src/config/db.ts`: `max: 3` (since 2026-09-21; it was 10), `idleTimeoutMillis: 30000`, through Supabase's transaction pooler on
port 6543. **Both recommendations below are done**; the reasoning stays because it is why the numbers are what they are.

The number that matters is not `max`, it is **`max` × concurrent warm instances**. Under a viral
reel, Vercel fans out to dozens of instances, each opening up to `max` connections. Supabase's
free tier direct-connection limit is around 60; the pooler's is higher but finite. The
realistic failure is connection exhaustion during exactly the traffic spike the product exists
to handle, surfacing as `connectionTimeoutMillis` expiries — which the `pool.on('error')`
handler (`db.idle_client_error` in `db.ts`) will log but cannot fix.

Three things, in order:

1. **Confirm `DATABASE_URL` points at Supabase's pooler (port 6543, transaction mode), not
   the direct port 5432.** If it is the direct port, this is the single highest-priority fix
   in this section. Cheap to check, and the symptom if it is wrong is indistinguishable from
   general slowness.
2. **Lower `max` to 2-3.** Counter-intuitive but correct for serverless: each instance handles
   a small number of concurrent requests, so a large per-instance pool buys nothing and
   multiplies the global count. With transaction-mode pooling, 1-2 is often right.
3. Only then consider Supabase Supavisor / an external pooler.

The queue helps here too: fewer long-lived handlers holding connections while awaiting Gemini. And two rules written since keep a
pooled connection from being held across a slow call: **no Graph call inside a database transaction** (ADR-12) and **no
transaction across an image-provider call** (ADR-13). A session-level setting on this pooler leaks onto whichever server
connection ran it, which is why read-only checks use `BEGIN READ ONLY` per statement (`connectReadOnly`, `scripts/lib/live.mjs`).
The pooler does saturate briefly after back-to-back deploys (EMAXCONN for about three minutes on 2026-10-22).

### 3.4 Smaller data-layer notes

- **No single artifact describes the live schema.** `schema.sql` plus 53 migration files (to v59; v43 and v46–v49 were never
  used), 54 ledger entries in all (`EXPECTED_MIGRATIONS`, `src/config/migrations.ts`). The ledger fixes *forward* drift and
  `src/services/health.ts` reports it on a live deployment, but neither reconstructs the present. Dumping the live schema to
  `schema/current.sql` in CI would.
- `interactions` has no index on `(creator_id, timestamp DESC)`, which is the dashboard's main
  query shape. `idx_interactions_creator` exists but is single-column.
- ~~`jobs` will accumulate `done` rows.~~ **Done (v14):** `pruneCompleted` deletes `done` rows after 7 days from the daily
  sweep; `failed` rows are kept, because they are the ones an operator reads (§9).

---

## 4. Cost model

Gemini is still the dominant marginal cost of the owner's DM bot. The structure of that cost is unusually lopsided and
therefore unusually easy to fix. (Two other AI costs exist now and are bounded differently: Claude on the owner's Mac runs on his
own plan (ADR-10), and every other tenant's AI work is billed to that tenant's keys through the providers layer, which writes an
`ai_usage` row per call and enforces the operator's budgets (ADR-11).)

### 4.1 Where the tokens go

Every call to `generateAiResponse` (`src/services/ai.ts`) sends:

| Component | Resent every call? | Rough size |
|---|---|---|
| System prompt | **yes** | 200-500 tokens |
| Knowledge base (`ai_agents.knowledge_base`) | **yes** | 1,000-5,000+ tokens, grows |
| Fixed instructions (`dmSystemInstruction`; in the tenant's language and register) | **yes** | ~150 tokens |
| Response schema (`dmResponseSchema`) | **yes** | ~400 tokens |
| Conversation history (`HISTORY_WINDOW = 8`) | partially | 200-800 tokens |
| Current user message | no | 10-50 tokens |

Arabic tokenises at roughly **2-2.5× more tokens per character than English** — Arabic script
is poorly covered by BPE vocabularies trained predominantly on English, so words fragment into
many subword pieces. For the owner both the knowledge base and the system prompt are Arabic, so the multiplier applies to the
largest, most-repeated component.

**Net: the static prefix is roughly 80-90% of input tokens on every single DM.** The variable
part — what the customer actually said — is a rounding error.

### 4.2 The fix: Gemini context caching

`cachedContents` bills the static prefix **once per TTL** rather than once per message, with
cached input tokens charged at roughly a quarter of the normal input rate.

Back-of-envelope, `gemini-2.5-flash`, a 3,000-token Arabic knowledge base, 1,000 DMs/month at
~4,000 input tokens each:

- Today: ~4.0M input tokens/month.
- With a 1-hour cache TTL and typical traffic clustering: ~0.4M uncached + ~3.6M cached.
- Effective cost reduction on the input side: **roughly 3.5-4×.**

The absolute numbers are small at one tenant. They matter for two reasons: the ratio is
invariant to scale, and adoption cost grows with knowledge-base size and tenant count. Doing
it at one tenant is a day; doing it at fifty is a migration.

The comment on `HISTORY_WINDOW` in `ai.ts` already identifies this. **Still not done for the Gemini path.** The providers engine
does the equivalent on Anthropic: `cacheSystem: true` puts the persona, knowledge base and rules in one cached system block
(`generateDmViaLayer`, `src/services/dmEngine.ts`), which pays off within a live back-and-forth (a 5-minute cache).

### 4.3 Measure first — not yet possible from the logs

`ai.ts` logs `ai.usage` on every success with `prompt_tokens`, `output_tokens`, `total_tokens`, `cached_tokens` and
`history_turns`. **Every one of the four token fields prints `[redacted]`:** the logger blanks any field whose NAME matches
`REDACT_KEY` (`/(token|secret|password|…)/i`, `src/utils/log.ts`), and `prompt_tokens` contains "token". Only `history_turns`
and the model survive. The same trap hid `webhook.signature_rejected`'s two diagnostic fields until PR #261 renamed them. Until
these fields are renamed (or the redaction learns that `*_tokens` counts are not secrets), the week of measurement this section
asks for cannot be taken from the logs. The providers layer's `ai_usage` table does record tokens and cost, but only for calls
that go through the layer.

### 4.4 Cheaper adjacent wins

- **`HISTORY_WINDOW` was trimmed 15 → 8.** Correct direction. With caching in place the
  history is the *only* uncached part, so it becomes the thing to tune, not the prefix.
- **A cheaper model is not a settings change today.** `SUPPORTED_MODELS` (`ai.ts`) is 2.5 Flash, 3.5 Flash and 3.8 Flash; the
  Flash-Lite models are not on it. On 2026-09-25 both 3.x Flash-Lite models fell into repetition loops on the carousel schema in
  most runs, 3.8 Flash answered 503, and 2.5 Flash was clean (the numbers are on `DEFAULT_MODEL`). The key itself is the other
  constraint: the DM key gets 404 on 2.5 Pro and 2.5 Flash-Lite, and a fresh key will probably 404 on the 2.5 Flash default too,
  so the default must move to a tested 3.x model before that key is rotated.
- **Do not send the response schema when it is not needed.** Most replies are
  `message_type: "text"`; the carousel and quick-reply branches of `dmResponseSchema`
  are ~400 tokens sent on every call to support a minority of responses. A
  two-tier approach (cheap text-only schema, retry with the full schema when the model asks
  for structure) is possible but adds a round-trip. **Lower priority than caching** — caching
  makes the schema free anyway, since it is part of the static prefix.

---

## 5. Failure modes and observability

### 5.1 What was wrong

150 `console.*` calls across `src/` (not ~60), the large majority prefixed with an emoji and
interpolating values into a prose sentence. Two consequences:

- **Unsearchable.** "Which comments failed to match a campaign last Tuesday?" is a question
  about a field, and there were no fields. Vercel's log search is substring-only.
- **Uncorrelated.** One Meta delivery fans out to a dozen lines across the router, the
  pipeline, the Meta client and the retry helper. Interleaved with concurrent deliveries —
  normal — there was no way to tell which lines belonged together.

The project's own docs describe a webhook signature failure as *invisible*. It was not
invisible — `index.ts` logged it — but it was **unfindable and un-alertable**, which is
operationally the same thing.

### 5.2 Structured logging

`src/utils/log.ts`: `log(level, event, fields)` emitting one JSON object per line. No
dependency — `JSON.stringify` and `AsyncLocalStorage`, both stdlib. Key properties:

- **`event` is a dotted machine-stable name**, not a sentence. Sentences get reworded and the
  alert that depended on the old wording stops firing silently.
- **Request correlation via `AsyncLocalStorage`** (the logging middleware in `src/index.ts`), preferring Vercel's own
  `x-vercel-id` so platform and application logs join for free. The correlation id is
  carried across the queue boundary in `jobs.request_id` and re-established by the runner
  (`runOne`, `src/jobs/runner.ts`), so a search for one delivery returns the work it caused, not just its
  acknowledgement.
- **Key-name redaction** for anything matching `token|secret|password|passwd|api_key|authorization|
  signature|cookie` (`REDACT_KEY`), applied recursively. This matters: an axios error's `config.headers`
  carries the Gemini API key, and `describeError` is called on axios errors throughout. **It matches the field's
  NAME, not its value, and that is a trap:** a count named `total_tokens`, a status named `token_status`, a boolean
  named `has_cookie` all print `[redacted]`. It hid the signature-rejection diagnostics until PR #261 renamed them
  (`app_keys_tried`, `instagram_app_configured`), and it still hides `ai.usage`'s token counts (§4.3) and
  `token.rechecked`'s `token_status`. Name a field for what it holds, not after the secret it is about.
- **It cannot throw.** It runs inside `catch` blocks. Circular references (an axios error
  holds request→response→config→request), `BigInt`, and `Error`'s non-enumerable fields are
  all handled; a failing sink is swallowed.
- **`describeError`** lifts `meta_code` / `meta_subcode` out of axios errors. This is the
  field that distinguishes a dead token (190) from a missing permission (200) from a
  recipient who blocked DMs (10903) — three different operator actions that the previous
  `err.message` logging rendered as one indistinguishable string.

The `console.*` calls left in `src/` are a deliberate exception in `src/config/env.ts` (they run before anything is serving,
there is no request to correlate, and the audience is a person reading a terminal) and `src/db_check2.ts`, an unreferenced
ad-hoc debug script that nothing imports and no route reaches; it should simply be deleted (§9). The default level is `info`
and production sets no `LOG_LEVEL`, so a `debug` line never prints there (FLOWS's silent-path index marks which evidence that
hides).

One privacy fix landed alongside: `api.ts` logged the full text of every manual inbox reply.
It now logs the length.

### 5.3 What should alert

Structured events make this expressible. In rough priority:

| Event | Condition | Why it matters |
|---|---|---|
| `webhook.signature_rejected` | any occurrence | Half of all traffic silently 403ing is the documented worst-case failure. `app_keys_tried` and `instagram_app_configured` are on the line. |
| `dm.quota_exhausted` | any occurrence | Real customers are being dropped. |
| `job.failed` | any occurrence | A job that spent its attempts. Nothing else will retry it. |
| `token.status_failed` / `meta_code: 190` | any occurrence | Dead Meta token — the whole product stops, and nothing else notices. |
| `webhook.enqueue_failed_falling_back` | any occurrence | Durability is off; the app is back to pre-queue behaviour. |
| `comment.no_campaign_match` | rate change | Not an error, but a sudden spike means a campaign was deactivated or a keyword broke. |
| `job.drain_complete` | `budgetExhausted: true` sustained | The drain cannot keep up; the external scheduler is missing or too infrequent. |
| `ai.usage` | `total_tokens` trend | Cost regression, e.g. someone pasted a 50KB knowledge base. **Prints `[redacted]` today (§4.3).** |
| `runtime.wait_until_unavailable` | any occurrence | The inline drain is running without `waitUntil`: DM latency goes back to minutes (ADR-9). |
| `ads.cap_paused_all`, `ads.cap_check_failed` | any occurrence | Money: the cap paused every campaign, or a check of the cap failed (2 h of failures raises the `guard_blind` alert). |

None of this needs a vendor. Vercel log drains into any HTTP endpoint, and these are JSON
lines. **Nothing reads them on a schedule yet**: Vercel's own log search reaches back about an hour, so an incident older than
that is reconstructed from the database and the Graph API, not the logs.

**What does reach a person now** is a second, separate path: product alerts sent by the app itself. The DM bot's handoffs and
hot leads go to the owner by Telegram (`src/services/notify.ts`, a bot token in `app_settings`) and/or email through Resend
(`src/services/notifyEmail.ts`); the ads guard and rules write an `ads_alerts` row first (once a day per kind and object) and
then send the same way (`src/services/ads/notify.ts`). Those are deliberate notifications about the business, not log alerts
about the system, and the gap above is still open.

### 5.4 The observability gap that remains

**There is no health signal for "the pipeline is working".** Every alert above is
failure-triggered, and the defining characteristic of this system's worst failures is silence.
A comment matching no campaign writes no row; a webhook that stops arriving writes nothing at
all. `GET /health` still checks the database and nothing else (`SELECT NOW()`). The closest things are run by hand:
`scripts/diagnose.mjs`, and the admin Tenants screen's last-webhook column.

The fix is a liveness metric, not a log: last successful `comment.matched` / `dm.sent`
timestamp per tenant, alerting on staleness relative to that tenant's normal rhythm. Proposed
only (§9) — it needs a baseline of real traffic to set thresholds that do not cry wolf.

---

## 6. Multi-tenancy at scale

The engineering is in decent shape and the constraint is not engineering.

### 6.1 The shared-pool problem

Meta's app-level rate limit is **`200 × daily active users` per hour**, pooled across the
entire app. Per-account limits scale naturally with customers; this one does not, because
"daily active users" counts *users of the app*, not tenants, and calls from all tenants draw
on the same pool.

The consequence: **one tenant with a viral reel can 429 every other tenant.** And because the
429 arrives as a Meta error on an individual send, the victim tenants see "some DMs failed"
with no indication that another customer caused it.

`src/utils/rateLimiter.ts` is per-creator (`DEFAULT_HOURLY_LIMIT = 180`). That is
the right shape for protecting Meta from any one tenant, and the wrong shape for protecting
tenants from each other, because N tenants × 180/hr has no relationship to the app-wide pool.

What is needed, in order:

1. ~~**A global bucket in addition to the per-creator one.**~~ **DELIVERED (v14).**
   `checkAppSendQuota` counts the app-wide pool and `checkFairSendQuota` checks both ceilings,
   creator first, app second. Every Meta send path calls it (the comment path, the DM path, the
   sales turn, its follow-up nudge, the failure handoff and the attachment acknowledgement), and
   `interactions.error_log` records *which* ceiling refused,
   so a tenant throttled by another tenant's traffic can be told that rather than debugging
   their own account.

   The sentinel-creator-id plan above was wrong and was abandoned: `rate_limit_counters` has
   `creator_id` in its primary key, NOT NULL with a foreign key to `creators`, so an app-wide
   row would have required either a fake creator or rebuilding a live table's primary key. A
   separate `app_rate_limit_counters` table instead — same shape, same 48h pruning, one fewer
   column (`migration_v14_functionality.sql:33-53`, pruned by `pruneRateLimitData`). The
   default ceiling is 1,000/hr via `META_APP_HOURLY_LIMIT`, deliberately generous so that
   turning it on could not throttle the single live account; lower it once the app's real DAU
   is known. (Production does not set it, so 1,000 applies.)

2. ~~**Round-robin by `creator_id`.**~~ **DELIVERED (v14) — but not as proposed here, because
   as written it was impossible.** `jobs.creator_id` is **NULL on every row the webhook
   writes**, by design: resolving the tenant needs a database read and the entire point of
   enqueueing is to get off the Meta clock before doing any (`planJobs`, `src/webhook/router.ts`;
   `migration_v13_jobs.sql:32-34`). Partitioning on it would have grouped every job in the
   table together and changed nothing.

   The partition is a new `jobs.tenant_key` column holding `entry.id` — the Meta page id the
   delivery is addressed to, which is already in the payload and needs no lookup. See ADR-6.
   `claim` now ranks each tenant's pending jobs oldest-first and takes every tenant's oldest
   before anyone's second (`claim`, `src/jobs/queue.ts`).

3. **Per-tenant quotas as a product feature**, with the app-wide pool as the real budget being
   allocated. Still open, and now the only one of the three that is.

### 6.2 The blocker is Meta, not code

Serving other people's accounts requires **Advanced Access**, which requires **Business
Verification plus per-permission App Review** for roughly six permissions including
`instagram_content_publish` and `pages_messaging`. Months of process with genuine rejection
risk. Standard Access covers the owner's own accounts, which is why the DM bot has answered
members of the public since about 2026-10-13 without it.

The architectural implication is real and worth stating: **do not build for scale that Meta
will not permit.** What was built instead is a *managed* service: the operator creates tenants
and invites their people (`src/routes/invites.ts`), a tenant connects its own Page through
Facebook Login for Business (FLOWS §8) and, for ads, uses its own system-user token and ad account
(ADR-12; Meta bills the client, never the platform). Self-serve signup is deliberately not built.
Fair queueing and the global rate bucket landed anyway (v14), because they were cheap; per-tenant
quotas as a product (§6.1 item 3) wait for Advanced Access.

### 6.3 Remaining tenancy debt

- `resolveTenant` falls back to `getActiveCreatorId()` for a legacy shared-password session
  (`src/services/tenant.ts`), which still mints a `platform_admin` session. Until those sessions are
  removed, "which tenant" has two answers.
- The `cachedId` module cache (`tenant.ts`) is per-instance state; correct only while there is one
  active creator. The owner is identified separately and stably (`getPlatformOwnerId`: the first
  creator ever made, active or not), which is what the Mac-brain guard and the owner-only switches use.
- Isolation is enforced in the queries, so every new query must name its tenant. The ads module
  makes that a test (`src/services/ads/isolation.test.ts` scans every `ads_*` query for `creator_id`);
  nothing does the same for the rest of the schema.
- RLS is enabled deny-by-default (v11) but the app connects as the table **owner**, which RLS
  does not apply to. It is a blast shield against a leaked anon key, not tenant isolation.
  Real isolation needs a non-owner role, `FORCE ROW LEVEL SECURITY`, and policies keyed on a
  verified session claim. The v11 migration says this clearly and honestly.

---

## 7. The staged migration, and where each stage stands

The stages proposed on 2026-09-21, and what became of them by 2026-10-25. Each was meant to be shippable on its own; most
shipped, two in a different form than proposed.

| Stage | Proposed | State on 2026-10-25 |
|---|---|---|
| 0 | Structured logging, the job seam, enqueue before the 200, the `MediaStore` seam, row types, opt-in `raw_payload` retention | **Done** (2026-09-21) |
| 1 | Turn on what exists: apply v13, set `RAW_PAYLOAD_RETENTION_DAYS`, use the pooler and a small `max`, point a scheduler at the drain | **Done.** The ledger has 54 entries; the retention variable exists in production (§3.2); `max: 3` on the 6543 pooler; the Heroku worker and the GitHub schedule both drain (§2.3) |
| 2 | Scheduled publishing as a `publish.post` job with `run_after = scheduled_time` | **Not done, and less needed:** the minute-level drain made the schedule honest without it (§2.4) |
| 3 | Media to object storage | **Done differently:** Supabase Storage rather than Vercel Blob, and the URL kept on this domain and streamed rather than redirected, because TikTok's verified prefix and Meta's stored URLs need it (§3.1) |
| 4 | Tenancy: an app-wide rate bucket, a round-robin claim, drop the legacy-session fallback, `cachedId` and the `creator_id IS NULL` predicates | **Mostly done:** the bucket and the round-robin (v14; on `tenant_key`, ADR-6), the NULL predicates removed. The legacy-session fallback and `cachedId` remain (§6.3) |
| 5 | Split `api.ts` by feature, with one explicit composition root | **In part:** every subsystem built since has its own router, but the original core is still one 4,832-line file (§1) |

What would change the system's character next, in the order this document would take them (proposals, not plans anyone has
approved):

1. **Make the logs measurable:** rename the fields `REDACT_KEY` blanks by accident (`ai.usage`'s token counts, `token.rechecked`'s
   `token_status`), or teach the redaction that a number is not a secret (§4.3, §5.2). Small, and it unblocks §4's measurement.
2. **A scheduled liveness check** that alerts on silence relative to each tenant's own rhythm (§5.4). `scripts/diagnose.mjs`
   already has the hard half; nothing runs it on a timer.
3. **Gemini context caching** for the owner's DM bot (§4.2), once 1 has made the before-and-after measurable.
4. **Retire the legacy shared-password session**, which removes the last second answer to "which tenant" (§6.3).
5. **Stage 2**, when more than one tenant schedules posts and the sweep's bespoke claim, reaper and cap become the third copy of
   machinery the job runner already has.

---

## 8. Decision records

### ADR-1 — Write to the queue *before* acknowledging Meta, and drain inline after

**Chosen:** enqueue → 200 → budgeted inline drain, with automatic fallback to the legacy
inline path if the enqueue fails.

**Rejected — keep the post-response `await` (status quo).** Work is lost on freeze *and* Meta
has been told it succeeded. Unrecoverable and invisible.

**Rejected — enqueue and return, with no inline drain.** Architecturally cleanest, and wrong
here: with no per-minute drainer provisioned, DMs would be answered once a day. That is a
catastrophic product regression in exchange for a purity win. The inline drain makes the
change behaviour-neutral on the happy path, which is what makes it safe to ship to a live
account.

**Rejected — return 503 when the enqueue fails, so Meta redelivers.** Genuinely better
engineering: it converts a database outage into a retry rather than a dropped event. Not
shipped because Meta's redelivery behaviour under sustained 5xx is a documented hazard in this
project and the blast radius of getting it wrong is the whole product. Proposed for Stage 2,
once the queue has production history.

**Consequence:** the worst case is "still pending" rather than "lost". The cost is a table
that accumulates rows (see §9) and one extra round-trip per event.

**Amended (2026-10-14):** "behaviour-neutral on the happy path" turned out to be false on Vercel. The inline drain was awaited
*after* the 200, where the instance can be frozen, so a claimed DM waited for a thaw (~70 s) or the 300 s reaper: `dm.process`
ran at p50 125 s. The drain now runs under `waitUntil` (ADR-9). The 503-on-enqueue-failure idea is still not shipped.

### ADR-2 — Postgres as the queue, not QStash/SQS/Redis

**Chosen:** a `jobs` table with an atomic claim, behind a `JobQueue` interface.

**Rationale:** the database is already here, already pooled, already backed up. At this volume
the extra round-trip is irrelevant next to the 2-8s Gemini call it wraps. The deciding factor
is operability: a stuck job can be inspected with the SQL editor the operator already has open
at 2am, which is not true of a hosted queue's dead-letter console.

**Amended (v14): the claim is not `FOR UPDATE SKIP LOCKED`, and cannot be.** Postgres rejects
`FOR UPDATE` outright in the presence of a window function, so once fair queueing made the
claim a `ROW_NUMBER() OVER (PARTITION BY tenant_key …)` the previous shape could not have run
at all. Atomicity now comes from `AND status = 'pending'` on the `UPDATE` itself: a contending
claimer waits on the row lock, re-evaluates its `WHERE` against the committed version, reads
`'running'` and skips it. Same guarantee — two drains split the work and cannot both run one
job — and the only thing lost is that a contender waits the length of one autocommit `UPDATE`
rather than skipping ahead (`claim`, `src/jobs/queue.ts`).

**Rejected — QStash.** The right answer at 10-100× this volume, and it cannot be provisioned
from here. `JobQueue`'s methods map 1:1 onto publish/receive/ack/nack/visibility-timeout
precisely so this is a new file, not a refactor.

**Rejected — in-memory queue with no table.** Solves nothing: the problem is durability across
invocation death.

**Consequence:** `jobs` rows accumulate and need their own retention — since delivered, see
§9. Claim contention is handled by the status guard but is not free at very high concurrency.

### ADR-3 — A `MediaStore` interface now, `BYTEA` behind it

**Chosen:** introduce the seam, keep the implementation.

**Rationale:** the reason media has not moved is that it *reads* as a big change when in fact
the storage decision is reachable from two call sites. Making that true in the type system
converts a scary migration into a scheduled one. Provisioning a bucket is not possible from
here anyway.

**Rejected — move to Vercel Blob now.** Requires provisioning; explicitly out of scope.

**Rejected — leave it alone until the move happens.** The seam is 113 lines and makes the move
a day's work instead of a week's. Cheap insurance.

**Amended (v23, 2026-09-26): the move happened, and the seam paid for itself.** `SupabaseStorageMediaStore` is a second
implementation beside `PostgresMediaStore`, chosen per call by `getMediaStore()` (§3.1). Supabase Storage rather than Vercel Blob:
it came with the database's project, needed no new vendor, and its free gigabyte was twice the database's whole tier. The
callers did not change. v51 added private rows (`is_private`, the `media-private` bucket) through the same interface.

### ADR-4 — Hand-written row types, not a generated schema or an ORM

**Chosen:** `src/db/rows.ts`, maintained by hand against the migrations.

**Rationale:** the `any` boundary is the single biggest reason `strict` buys nothing here.
Row types close it at the call sites that matter for a few hours' work and zero runtime risk.

**Rejected — a query builder or ORM (Kysely, Drizzle, Prisma).** The SQL in this codebase is
good and several statements depend on Postgres specifics a builder would obscure or forbid:
the `ON CONFLICT ... WHERE ... DO NOTHING` idempotency claims, the window-function fair claim,
the atomic publish claim, the allowance's single-statement reserve. The problem was never the SQL — it was that the results
were untyped. Adding an ORM would also add the first heavyweight dependency to a project with five runtime dependencies
(`@vercel/functions` joined the original four for `waitUntil`).

**Rejected — generated types (`pg-to-ts`, `kysely-codegen`).** Strictly better, and it needs a
live database connection at build time, which CI does not have. **This is the right eventual
answer** and the honest weakness of ADR-4: nothing enforces that `rows.ts` still matches the
database. Recommended follow-up: a CI job that connects to a migrated throwaway database and
diffs generated types against the committed ones.

**Consequence, already realised:** writing these types immediately caught `Creator.is_active`
being declared non-optional while never being selected on the webhook path.

### ADR-5 — Retention is opt-in, and clears only `raw_payload`

**Chosen:** `RAW_PAYLOAD_RETENTION_DAYS` unset = no-op; a misconfigured value disables rather
than falling back to a default; minimum accepted window is 7 days; only the `raw_payload`
column is cleared, never the row.

**Rationale:** this is a live account and nulling a column is irreversible. Deleting on a
schedule the operator did not explicitly ask for is worse than not deleting. The 7-day floor
exists because a shorter window would destroy the evidence needed to debug a webhook problem
that is still happening.

**Rejected — deleting whole message rows.** `text`, `direction` and `created_at` are what the
inbox renders and what `ai.ts` reads back as history. Losing them changes the product.

**Rejected — a sensible default like 90 days, enabled automatically.** Correct for a new
product; wrong for one already holding a real customer's data under a different implicit
policy. §7 Stage 1 says to set it to 90 deliberately.

**Amended:** the published `/data-deletion` page commits to deleting the verbatim Meta event
**after 30 days**, not 90. The page is the promise, so 30 is the value to set. Note that the
*opt-in* decision above means the promise is untrue until somebody sets it — see RUNBOOK.md §7.

**Amended (2026-10-25):** the variable is set in production (§3.2); its value is a Vercel secret and cannot be read back, so
`cron.retention_sweep` is the evidence that it works.

### ADR-6 — `tenant_key` (the Meta page id), not `creator_id`, as the fair-queueing partition

**Chosen:** a new `jobs.tenant_key TEXT` holding `entry.id`, defaulting to the creator id at enqueue
(`enqueue`, `src/jobs/queue.ts`), partitioned on in the claim (`claim`), indexed by
`idx_jobs_claimable_fair (tenant_key, run_after) WHERE status = 'pending'` (`migration_v14_functionality.sql:71-72`).

**Rejected — `creator_id`, as §6.1 originally proposed.** Not a preference: it does not work.
`jobs.creator_id` is NULL on every row the webhook writes, because resolving the tenant costs a
database read and enqueueing exists precisely to get off Meta's ~20s clock before doing any
(`planJobs`, `src/webhook/router.ts`). Every row would fall in one partition and the round-robin would
degenerate to the FIFO it replaced — while looking, in the code, like it worked.

**Rejected — resolve the tenant at enqueue time so `creator_id` is populated.** This is the
version that keeps the schema clean, and it pays for it in the one place with no budget. It
also reintroduces a failure mode the queue was built to remove: the tenant lookup is now on the
critical path, so a slow database delays the acknowledgement rather than the work.

**Rejected — `COALESCE(tenant_key, creator_id)` in the claim's `PARTITION BY`.** Costs a sort
on every claim, because an expression cannot be satisfied by the index. Doing the COALESCE once
at enqueue costs nothing and lets the partition and the ordering both come off the index.

**Amended (2026-09-27): the default moved from SQL to JS.** The enqueue's `COALESCE($8, $3::text)` reused `$3`, so Postgres
deduced it as both uuid and text and rejected the statement (42P08). **Every enqueue failed from 2026-09-21 to 09-27**; the
webhook fell back to its inline path (ADR-1's fallback doing exactly its job), and Vercel froze some of those before they
finished, so real comments went unanswered. `input.tenantKey ?? input.creatorId` in JS now does the same thing.

**Consequence:** the partition key is not the tenant's identity. It is a stable per-tenant
*proxy*, and a tenant with two page ids (Instagram and Facebook) occupies two slots rather than
one — fairer to them than to everyone else, in a direction small enough to ignore at this
volume. Jobs with no key at all share one group, which is the conservative answer: they
compete with each other rather than each getting a slot.

### ADR-7 — Application-layer AES-256-GCM for token encryption, not Supabase Vault

**Chosen:** encrypt `creators.page_access_token` in the application with AES-256-GCM, key in
`TOKEN_ENCRYPTION_KEY`, stored as `enc:v1:<iv>:<tag>:<ciphertext>`
(`encryptSecret`, `src/config/crypto.ts`). Decryption is funnelled through one function
(`decryptSecret`, called where `src/services/tenant.ts` reads a creator row).

**Rationale — the threat model decides it.** The threat is *database access*, and it is not
hypothetical: the production connection string, with the password, was committed to a public
repository, and `page_access_token` was plaintext beside it. A key stored in the same database
as the data does not defend against that at all. An environment-held key lives in a different
trust domain, so the leak that already happened would not have been enough
(the header of `src/config/crypto.ts`).

**Rejected — Supabase Vault / pgsodium.** The key material is reachable from the same
credential that reaches the ciphertext, which is the exact adversary here. pgsodium is also
pending deprecation. Convenient, and defends against the wrong thing.

**Rejected — encrypt later, once tenancy exists.** Migrating plaintext secrets after multiple
tenants exist means rotating every tenant's Meta token simultaneously. Doing it while there is
one account is nearly free.

**Rejected — a required key with a hard migration window.** `decryptSecret` returns an
unprefixed value unchanged, so legacy plaintext keeps working and
each token becomes encrypted the next time it is saved. The cost is that "encrypted at rest" is
true per row rather than per table, which is why `diagnose.mjs` warns per tenant when it finds
plaintext.

The same scheme now holds every secret the operator types into Settings: the keys listed in `SECRET_KEYS`
(`src/services/appSettings.ts`: the TikTok and YouTube client secrets, the Gemini and AI-provider keys, the Storage key, the
Telegram bot token, the email API key) and the per-tenant secret prefixes, the Cloudflare token (`explainers/pictures/provider.ts`),
and, with `encryptBytes`, the answers of lead-ads forms.

**Consequence:** losing `TOKEN_ENCRYPTION_KEY` is unrecoverable — every tenant must paste a
fresh token. That is the accepted price of the key not being in the database. It is also why
the key is deliberately *not* required at startup but *is* required to write a token, and the
endpoints say so.

### ADR-8 — One cross-tenant admin surface, 404 rather than 403

**Chosen:** `src/routes/admin.ts`, mounted at `/api/admin` inside `requireAuth` +
`requireLiveSession` and gated again on `role === 'platform_admin'`
(the `/admin` mount in `src/routes/api.ts`, and the router's own role check in `src/routes/admin.ts`). Dashboard screens **Tenants** and **Users**,
hidden unless the session says admin (`dashboard/js/app.js`).

**Rationale:** two things had no home. Creating a creator had no UI and no API at all — a fresh
deployment was unusable until someone hand-wrote an `INSERT` in the Supabase SQL editor. And
"is anything broken for anybody" is a question the per-tenant dashboard **structurally cannot
answer**, because every other route in the app is deliberately pinned to one tenant
(the header of `src/routes/admin.ts`).

**Chosen — 404, not 403, for a non-admin.** Confirming that an administrative surface exists is
itself a disclosure. `resolveTenant` does the same for a tenant the
session may not act as (`src/services/tenant.ts`).

**Chosen — `token_version` as the only revocation mechanism.** Sessions are stateless HMACs
with a 24h TTL, so before this column a leaked token simply could not be taken back. Bumping it
invalidates every session a user holds, checked against the database on each request so a
revoked membership takes effect immediately rather than at expiry
(the admin routes that change a membership, and `resolveTenant`).

**Rejected — a token re-check endpoint in this increment.** `GET /api/admin/tenants` *reads*
`token_status` and `last_webhook_at`; nothing re-asked Meta. Passive
detection covers the important case — every send path calls `noteMetaFailure`, so a revoked
token flips the row on the first real failure (`src/services/tokenHealth.ts`) — but a token
that died while the account was quiet read stale until someone opened the page or ran
`diagnose.mjs`. **This was the honest gap in ADR-8.**

**Closed since (P29):** the daily cron re-asks Meta about every connected tenant's token (`recheckAllMetaTokens`,
`src/services/metaTokenRecheck.ts`), including the data-access expiry that lapses while `/debug_token` still says `is_valid`,
and flags "reconnect due" on the Connections card and Overview. `POST /api/admin/tenants/:id/recheck-token` and Settings'
`POST /api/settings/token/recheck` do the same on demand.

**Rejected — deriving `last_webhook_at` from a dedicated column.** Derived instead from
`GREATEST(max(interactions.timestamp), max(messages.created_at))`, which needs no writer
changes and reports correctly for a tenant that only ever receives one of the two kinds
(`src/routes/admin.ts`). The limitation is stated in §5.4's terms: a comment matching no
campaign writes no `interactions` row, so this column can look stale on a perfectly healthy
tenant. `jobs` is the unambiguous signal.

---

### ADR-9 — Keep the instance alive for the inline drain with `waitUntil` (2026-10-14)

**Chosen:** `acknowledgeThenRun` (`src/webhook/ack.ts`) sends the 200, starts the work, and hands the running promise to
`waitUntil` (`src/utils/waitUntil.ts`, over `@vercel/functions`), which tells Vercel the invocation is not over until it settles.
Two rules make it a module of its own: the caller must *start* the work (`waitUntil` runs nothing, and outside Vercel it does
nothing at all), and the handoff must never throw, since it runs after the response.

**Context:** ADR-1's inline drain was awaited after the 200, where Vercel may freeze the instance. A claimed job then waited for
a thaw (about 70 s) or for the 300 s stale-claim reaper, so over the 14 days to 2026-10-14 `dm.process` ran at p50 125 s and
p90 362 s for a DM bot that had just started answering the public.

**Rejected — answer Meta after the work.** Meta's ~20 s timeout and its redeliveries (ADR-1).

**Rejected — leave latency to the external drain.** Even the 60-second worker makes every DM wait up to a minute, and on the day
this was found the GitHub schedule was running hours apart.

**Consequence:** a DM is answered in seconds again. Where the platform gives no request context the call is a silent no-op, so
it logs `runtime.wait_until_unavailable` once per instance: if latency comes back, that is the line to look for. The same
helper counts `/r/` clicks after the redirect and runs the ads write queue inline after a 202.

### ADR-10 — Claude on the owner's Mac does the owner's work only

**Chosen:** four kinds of Studio work are answered by the Claude CLI on the owner's Mac, on his personal plan: `monteur_think`,
`render_infographic` jobs that carry `write`, `ads_think` and `explainer_write`. The server refuses them for every tenant except
the owner (`getPlatformOwnerId`: the first creator ever made, active or not) and those listed in `studio.mac_brain_tenants`,
in code rather than by convention: in `think()`, `createInfographic` / `rerenderInfographic`, `enqueueJob`, `claimJob` and
`applyStudioPatch` (`src/services/macBrain.ts` lists each and why). The providers layer refuses the reverse: the Mac's purposes
for the owner (`MacBrainTenantRefused`).

**Rationale:** Anthropic's terms forbid routing other people's work through a personal Pro or Max plan. The owner's own videos,
infographics and ad drafts stay on the plan he already pays for (his choice: Claude, not Gemini, for his content), and anyone
else's go through the providers layer on that tenant's key (ADR-11).

**Rejected — one path for everyone.** Either the Mac answers tenants (against the terms) or the owner's volume moves onto paid
API calls for no gain.

**Consequence:** the guard fails closed: an unreadable list is a refusal, and a job queued before a tenant was taken off the list
is failed at claim instead of reaching the worker. The Mac is one machine, so the owner's Studio work waits while it is off;
only an explainer's script has a fallback (Gemini, when the owner picks it, the Mac is signed out, or the write sits unclaimed
10 minutes with no worker seen in the last 90 s), and on a free Gemini key that fallback cannot research.

### ADR-11 — An AI providers layer, routed by purpose, for everything that is not the owner's Mac or his Gemini bot

**Chosen:** two layers. `src/services/llm/` is a stateless library (adapters for Anthropic, OpenAI, Gemini, OpenRouter, Groq and
a custom endpoint, wire formats, errors, schemas, prices), held clear of the database by a test. `src/services/aiProviders/` is
built on it: the operator's keys, routes, prices and budgets, `resolveRoute`, one `ai_usage` row per call, and `generate`, which
does all of that around one call. Each caller names a purpose (`AI_PURPOSES`): onboarding drafts and proof samples, the DM engine
when a tenant switches `ai_agents.engine` to `providers`, WhatsApp replies, and a non-owner tenant's Monteur, infographics,
Studio writer and ad proposals. Voice transcription uses the same keys under a rule of its own (`transcribe`).

**Rationale:** the alternative was Gemini for everything on one key. That key is the DM bot's, its free-tier limits are per
project and model (on 2026-09-24 the Studio's indexer spent the bot's whole day), and a free Gemini key may train on what it is
sent. A layer lets each purpose name its provider, lets a tenant bring its own key, and makes cost visible per call.

**Two rules carry the weight:**
- **A saved route never falls through.** If its provider cannot answer (no key, switched off), the call is `no_provider`, naming
  the cause; moving quietly to another provider would bill someone the operator did not choose and hide a broken key.
- **Customers' words go only where the terms forbid training.** `dm_whatsapp` may use only `NO_TRAINING_PROVIDERS` (Anthropic,
  OpenAI, Groq), and voice notes only Groq, then OpenAI if paid AI is allowed (`TRANSCRIBE_PROVIDERS`), because Meta's
  WhatsApp terms bar letting its data train a model.

**Kept as it was, on purpose:** the owner's DM bot on Gemini. The `gemini` engine is the default and is byte-identical to the
pre-layer request (pinned by `ai.test.ts`); `providers` is opt-in per tenant, with a once-only Gemini fallback.

**Consequence:** an AI feature for a new tenant needs a key on some provider before it works, and a budget refusal is an answer
(`BudgetRefused`), not a retry.

### ADR-12 — Ads: one money rule, and no Graph call inside a database transaction

**Chosen:** everything that can start or raise spend passes one rule (`src/services/ads/money.ts`): what the ad account spent
this month (Meta's figure, the account's own month and time zone, every campaign including those made in Ads Manager) + what
every ACTIVE budget can still spend (a daily budget counts today at 1.75×, Meta's allowed overspend) + what is about to run + the
candidate ≤ the owner's monthly cap. Spending runs in three steps: read the month from Meta outside any transaction; a short
transaction takes the tenant's lock, re-checks with what is about to run and records a `running` op (`checkAndStartSpend`); then
Meta is called and the op finished (`finishSpendOp`).

**Rationale:** v1 had two money models that could disagree (a local UTC-month sum of boosts and `adsCap.ts`). And a Graph call
inside a transaction would hold a pooled connection and a lock for up to 40 s of Meta retries, on a pooler sized at three per
instance (§3.3). A second activation racing the first still counts it: its op is either running or finished recently enough to
be read.

**Same reasoning, one level up — rules run in our own evaluator, not Meta's `adrules_library`.** Meta's rules cannot ask for
approval, cannot see the cap or our alerts, and their `CHANGE_BUDGET` would bypass this rule. So raises and resumes become
proposals a person approves, and only protective actions (pause, lower, notify) run alone.

**Consequence:** every screen's "remaining" is one answer (`GET /api/ads/money`); Activate is the binding check; the guard on every
drain pauses campaigns at the cap and alerts when it has not managed a check for two hours. Throttles are never retried, and a
dead token is a 409, never a 401, because the dashboard reads 401 as "signed out". Until Meta verifies the owner's business, each
managed client uses its own system-user token and ad account, so Meta bills the client and the platform never pays Meta for one.

### ADR-13 — Explainer pictures: drawn by the app on Cloudflare's free tier, under an allowance reserved before each call

**Chosen:** the app server draws one scene per call through an `ImageProvider`, today Cloudflare Workers AI's FLUX.2 klein 4B
(`src/services/explainers/pictures/`). The Mac's `explainer_draw` job only loops on `POST /api/studio/worker/explainers/:id/draw-next`.
Every draw reserves estimated units in one atomic statement before the call (`reserveAllowance`), refunds them after an
ordinary failure, and on Cloudflare's "allocation used up" (code 3036, or 4006 in older answers) marks the day exhausted, which
pauses drawing until 00:05 UTC. No transaction and no pooled client is held across the provider call.

**Rationale (the explainers' research, R5):** it is the only free image API that takes reference pictures, which is what keeps
a recurring character consistent; Gemini's image models have no free tier; and generating locally on the owner's 8 GB M2 is
impractical (FLUX.1 schnell is 9.85 GB even at 4 bits). Drawing on the server also keeps the Cloudflare token there, in a
private field whose every message out is scrubbed.

**Consequence:** about 90 pictures a day (10,000 free neurons, about 110 a picture with one reference), counted platform-wide,
because the provider account is the owner's and every tenant would spend the same allocation. A 429 that is not the allocation
(code 3040, "out of capacity") means busy, never a day's pause. On the Workers Free plan a call past the allocation is refused,
not billed, so the $0 guarantee depends on staying on that plan.

---

## 9. Deliberately not done

Recorded so it is a decision rather than an omission. Struck-through items were done since; they stay one line each so the
history is findable.

- **Splitting the core of `api.ts`.** Largest diff, smallest behavioural win, and every new subsystem already gets its own
  router. Stage 5.
- **Moving scheduled publishing onto the queue.** The seam exists, but it touches the code path that posts to real accounts, and
  the minute-level drain removed the urgency. It wants its own change with its own review. Stage 2.
- **Gemini context caching.** The largest cost win available on the owner's bot, but it changes what is sent on every DM, and it
  should follow measurement, which the logs cannot give yet (§4.3).
- **Returning 503 on enqueue failure.** ADR-1.
- **A pipeline liveness check that runs on a schedule.** §5.4. `scripts/diagnose.mjs` compares each tenant's silence against its
  own median gap, which is the hard half; nothing runs it on a timer or alerts.
- **A dry run for `/api/cron/publish`.** There is still no way to exercise the publish path without publishing to the live
  accounts. The diagnostics report stranded claims, overdue rows and failures instead.
- **Generated row types** (ADR-4). Nothing yet checks that `src/db/rows.ts` matches the database.
- **Deleting `src/db_check2.ts`.** An ad-hoc debug script that nothing imports and no route reaches, still in `src/`, where it
  is compiled and deployed. Harmless; it should go.
- **Removing the legacy `getActiveCreator*` half of `tenant.ts`.** Blocked on removing legacy shared-password sessions (§6.3).
- ~~`jobs` row retention~~ — done (v14): `pruneCompleted`, 7 days, `failed` rows kept, converging over up to 20 passes.
- ~~A global (app-wide) rate bucket~~ — done (v14), in its own table, because `rate_limit_counters` could not hold an app-wide row.
- ~~A token re-check endpoint or scheduled check~~ — done (P29): the daily cron, the admin route and Settings (ADR-8).
- ~~Media out of `BYTEA`~~ — done (v23): Supabase Storage (§3.1, ADR-3).

---

## 10. The lesson worth keeping

A proposal that typechecks in prose can still be impossible in the schema: round-robin by `creator_id` could never have worked,
because that column is NULL on every webhook row by design (ADR-6). A correction can itself go stale, as this file's own
correction log did more than once. And a measurement beats a configuration: the GitHub schedule "every 5 minutes" ran every few
hours, the "dormant" Heroku worker was running, and a dashboard flag was once flipped on from documented intent rather than
measured behaviour (§2.3).

All of these have the same cause: asserting from the document rather than checking against the code and the running system.
On 2026-10-25 a full audit of the docs found the same thing at scale, with two-thirds of FLOWS.md's line anchors pointing at
code that had moved. So this file cites symbols, and every fact in it with a date was checked on that date.
