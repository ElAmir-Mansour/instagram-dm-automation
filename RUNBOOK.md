# AutoReply Pro — operator runbook

For the person who operates this, at 2am, when something is wrong.

Every procedure below is: the symptom, what to run, what healthy looks like, and what to do
when it isn't. Claims are cited to `file:line` so you can check them rather than trust them.

This document works backwards from a symptom. When you need the forward direction — every hop a
comment, DM, publish, login or job actually takes, in order — see [`FLOWS.md`](FLOWS.md); its
final table indexes every point where a flow can silently do nothing.

**Ground rule.** Two scripts are safe to run at any time and cannot write:
`scripts/diagnose.mjs` and `scripts/watch.mjs` both hold a session with
`default_transaction_read_only = on`, verified on connect, and neither prints a token,
password or connection string (`scripts/diagnose.mjs:5-9`, `scripts/watch.mjs:15-18`).

Two things are **never** "just a test", because both act on the live accounts:

| Endpoint | What it actually does |
|---|---|
| `GET /api/cron/publish` | Publishes every `PENDING` post whose `scheduled_time` has passed (`publishDuePosts`, `src/routes/api.ts:600`; route at `:666`). Six posts were pending when this was written. |
| `GET /api/jobs/drain` | Runs real handlers — sends real DMs and real public replies (`src/routes/api.ts:328`). |

---

## 1. "Is it working?"

```bash
node scripts/diagnose.mjs
# from a git worktree, which has no .env of its own:
node scripts/diagnose.mjs --env /path/to/repo/.env
```

Reads the deployed app and the production database and prints a verdict, then `CRITICAL`,
then `WARNINGS`, then `HEALTHY`, then a `DETAIL` block of context
(`scripts/diagnose.mjs:855-912`).

Exit codes, so this can gate a deploy or drive an alert (`scripts/diagnose.mjs:22-26`):

| Code | Meaning |
|---|---|
| `0` | everything checked is healthy |
| `1` | warnings only — degraded, or unproven and worth a look |
| `2` | at least one critical finding |
| `3` | the diagnostics themselves could not run (no `DATABASE_URL`, read-only guard failed) |

**Read `CRITICAL` first and stop there.** Each of those makes the rest of the report
meaningless:

| Critical finding | Why it stops you |
|---|---|
| `N migration(s) ... are NOT applied` | The deployed code expects columns the database lacks. See §6. |
| `object "instagram" delivers to <other host>` | Comments are being POSTed to a different project. Nothing else can succeed. |
| `token is INVALID` / `missing scope` | Deliveries arrive and every send fails. See §3. |
| `no active campaigns` | Every comment matches nothing and writes no row. |
| `job ... has been "running" since ...` | A claim went stale — an invocation died mid-flight. See §5. |

Known-good baseline as of 2026-09-21: `verdict DEGRADED — 6 warning(s), nothing critical`,
all migrations applied, token PAGE/valid/never-expires with all 12 required scopes,
storage 11% of the 500MB tier. `DEGRADED` is the normal resting state of this deployment,
not an incident.

### The question diagnostics cannot answer, and the one signal that can

**A comment that matches no campaign writes no row at all.** So "no activity" and "webhooks
stopped arriving" look identical from inside the database — this is the single hardest failure
in the project to diagnose, and the reason every other check exists
(`scripts/diagnose.mjs:29-33`).

The `jobs` table is what breaks the tie. Every verified **comment** delivery is written to `jobs`
*before* the 200 goes back to Meta, matched or not (`src/index.ts:231-250`), so:

> Note the asymmetry: `entry.changes` elements are enqueued unconditionally, but `entry.messaging`
> events are filtered first — echoes, read watermarks and delivery receipts never become jobs at
> all (`isActionableMessagingEvent`, `src/webhook/router.ts:64`). So an empty `jobs` table rules
> out comment traffic; it does not by itself rule out DM traffic that was all receipts.

> **An empty `jobs` table is the one thing "nothing matched" cannot explain.**
> (`scripts/diagnose.mjs:580-586`)

```
! queue    the jobs table is EMPTY — no webhook delivery has ever been enqueued
```

That warning is currently **present** on production. It means no delivery has reached the
handler since migration v13 was applied. Do not read it as proof of a broken webhook on its
own: the migrations were applied at 2026-09-21 13:17Z and the account's typical comment gap is
68 minutes, so an empty table a couple of hours later is also just a quiet evening. It becomes
an incident when it is still empty after a comment you posted yourself — which is the whole
point of `VERIFYING.md`.

The one caveat: if `WEBHOOK_QUEUE=off` is set in the environment, nothing is enqueued by design
(`src/index.ts:226`, `.env.example:56-63`) and an empty table proves nothing at all. Check that
first.

---

## 2. "A comment didn't get a DM."

Work these in order. The first four are cheap and cover almost everything.

