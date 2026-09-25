# Verifying AutoReply Pro against a real Meta event

The pipeline was split into modules, given a durable job queue, moved the 200 to before the
work, wired rate limiting and added an AI disclosure prefix. 548 unit tests cover the pieces.
None of that proves the deployed system handles a real Instagram comment, and as of
2026-09-21 the live database shows **zero jobs, zero interactions and zero messages since the
last migration** — so the refactor is currently unverified in production.

Only the account owner can post a comment. This is the procedure, with what to run at each
step and what a healthy result looks like.

> This document is for **proving the pipeline works once**. When something is already broken
> and you need to fix it, go to [`RUNBOOK.md`](RUNBOOK.md) instead.

**Budget 15 minutes.** You need a second Instagram (or Facebook) account you control, because
step 5 sends a real DM to whoever comments.

---

## Ground rules

| Safe to run any time | Never run to "test" |
|---|---|
| `node scripts/diagnose.mjs` — read-only | `GET /api/cron/publish` with the bearer token — **publishes all 6 pending posts to the live accounts** |
| `node scripts/watch.mjs` — read-only | `GET /api/jobs/drain` with the bearer token — runs real handlers and sends real DMs |
| The dashboard | Any `INSERT`/`UPDATE` against production |

Both scripts hold a database session with `default_transaction_read_only = on`, verified on
connect, so they cannot write even by accident. Neither prints a token, password or
connection string — secrets appear only as `fingerprint/length`.

---

## Step 1 — Pre-flight

```bash
node scripts/diagnose.mjs              # add --env <path/to/.env> from a worktree
```

Healthy result: `verdict HEALTHY`, or `DEGRADED` with only the warnings you already know
about. Read the `CRITICAL` block first — **fix those before continuing**, because they make
the rest of this procedure meaningless:

| Critical finding | Why it stops you |
|---|---|
| `object "instagram" delivers to <other host>` | Your comment will be POSTed to a different project. Nothing you do here can succeed. |
| `N migration(s) are NOT applied` | The code expects columns the database does not have; the `INSERT` fails after Meta was told 200. |
| `token is INVALID` / `missing scope` | The delivery arrives and the send fails. |
| `no active campaigns` | Every comment matches nothing and writes no row. |

Exit codes: `0` healthy, `1` warnings, `2` critical, `3` the diagnostics could not run.

**Expected warnings before you start** — these are the ones this procedure exists to clear, so
seeing them is the point, not a problem:

```
! queue    the jobs table is EMPTY — no webhook delivery has ever been enqueued
! flow     NOTHING has been processed since <last migration> — the current code has never handled a real event
! flow     no inbound DM for 124d — the DM path is unexercised, not necessarily broken
```

Two more are environmental rather than faults: `INSTAGRAM_APP_SECRET` not being in your local
`.env` (it only limits what `--probe-signature` can test), and the short-keyword warning from
step 2.

## Step 2 — Pick a keyword that will actually match

Matching is **substring** by default, on the normalised comment text, and `trigger_keyword` is
a comma-separated list. Take one from an active campaign:

```bash
node --input-type=module -e "
import { loadEnv, connectReadOnly } from './scripts/lib/live.mjs';
loadEnv();
const db = await connectReadOnly();
const r = await db.query('SELECT left(trigger_keyword, 60) kw, match_mode, post_id FROM campaigns WHERE is_active ORDER BY created_at');
console.table(r.rows); await db.end();"
```

Healthy result: a list of keywords. Verified on 2026-09-21: **18 active campaigns, 104 active
keywords, all of them `match_mode = 'substring'`** — nothing has opted into word matching yet.

Note three things:

- A campaign with a non-null `post_id` only fires on **that** post. Prefer a keyword whose
  `post_id` is `null`, or comment on the post it names.
- Write the keyword **exactly**, as its own word, in a comment on a recent post.
- **Pick a long keyword.** Ten of the 104 are 1–3 characters, and in substring mode they fire
  inside unrelated words — `عيد` matches inside `سعيد`, `جو` inside `موجود`. A short keyword
  makes step 5 ambiguous, because you cannot tell a real match from an accidental one. It also
  means a campaign you did not intend may claim the comment first: the winner is the most
  specific campaign, ranked post-specific before generic, then by keyword length
  (`src/services/matching.ts:45-51`).

