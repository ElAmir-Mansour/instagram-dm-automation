# Verifying AutoReply Pro against a real Meta event

The pipeline was split into modules, given a durable job queue, moved the 200 to before the
work, wired rate limiting and added an AI disclosure prefix. 449 unit tests cover the pieces.
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