### 2.1 Is the keyword actually a substring match?

Matching is **substring by default**, on Arabic-normalised text
(`src/services/matching.ts:83-85`, `src/utils/arabic.ts:79`). `trigger_keyword` is a
comma-separated list and any one entry matching is enough (`src/services/matching.ts:75-85`).
A campaign with a non-null `post_id` fires only on that post (`src/services/matching.ts:88`).

```bash
node --input-type=module -e "
import { loadEnv, connectReadOnly } from './scripts/lib/live.mjs';
loadEnv();
const db = await connectReadOnly();
const r = await db.query('SELECT left(trigger_keyword, 60) kw, match_mode, post_id FROM campaigns WHERE is_active ORDER BY created_at');
console.table(r.rows); await db.end();"
```

Substring matching is also the standing hazard, and the numbers are worse than the diagnostic
admits. Verified against production on 2026-09-21: **18 active campaigns, 104 active keywords,
and all 104 are `match_mode = 'substring'`** — nothing has opted into word matching.

- **5 keywords are 1–2 characters**: `c#`, `جو`, `go`, `ai`, `cv`.
- **10 keywords are 1–3 characters**: those five plus `css`, `ويب`, `ios`, `عيد`, `eid`.

Confirmed false positives, run through the real matcher:

| Keyword | Fires inside | substring | word |
|---|---|---|---|
| `جو` | `موجود` | yes | no |
| `عيد` | `سعيد` | yes | no |
| `تم` | `اهتمام`, `تمام`, `يتم` | yes | no |

**`scripts/diagnose.mjs` will not warn you about `عيد`.** Its threshold is
`k.length < MIN_SAFE_KEYWORD_LEN` with `MIN_SAFE_KEYWORD_LEN = 3`
(`scripts/diagnose.mjs:86`, `:560`), so a 3-character keyword passes the check silently while
still matching inside a longer word. `عيد` and `eid` are in that blind spot today.

The fix per campaign is `match_mode = 'word'`, which anchors the keyword to token boundaries
using explicit Unicode lookarounds — JavaScript's `\b` is useless for Arabic
(`src/utils/arabic.ts:81-86`). It is set per campaign from the dashboard and defaults to
`substring` forever, so existing campaigns never change behaviour on their own
(`src/config/migration_v14_functionality.sql:16-18`).

### 2.2 Is the callback URL right — per object type?

There is **one callback URL per object type, app-wide**, and the `instagram` object once
pointed at an unrelated project while Facebook worked fine. `diagnose.mjs` checks both
(`scripts/diagnose.mjs:229-239`). Healthy:

```
✔ meta     all 2 webhook subscriptions point at this deployment
  instagram → https://msg-response-auto.vercel.app/webhook (active) [comments, mentions, messages, messaging_postbacks, story_insights]
  page      → https://msg-response-auto.vercel.app/webhook (active) [feed, messages, messaging_postbacks]
```

Both must name *this* deployment, and the fields list must contain what you depend on —
`comments`/`feed` for the comment path, `messages` for DMs.

### 2.3 Was the signature rejected?

**A webhook signature failure is invisible from the database.** The 403 happens before
anything is written (`src/index.ts:175-186`), so it is indistinguishable from silence. The only
evidence is the Vercel log line:

```
webhook.signature_rejected  { secrets_tried: N, instagram_secret_set: true|false }
```

The app verifies against `META_APP_SECRET` **and** `INSTAGRAM_APP_SECRET`, because Instagram
API with Instagram Login is a *separate Meta app with its own secret*. Dropping either silently
403s half the traffic. `INSTAGRAM_APP_SECRET` is required at startup
(`src/config/env.ts:16-19`) — if it were missing, every route would be 503ing, so a running app
proves it is set.

> **Verified 2026-09-21: this is no longer the live configuration.** `GET /{META_APP_ID}/subscriptions` returns *both* the `instagram` and `page` objects under one app, so every event is signed with `META_APP_SECRET` and `INSTAGRAM_APP_SECRET` is vestigial. The dual-secret check in `verifyMetaSignature` stays — it costs nothing and this setup has changed before — but do not diagnose a silent comment path by suspecting that secret first. `diagnose.mjs` now derives this for itself and says so.


### 2.4 Did it get past the guards?

If `jobs` shows the delivery but no DM went out, one of the send guards refused it. Each writes
its reason into `interactions.error_log`:

| Reason in `error_log` | Meaning | Where |
|---|---|---|
| `Skipped: recipient already received an automated DM within 24 hours.` | Per-recipient courtesy cap. Working as designed. | `src/webhook/comments.ts:264-268` |
| `Send quota exhausted (creator: …)` | This tenant's hourly ceiling, 180/hr. | `src/webhook/comments.ts:277-294` |
| `Send quota exhausted (app: …)` | The **app-wide** pool, shared by every tenant — another tenant may have caused it. Default 1000/hr, `META_APP_HOURLY_LIMIT`. | `src/utils/rateLimiter.ts:87-102` |
| `App does not have Advanced Access to instagram_manage_messages` | The recipient must have messaged you first, or you need App Review. | Meta |
| `Activity already replied to` | That comment was already handled. | Meta |