## Step 3 — Start the watcher

In its own terminal, and leave it running:

```bash
node scripts/watch.mjs
```

Healthy result — a baseline and then silence:

```
AutoReply Pro — live pipeline watcher  (read-only)
polling every 2000ms · started 2026-09-21T13:00:58.729Z
baseline: 0 jobs, 96 interactions, 12 messages · last comment 6h 26m ago · last inbound DM 124d 11h ago
```

## Step 4 — Post the comment

From the **second** account, comment your keyword on a recent Instagram post (or a Facebook
page post — the `page` object is subscribed too, and `interactions.platform` will say which).

## Step 5 — Read the stages

Expect all of this inside **5–15 seconds**. The webhook drains inline after answering Meta,
so you should not have to wait for a cron.

```
13:02:41.109 +1m42s  ① webhook arrived      job 4c17ab90 comment.process enqueued [cmt …18829301]
                                  ↳ from @second_account: "عايز كورس بايثون"
                                  ↳ signature verified and the work is durable — anything after this point is recoverable
13:02:43.882 +2s     ② campaign matched     interaction 7b02e4d1 claimed for @second_account (instagram) [cmt …18829301]
                                  ↳ campaign 8014ee7f keyword "بايثون, python, python arabic" · post 17912…
13:02:44.310 +0s     ③ rate limit checked   dm counter 0 → 1 this hour (ceiling 180)
13:02:44.902 +1s     ④ recipient cap set    recipient …4f9b21 recorded — no second automated DM for 24h
13:02:46.551 +2s     ⑤ DM sent              interaction 7b02e4d1 → @second_account
13:02:47.004 +0s     ⑥ job drained          job 4c17ab90 done
```

**Where it stops is the diagnosis:**