A `PENDING` interaction row is unfinished work, not a resting state: `SENT` is written before
`recordDmSent` and every failure path writes `FAILED` or `USER_BLOCKED_DMS`
(`src/webhook/comments.ts:150-151`).

**A successful public reply is recorded nowhere.** Only failure is, in
`interactions.error_log`. Success exists solely as the log line `comment.public_reply_sent`
(`src/webhook/comments.ts:403`).

### 2.5 Watch it happen

To see the stages live rather than reconstruct them, run the watcher in its own terminal and
post one comment from a second account. The stage map is in `scripts/watch.mjs:31-37`, and the
full procedure with the "where it stops is the diagnosis" table is `VERIFYING.md`.

```bash
node scripts/watch.mjs
```

---

## 3. Token health and rotation

### The silent failure with a date on it

Production today reports a healthy token **and** this, in the `DETAIL` block rather than as a
warning:

```
[Default] data access expires in 89d (2026-12-19 14:29:29Z)
```

Data access is **separate from token expiry**. The token is a PAGE token that never expires,
but Meta lapses *data access* after 90 days without re-authorisation, and when it does, reads
start failing while `/debug_token` still answers `is_valid: true`
(`scripts/diagnose.mjs:419-425`). Nothing in the app notices.

**Diarise 2026-12-19.** It becomes a warning only inside 14 days
(`scripts/diagnose.mjs:424`), which is later than you want to find out. Fixing it means
re-authorising the app and re-exchanging the token (§3.3), not pasting the same one back.

### 3.1 What actually refreshes `token_status`

`creators.token_status` is not polled. These are the things that write it:

| Writer | Trigger |
|---|---|
| `recordTokenStatus` (`src/routes/api.ts:1579`) | someone opens the dashboard token page, saves a token, or runs the extend flow — three routes, one helper |
| `persistInspection` (`src/services/tokenHealth.ts:284`) | a deliberate re-check asks Meta and records the answer, including `POST /api/admin/tenants/:id/recheck-token` |
| `noteMetaFailure` (`src/services/tokenHealth.ts:49`) | **a real Meta send failed with code 190** |
| `src/routes/admin.ts` (tenant create / PATCH) | a tenant is created (sets `'unknown'`), or an admin updates one |

The third is the one that matters and it is new: every Meta send path calls `noteMetaFailure`
in its catch block, so a token Meta revoked on Friday now flips the row the first time a send
fails, rather than reading `valid` until somebody happens to look
(`src/services/tokenHealth.ts:1-18`). It is deliberately narrow — it does not flip on a
missing scope (code 200), a recipient who blocked DMs (10903) or a transient 500, because
marking a working token invalid sends you to regenerate something that was never broken
(`src/services/tokenHealth.ts:16-18`).

`GET /api/admin/tenants` shows `token_status`, `token_last_checked_at` and `token_error` per
tenant (`src/routes/admin.ts:80-82`), but it **reads** the column — it does not re-check
against Meta. There is no re-check endpoint and no scheduled check on `main`. Until there is,
`node scripts/diagnose.mjs` is the only thing that actively asks Meta, and it only runs when
you run it.

### 3.2 Tokens are encrypted at rest

`creators.page_access_token` is stored as `enc:v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM, with
the key in `TOKEN_ENCRYPTION_KEY` (`src/config/crypto.ts:42-49`). Decryption happens in one
place, `withDecryptedToken` in `src/services/tenant.ts:70-76`, plus the publish cron which
reads off a joined row and decrypts inline (`attemptPublish`, `src/routes/api.ts:498`).

Two operational consequences:

- **A value without the `enc:v1:` prefix is returned unchanged** (`src/config/crypto.ts:58-60`),
  so a legacy plaintext token keeps working. `diagnose.mjs` warns when it finds one and the fix
  is to re-save the token from Settings (`scripts/diagnose.mjs:381-385`).
- `TOKEN_ENCRYPTION_KEY` is **not** required at startup, but it **is** required to save a token
  or create a tenant, and those endpoints say so (`src/routes/admin.ts:143-146`,
  `.env.example:31-38`). Generate with `openssl rand -hex 32`.

**Losing `TOKEN_ENCRYPTION_KEY` means every encrypted token is unrecoverable** and each tenant
must paste a fresh one. It is not in the database by design — the threat model is database
access, which is exactly what materialised when the connection string was committed to a public
repo (`src/config/crypto.ts:4-8`).

### 3.3 Rotating a token

1. `node scripts/diagnose.mjs` — confirm the current state and note the fingerprint.
2. Graph API Explorer → select the app → **User Token**, not a Page token → add the required
   scopes → generate.
3. `node scripts/exchange-token.mjs <short-lived-user-token>` — exchanges via `/me/accounts`
   for a permanent PAGE token. Starting from a Page token instead only ever gets you 60 days.
4. Paste it into the dashboard Settings page. That encrypts it on write and sets
   `token_status = 'valid'` (`recordTokenStatus`, `src/routes/api.ts:1579`).
5. `node scripts/diagnose.mjs` — expect `token is PAGE, valid, never expires, all 12 required
   scopes present`. The 12 required scopes are listed at `scripts/diagnose.mjs:89-104`; the
   live token carries 13.

A missing scope disables a path **silently**: `instagram_manage_messages` is DMs,
`instagram_content_publish` is scheduling, `pages_manage_engagement` is public replies
(`scripts/diagnose.mjs:434-436`).

---

## 4. "A post didn't publish."

```bash
node scripts/diagnose.mjs        # read the `publish` section
```

Healthy is `✔ publish  no stranded, overdue or failed scheduled posts`, with a `DETAIL` line
of counts by status. Today: `PENDING=6  PUBLISHED=10`.

### 4.1 It is probably the cron granularity

The Vercel cron runs **once daily at 00:00 UTC** — a Hobby-plan limit (`vercel.json` `crons`) —
but it is no longer the only thing that publishes. `GET /api/jobs/drain` calls
`publishDuePosts()` too (`src/routes/api.ts:352`), and that endpoint is on the GitHub Actions
schedule, so a post scheduled for 14:30 goes out on the next drain rather than waiting for
midnight UTC.

What that buys is "within the drain interval", not minute accuracy. GitHub throttles scheduled
workflows, so the real gap varies from minutes to hours — see §5.1. A post that is late by an
hour is expected behaviour, not a fault; a post still `PENDING` the next day means the drain is
not running at all, and §5.1 says how to check.

### 4.2 Stranded claims

A publish claims its row atomically by flipping `PENDING → PUBLISHING`
(`src/routes/api.ts:623-629`). If the invocation dies mid-publish the row stays `PUBLISHING`
forever, so each cron run first releases claims older than 15 minutes with attempts left
(`src/routes/api.ts:674-681`), and fails anything past 5 attempts with an explanatory
`error_log` (`src/routes/api.ts:687-694`).

If you see rows sitting in `PUBLISHING`, the cron has not run since they were claimed. Running
`GET /api/cron/publish` will release them — **and publish everything else that is due.**

### 4.3 The partial-publish case — read this before retrying

On `platform = 'both'`, **Facebook publishes first** (`attemptPublish`,
`src/routes/api.ts:501`), Instagram second (`:522`). A Facebook success followed by an
Instagram failure records the row as `FAILED` **while the Facebook post is live**.

Editing a scheduled post flips `FAILED → PENDING`:

```sql
status = CASE WHEN status = 'FAILED' THEN 'PENDING' ELSE status END
```
(`src/routes/api.ts:2080`)

Historically that republished it and **duplicated the Facebook post on the live account**.
That is fixed, but understand *how*, because the fix is what you are relying on:
`published_post_id` now retains whatever did go live, as `FB:<id>`, `IG:<id>` or
`FB:<id> | IG:<id>` (`publishedPlatforms` / `formatPublishedIds`,
`src/routes/api.ts:378` and `:386`, written on the failure path at `:565-575`), and the next
attempt parses it back and skips the platform that is already public (`:492-494`, and the
`&& !fbId` / `&& !igId` guards at `:501` and `:522`). The `error_log` also names what is live:
`Partially published (FB:123) — the rest failed: <reason>`.

So: **before retrying a `FAILED` post, read `published_post_id` and `error_log`.** If
`published_post_id` is non-empty, part of it is public. A retry will complete it, not repeat it
— but only as long as that column is intact. Do not clear it to "start clean".

`FAILED` is also the status for a partial success, deliberately, because the dashboard filters
on that vocabulary and a half-published post is not a finished post
(`src/routes/api.ts:560-575`).

### 4.4 Two combinations to know about

- `post_type: 'story'` with `platform: 'facebook'` or `'both'` is rejected at create time —
  Facebook Page stories need a `/photo_stories` + `/video_stories` upload that is not
  implemented (`unsupportedPlatformCombination`, `src/routes/api.ts:403`, called at `:1937`).
  `publishFacebookPost` also throws on it rather than degrading, because a degraded publish
  still returns a post id and is recorded as a success (`src/services/instagram.ts:285-290`).
- For cross-posting a video, prefer **`video`** over `reel`. This entry used to say
  `publishFacebookPost` "does not handle `reel` and falls through to a text-only feed post" —
  **that is no longer true**: `reel` and `video` are the same asset to Facebook and both now
  publish through `/videos` (`src/services/instagram.ts:299-305`). `video` remains the value to
  use because it is what the dashboard offers, and legacy `reel` rows are mapped onto it.

Also always set `cover_url`, or Instagram takes frame 0 as the thumbnail and any video fading
up from black gets a black tile in the profile grid. `attemptPublish` passes it through
(`src/routes/api.ts:538`).

---

## 5. Queue operations

The `jobs` table *is* the queue: `run_after` plus an atomic claim, in the database you already
have open (`src/config/migration_v13_jobs.sql:10-16`).

```bash
node scripts/diagnose.mjs        # read the `queue` section
```

| Finding | Threshold | Meaning |
|---|---|---|
| `queue is drained` | — | Healthy: nothing pending, stuck or dead-lettered. |
| `N job(s) pending, oldest due Xm ago` | warn >15m, **crit >90m** | Nothing is draining. See §5.1. (`scripts/diagnose.mjs:83-84`, `:595-601`) |
| `job … has been "running" since …` | claim >300s | The invocation holding it died. It is reapable. (`scripts/diagnose.mjs:75`, `src/jobs/runner.ts:26`) |
| `job … exhausted its retries` | `attempts >= max_attempts` | Permanent. Read the printed error; retrying will not help. |

### 5.1 What drains the queue, and how to check it is still doing so

Three things can call `GET /api/jobs/drain`. Two are live:

| Caller | Interval | State |
|---|---|---|
| `.github/workflows/drain.yml` | `*/5`, throttled by GitHub — see below | **active** |
| Vercel cron → `GET /api/cron/publish`, which calls `drainWorker()` (`src/routes/api.ts:712`) | once daily, 00:00 UTC | **active**, the backstop |
| `heroku-worker/worker.mjs` | 60s | **scaled to zero** (~$7/mo when on) |

Check the GitHub one first, because its failure mode is silent:

```bash
gh run list --workflow=drain.yml --limit 5
```

A run that **fails in under ~10 seconds** means `CRON_SECRET` is not set as a repository secret,
or does not match production. That is not hypothetical: the workflow existed for a long time and
had *never once succeeded* for exactly that reason, which reads as "configured" at a glance
because a red row in a tab nobody opens looks the same as no rows at all. Fix with
`gh secret set CRON_SECRET`.

**Do not expect five-minute punctuality.** GitHub throttles scheduled workflows and explicitly
does not guarantee them; observed delivery on this repository has been hours apart, not minutes
(`.github/workflows/drain.yml:12-23` says so in the workflow itself). Frequent-but-irregular is
the honest description. If the interval genuinely matters — minute-accurate scheduled posts,
say — scale the Heroku worker back up:

```bash
heroku ps:scale worker=1 -a autoreply-pro-worker
```

To drain by hand:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" \
  https://msg-response-auto.vercel.app/api/jobs/drain
```