| Last line you see | What it means | What to do |
|---|---|---|
| *nothing at all* | The delivery never reached the handler. Meta did not send it, or the HMAC signature was rejected — both happen before any row exists. | Watcher prints the checklist after 90s. In order: `scripts/diagnose.mjs` (callback URL + subscribed fields), then Vercel logs for `webhook.signature_rejected` (it reports how many secrets were tried — `INSTAGRAM_APP_SECRET` is a *separate app's* secret). |
| `① webhook arrived` then `⊘ no campaign match` | The pipeline worked and decided there was nothing to do: no active keyword is a substring of your comment. **No interaction row is written** — this is exactly what "silence" looks like, and the only reason it is visible at all is the `jobs` row. | Re-read step 2 and comment again with a keyword that matches. |
| `② campaign matched` then `✖ send FAILED` | The DM send failed. The reason is printed from `interactions.error_log`. | `App does not have Advanced Access to instagram_manage_messages` → the recipient must have messaged you first, or you need App Review. `Activity already replied to` → that comment was already handled. |
| `③ rate limit checked` showing `≥ 180` | The hourly quota is exhausted; sends are being dropped and marked FAILED. | Wait for the next hour boundary; counters prune after 48h. |
| `⑤ DM sent` then `⚠ public reply failed` | The DM went out; the public comment reply did not. | Usually `Activity already replied to` or a >1000-character reply template. |
| `↻ job retrying` | A transient failure; backoff is ~30s, ~2m, ~8m with jitter. | Wait. If it reaches `✖ job FAILED` the error is permanent — read the printed message. |
| Everything but `⑥ job drained` | The work happened but the queue bookkeeping did not finish — the invocation was frozen after the send. | Harmless (the sends are idempotent), but it means the inline drain is being cut short: consider lowering `JOB_INLINE_BUDGET_MS`, or point an external scheduler at `/api/jobs/drain`. |

## Step 6 — Check the two things the database does not record

1. **The DM itself.** Open the second account's inbox. The message should be there, and — if
   this is the first automated message in that thread — it must carry the **AI disclosure**
   prefix. That prefix is new in this refactor and is a Meta requirement, so read it.
2. **The public reply.** Look at the comment on the post. Success is not stored anywhere; only
   failure is (`interactions.error_log`). The Vercel log line is `comment.public_reply_sent`.

## Step 7 — Verify the DM path separately

The DM path has had **no traffic since May 2026**, so it is the least proven part of the
system. From the second account, reply in the DM thread (any question).

Healthy result:

```
① DM conversation      conversation 3f1a77c2 with …4f9b21
② DM claimed           message 9ac41b08 inbound (text) [mid …HZWNiZD]
                       ↳ "بكام الكورس؟" — meta_message_id is UNIQUE, so a redelivery stops here
   AI disclosed        conversation 3f1a77c2 — automated-service disclosure recorded
⑤ AI reply sent        message 1de0c934 outbound
```

If `② DM claimed` appears but `⑤ AI reply sent` never does: check `conversations.is_bot_active`
for that thread (the watcher says when the bot is paused), that the `ai_agents` row is active
(diagnostics report it), and `GEMINI_API_KEY` in the Vercel logs (`dm.pipeline_failed`).

## Step 8 — Post-flight

```bash
node scripts/diagnose.mjs
```

Healthy result — two warnings from step 1 have flipped:

```
✔ flow   N events processed since <deploy> — the current deployment has handled real traffic
✔ queue  queue is drained — nothing pending, stuck or dead-lettered
```

If `queue` now reports jobs `pending` with an age over 15 minutes, the inline drain is not
keeping up and the scheduled drain has not caught them either. Two things call
`GET /api/jobs/drain`: `.github/workflows/drain.yml` on a `*/5` schedule (check it with
`gh run list --workflow=drain.yml --limit 5` — a run that fails in under 10 seconds means
`CRON_SECRET` is missing or wrong), and the Vercel cron **once daily** as the backstop
(Hobby-plan limit). GitHub throttles scheduled workflows heavily, so a gap of hours between
runs is normal rather than broken. If the interval genuinely matters, scale the Heroku worker
up (`heroku ps:scale worker=1 -a autoreply-pro-worker`, 60s polling) or point any 1-minute cron
service at the same URL with the same bearer.

## Step 9 — Idempotency, if you want it proven

Meta redelivers aggressively, and the refactor added queue-level dedupe on top of the existing
row-level claims. You cannot make Meta redeliver on demand, but you can confirm the guard is
armed: comment the **same keyword again from the same account within 24 hours**. Expect
`④ recipient cap` to suppress a second DM — the watcher shows
`interaction … FAILED: Skipped: recipient already received an automated DM within 24 hours`,
which is the per-recipient cap working, not a fault.

---

## Verifying TikTok

Steps 1–9 prove the Meta pipeline. This proves the TikTok one — Connect, a Direct Post, TikTok's
processing, and the three writers that settle the status — with a post nobody but you can see.
Until TikTok audits the app, that is the only kind of TikTok post there is: **Only me
(`SELF_ONLY`), from a private account.** Setup and background: [`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md).
When something is already broken: `RUNBOOK.md` §10.

**Budget 20 minutes.** You need the TikTok account connected in Settings, the phone with TikTok on
it, a short MP4 (5–15 s, H.264, 23–60 fps, at least 360 px a side), and for T6 two JPEGs.

| Safe to run any time | Never run to "test" |
|---|---|
| The Settings card, Posts Scheduler, read-only `SELECT`s | `GET /api/jobs/drain` or `GET /api/cron/publish` — **they publish every due post, TikTok rows included** |
| **Publish now** on *your test row* | **Publish now** on a real scheduled post |
| The unsigned webhook `POST` (a `401` by design) and the signed probe in RUNBOOK §10.6 | Removing the app under TikTok's "Manage app permissions" — `authorization.removed` **deletes the connection** |

### T1 — Pre-flight

1. Settings → **TikTok**. Healthy: **Connected**; "Posting mode: Direct post or drafts — you choose
   per post (until TikTok approves the app)"; **Permissions** shows `user.info.basic`,
   `video.upload` and `video.publish`; "reconnect before" is months away.
2. Settings → TikTok → **TikTok app (platform admin)**: "Direct Post is switched on…" ticked,
   "TikTok has approved this app…" unticked.
3. The connection, read-only:

   ```sql
   SELECT status, scopes, last_refreshed_at, refresh_expires_at, left(last_error, 120) AS last_error
     FROM platform_connections
    WHERE platform = 'tiktok';
   ```

   Healthy: `active`, `last_refreshed_at` within the last day, `last_error` NULL.
4. The public surface — the `curl` block in guide §2.4. Healthy: `200` `200` `200`, `302`, `401`.

| Finding | Why it stops you |
|---|---|
| **Needs reconnecting** | every post fails at the token step — RUNBOOK §10.4 |
| Posting mode "Inbox drafts" | the Direct Post switch is off, or the connection lacks `video.publish` — guide §5.1 |
| no `video.publish` chip | Reconnect first |
| a verification file answers `404` | T6's photo post will fail — guide §2.5 |

### T2 — Make the account private

TikTok app → Profile → menu → Settings and privacy → Privacy → **Private account** on. Before the
audit TikTok accepts a direct post only from a private account; T7 shows the refusal when it isn't.

### T3 — Create the test post

Posts Scheduler → new post:

- **Platform** TikTok, **Type** Video, upload the MP4.
- **Caption** with a marker you can search for, e.g. `verify-tiktok 2026-09-25 14:05`.
- Schedule it **an hour ahead**, so no drain claims it before you do.
- **TikTok post settings**: "Post directly to my profile"; "Who can see this video" → **Only me**;
  Interactions left off; Commercial content left off; tick **I agree to post this video to my
  TikTok account**.

Healthy — the row exists, `PENDING`, carrying the choices and the moment of consent:

```sql
SELECT id, status, platform_options
  FROM scheduled_posts
 WHERE platform = 'tiktok' AND caption LIKE '%verify-tiktok%'
 ORDER BY created_at DESC
 LIMIT 1;
```

`platform_options` reads `"mode": "direct"`, `"privacy_level": "SELF_ONLY"`, every `allow_*`
`false`, and a `consent_at` of just now (`validateTikTokOptions`,
`src/services/tiktokPublish.ts:73-135`). Note the `id`.

### T4 — Publish now, and read the stages

Press **Publish now** on the card. The request waits up to 12 seconds for TikTok's verdict
(`src/services/tiktokPublish.ts:45`). Re-run this as it goes:

```sql
SELECT status, attempts, claimed_at, external_publish_id IS NOT NULL AS reached_tiktok,
       published_post_id, status_checked_at, left(error_log, 200) AS error_log
  FROM scheduled_posts
 WHERE id = '<id from T3>';
```

| Stage | The row | The Vercel log line |
|---|---|---|
| ① claimed | `PUBLISHING`, `attempts` 1, `claimed_at` now | `publish.now_requested` |
| ② init accepted | `reached_tiktok` true — written **before** any byte is uploaded, so a crash from here resumes rather than re-posts | `tiktok.upload_started { mode: "direct", caption_sent: true }` |
| ③ uploaded | `PROCESSING` | `tiktok.upload_done` |
| ④ settled | **`PUBLISHED`**, `published_post_id` NULL — an Only me post never gets a TikTok id | `tiktok.publish_settled { status: "PUBLISHED" }` inline, or later `tiktok.webhook_applied` / `tiktok.reconciled` |

A card still reading "TikTok is processing" after the 12 seconds is normal: TikTok is still
working, and the webhook or the next drain's sweep moves it on.

**Where it stops is the diagnosis:**

| Last thing you see | Means | Do |
|---|---|---|
| a refusal when saving (400/409) | the composer's checks: privacy not Only me, consent unticked, TikTok not connected | read the message; RUNBOOK §10.2, §10.4 |
| `FAILED`, `reached_tiktok` false, "TikTok creator info: …" | reading the account's posting options failed, usually on the token | RUNBOOK §10.4 |
| `FAILED`, `reached_tiktok` false, "TikTok post init: Until TikTok approves this app, direct posts only work when your TikTok account is set to private…" | the account is still public | T2, then **Publish now** |
| `FAILED`, "This video is *n*s; your TikTok account allows up to *m*s." | too long for this account | a shorter video |
| `FAILED`, `reached_tiktok` true, "TikTok upload (chunk 1 of 1): …" | the upload broke after the init | **Publish now** — the retry asks TikTok first (RUNBOOK §10.1) |
| `FAILED` with one of TikTok's `fail_reason` sentences | TikTok refused the video after processing it | guide §11.2 — usually re-encode |
| `PROCESSING` for more than a few minutes | TikTok is slow, or nothing is polling | RUNBOOK §10.7 |
| `PUBLISHED` | the pipeline worked | T5 |

### T5 — Check it on TikTok

The database only records what TikTok *said*. On the phone: Profile. The video is there, visible to
you alone — look in the grid and under the private (lock) tab — with the caption and its marker.
Tap ⋯ → **Privacy settings**: it reads **Only me**. Leave it so; it is a test.

`PUBLISHED` but nothing on the profile after a few minutes is worth writing down with the time and
the row's `external_publish_id`: TikTok reported `PUBLISH_COMPLETE` for that publish id, so the gap is
on TikTok's side — the same shape as the inbox drafts nobody could find (RUNBOOK §10.5).

### T6 — A photo post (optional; proves the URL prefix)

Repeat T3–T5 with **Type** Carousel, two JPEGs, a **TikTok title**, Only me. The stages are the same
minus the upload: the log says `tiktok.photo_post_started { photos: 2, mode: "direct" }` and TikTok
pulls the images itself (`src/services/tiktokPublish.ts:422-465`). A `url_ownership_unverified` or
"could not fetch the photos" here is exactly the finding T6 exists for — RUNBOOK §10.3.

### T7 — The refusal path (optional, safe)

Make the account **public**, create a second Only me test post, and press **Publish now**. Expect
`FAILED` with "TikTok post init: Until TikTok approves this app, direct posts only work when your
TikTok account is set to private…" and `reached_tiktok` false — TikTok refused the init, so nothing
was posted. Now make the account private and press **Publish now** on the same card: expect
`PUBLISHED`. That proves the error surface and the retry that the real private-account workflow
(guide §6.3) depends on.

### T8 — The webhook, separately

T4 can pass without the webhook: the inline poll and the sweep write the same status. So look in the
Vercel logs around the test's time:

| You find | Means |
|---|---|
| `tiktok.webhook_applied { event: "post.publish.complete", outcome: "post_published" }` | the webhook is delivered and verified. It logs `post_published` even when the poll got there first — the transition is idempotent |
| `tiktok.webhook_signature_rejected` | TikTok calls, but with a different secret — RUNBOOK §10.6 |
| neither | TikTok did not call: check the Webhooks product and its callback URL in the portal. Posts still settle, only later |

### T9 — Post-flight

1. Delete the test posts in TikTok (⋯ → Delete). They are Only me, but a clean profile makes the next
   real run easier to check.
2. Put the account back the way it is normally kept, unless a real Only me run follows.
3. If you like, delete the test rows in Posts Scheduler — that removes this app's record only, never
   the TikTok post (`src/routes/api.ts:2492-2516`).
4. Re-run the T1 connection query: still `active`, `last_error` NULL.

### What the TikTok procedure does not prove

- **Public posting.** It needs the audit; until then nothing here can show a post going out as
  Everyone.
- **Inbox drafts.** Known unreliable (RUNBOOK §10.5). An `IN_INBOX` row proves nothing a person can
  see.
- **The 5-draft hold, `rate_limit_exceeded` under a backlog, and the 24-hour give-up.** They need load
  or time.
- **Token refresh.** Check `last_refreshed_at` the day after: the daily cron refreshes every
  connection. The yearly reconnect can only be diarised (guide §8.1).
- **`authorization.removed`.** Testing it means removing the app in TikTok, which deletes the
  connection. If you do, expect the `platform_connections` row gone and Settings back to **Connect
  TikTok**.
- **The sandbox → production switch.** It happens once, on approval (guide §8.3).

---

## What this procedure deliberately does not verify

- **Publishing.** There is no dry run: `/api/cron/publish` publishes to the live accounts, and
  six posts are currently `PENDING`. Verify it only when you actually want the next scheduled
  post to go out; the diagnostics already report stranded claims, overdue rows and failures.
- **The Instagram app's signing secret.** `diagnose.mjs --probe-signature` proves
  `META_APP_SECRET` matches production (it POSTs a correctly signed body whose `object` is
  unrecognised, which returns 200 before the enqueue and writes nothing). `INSTAGRAM_APP_SECRET`
  belongs to the separate Instagram-Login app and is not in the local `.env`, so the only proof
  for it is a real Instagram-signed delivery — which is step 5.
- **Multi-tenant isolation.** One creator row exists and it is the active one, so the tenant
  scoping cannot be exercised at all. Fair queueing by `tenant_key` is likewise untestable
  here: with one page id every job lands in one partition, which is exactly the degenerate case
  the round-robin was written to avoid (`src/jobs/queue.ts:100-123`).
- **Token re-checking.** Nothing asks Meta about the token on a schedule. A token that dies
  while the account is quiet will not be noticed by anything in this procedure — the passive
  detector only fires on a real send failure (`src/services/tokenHealth.ts:47`). Data access
  on the current token lapses **2026-12-19** while `/debug_token` still reports it valid; see
  `RUNBOOK.md` §3.
- **Data-subject erasure.** *Superseded 2026-09-21: there is now a two-step preview-then-execute
  tool at Dashboard → Erasure, backed by `src/services/erasure.ts`. See RUNBOOK §7.* The
  original note follows, for the retention half which still applies. The retention sweep that the
  published `/data-deletion` page depends on is a no-op until `RAW_PAYLOAD_RETENTION_DAYS` is
  set. See `RUNBOOK.md` §7.

## If it all goes wrong

`WEBHOOK_QUEUE=off` in the Vercel environment reverts to processing inline with no queue, which
is the behaviour that shipped before this refactor. The handlers are the same either way, so it
is a rollback of the durability layer only.

---

## Verifying the Carousel Studio

This proves the Studio's whole path once, on the live deployment: scan the library, index one
lesson, generate one carousel, render it, and schedule it. What each part does is in
[`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md); the SQL for when a step goes wrong is in
[`RUNBOOK.md`, *Carousel Studio*](RUNBOOK.md#carousel-studio).

**Budget 30 minutes**, most of it waiting: on the creator's uplink (20 to 30 KB/s) an index takes a
few minutes and a render about three. It costs two to four Gemini requests, out of a free tier of
about 20 a day per Flash model. **Nothing is published until step 5**, and then only at the slot you
pick, so pick one hours ahead.

| Safe at any time | Acts on the live accounts |
|---|---|
| Scanning, indexing, generating, rendering and editing: they touch only the Studio's tables, the media store and the Gemini quota | **Schedule**: a real post at its slot, and a campaign that answers comments from that moment |
| Every query in RUNBOOK's *Carousel Studio* section that doesn't say **Write** | **Post queued TikTok carousels**: posts to TikTok *now* |
| `node scripts/studio-harness.mjs`: the Studio page on fixtures, with no database, Gemini or worker | |

### Step 0: pre-flight

1. **The schema.** `npm run migrate:status` lists `migration_v21_studio.sql` as applied. If it
   isn't, every Studio route answers 503 *"The database is missing migration v21…"*; run `npm run
   migrate` first.
2. **The settings.** Studio → Settings has a **Library folder**, and the Brand kit, Voice and
   Product sections hold the creator's values, not the neutral defaults (*My Studio*, English).
   `node scripts/seed-studio-settings.mjs <creatorId> --dry-run` prints what the seed would write.
3. **The worker.** The status bar says **Worker online**, and RUNBOOK's workers query shows
   `online = true`. On the Mac, `launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E
   'state|pid'` shows it running. Keep `tail -f ~/Library/Logs/aicourse-studio-worker.log` open in
   a Terminal for the rest of this procedure.
4. **The quota.** If anything failed with *HTTP 429* today, wait for the reset (midnight Pacific:
   10:00 or 11:00 in Riyadh) or enable billing (guide §8). A run on a spent quota proves nothing.

### Step 1: scan

Press **Scan library** (فحص المكتبة). The toast says *"Scanning the library. New lessons appear here
when it finishes."*

- **The log:** `scan_library …: claimed`, `reading durations 1/35`, then `scan: 34 lessons among 35
  videos in /Users/elamir/Desktop/AI Course` and `done in …s`.
- **The database:** RUNBOOK's scan query shows the newest `scan_library` job `done`, with
  `lessons_upserted` 34 and `skipped` empty.
- **The dashboard:** the status bar reads *n/34 lessons indexed*, and the lesson picker lists the
  lessons by number, 1.2 before 1.10.

A scan that finishes with no lessons has failed on the Mac, which the dashboard does not show: read
the job's error.

### Step 2: index one lesson

Pick a short lesson marked **Not indexed yet**, open it from the lesson picker, and press **Index
this lesson** (فهرس هذا الدرس). It turns **Indexing…** at once.

- **The log**, in order: `making the proxy for Gemini: …%`, then `index: … MB original, … MB proxy
  (…%)`; `uploading the … MB proxy to Gemini: …%`, then `index: uploaded the … proxy in …s (… KB/s)`;
  `Gemini is processing the video`; `Gemini is watching the lesson`; `Gemini gemini-3.5-flash: …
  tokens in, … out`; `thumbnail 1/…`; `index: … points, … prompts, … moments (… clean)`; `done in
  …s`. The model named is one of the indexer's chain (`gemini-3.5-flash`, `gemini-3.6-flash`,
  `gemini-3-flash-preview`) and **never `gemini-2.5-flash`**, the DM bot's.
- **The database:**

  ```sql
  SELECT l.lesson_no, l.status, l.indexed_at, left(l.notes->>'summary', 120) AS summary,
         count(m.id) AS moments,
         count(m.id) FILTER (WHERE m.clean) AS clean,
         count(m.id) FILTER (WHERE m.thumb_url IS NULL) AS without_thumbnail
    FROM course_lessons l
    LEFT JOIN lesson_moments m ON m.lesson_id = l.id
   WHERE l.lesson_no = '4.3'                       -- the lesson you indexed
   GROUP BY l.id;
  ```

  Healthy: `indexed`, 12 to 30 moments, some of them clean (with none, the carousel gets no
  screenshots), and `without_thumbnail` 0.
- **The dashboard:** the lesson's details show a summary, *What it teaches*, the tools, and
  *Screenshots (n)* with thumbnails. Spot-check two points and one moment's time against the video
  itself: the notes are all the writer may use, so this is the step where invention would start.
- **A thumbnail is public**, as Instagram needs its images to be. Copy one `thumb_url` from
  `lesson_moments` and `curl -sI '<thumb_url>' | head -3`: `200`, `content-type: image/jpeg`.

### Step 3: generate

**From a lesson** (من درس) → pick the lesson you indexed → **Generate carousel** (أنشئ الكاروسيل).
Leave **More options** alone the first time. *Writing your carousel* walks through its stages, and
about a minute later (54 s for the first real one) the draft appears as **Rendering**.

- **The Vercel logs:** on the free tier, a `studio.ai_request_failed` line for
  `gemini-3.1-pro-preview` with `http_status` 429 comes first. That is expected, because the Pro
  model has no free quota. Then `studio.ai_usage` names the Flash model that answered, and
  `studio.draft_generated` shows `problems_left: 0` and the `rounds` of repair it took.
- **The database:**

  ```sql
  SELECT id, status, carousel->>'keyword' AS keyword, carousel->>'accent' AS accent,
         jsonb_array_length(carousel->'slides') AS slides,
         carousel->'slides'->0->>'title' AS cover,
         campaign->>'create' AS new_campaign, campaign->'variants' AS variants,
         (SELECT count(*) FROM jsonb_object_keys(coalesce(shots, '{}'::jsonb))) AS screenshots
    FROM carousel_drafts
   ORDER BY created_at DESC
   LIMIT 1;
  ```

  Healthy: `rendering` (or already `ready`), usually 8 slides (never fewer than 6: a slide the
  writer could not source is dropped), a one-word keyword, an accent from the palette, and one to
  three screenshots.
- **By eye, the checks no rule makes:** every middle slide says something the lesson says; no
  number appears that is not in the notes or the product facts; the Instagram caption carries the
  keyword line with *this* keyword; the TikTok description carries the bio line and asks for no
  comment. Run RUNBOOK's keyword-clash query with the keyword: no other active campaign should
  answer it unless the draft reused that campaign on purpose (`new_campaign` false).

### Step 4: render

The editor re-reads the draft every 4 s. *"Rendering the slides on your Mac. This page updates by
itself."* About three minutes later the draft is **Ready**.

- **The log:** `render_carousel …: claimed`; `bundled src/ in …s` on the first render after the
  worker starts; `extracting shot 1/…`; `rendering ig 1/8` through `rendering tt 8/8`; `uploading
  slide 1/16` through `16/16`; `done in …s`. Most of the time is the uploads.
- **The database:**

  ```sql
  SELECT id, status, jsonb_array_length(carousel->'slides') AS slides,
         jsonb_array_length(render->'ig') AS ig, jsonb_array_length(render->'tt') AS tt,
         render->>'rendered_at' AS rendered_at
    FROM carousel_drafts
   ORDER BY created_at DESC
   LIMIT 1;
  ```

  Healthy: `ready`, and `ig` and `tt` each equal to `slides`.
- **The dashboard:** both **Instagram 4:5** and **TikTok 9:16** show every slide. Check the
  cover's highlighted words in the accent, the screenshots' framing, the signature, the digits,
  and the last slide's words, which come from Settings (the keyword pill on Instagram, the bio pill
  on TikTok).
- **The edit loop:** change one word on a slide and press **Save & update preview**. The draft goes
  **Rendering**, then **Ready** with the change. Then prove the rules guard edits: make a title far
  too long and save. **Problems to fix: 1** appears on that field and nothing is saved. **Discard
  changes**.

### Step 5: schedule

In **Schedule** (جدولة), pick a slot hours ahead (the first free one, or **Another time…**). For TikTok,
**Queue for TikTok** or **Don't post to TikTok**. Keep **Also create the keyword automation** ticked if
the keyword is new. Read *What will happen*, then press **Schedule for {time}**.

- **The database:**

  ```sql
  SELECT p.id, p.platform, p.post_type, p.status, p.scheduled_time,
         array_length(p.media_urls, 1) AS images, left(p.caption, 80) AS caption
    FROM carousel_drafts d
    JOIN scheduled_posts p ON p.id::text = d.schedule->>'meta_row_id'
   WHERE d.id = '<draft id>';

  SELECT id, trigger_keyword, match_mode, is_active, post_id, created_at
    FROM campaigns
   ORDER BY created_at DESC
   LIMIT 3;
  ```

  Healthy: one post, `both` and `carousel`, `PENDING` at the slot, with as many images as slides
  and the Instagram caption. And a campaign on the keyword (plus its variants), `substring`, active,
  for every post (`post_id` NULL); or, when the keyword was reused, no new campaign, and the audit
  log's `studio.schedule` row saying `campaign_created` false with the older campaign's id.
- **The dashboard:** the editor is read-only (*"Scheduled, so edits are closed…"*), says *Publishes
  {when}*, and **Open in Posts** shows the post. With **Queue for TikTok**, **Waiting for TikTok** in
  the status bar went up by one.

**From here it is live.** The campaign answers the keyword on every post now, and the post
publishes at its slot. To stop it, delete the post in Posts and pause the campaign on the Campaigns
page.

### Step 6, optional: after it publishes

- **The DM.** Once the post is live, prove the keyword round trip with the main procedure's Steps 2
  to 5 (*Pick a keyword that will actually match* through *Read the stages*), commenting the
  carousel's keyword from your second account.
- **TikTok**, only when you mean to post: set the TikTok account to private, press **Post queued
  TikTok carousels**, and watch its row in Posts go through TikTok's statuses. Then make the post and
  the account public, and tick **Made public on TikTok**.

### What this does not verify

- **Several workers, or a hosted one.** One Mac proves one worker. The shared-path requirement of a
  second machine (guide §3) is untested.
- **The copy's quality**, beyond your read in step 3. The rules prove limits and required lines,
  not that a slide is good.
- **Plan my week**, **Rewrite with AI**, and a brand-kit change followed by a re-render. Each is one
  more button on the same path; the first two also spend Gemini quota.