Safe to run at any time, and safe to overlap with the schedules: the claim guards on
`AND status = 'pending'` in the `UPDATE`, so two concurrent drains split the work rather than
both running the same job — which would be a duplicate DM to a real person
(`src/jobs/queue.ts`, `PostgresJobQueue.claim`). It is **not** `FOR UPDATE SKIP LOCKED`, and
cannot be: Postgres rejects that alongside a window function.

A healthy response is JSON: `{"claimed":N,"succeeded":N,"failed":0,"budgetExhausted":false,"reaped":0}`.
`budgetExhausted: true` just means it stopped on its time budget with work left — the next call
takes it.

### 5.2 Draining by hand

The same `curl` above. Budgets, if you need to tune them:

| Knob | Default | Where |
|---|---|---|
| `JOB_INLINE_BUDGET_MS` | 8000 | drain inside a webhook invocation, after the 200 (`src/jobs/drain.ts:21-24`) |
| `JOB_WORKER_BUDGET_MS` | 45000 | drain for a dedicated `/api/jobs/drain` request (`src/jobs/drain.ts:27-30`) |

Lower `JOB_INLINE_BUDGET_MS` if webhook invocations are being killed on duration.

> **Unverified:** `vercel.json` sets no `maxDuration` for the function, so the 45s worker
> budget is not provably inside the platform's limit for this plan. If `/api/jobs/drain`
> returns a platform timeout rather than JSON, lower `JOB_WORKER_BUDGET_MS` first.

### 5.3 Stuck and failed jobs

A claim is reapable after **300 seconds** (`src/jobs/runner.ts:26`) — generous on purpose,
because reaping a job that is still running is how a DM gets sent twice. Both drain paths reap
before claiming (`src/jobs/drain.ts:53-58`, `:87`), so **draining is also how you unstick a
stale claim**. A job with attempts left goes back to `pending`; one without becomes `failed`
with `[abandoned: the claim went stale and no attempts remain]` appended
(`src/jobs/queue.ts:183-202`).

Retries are exponential with jitter: roughly **30s, 2m, 8m**, `max_attempts` 3 by default
(`src/jobs/runner.ts:36-40`, `src/config/migration_v13_jobs.sql:43`). Jittered because the
triggering failure is usually shared — a Meta outage, a dead token — so unjittered retries turn
one outage into a thundering herd.

Inspect a stuck job's payload with SQL; `payload` is JSONB precisely so you can
(`src/config/migration_v13_jobs.sql:28-30`):

```sql
SELECT id, kind, status, attempts, max_attempts, run_after, claimed_at,
       left(last_error, 200) AS err, payload->>'entryId' AS page_id
  FROM jobs WHERE status IN ('running','failed') ORDER BY updated_at DESC LIMIT 20;
```

`failed` rows are **never** pruned — those are the ones you need. `done` rows are deleted after
7 days by the retention sweep (`src/services/retention.ts:45`, `src/jobs/queue.ts:223-234`).

### 5.4 Rolling the queue back entirely

`WEBHOOK_QUEUE=off` in the Vercel environment reverts to processing inline with no queue, which
is the behaviour that shipped before the queue existed (`src/index.ts:226`,
`.env.example:56-63`). The handlers are identical either way
(`src/webhook/router.ts:8-12`), so this is a rollback of the durability layer only.

Remember that this also makes the §1 "empty `jobs` table" signal meaningless.

---

## 6. Migrations

```bash
npm run migrate:status     # what would run
npm run migrate            # apply it
```

Both read `.env` via `node --env-file=.env` (`package.json`). Healthy status output:

```
applied: 15
pending: none
```

15, not 14: the ledger counts `schema.sql` plus the fourteen `src/config/migration_v*.sql`
files (v2 through v15). The canonical list is `EXPECTED_MIGRATIONS` in
`src/config/migrations.ts`, and `migrations.test.ts` fails if it drifts from what is on disk.

Healthy apply output is one `applying <file> ... ok` line per file, then
`All migrations applied.`

**Each migration is its own transaction.** A failure rolls that file back entirely, stops the
run, prints the error, and **exits non-zero** (`scripts/migrate.mjs:105-129`). A partial schema
change is not possible; a partial *run* is — files before the failure are applied and recorded,
so fix the failing file and re-run.

Ordering is by the embedded `_vN` number, not lexically, and `schema.sql` is forced first —
plain `.sort()` would put `v10` before `v3` and ALTER tables that do not exist yet
(`scripts/migrate.mjs:37-50`).

### Why the ledger exists

The two scripts this replaced hardcoded filenames, recorded nothing, and **caught their own
errors and exited 0** — so a failed migration was indistinguishable from a successful one. That
is how `interactions.platform` came to exist in production while appearing in no migration file
at all (`scripts/migrate.mjs:5-8`). If you ever wonder why a column has no migration, that is
the mechanism.

All migrations use `IF NOT EXISTS` and are idempotent, so re-running is safe.

### Two things that will bite you

- **Never edit an applied migration.** The ledger stores a checksum; a changed file prints
  `⚠️ <name> changed since it was applied` and is **not re-run**, so the ledger no longer
  describes the database (`scripts/migrate.mjs:76-81`). `diagnose.mjs` reports the same drift
  independently (`scripts/diagnose.mjs:779`). Add a new migration instead.
- **`--baseline` marks everything applied and runs nothing** (`scripts/migrate.mjs:92-101`).
  Correct only for a database whose schema is already current and which predates the ledger.
  On a database that genuinely lacks the columns it is how you get code expecting a schema that
  isn't there.

Alternative route: paste the SQL into the Supabase SQL editor. It will not update the ledger,
so follow with `--baseline` if you do.

---

## 7. Data-subject erasure

### What the published page commits you to

`https://msg-response-auto.vercel.app/data-deletion` (served from `public/data-deletion.html`
via `src/index.ts:105-107`) makes four promises:

1. On request, with an Instagram username: **"we will delete all associated records within 30
   days."**
2. Requests arrive by replying to the Instagram/Facebook account, or on the project issue
   tracker.
3. The stored data is named explicitly: username, comment id, post id, timestamp, and for DMs
   the message text, the replies, the Meta-scoped user id, and **the verbatim event received
   from Meta**.
4. **"The verbatim event received from Meta … is deleted automatically after 30 days."**

### Promise 4 is not true unless you set one variable

`messages.raw_payload` holds that verbatim event. The sweep that clears it is **opt-in**: with
`RAW_PAYLOAD_RETENTION_DAYS` unset, `pruneRawPayloads` is a no-op and payloads are kept forever
(`src/services/retention.ts:25-27`, `:102-115`). Clearing `messages.text` while `raw_payload`
holds the same text deletes nothing — this is the mechanism by which the promise is otherwise
untrue (`src/services/retention.ts:14-18`).

**Set `RAW_PAYLOAD_RETENTION_DAYS=30` in the Vercel environment to match the page.** The
minimum accepted is 7; a misconfigured value disables pruning rather than falling back to a
default, and logs `retention.misconfigured` (`src/services/retention.ts:83-93`, `:107-112`).
The sweep runs once daily from the publish cron and converges rather than clearing one batch a
day — up to 20 passes of 5,000 rows (`src/services/retention.ts:190-222`,
`src/routes/api.ts:703`).

> **Fixed 2026-09-21.** `.env.example` used to declare `RAW_PAYLOAD_RETENTION_DAYS` twice —
> empty in one block and `30` in another, with contradictory advice (90 vs 30) — so which one
> applied depended on the parser. It is now declared once, as `30`, because that is what the
> published page commits to. The value is a promise to users, not a preference.

### Handling a request

**There is now tooling, as of 2026-09-21.** This section previously said there was none, and
that erasure was manual SQL — true when written, false now. Use the dashboard: **Erasure**, the
last item in the admin nav because it is the only hard DELETE in the product. It is backed by
`src/services/erasure.ts` and `GET /api/admin/erasure/preview` + `POST /api/admin/erasure`,
both `platform_admin` only.

The flow is deliberately two-step, and there is no way to spell "delete this handle" in one
request:

1. **Preview** resolves the handle, counts what would go, writes nothing, and returns a
   short-lived signed token bound to *that handle and those counts*.
2. **Execute** accepts only a token. It re-resolves the target from inside the token, re-counts
   within the deleting transaction, and refuses if anything moved.

That drift check is not just a guard against a stale preview — it is what makes a replayed
token harmless. Once the rows are gone the counts are zero, so the same token cannot delete a
second person who later arrives under the same handle.

It clears all four tables the published page names — `interactions`, `messages`,
`conversations` and `dm_send_log` — which is the part manual SQL got wrong: the obvious
statement clears `messages.text` and leaves `raw_payload` holding the same text as a verbatim
JSONB copy of the Meta event, so the row still contains everything the person wrote plus their
Meta user id.

The preview deliberately returns **metadata only, never message bodies**. Usernames, IGSIDs,
tenant names and timestamps are enough to confirm the right person; the text of what a private
individual wrote does not need to be rendered into an admin page and a browser cache on its way
to being deleted.

Every execution is written to the audit log. If you still need raw SQL — for a case the tool
cannot express — match on the username in `interactions` and the Meta-scoped user id in
`conversations`/`messages`, and remember `raw_payload`.

Before running anything, note what the page says is *retained*: message text and interaction
logs are kept beyond 30 days so the account owner can read their own conversation history. Only
a request removes those. So an erasure must clear the message rows **and** `raw_payload`, or it
has not deleted the content.

Write the SQL, read it back with a `SELECT` first, and keep a note of what you ran and when —
30 days is a commitment you may have to evidence.

---

## 8. Adding a tenant / onboarding a client

Two halves, and the Meta half has an ordering trap.

### 8.1 Application side

Requires a `platform_admin` session. Everything under `/api/admin` returns **404, not 403**, to
a non-admin — a non-admin has no business knowing the surface exists
(`src/routes/admin.ts:46-55`).

```
POST /api/admin/tenants
  { name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token }
```

`instagram_page_id` and `page_access_token` are both required (NOT NULL in the schema). The
token is encrypted in the handler, so a tenant created this way **never has a plaintext token in
the database at any point** (`src/routes/admin.ts:118-147`). A duplicate page id is a 409
(`:171-174`).

If `TOKEN_ENCRYPTION_KEY` is unset this returns a 500 that names the problem and tells you to
run `openssl rand -hex 32` (`src/routes/admin.ts:139-147`). Set it first.

Then create the client's user and grant membership in one call:

```
POST /api/admin/users        { email, password, role: 'user', creator_id }
```

Password minimum is 12 characters (`src/routes/admin.ts:226`, `:266-269`). A user with no
membership can log in and reach nothing, which is why the common case grants it in the same
request (`src/routes/admin.ts:289-297`). There is **no self-serve signup** — this endpoint is
the only way a `users` row comes into existence (`src/routes/admin.ts:252-257`).

Both are also available as dashboard screens for a `platform_admin`: **Tenants** and **Users**
(`dashboard/js/app.js:53-54`, `dashboard/js/pages/tenants.js`, `dashboard/js/pages/users.js`).
The Tenants screen leads on the two columns that say something is broken — token status and
last webhook received (`dashboard/js/pages/tenants.js:3-8`).

### 8.2 Meta side — get the verify token right *before* the subscription exists

This is the ordering trap, and it has already cost hours.

**Meta only re-checks the verify token when a subscription changes.** Existing subscriptions
keep delivering forever even if the token is wrong or empty. Production once ran with
`META_VERIFY_TOKEN=""`, which broke *every* subscription change with an opaque
`Callback verification failed: HTTP 403` while existing webhooks kept working — so the symptom
appears at the moment you try to add the new tenant, and points at nothing.

So, in this order:

1. **Set the verify token and confirm the handshake returns the challenge**, before touching
   any subscription. The app accepts a token from either `META_VERIFY_TOKEN` **or**
   `creators.webhook_verify_token`, and compares against every candidate it has
   (`src/index.ts:145-162`). The database copy exists so the token can be changed from
   Settings with no redeploy.
2. Verify with `node scripts/diagnose.mjs`. Healthy:
   ```
   ✔ meta     verify-token handshake returns the challenge (accepted: local env META_VERIFY_TOKEN; creators.webhook_verify_token (Default))
   ```
   The log line `webhook.verified { candidates: N }` confirms how many were tried.
   **`candidates: 0` is the specific, actionable failure**: neither source has a token set, so
   every subscription change Meta attempts will 403 opaquely while existing webhooks keep
   delivering (`src/index.ts:164-168`).
3. **Type it identically** into the Meta console. It is compared as an exact string — a
   trailing space is a 403 with no diagnostic.
4. Now create or change the subscription, and set the callback URL to
   `https://<deployment>/webhook`. Remember §2.2: one callback URL per object type, app-wide,
   so changing it for one tenant changes it for all of them.
5. Subscribe the fields you need: `comments`/`feed`, `messages`, `messaging_postbacks`.
6. Re-run `node scripts/diagnose.mjs` and confirm the new subscription points at this
   deployment.

### 8.3 Do not promise multi-tenant service yet

Serving other people's accounts requires Meta **Advanced Access**, which requires Business
Verification plus per-permission App Review for roughly six permissions including
`instagram_content_publish` and `pages_messaging`. Months of process with real rejection risk.
The application side works; the permission to use it is the blocker.

---

## 9. Rolling back a deploy

Vercel is the only pipeline — there is no CI deploy step (`.github/workflows/ci.yml` runs
typecheck, tests and a dashboard syntax check, and nothing else).

```bash
vercel rollback              # interactive: pick a previous deployment
vercel rollback <url|id>     # revert to a specific one
vercel rollback status       # is a rollback still pending
```

Verified against the installed CLI (59.23.2): "Quickly revert back to a previous deployment",
with `--timeout <TIME>` (default 3m) and `-y`.

**Before you roll back, check whether the problem is code or schema.** Migrations are not
reverted by a code rollback, and they are additive by design — every v13/v14 change is an
`ADD COLUMN IF NOT EXISTS`, a `CREATE TABLE IF NOT EXISTS` or a `CREATE INDEX IF NOT EXISTS`,
and "nothing here changes what an existing row means"
(`src/config/migration_v14_functionality.sql:3-6`). So older code generally tolerates the newer
schema: it simply does not read the new columns. Rolling *forward* past a missing migration is
the direction that breaks.

Prefer a narrower switch when one exists, because it is faster and reversible without a deploy:

| Symptom | Narrower lever |
|---|---|
| Queue misbehaving, webhooks failing | `WEBHOOK_QUEUE=off` (§5.4) |
| Webhook invocations killed on duration | lower `JOB_INLINE_BUDGET_MS` |
| Retention deleting too aggressively | unset `RAW_PAYLOAD_RETENTION_DAYS` — but see §7 |
| Need noisier logs | `LOG_LEVEL=debug`, `LOG_STACKS=1` |

After any rollback or environment change:

```bash
node scripts/diagnose.mjs
```

The app **refuses all traffic with a 503 naming the missing variable** if required environment
variables are absent, rather than serving with a missing secret
(`src/index.ts:23-29`, `:70-76`; the seven required vars are `src/config/env.ts:12-23`). So if
every route 503s after a rollback, read the body — it tells you which variable it is. The app
also refuses to start if `DASHBOARD_PASSWORD` is the old published default `"admin"`, which is
in the public repo's history (`src/config/env.ts:45-49`).

---

## 10. Before you touch anything: the checks that are free

```bash
npm run typecheck    # tsc --noEmit
npm test             # 449 unit tests, node:test via tsx
```

Both pass on `main` as of 2026-09-22 (449 tests, 86 suites, 0 failures). CI also runs four
content guards — `check:assets`, `check:icons`, `check:contrast` and `check:i18n` — each added
after a failure that nothing else could see. There is **no build
step**: TypeScript runs through `ts-node/esm` locally and `@vercel/node` in production. The
dashboard has no build and no typecheck, so a syntax error there ships silently and blanks the
page — `find dashboard -name '*.js' | xargs -n1 node --check` is the only guard it has, and CI
runs it (`.github/workflows/ci.yml`).

Inspect production configuration without deploying:

```bash
vercel env pull .env.local --environment=production
```
