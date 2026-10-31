# AutoReply Pro — operator runbook

For the person who operates this, at 2am, when something is wrong.

Every procedure below is: the symptom, what to run, what healthy looks like, and what to do
when it isn't. Claims are cited so you can check them rather than trust them: older ones to
`file:line`, newer ones to the file plus the function, route, setting or log event, because line
numbers move and a name can be searched for.

This document works backwards from a symptom. When you need the forward direction — every hop a
comment, DM, publish, login or job actually takes, in order — see [`FLOWS.md`](FLOWS.md); its
final table indexes every point where a flow can silently do nothing.

## Find your symptom

| What you see | Go to |
|---|---|
| You do not know what is wrong yet | §1 |
| A comment got no DM | §2 |
| A token, a "Reconnect" notice, a missing Meta permission | §3 |
| A post did not publish | §4 (TikTok §10, YouTube §14) |
| Jobs are pending, stuck or failed; something runs late | §5 |
| A migration is pending, or a schema error | §6 |
| Someone asked for their data to be deleted | §7 |
| Adding a client, an invite, a webhook subscription | §8 |
| A deploy broke something | §9 |
| TikTok: a failed post, "Only me", the token, drafts | §10 |
| WhatsApp: a message did not arrive, no reply, free replies | §12 |
| Ads: "Spending is not being watched", paused campaigns, a dead token, limits | §13 |
| YouTube: "Needs reconnecting", the quota, a Short that is not public | §14 |
| The Mac: Studio jobs wait or fail, Claude jobs, explainer pictures stopped | §15 (the Carousel Studio section has the worker commands) |
| The DM bot: slow, silent, sales mode, the hand-off alert | §16 |

**Ground rule.** Two scripts are safe to run at any time and cannot write:
`scripts/diagnose.mjs` and `scripts/watch.mjs` run every query in its own
`BEGIN READ ONLY … ROLLBACK`, checked inside the transaction, and neither prints a token,
password or connection string (`scripts/diagnose.mjs:5-9`, `scripts/watch.mjs:15-18`).

Two things are **never** "just a test", because both act on the live accounts:

| Endpoint | What it actually does |
|---|---|
| `GET /api/cron/publish` | The daily cron's whole job. It publishes every `PENDING` post whose `scheduled_time` has passed (`publishDuePosts`), and it runs the once-a-day sweeps: stale publish claims, retention, a backstop queue drain, the TikTok, YouTube, WhatsApp and Meta Page token refreshes and health checks, the ads health check and proposals, the explainers backstop and the growth sync (route `GET /cron/publish`, `src/routes/api.ts`). |
| `GET /api/jobs/drain` | Runs real handlers: it sends real DMs and real public replies. In the same call it publishes due posts, asks TikTok about unfinished uploads, and runs the ads sweeps: the spending guard (which can **pause every active campaign** in the ad account), the rules, the write queue and its sync, the split-test polls and the lead purge. It ends with the Monteur sweep (route `GET /jobs/drain`, `src/routes/api.ts`). |

---

## 1. "Is it working?"

```bash
node scripts/diagnose.mjs
# from a git worktree, which has no .env of its own:
node scripts/diagnose.mjs --env /path/to/repo/.env
```

Reads the deployed app and the production database and prints a verdict, then `CRITICAL`,
then `WARNINGS`, then `HEALTHY`, then a `DETAIL` block of context
(`scripts/diagnose.mjs:918-975`).

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
*before* the 200 goes back to Meta, matched or not (`src/index.ts:417-436`), so:

> Note the asymmetry: `entry.changes` elements are enqueued unconditionally, but `entry.messaging`
> events are filtered first — echoes, read watermarks and delivery receipts never become jobs at
> all (`isActionableMessagingEvent`, `src/webhook/router.ts:86`). So an empty `jobs` table rules
> out comment traffic; it does not by itself rule out DM traffic that was all receipts.

> **An empty `jobs` table is the one thing "nothing matched" cannot explain.**
> (`scripts/diagnose.mjs:598-604`)

```
! queue    the jobs table is EMPTY — no webhook delivery has ever been enqueued
```

On 2026-09-21 that warning was **present** on production: no delivery had reached the handler
since migration v13 was applied. Do not read it as proof of a broken webhook on its own: the
migrations were applied at 2026-09-21 13:17Z and the account's typical comment gap was 68
minutes, so an empty table a couple of hours later was also just a quiet evening. It becomes an
incident when it is still empty after a comment you posted yourself — which is the whole point
of `VERIFYING.md`.

The word "ever" in that line is no longer true. The daily retention sweep deletes `done` jobs
after 7 days (§5.3), so an empty table now means "no delivery in the last seven days", and a
quiet week looks the same. Post a comment from a second account before you conclude anything.

The one caveat: if `WEBHOOK_QUEUE=off` is set in the environment, nothing is enqueued by design
(`src/index.ts:418`, `.env.example:57-64`) and an empty table proves nothing at all. Check that
first.

---

## 2. "A comment didn't get a DM."

Work these in order. The first four are cheap and cover almost everything.

### 2.1 Is the keyword actually a substring match?

Matching is **substring by default**, on Arabic-normalised text
(`src/services/matching.ts:115-116`, `src/utils/arabic.ts:141`). `trigger_keyword` is a
comma-separated list and any one entry matching is enough (`src/services/matching.ts:111-116`).
A campaign with a non-null `post_id` fires only on that post (`src/services/matching.ts:122`).

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
(`scripts/diagnose.mjs:88`, `:578`), so a 3-character keyword passes the check silently while
still matching inside a longer word. `عيد` and `eid` are in that blind spot today.

The fix per campaign is `match_mode = 'word'`, which anchors the keyword to token boundaries
using explicit Unicode lookarounds — JavaScript's `\b` is useless for Arabic
(`src/utils/arabic.ts:143-148`). It is set per campaign from the dashboard and defaults to
`substring` forever, so existing campaigns never change behaviour on their own
(`src/config/migration_v14_functionality.sql:16-18`).

### 2.2 Is the callback URL right — per object type?

There is **one callback URL per object type, app-wide**, and the `instagram` object once
pointed at an unrelated project while Facebook worked fine. `diagnose.mjs` checks both
(`scripts/diagnose.mjs:237-247`). Healthy:

```
✔ meta     all 2 webhook subscriptions point at this deployment
  instagram → https://msg-response-auto.vercel.app/webhook (active) [comments, mentions, messages, messaging_postbacks, story_insights]
  page      → https://msg-response-auto.vercel.app/webhook (active) [feed, messages, messaging_postbacks, messaging_referrals]
```

Both must name *this* deployment, and the fields list must contain what you depend on —
`comments`/`feed` for the comment path, `messages` for DMs.

The `page` object also needs `messaging_referrals`: a person who already has a Messenger thread
and taps a click-to-message ad is announced only by that field, so without it ads → DM
attribution silently misses every existing thread. `diagnose.mjs` warns when a field is missing
(`object "page" is not subscribed to: messaging_referrals`). `leadgen` (lead ads) is needed only
once a tenant has a lead-ads legal sign-off, so `diagnose.mjs` prints its absence as a fact, not
a warning. The app subscribes a connected Page to the same list itself (`WEBHOOK_FIELDS` and
`leadgenFieldsFor`, `src/services/metaLogin.ts`); the App Dashboard's Page webhook needs the
fields too.

**The dashboard checks this for you (2026-10-30).** On 2026-10-30 another project that uses this Meta app pointed `instagram` at its own site: 45 hours without an Instagram
DM or comment while every connection read "Connected". Settings → Platform → "Where Meta sends your events" now reads the same `GET /{app}/subscriptions` and says, per object, whether
it goes to AutoReply, to another website (named), or is switched off, with when an event of that kind last reached the workspace; "Send everything to AutoReply" sets it back after a
question that lists what will change. The drain reads it at most once an hour: a problem raises a red alert on Today, a strip on the Inbox, and an email and Telegram message once a day
per problem (`meta.webhooks_checked` and `meta.webhooks_alert` in the log). `diagnose.mjs` stays the check you run from a terminal. How it works: `FLOWS.md` §8.10.

### 2.3 Was the signature rejected?

**A webhook signature failure is invisible from the database.** The 403 happens before
anything is written (`src/index.ts:365-374`), so it is indistinguishable from silence. The only
evidence is the Vercel log line:

```
webhook.signature_rejected  { app_keys_tried: N, instagram_app_configured: true|false, probe: true|false }
```

`app_keys_tried` is how many app secrets the signature was checked against (`0` means neither is
set), `instagram_app_configured` says whether `INSTAGRAM_APP_SECRET` is one of them, and
`probe: true` is `diagnose.mjs --probe-signature` proving the guard still holds, not an incident.
Until 2026-10-25 the first two were named `secrets_tried` and `instagram_secret_set`, and the
logger printed both as `"[redacted]"` (it blanks any field whose name contains `secret`), so older
lines show no count at all.

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
| `Skipped: recipient already received an automated DM within 24 hours.` | Per-recipient courtesy cap. Working as designed. | `src/webhook/comments.ts:272-279` |
| `Skipped: hourly DM quota reached (N/180). …` | This tenant's hourly ceiling, 180/hr (`DEFAULT_HOURLY_LIMIT`). | `src/webhook/comments.ts` |
| `Skipped: the app-wide Meta send budget is exhausted (N/L this hour). …` | The **app-wide** pool, shared by every tenant — another tenant may have caused it. Default 1000/hr, `META_APP_HOURLY_LIMIT`. | `src/webhook/comments.ts`, `checkFairSendQuota` in `src/utils/rateLimiter.ts` |
| `App does not have Advanced Access to instagram_manage_messages` | The recipient must have messaged you first, or you need App Review. | Meta |
| `Activity already replied to` | That comment was already handled. | Meta |

Both quota lines also log `dm.quota_exhausted`, with `blocked_by` (`creator` or `app`) and
`source: 'comment'`. A skipped comment is **not retried**: the row is `FAILED` and the person gets
no DM.

`Send quota exhausted (creator: N/L)` and `Send quota exhausted (app: N/L)` are the **DM** path's
wording (`src/webhook/messaging.ts`), not the comment path's, and they are not written to
`interactions`. A DM is retried instead: the text is the job's `last_error` while it backs off
(30 s, 2 m, 8 m; §5.3), and the same `dm.quota_exhausted` line says which ceiling (`source: 'dm'`).
If the ceiling still holds on the last attempt, the message is concluded with no reply and only
that log line remains.

A `PENDING` interaction row is unfinished work, not a resting state: `SENT` is written before
`recordDmSent` and every failure path writes `FAILED` or `USER_BLOCKED_DMS`
(`src/webhook/comments.ts:142-143`).

**A successful public reply is recorded nowhere.** Only failure is, in
`interactions.error_log`. Success exists solely as the log line `comment.public_reply_sent`
(`src/webhook/comments.ts:462`).

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

On 2026-09-21 production reported a healthy token **and** this, in the `DETAIL` block rather than
as a warning:

```
[Default] data access expires in 89d (2026-12-19 14:29:29Z)
```

Data access is **separate from token expiry**. The token is a PAGE token that never expires,
but Meta lapses *data access* after 90 days without re-authorisation, and when it does, reads
start failing while `/debug_token` still answers `is_valid: true`
(`scripts/diagnose.mjs:437-444`).

Two things now watch for it, and both start only inside 14 days of the date. The daily check
asks Meta about every connected tenant's Page token and raises **Reconnect due** for a
data-access date less than 14 days away (`recheckAllMetaTokens`,
`src/services/metaTokenRecheck.ts`; §3.1). `diagnose.mjs` turns its `DETAIL` line into a warning
inside the same 14 days (`scripts/diagnose.mjs:442`). That is later than you want to find out, so
**diarise the date** your own `node scripts/diagnose.mjs` prints (it was 2026-12-19 on 2026-09-21;
a reconnect moves it). Fixing it means re-authorising the app (Settings → Instagram & Facebook →
**Reconnect**) or re-exchanging the token (§3.3), not pasting the same one back.

### 3.1 What actually refreshes `token_status`

`creators.token_status` is not polled. These are the things that write it:

| Writer | Trigger |
|---|---|
| `recordTokenStatus` (`src/routes/api.ts:2470`) | someone opens the dashboard token page, saves a token, or runs the extend flow — three routes, one helper |
| `persistInspection` (`src/services/tokenHealth.ts:307`) | a deliberate re-check asks Meta and records the answer, including `POST /api/admin/tenants/:id/recheck-token` |
| `noteMetaFailure` (`src/services/tokenHealth.ts:49`) | **a real Meta send failed with code 190** |
| `recheckAllMetaTokens` (`src/services/metaTokenRecheck.ts:191`) | **the daily cron** asks Meta about every connected tenant's Page token and writes what Meta definitively said (valid, expiring, invalid). A transient failure writes nothing |
| `src/routes/admin.ts` (tenant create / PATCH) | a tenant is created (sets `'unknown'`), or an admin updates one |

The third is the one that matters and it is new: every Meta send path calls `noteMetaFailure`
in its catch block, so a token Meta revoked on Friday now flips the row the first time a send
fails, rather than reading `valid` until somebody happens to look
(`src/services/tokenHealth.ts:1-18`). It is deliberately narrow — it does not flip on a
missing scope (code 200), a recipient who blocked DMs (10903) or a transient 500, because
marking a working token invalid sends you to regenerate something that was never broken
(`src/services/tokenHealth.ts:16-18`).

`GET /api/admin/tenants` shows `token_status`, `token_last_checked_at` and `token_error` per
tenant (`src/routes/admin.ts:83-85`), but it **reads** the column — it does not re-check
against Meta. What does ask Meta: the daily cron (once a day, 00:00 UTC, with the other sweeps in
`/api/cron/publish`), the tenant owner's or an admin's Re-check button, and
`node scripts/diagnose.mjs`, which only runs when you run it.

**"Reconnect due"** (the notice on Settings → Instagram & Facebook and on Overview) is not a
column: it is `invalid`, or a data-access / token date less than 14 days away, as the daily check
last stored them (`getMetaConnection`). To see why a tenant has it:
`grep token.reconnect_due` in the logs (`warn`, `error` for a token Meta rejected), and
`token.recheck_transient` for the runs that could not reach Meta and so wrote nothing. A tenant
that shows it wrongly has a stored `invalid` from the manual Re-check pressed during a Meta
outage (that button still records "could not check" as `invalid`); the next daily run that gets
an answer clears it.

### 3.2 Tokens are encrypted at rest

`creators.page_access_token` is stored as `enc:v1:<iv>:<tag>:<ciphertext>`, AES-256-GCM, with
the key in `TOKEN_ENCRYPTION_KEY` (`src/config/crypto.ts:42-49`). Decryption happens in one
place, `withDecryptedToken` in `src/services/tenant.ts:116-122`, plus the publish cron which
reads off a joined row and decrypts inline (`attemptPublish`, `src/routes/api.ts:723`).

Two operational consequences:

- **A value without the `enc:v1:` prefix is returned unchanged** (`src/config/crypto.ts:58-60`),
  so a legacy plaintext token keeps working. `diagnose.mjs` warns when it finds one and the fix
  is to re-save the token from Settings (`scripts/diagnose.mjs:399-403`).
- `TOKEN_ENCRYPTION_KEY` is **not** required at startup, but it **is** required to save a token
  or create a tenant, and those endpoints say so (`src/routes/admin.ts:763-771`, `:1061-1069`,
  `.env.example:32-39`). Generate with `openssl rand -hex 32`.

**Losing `TOKEN_ENCRYPTION_KEY` loses every secret the app stores, not only the Meta tokens.**
It is not in the database by design — the threat model is database access, which is exactly what
materialised when the connection string was committed to a public repo
(`src/config/crypto.ts:4-8`). The same key (`encryptSecret`, `src/config/crypto.ts`) protects:

- the Meta Page tokens (`creators.page_access_token`), and the unfinished Facebook Connect picks
  in `oauth_states.payload`, which hold Page tokens;
- the TikTok, YouTube and WhatsApp connection tokens (`platform_connections`);
- every secret app setting (`app_settings` rows with `is_secret`, written by `setSetting`,
  `src/services/appSettings.ts`): the Gemini key, the AI-provider keys (Anthropic, OpenAI,
  OpenRouter, Groq, Meta, Baseten, custom), the TikTok and YouTube client secrets, the YouTube API key, the
  media-storage key, the Telegram bot token, the email (Resend) key, and each tenant's ads token
  (`ads.token.<tenant>`);
- the Cloudflare token that draws explainer pictures
  (`src/services/explainers/pictures/provider.ts`);
- what a person typed into a lead form (`ads_leads.answers_enc`), and the keyed hash that finds
  a person's leads for an erasure (`personKey`).

With the key gone, each of these must be entered again, and lead answers cannot be read. A
**wrong** key is no better: decrypting throws, so what needs the value fails (the daily Meta
check logs `token.recheck_unreadable` for a token it cannot decrypt, and does nothing else with
it). Keep a copy of the key where the database is not.

### 3.3 Rotating a token

1. `node scripts/diagnose.mjs` — confirm the current state and note the fingerprint.
2. Graph API Explorer → select the app → **User Token**, not a Page token → add the twelve
   required scopes (listed in `docs/TOKEN_GUIDE.md`, step 1), plus `instagram_manage_insights`
   and `read_insights` for the Growth screen → generate. (Where the operator has set up
   **Connect with Facebook**, connecting from Settings asks for all fourteen and replaces steps 2–4.)
3. `node --env-file=.env scripts/exchange-token.mjs <short-lived-user-token>` — exchanges via
   `/me/accounts` for a permanent PAGE token. It needs `META_APP_ID` and `META_APP_SECRET` in
   `.env` and exits without them. Starting from a Page token instead only ever gets you 60 days.
4. Paste it into the dashboard: **Settings** → **Advanced** → **Update access token** → **Validate & save**.
   That checks it with Meta, encrypts it on write and records `token_status = 'valid'`
   (`recordTokenStatus` in `src/routes/api.ts`). Never write the token with SQL (see
   `docs/TOKEN_GUIDE.md`, step 4).
5. `node scripts/diagnose.mjs` — expect `token is PAGE, valid, never expires, all 12 required
   scopes present`. The 12 are `REQUIRED_SCOPES` in `scripts/diagnose.mjs`, the same list as
   `src/services/tokenHealth.ts`.

A missing scope disables a path **silently**: `instagram_manage_messages` is DMs,
`instagram_content_publish` is scheduling, `pages_manage_engagement` is public replies
(`scripts/diagnose.mjs:449-451`).

---

## 4. "A post didn't publish."

```bash
node scripts/diagnose.mjs        # read the `publish` section
```

Healthy is `✔ publish  no stranded, overdue or failed scheduled posts`, with a `DETAIL` line
of counts by status. Today: `PENDING=6  PUBLISHED=10`.

**A TikTok post** has its own statuses (`PROCESSING`, `IN_INBOX`) and its own failure modes: §10.

### 4.1 It is probably the cron granularity

The Vercel cron runs **once daily at 00:00 UTC** — a Hobby-plan limit (`vercel.json` `crons`) —
but it is no longer the only thing that publishes. `GET /api/jobs/drain` calls
`publishDuePosts()` too (the route `GET /jobs/drain` in `src/routes/api.ts`), and three things call
that endpoint (§5.1), so a post scheduled for 14:30 goes out on the next drain rather than waiting
for midnight UTC.

What that buys is "within the drain interval", not minute accuracy. With the Heroku worker
running, the interval is about a minute, and the publish itself takes more (a reel that Instagram
is still processing is held and tried again on later sweeps; see *Publishing and DM safety*). With
the worker off, only GitHub's schedule is left, and it delivers every 2 to 5 hours (§5.1), so a
post late by hours is expected behaviour, not a fault. A post still `PENDING` the next day means
no drain is running at all, and §5.1 says how to check.

### 4.2 Stranded claims

A publish claims its row atomically by flipping `PENDING → PUBLISHING`
(`src/routes/api.ts:969-975`). If the invocation dies mid-publish the row stays `PUBLISHING`
forever, so each cron run first releases claims older than 15 minutes with attempts left
(`src/routes/api.ts:1030-1037`), and fails anything past 5 attempts with an explanatory
`error_log` (`src/routes/api.ts:1043-1050`).

If you see rows sitting in `PUBLISHING`, the cron has not run since they were claimed. Running
`GET /api/cron/publish` will release them — **and publish everything else that is due.**

### 4.3 The partial-publish case — read this before retrying

On `platform = 'both'`, **Facebook publishes first** (`attemptPublish`,
`src/routes/api.ts:726`), Instagram second (`:522`). A Facebook success followed by an
Instagram failure records the row as `FAILED` **while the Facebook post is live**.

Editing a scheduled post flips `FAILED → PENDING`:

```sql
status = CASE WHEN status = 'FAILED' THEN 'PENDING' ELSE status END
```
(`src/routes/api.ts:3214`)

Historically that republished it and **duplicated the Facebook post on the live account**.
That is fixed, but understand *how*, because the fix is what you are relying on:
`published_post_id` now retains whatever did go live, as `FB:<id>`, `IG:<id>` or
`FB:<id> | IG:<id>` (`publishedPlatforms` / `formatPublishedIds`,
`src/services/publishedIds.ts:22` and `:30`, written on the failure path at `src/routes/api.ts:828-838`), and the next
attempt parses it back and skips the platform that is already public (`:699-701`, and the
`&& !fbId` / `&& !igId` guards at `:726` and `:749`). The `error_log` also names what is live:
`Partially published (FB:123) — the rest failed: <reason>`.

So: **before retrying a `FAILED` post, read `published_post_id` and `error_log`.** If
`published_post_id` is non-empty, part of it is public. A retry will complete it, not repeat it
— but only as long as that column is intact. Do not clear it to "start clean".

`FAILED` is also the status for a partial success, deliberately, because the dashboard filters
on that vocabulary and a half-published post is not a finished post
(`src/routes/api.ts:823-838`).

### 4.4 Two combinations to know about

- `post_type: 'story'` with `platform: 'facebook'` or `'both'` is rejected at create time —
  Facebook Page stories need a `/photo_stories` + `/video_stories` upload that is not
  implemented (`unsupportedPlatformCombination`, `src/routes/api.ts:510`, called at `:1937`).
  `publishFacebookPost` also throws on it rather than degrading, because a degraded publish
  still returns a post id and is recorded as a success (`src/services/instagram.ts:608-613`).
- For cross-posting a video, prefer **`video`** over `reel`. This entry used to say
  `publishFacebookPost` "does not handle `reel` and falls through to a text-only feed post" —
  **that is no longer true**: `reel` and `video` are the same asset to Facebook and both now
  publish through `/videos` (`src/services/instagram.ts:627-633`). `video` remains the value to
  use because it is what the dashboard offers, and legacy `reel` rows are mapped onto it.

Also always set `cover_url`, or Instagram takes frame 0 as the thumbnail and any video fading
up from black gets a black tile in the profile grid. `attemptPublish` passes it through
(`src/routes/api.ts:776`).

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
| `N job(s) pending, oldest due Xm ago` | warn >15m, **crit >90m** | Nothing is draining. See §5.1. (`scripts/diagnose.mjs:85-86`, `:613-619`) |
| `job … has been "running" since …` | claim >300s | The invocation holding it died. It is reapable. (`scripts/diagnose.mjs:77`, `src/jobs/runner.ts:31`) |
| `job … exhausted its retries` | `attempts >= max_attempts` | Permanent. Read the printed error; retrying will not help. |

### 5.1 What drains the queue, and how to check it is still doing so

Three things call `GET /api/jobs/drain`, and all three are live:

| Caller | Interval | State |
|---|---|---|
| `heroku-worker/worker.mjs` (Heroku app `autoreply-pro-worker`) | 60 s after the last call finished | **running** (`worker=1`, about $7 a month). On 2026-10-25 the Vercel logs showed `GET /api/jobs/drain` once a minute |
| `.github/workflows/drain.yml` | written as `*/5`; GitHub delivers it every 2 to 5 hours, see below | **active**, free |
| Vercel cron → `GET /api/cron/publish`, which calls `drainWorker()` (`src/routes/api.ts:1071`) | once daily, 00:00 UTC | **active**, the backstop |

The worker has a second job: it is the **only** caller of `POST /api/onboarding/drafts/sweep`,
which moves tenant profile drafts along (§8.1). Scale it to zero and both stop. How to turn it on
and off, its settings, its log lines (`worker.drain_ok`, `worker.drain_bad_status`,
`worker.drain_failed`) and how to deploy a change are in
[`heroku-worker/README.md`](heroku-worker/README.md).

Check the worker first, because it is what keeps the interval short:

```bash
heroku ps -a autoreply-pro-worker     # "worker.1: up" means on; needs `heroku login`
```

or look for `/api/jobs/drain` once a minute in the Vercel logs. If it is off and should not be:
`heroku ps:scale worker=1 -a autoreply-pro-worker`. If you switch it off on purpose, also set
`FREQUENT_SWEEP` to `false` in `dashboard/js/pages/posts.js`, or the Posts screen promises minutes
that the daily cron cannot keep.

The GitHub one fails silently, so check it too:

```bash
gh run list --workflow=drain.yml --limit 5
```

A run that **fails in under ~10 seconds** means `CRON_SECRET` is not set as a repository secret,
or does not match production. That is not hypothetical: the workflow existed for a long time and
had *never once succeeded* for exactly that reason, which reads as "configured" at a glance
because a red row in a tab nobody opens looks the same as no rows at all. Fix with
`gh secret set CRON_SECRET`. The secret must be the same in Vercel, in the GitHub repository
secret and in the Heroku config var `CRON_SECRET`; a rotation changes all three
(`heroku-worker/README.md`).

**Do not expect five-minute punctuality.** The workflow asks for `*/5`, but GitHub throttles
scheduled workflows and does not guarantee them. The comment at the top of
`.github/workflows/drain.yml` says what was measured in October 2026: every 2-4.5 hours, so it is
the backstop. Counted with `gh run list --workflow=drain.yml --limit 30` on 2026-10-25: 25
scheduled runs since 2026-10-22, every one green, about 2 to 5 hours apart (the other five rows
were manual `workflow_dispatch` runs). Read it as "a few times a day". That is why the Heroku
worker, and not the workflow, is what answers "every minute". FLOWS.md §3.2 lays the four callers
side by side.

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

A healthy response is JSON. The queue's own numbers come first, then one key for each other thing
the call does:

```json
{"claimed":N,"succeeded":N,"failed":0,"budgetExhausted":false,"reaped":0,
 "publish":{"due":N,"claimed":N,"published":[],"heldForInactiveTenant":0},
 "monteur":{…},
 "tiktok":{"checked":N,"settled":N,"gaveUp":N}}
```

`budgetExhausted: true` just means the queue stopped on its time budget with work left — the next
call takes it. A key `jobsError`, `publishError` or `monteurError` names a part that threw; the
status is 500 only when both the queue and the publish part failed (`composeDrainResponse`,
`src/routes/api.ts`). The ads sweeps (the guard, rules, write queue, sync, split tests, lead
purge) add nothing to the body. They write their own log lines when they did something or
failed: `ads.cap_sweep`, `ads.rules_sweep`, `ads.ops_drain`, `ads.sync_sweep`, `ads.study_sweep`,
`ads.leads_sweep`.

**One call can take minutes, and that is not a hang.** The queue's own budget is 45 s (§5.2), but
the sweeps after it run until a deadline 270 s after the request started (`SWEEP_DEADLINE_MS` in
`src/services/monteur/sweep.ts`, overridden by the env var `MONTEUR_SWEEP_DEADLINE_MS`): the
Monteur's pick alone is two Gemini calls. The callers wait for it: the worker up to 290 s
(`REQUEST_TIMEOUT_MS`), the workflow's `curl` up to 300 s.

### 5.2 Draining by hand

The same `curl` above. Budgets, if you need to tune them:

| Knob | Default | Where |
|---|---|---|
| `JOB_INLINE_BUDGET_MS` | 8000 | drain inside a webhook invocation, after the 200 (`src/jobs/drain.ts:21-24`) |
| `JOB_WORKER_BUDGET_MS` | 45000 | drain for a dedicated `/api/jobs/drain` request (`src/jobs/drain.ts:27-30`) |

Lower `JOB_INLINE_BUDGET_MS` if webhook invocations are being killed on duration.

**Is the inline drain being kept alive after the 200?** The webhook drains under `waitUntil`
(`src/webhook/ack.ts`). Read the median created-to-done time per job kind (run it read-only,
through `connectReadOnly()` as in §2.1); after the deploy it should sit in seconds, where it was
`dm.process` p50 125 s and `comment.process` p90 28 s:

```sql
SELECT kind, percentile_cont(0.5) within group (order by extract(epoch from (updated_at-created_at)))
FROM jobs WHERE status='done' AND created_at > now()-interval '1 day' GROUP BY 1
```

A median back near 70 s means the instance is being frozen again. Look for
`runtime.wait_until_unavailable` in the logs (the platform gave the request no `waitUntil`).

> **Unverified:** `vercel.json` sets no `maxDuration` for the function, so the platform's limit
> for this plan is only assumed to be 300 s (the sweep deadline in §5.1 and `drain.yml` both
> assume it). If `/api/jobs/drain` returns a platform timeout rather than JSON, lower
> `MONTEUR_SWEEP_DEADLINE_MS` first, because the sweeps are what run long, then
> `JOB_WORKER_BUDGET_MS`.

### 5.3 Stuck and failed jobs

A claim is reapable after **300 seconds** (`src/jobs/runner.ts:31`) — generous on purpose,
because reaping a job that is still running is how a DM gets sent twice. Both drain paths reap
before claiming (`src/jobs/drain.ts:53-58`, `:87`), so **draining is also how you unstick a
stale claim**. A job with attempts left goes back to `pending`; one without becomes `failed`
with `[abandoned: the claim went stale and no attempts remain]` appended
(`src/jobs/queue.ts:212-231`).

A drain that only ran out of its time budget does not leave claims for this: it hands the jobs it
claimed but did not reach back to `pending` itself, with the attempt given back (`job.released`
in the logs; `src/jobs/runner.ts:167`, `src/jobs/queue.ts:260`). `job.released` carries
`released`, `unrun` and `job_ids`; `released` lower than `unrun` means some row had already moved
on (it finished, or another drain took it), and that row is left alone. So a row that stays
`running` means its drain was frozen or killed, or that handing it back failed
(`job.release_failed`). A `running` row older than 300 s is freed by the next drain's reap, as
above; one that stays `running` for much longer means no drain has run (§5.1).

Retries are exponential with jitter: roughly **30s, 2m, 8m**, `max_attempts` 3 by default
(`src/jobs/runner.ts:41-45`, `src/config/migration_v13_jobs.sql:43`). Jittered because the
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
7 days by the retention sweep (`src/services/retention.ts:51`, `src/jobs/queue.ts:289-300`).

**Replaying a dead job.** Once the cause is fixed, use the admin **Job queue** screen (`#/jobs`,
platform admin only). It lists jobs by status (`pending`, `running`, `done`, `failed`,
`cancelled`) and by tenant, and never shows `payload`, because that holds the verbatim Meta
event. **Retry** puts a `failed` or `cancelled` job back to `pending` with its attempts reset to
0 and `run_after` set to now, so it gets all its attempts again; its `last_error` stays until it
succeeds. **Cancel** stops a `pending` job from ever running (it becomes `cancelled`); a
`running` job cannot be cancelled. The routes are `GET /api/admin/jobs` (`status`, `tenant`,
`limit`), `POST /api/admin/jobs/:id/retry` and `POST /api/admin/jobs/:id/cancel`
(`src/routes/admin.ts`). A job in the wrong state answers 409 `JOB_NOT_RETRYABLE` or
`JOB_NOT_CANCELLABLE`, and every press is an audit row (`job.retry`, `job.cancel`). A retry
before the cause is fixed only spends the attempts again.

### 5.4 Rolling the queue back entirely

`WEBHOOK_QUEUE=off` in the Vercel environment reverts to processing inline with no queue, which
is the behaviour that shipped before the queue existed (`src/index.ts:418`,
`.env.example:57-64`). The handlers are identical either way
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
applied: N
pending: none
```

`pending: none` is the line to read. `N` is the number of rows in the ledger, and it should equal
the number of entries in `EXPECTED_MIGRATIONS` (`src/config/migrations.ts`): `schema.sql` plus
every migration file in `src/config/`. That list is the canonical one, and `migrations.test.ts`
fails if it drifts from what is on disk. It does not stay still, so do not memorise the number
(it was 54 on 2026-10-25; the numbering skips v43 and v46 to v49). To see what this checkout
expects:

```bash
grep -c "^    '.*\.sql',$" src/config/migrations.ts
```

If `applied` is lower, run `npm run migrate:status` to see the file names that are pending. If a
file name in the ledger is missing from the list, the deployed code is older than its database
(`compareSchema` calls it `unknown`; do not run a migration for that).

Healthy apply output is one `applying <file> ... ok` line per file, then
`All migrations applied.`

**Each migration is its own transaction.** A failure rolls that file back entirely, stops the
run, prints the error, and **exits non-zero** (`scripts/migrate.mjs:114-138`). A partial schema
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
  describes the database (`scripts/migrate.mjs:85-90`). `diagnose.mjs` reports the same drift
  independently (`scripts/diagnose.mjs:797`). Add a new migration instead.
- **`--baseline` marks everything applied and runs nothing** (`scripts/migrate.mjs:101-110`).
  Correct only for a database whose schema is already current and which predates the ledger.
  On a database that genuinely lacks the columns it is how you get code expecting a schema that
  isn't there.

If you pasted a file's SQL into the Supabase SQL editor instead, the ledger does not know.
**Do not follow it with `--baseline`**: that records *every* pending file as applied, not just the
one you pasted, and the others then never run (`scripts/migrate.mjs:101-108`). Run
`npm run migrate` instead: the files are idempotent (above), so the pasted one runs again
harmlessly and is recorded, and anything else pending is applied too. Check first with
`npm run migrate:status`.

---

## 7. Data-subject erasure

### What the published page commits you to

`https://msg-response-auto.vercel.app/data-deletion` (served from `public/data-deletion.html`
via `src/index.ts:256-258`) makes four promises:

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
(`src/services/retention.ts:25-27`, `:108-121`). Clearing `messages.text` while `raw_payload`
holds the same text deletes nothing — this is the mechanism by which the promise is otherwise
untrue (`src/services/retention.ts:14-18`).

**Set `RAW_PAYLOAD_RETENTION_DAYS=30` in the Vercel environment to match the page.** On 2026-10-25 it
was set: `vercel env ls production` lists it (added about 2026-09-21). Vercel keeps it as a secret, so its
value cannot be read back; the daily cron's `cron.retention_sweep` line (`rawPayloadsCleared`) shows the
sweep at work. The
minimum accepted is 7; a misconfigured value disables pruning rather than falling back to a
default, and logs `retention.misconfigured` (`src/services/retention.ts:89-99`, `:107-112`).
The sweep runs once daily from the publish cron and converges rather than clearing one batch a
day — up to 20 passes of 5,000 rows (`src/services/retention.ts:710-783`,
`src/routes/api.ts:1059`).

> **Fixed 2026-09-21.** `.env.example` used to declare `RAW_PAYLOAD_RETENTION_DAYS` twice —
> empty in one block and `30` in another, with contradictory advice (90 vs 30) — so which one
> applied depended on the parser. It is now declared once, as `30`, because that is what the
> published page commits to. The value is a promise to users, not a preference.

### Handling a request

**There is now tooling, as of 2026-09-21.** This section previously said there was none, and
that erasure was manual SQL — true when written, false now. Use the dashboard: **Data erasure**,
the last item in the admin nav because it is the only hard DELETE in the product. It is backed by
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

It deletes from six tables. Four are the ones the published page names — `interactions`,
`messages`, `conversations` and `dm_send_log` — which is the part manual SQL got wrong: the
obvious statement clears `messages.text` and leaves `raw_payload` holding the same text as a
verbatim JSONB copy of the Meta event, so the row still contains everything the person wrote plus
their Meta user id. The other two came later:

- the contact's **private uploads** in `media_uploads` (voice notes, photos and files a person
  sent on WhatsApp), found through the person's messages and deleted first; the daily sweep then
  removes the object from Storage;
- the **lead-ad leads** in `ads_leads` that gave the handle as an email address or a phone number,
  found by a keyed hash of it and never by reading anyone's answers. An Instagram handle deletes
  no lead.

Deleting a conversation also deletes the tracked links sent in it and their clicks
(`tracked_links`, `link_clicks`: the schema cascades).

**Stop requests are kept.** A stop or a consent change (`contact_consents`: the person's platform id, the
words they sent, the time) survives the erasure. Its link to the conversation is set to NULL
(`ON DELETE SET NULL`, migration v50), and nothing deletes the row, because it is the evidence that the
person asked. Keeping it, or deleting it in `erasure.ts`, is the owner's decision; the WhatsApp privacy
update (#221) discloses that it is kept. The preview counts conversations,
messages, interactions, the send log and leads. The uploads are not in those counts: they are
`media_deleted` in the audit row.

**It never touches `jobs`.** A queued event holds the person's words verbatim in `payload`. A
`done` job is deleted after 7 days, but a `failed` job is never pruned (§5.3), so one can still
hold the person after the erasure. Look for it (read-only; replace the handle):

```sql
SELECT id, kind, status, created_at FROM jobs
 WHERE status = 'failed' AND payload::text ILIKE '%' || '<handle>' || '%';
```

If one turns up it is yours to delete by hand, with a `SELECT` first, like the other raw SQL
below. Its `dedupe_key` goes with it.

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
(`src/routes/admin.ts:121-129`).

```
POST /api/admin/tenants
  { name, instagram_page_id, facebook_page_id, page_access_token, webhook_verify_token }
```

In this form `instagram_page_id` and `page_access_token` are both required, and the token is
checked with Meta before anything is written. The schema no longer insists on them: migration v34
(`migration_v34_onboarding.sql`) dropped both NOT NULLs, so a body with just `{ name }` (and
optionally `lang`, `instagram_username`, `website`) creates a tenant with **no Meta connection**,
which connects its Page later with **Connect with Facebook**. A CHECK keeps a Page id from existing
without a token. The token is encrypted in the handler, so a tenant created this way **never has a
plaintext token in the database at any point** (`POST /tenants`, `src/routes/admin.ts`). A
duplicate page id is a 409.

If `TOKEN_ENCRYPTION_KEY` is unset this returns a 500 that names the problem and tells you to
run `openssl rand -hex 32` (the same handler). Set it first.

Then create the client's user and grant membership in one call:

```
POST /api/admin/users        { email, password, role: 'user', creator_id }
```

Password minimum is 12 characters (`MIN_PASSWORD_LENGTH`, `src/services/adminGuards.ts`). A user with no
membership can log in and reach nothing, which is why the common case grants it in the same
request (`POST /users`, `src/routes/admin.ts`). There is **no self-serve signup**. A `users` row comes
into existence in two ways only: this endpoint, and an invite link (`acceptInvite`,
`src/services/invites.ts`), which creates the account when the invited person opens the link and
sets a password (below).

Both are also available as dashboard screens for a `platform_admin`: **Tenants** and **Users**
(`dashboard/js/app.js:144-145`, `dashboard/js/pages/tenants.js`, `dashboard/js/pages/users.js`).
The Tenants screen leads on the two columns that say something is broken — token status and
last webhook received (`dashboard/js/pages/tenants.js:3-8`).

**Bringing the tenant's person in (invite link, P17).** Prefer this to typing them a password. **Tenants → New tenant** (a name,
no Meta ids) returns an invite card: **Copy link**, or **Send on WhatsApp**. The same card is on the tenant's page under Members
(**New invite link**, **Regenerate**, **Revoke**, and **Reset link** for a member who forgot their password). The link is a single-use
URL whose token is in the `#` fragment: it works once, lasts 7 days by default (Settings → Onboarding and invites), and is shown
**only once**, because only its sha256 is stored: *Regenerate* if it was lost. If the person's address already has an account the
page tells them to sign in and then adds the tenant to that account; it never replaces a password. Every create, regenerate, revoke
and accept is in **Audit** (`invite.*`), without the link. Checking a link works: open it in a private window, never in the
admin's own session (that is refused, so it is not used up). Sessions from a link last 24 hours, or 30 days if the person leaves
"keep me signed in" ticked (also a setting). Full walk-through: FLOWS.md §4.8.

**What the person sees next (the setup wizard, P18).** A tenant whose onboarding is not `completed` is sent to `#/welcome` from every
dashboard route (an owner only: operators, viewers and platform admins are never held by it); they answer W1 (about them), W2 (their
voice) and W3 (their look, skippable), and the last screen finishes it. What they type is kept as they go (`onboarding.steps`), so a
closed phone resumes where it was, and nothing reaches the profile until they press Next. To look at one tenant:
`SELECT status, current_step, filled_by, steps FROM onboarding WHERE creator_id = '<id>'`. **A tenant is stuck** when Next answers
an error you cannot clear: open **Tenants → the tenant → Profile** and fill the missing fields in yourself (it is the same profile,
and the wizard then lets them finish), or, as a last resort, `UPDATE onboarding SET status = 'completed', completed_at = NOW()
WHERE creator_id = '<id>'`, which lets them in with a profile that is not complete. The owner's own tenant is `completed` and
never sees the wizard; `#/welcome?mode=behalf` opens it for a platform admin. Full walk-through: FLOWS.md §4.9.

**The profile draft (P24).** Creating a tenant by name also starts a draft of its profile from the handle and site you typed: the Tenants
screen fires `POST /api/admin/tenants/:id/draft/advance` right after the 201. It reads the public Instagram account (Business Discovery, as the
tenant named in Settings → Onboarding → "Instagram account that reads other people's profiles", default the owner's), the website, a YouTube
channel (needs the YouTube Data API key in the same card) and any text pasted, asks the AI route `onboarding_draft` for a profile, **checks the
answer in code** and keeps it as a draft. **Nothing is applied until a person applies it** (the wizard, or you on the tenant's Profile screen).
`GET /api/admin/tenants/:id/draft` shows its state, each source's outcome, every step's `elapsed_ms` and what it cost.

- **"needs an AI key" / `error_kind: no_provider`:** no AI provider has a key (Operations → AI providers). The draft failed cleanly after
  reading the sources and kept what code found (colours, logo candidates, links); the wizard continues by hand. Add a key, then start a new
  draft (`POST …/draft`, five new drafts a tenant a day).
- **Stuck in `queued` / `drafting`:** something has to move it. The wizard's poll does, and so does `POST /api/onboarding/drafts/sweep`, which the
  Heroku worker calls about every minute (it is the only caller, §5.1; its second loop, `DRAFT_SWEEP_INTERVAL_MS`). With the
  worker off and nobody on the wizard, a draft waits; after 30 minutes whoever touches it first ends it as `expired`. The sweep is guarded like the
  drain (Bearer `CRON_SECRET`). Redeploy the worker after pulling this: an old worker has no second loop.
- **`failed`, `no_source`:** nothing could be read: check `sources_status` (a private or personal Instagram account is `not_readable`, a site that
  refuses is `blocked` and asks the tenant to paste their About text).
- **Cost and time:** every call is an `ai_usage` row (`onboarding_draft`); the daily budgets in Operations refuse a call with `budget`. Look for
  `onboarding.draft_step` (`elapsed_ms` per step), `onboarding.draft_ready` (`total_ms`) and, to learn whether Vercel keeps an `advance` running
  after the browser has gone, `onboarding.advance_client_gone` followed by `onboarding.draft_advance`. Full walk-through: FLOWS.md §9.

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
   (`src/index.ts:335-352`). The database copy exists so the token can be changed from
   Settings with no redeploy.
2. Verify with `node scripts/diagnose.mjs`. Healthy:
   ```
   ✔ meta     verify-token handshake returns the challenge (accepted: local env META_VERIFY_TOKEN; creators.webhook_verify_token (Default))
   ```
   The log line `webhook.verified { candidates: N }` confirms how many were tried.
   **`candidates: 0` is the specific, actionable failure**: neither source has a token set, so
   every subscription change Meta attempts will 403 opaquely while existing webhooks keep
   delivering (`src/index.ts:354-358`).
3. **Type it identically** into the Meta console. It is compared as an exact string — a
   trailing space is a 403 with no diagnostic.
4. Now create or change the subscription, and set the callback URL to
   `https://<deployment>/webhook`. Remember §2.2: one callback URL per object type, app-wide,
   so changing it for one tenant changes it for all of them.
5. Subscribe the fields you need: `comments`/`feed`, `messages`, `messaging_postbacks`, and on
   the `page` object `messaging_referrals` (ads → DM attribution for a person who already has a
   Messenger thread). Add `leadgen` only for lead ads, after a lead-ads sign-off. §2.2 says what
   `diagnose.mjs` checks.
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
typecheck, tests, a dashboard syntax check and ten `check:*` guards (§11), and nothing else).
Every merge to `main` deploys production through Vercel's Git integration, with no manual step
(`README.md`, *Deploys*), so a rollback is the way back from a merge that went wrong.

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
variables are absent, rather than serving with a missing secret (`startupError` in `src/index.ts`;
the log line is `startup.validation_failed`). The six required vars are `DATABASE_URL`,
`META_VERIFY_TOKEN`, `META_APP_SECRET`, `INSTAGRAM_APP_SECRET`, `DASHBOARD_PASSWORD` and
`CRON_SECRET` (`REQUIRED_VARS` in `src/config/env.ts`). So if every route 503s after a rollback,
read the body — it tells you which variable it is. The app also refuses to start if
`DASHBOARD_PASSWORD` is the old published default `"admin"`, which is in the public repo's
history (`src/config/env.ts:49-53`).

---

## 10. TikTok

Setup, the developer portal, app review and every error code are in
[`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md) (tracked with `git add -f`, since `docs/` is
gitignored). This section works backwards from a symptom; the forward walk is FLOWS.md §6, and
§3.6 for photo posts.

**The ground rule from the top of this file applies to TikTok too.** `GET /api/jobs/drain` and
`GET /api/cron/publish` publish every due post, TikTok rows included, so neither is a test.
**Publish now** on one card is the narrow lever: it claims that one row and nothing else
(`src/routes/api.ts:3336-3363`).

The states a TikTok row moves through, and what moves it:

| Status | Means | Moved on by |
|---|---|---|
| `PENDING` | due later — or **held** by the 5-draft limit, with "Waiting for TikTok: …" in `error_log` | a drain or the daily cron claims it (`src/routes/api.ts:969-975`) |
| `PUBLISHING` | claimed, being sent | the publish call. A dead one is released only by the daily cron, after 15 minutes (§4.2) |
| `PROCESSING` | TikTok has it | the 12 s poll inside the publish call, the webhook, or the sweep on every drain (`src/services/tiktokPublish.ts:582-641`) |
| `IN_INBOX` | an inbox draft, waiting for the creator | the creator posting it in TikTok |
| `PUBLISHED` | TikTok said `PUBLISH_COMPLETE` | — |
| `FAILED` | `error_log` says why | **Publish now**, or edit and save |

Every query in this section is a read-only `SELECT`: paste it into the Supabase SQL editor, or run
it through `connectReadOnly()` as in §2.1. Start with the last twenty TikTok rows:

```sql
SELECT id, status, post_type, scheduled_time, attempts,
       platform_options->>'mode' AS mode, platform_options->>'privacy_level' AS privacy,
       external_publish_id IS NOT NULL AS reached_tiktok, published_post_id,
       claimed_at, status_checked_at, left(error_log, 160) AS error_log
  FROM scheduled_posts
 WHERE platform = 'tiktok'
 ORDER BY scheduled_time DESC
 LIMIT 20;
```

and the connection:

```sql
SELECT status, scopes, display_name, refresh_expires_at, last_refreshed_at,
       refresh_claimed_at, left(last_error, 160) AS last_error
  FROM platform_connections
 WHERE platform = 'tiktok';
```

### 10.1 "A TikTok post failed."

Read `error_log` — on the card, or in the first query. It starts with the step that failed
(`TikTok post init:`, `TikTok photo post:`, `TikTok upload init:` …), then a plain sentence
(`toTikTokError`, `src/services/tiktok.ts:154-178`):

| `error_log` contains | Go to |
|---|---|
| "…direct posts only work when your TikTok account is set to private…" | §10.2 |
| "…can only be private (Only me)…" | §10.2 |
| "…can only fetch photos from a verified URL prefix…" or "…could not fetch the photos…" | §10.3 |
| "reconnect TikTok", or "TikTok is not connected for this account" | §10.4 |
| "TikTok rate limit reached — it will be retried." | **Not retried if it was the init** — photo inits allow 6 a minute. Wait a minute, then **Publish now** |
| "TikTok did not confirm this upload within 24 hours…" | §10.7 |
| "Waiting for TikTok: *n* drafts…" — status `PENDING`, not `FAILED` | §10.5: held, not failed |
| anything else | the full tables, `docs/TIKTOK_GUIDE.md` §11 |

**Before you retry, look at `external_publish_id`** (`reached_tiktok` in the query). Non-NULL
means that attempt reached TikTok. A retry asks TikTok about that `publish_id` first: a video
whose upload finished, or a photo post TikTok has not failed, is settled from TikTok's answer
instead of being sent again (`src/services/tiktokPublish.ts:430-441`, `:515-528`). **That column is
what stops a duplicate post — do not clear it to "start clean".** Only when TikTok itself reports
the old attempt as failed does a retry make a new post.

Two ways to retry:

- **Publish now** on the card — claims a `PENDING` or `FAILED` row, publishes it at once and waits
  up to 12 s for TikTok's verdict (`src/routes/api.ts:3352-3357`, `src/services/tiktokPublish.ts:45`).
- **Edit and save** — flips `FAILED → PENDING` (`src/routes/api.ts:3214`), and the next drain takes
  it. Edits are refused once a row is `PUBLISHING`, `PROCESSING` or `IN_INBOX` (`:2395-2398`).

**No TikTok init is retried on failure** — a 5xx may already have created the post or the draft
(`src/services/tiktok.ts:362-372`, `:501-504`, `:652-655`). The one exception is an inbox video
whose caption TikTok refuses as invalid, which is sent once more without it. So a `FAILED` TikTok
row stays `FAILED` until someone acts; nothing re-queues it.

### 10.2 The post is "Only me" — or refused because the account is public

Three symptoms, one cause: TikTok has not audited the app yet.

| Symptom | Means | Fix |
|---|---|---|
| The post is live, but only you can see it | expected — every direct post is Only me until the audit | make it public by hand: open the post → ⋯ → Privacy settings → Everyone |
| `FAILED`: "Until TikTok approves this app, direct posts only work when your TikTok account is set to private…" (`unaudited_client_can_only_post_to_private_accounts`) | the account was public when the post went out | account private → **Publish now** → wait for `PUBLISHED` → account public → make the post public |
| Refused at scheduling with "Until TikTok approves this app, direct posts can only be private (Only me).", or `FAILED` with "…can only be private (Only me) — edit the post." | a privacy wider than Only me — or Audited was ticked and later unticked | edit the post and choose Only me (`src/services/tiktokPublish.ts:94-96`, `:290-292`) |

Before switching the account back to public after a run of posts, make sure nothing is still going
out:

```sql
SELECT id, status, post_type, scheduled_time
  FROM scheduled_posts
 WHERE platform = 'tiktok'
   AND platform_options->>'mode' = 'direct'
   AND status IN ('PENDING', 'PUBLISHING', 'PROCESSING')
 ORDER BY scheduled_time;
```

Empty is safe. A row due later will fail if the account is public by then. The whole workflow is
`docs/TIKTOK_GUIDE.md` §6.3. Once the audit passes, tick Audited (guide §5.2) — and note that posts
scheduled before the tick keep Only me until they are edited.

### 10.3 `url_ownership_unverified`, or "TikTok could not fetch the photos"

Photo posts only. TikTok pulls each image itself, from `<Public site address>/api/uploads/<uuid>.jpg`
(`.webp` for WebP), and only from the URL prefix verified in its portal
(`src/services/tiktokPublish.ts:396-400`). Check in this order:

1. **Is the prefix verified?** Portal → URL properties → `https://msg-response-auto.vercel.app/`
   shows verified. If not, guide §2.5.
2. **Is every verification file still served?**

   ```sql
   SELECT key, left(value, 300) AS value
     FROM app_settings
    WHERE key IN ('tiktok.verification_filename', 'tiktok.verification_history');
   ```

   then, for each file name:

   ```bash
   curl -fsS https://msg-response-auto.vercel.app/tiktokAbC123.txt
   ```

   Healthy: the file's one line. A `404` means that name is no longer saved — the history keeps the
   last ten only (`src/services/appSettings.ts:749-759`). Save it again.
3. **Is the Public site address that same origin?**

   ```sql
   SELECT value FROM app_settings WHERE key = 'app.public_base_url';
   ```

   It must be `https://msg-response-auto.vercel.app`. NULL falls back to `PUBLIC_BASE_URL`; with
   both unset, photo posts fail with "…none is set — add it in Settings → TikTok app."
   (`src/services/tiktokPublish.ts:397-399`).
4. **Does every image answer?**

   ```sql
   SELECT unnest(COALESCE(media_urls, ARRAY[media_url])) AS url
     FROM scheduled_posts
    WHERE id = '<post id>';
   ```

   then, for each `…/api/uploads/<uuid>`:

   ```bash
   curl -sI https://msg-response-auto.vercel.app/api/uploads/<uuid>.jpg | grep -iE '^(HTTP|content-type)'
   ```

   Healthy: `200` with `image/jpeg` or `image/webp`. A `404` means the upload was deleted after the
   post was scheduled: upload the image again and edit the post.

Then **Publish now**.

### 10.4 "Reconnect TikTok" / the token is invalid

Symptom: the Settings card says **Needs reconnecting** with "Last problem: …"; TikTok posts fail
with "…reconnect TikTok in Settings." or "TikTok is not connected for this account — connect it
in Settings."; scheduling a TikTok post is refused with a 409.

What does it: a refresh or a publish call answered with `access_token_invalid`, `invalid_grant`,
`scope_not_authorized` or `scope_permission_missed` marks the connection `invalid`
(`src/services/tiktok.ts:109-114`, `src/services/tiktokConnections.ts:331-344`, `:360-367`).
Transient failures never do (`:288-290`). The daily cron refreshes every active connection, so a
revoked account usually shows up the morning after (`src/routes/api.ts:1087`).

| Cause | Tell |
|---|---|
| the yearly expiry | `refresh_expires_at` has passed — the card warned for 30 days before |
| the creator removed the app in TikTok | no row at all: `authorization.removed` deleted it. If that webhook was refused (§10.6), the row stays until the next refresh fails with `invalid_grant` |
| the client key or secret changed — sandbox ↔ production | every connection fails its next refresh with `invalid_grant` (guide §8.3) |
| a scope was withdrawn in the portal | `scope_not_authorized` |

**Fix: the workspace owner presses Reconnect** (Settings → TikTok). There is nothing else — a dead
refresh token cannot be revived. Then retry the posts that failed in the meantime with **Publish
now**. Connect's own error toasts (cancelled, link expired, account in another workspace, exchange
refused) are in guide §4.2; the log line `tiktok.oauth_callback_failed` carries TikTok's reason.

Two sentences that look like this and are not:

- "The TikTok token is being refreshed by another request — retry in a moment." — another
  invocation held the refresh claim (`src/services/tiktokConnections.ts:380`). Retry. A claim older
  than 2 minutes is taken over (`:31`, `:252`).
- "This post is set to post directly, but TikTok has not granted direct posting — reconnect TikTok
  in Settings." — the connection predates the Direct Post switch. Reconnect once
  (`src/services/tiktokPublish.ts:497-499`); the token was never dead.

### 10.5 "The drafts never showed up."

Inbox mode (`video.upload`). **Known and unresolved.** On 2026-09-23/24 TikTok reported six drafts
as delivered — the rows went to `IN_INBOX` — and none was ever found: no notification on the phone,
nothing among TikTok Studio's drafts on the web. `IN_INBOX` records what TikTok said, not what
anyone can see.

What it costs meanwhile:

- Each one counts against TikTok's 5 unposted drafts per 24 hours, and at five the app **holds** the
  next inbox post: status back to `PENDING`, `error_log` "Waiting for TikTok: *n* drafts from the last
  24 hours…", log line `cron.publish_held_tiktok_inbox`, and **Publish now** answers 409
  (`src/services/tiktokPublish.ts:486-491`, `:555-563`; `src/routes/api.ts:996-999`, `:2593-2596`).
- The rows stay `IN_INBOX`. The sweep asks about them every 10 minutes for 7 days, then stops
  (`src/services/tiktokPublish.ts:594-598`).
- Nothing in the app can list or delete a TikTok draft.

What is counted right now — the same query as `pendingInboxShares`
(`src/services/tiktokPublish.ts:190-201`), and the number on the Settings card's "Drafts waiting in
your TikTok inbox (last 24 hours)":

```sql
SELECT status, count(*)
  FROM scheduled_posts
 WHERE platform = 'tiktok'
   AND COALESCE(platform_options->>'mode', 'inbox') = 'inbox'
   AND status IN ('PUBLISHING', 'PROCESSING', 'IN_INBOX')
   AND claimed_at > NOW() - INTERVAL '24 hours'
 GROUP BY status;
```

**Fix: switch to Direct Post** (guide §5.1) and post with the private-account workflow (guide §6.3).
Direct posts do not count against the draft limit, and a held inbox post can be edited to "Post
directly to my profile". If you do test inbox mode again, check that the card's display name is the
account open on the phone, and that the TikTok app is current — 31.8 or newer for photo drafts
(`app_version_check_failed`).

### 10.6 The webhook signature

Symptom: the Vercel logs show `tiktok.webhook_signature_rejected { has_header, app_configured }`
and TikTok's deliveries get a `401` (`src/routes/tiktok.ts:153-161`). As with Meta (§2.3), a
rejection writes nothing, so the logs are the only evidence.

It costs less than on the Meta side. The webhook is one of three writers; the inline poll and the
sweep still settle every post, only later (FLOWS.md §6.5). The real loss is
`authorization.removed`: when a creator removes the app in TikTok, the stored connection is not
deleted until its next refresh fails — and `/data-deletion` promises that deletion.

| `has_header` | `app_configured` | Cause |
|---|---|---|
| `false` | — | not TikTok, or something on the way stripped the header |
| `true` | `false` | no client key and secret saved (guide §3) |
| `true` | `true` | TikTok signs with a different secret from the one saved — most likely the **sandbox versus production** secret, or a secret reset in the portal |

The signature is HMAC-SHA256 of `"<t>.<raw body>"` keyed with the **client secret**
(`src/services/tiktok.ts:836-859`). To prove the saved secret is the portal's, sign a harmless body
with the secret copied from the portal and send it. Its event name is one the app does not know,
so it is acknowledged and ignored, and nothing is written (`src/services/tiktokPublish.ts:662-663`):

```bash
read -rs TT_SECRET && export TT_SECRET   # paste the portal's client secret; it is not echoed
node --input-type=module -e "
import crypto from 'crypto';
const body = JSON.stringify({ event: 'probe.signature_check', content: '{}' });
const t = Math.floor(Date.now() / 1000);
const s = crypto.createHmac('sha256', process.env.TT_SECRET).update(t + '.' + body).digest('hex');
const r = await fetch('https://msg-response-auto.vercel.app/api/tiktok/webhook', {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'Tiktok-Signature': 't=' + t + ',s=' + s }, body });
console.log(r.status, await r.text());"
unset TT_SECRET
```

- `200 {"received":true}` — the saved secret is that portal app's. If TikTok's real deliveries are
  still refused, they come from the *other* app: sandbox versus production.
- `401` — the saved secret is different. Paste the portal's into Settings → TikTok app → Client
  secret → **Save TikTok app**, and run the probe again.

Also confirm the portal's webhook URL is exactly `https://msg-response-auto.vercel.app/api/tiktok/webhook`.
Healthy deliveries log `tiktok.webhook_applied` with an `outcome` such as `post_published`;
`ignored:unknown_publish_id` is normal for a post this app did not send
(`src/services/tiktokPublish.ts:655-686`).

### 10.7 A status stuck in `PROCESSING` (or `PUBLISHING`)

```sql
SELECT id, status, post_type, claimed_at, status_checked_at,
       external_publish_id IS NOT NULL AS reached_tiktok, left(error_log, 120) AS err
  FROM scheduled_posts
 WHERE platform = 'tiktok' AND status IN ('PUBLISHING', 'PROCESSING', 'IN_INBOX')
 ORDER BY claimed_at;
```

| What you see | Means | Do |
|---|---|---|
| `PROCESSING`, `status_checked_at` recent | the sweep is asking and TikTok is still working | wait. After 24 h of silence the sweep fails it with "TikTok did not confirm this upload within 24 hours…" (`src/services/tiktokPublish.ts:617-620`) |
| `PROCESSING`, `status_checked_at` old or NULL | nothing is asking: no drain has run. The sweep runs only inside `/api/jobs/drain` and the daily cron (`src/routes/api.ts:414`, `:894`) | check the drainers (§5.1); a working webhook would have moved it anyway (§10.6) |
| `PROCESSING`, `status_checked_at` advancing but never settling, `tiktok.reconcile_row_failed` in the logs | the status call itself fails, usually on the token | §10.4; the next sweep settles it |
| `PUBLISHING`, `claimed_at` more than 15 minutes ago | the invocation died mid-send, and only the daily cron releases it back to `PENDING` (`src/routes/api.ts:1030-1037`) | wait for 00:00 UTC, or call `/api/cron/publish` knowing it publishes everything due (§4.2). With `reached_tiktok` true, the retry asks TikTok before sending anything again |
| `IN_INBOX` | an inbox draft waiting for the creator, not stuck | §10.5 |

To make the sweep run now — it also publishes every due post and runs queued DM jobs, as §1 warns:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://msg-response-auto.vercel.app/api/jobs/drain
```

Export the current `CRON_SECRET` first; the copy in `.env` was not updated when it was rotated on
2026-09-22. The response ends with `"tiktok":{"checked":N,"settled":N,"gaveUp":N}` — `settled`
counts rows that moved.

---

## 11. Before you touch anything: the checks that are free

```bash
npm run typecheck    # tsc --noEmit
npm test             # the whole suite, node:test via tsx
```

Both pass on `main`. `npm test` prints its totals last: read the `fail` line, which must be `0`.
The suite grows with every change (16,350 tests in 2,983 suites on 2026-10-25), so do not compare
the count with this one. CI also runs ten content guards, each added after a
failure that nothing else could see: `check:assets`, `check:icons`, `check:icon-subset`,
`check:hero3d`, `check:font`, `check:og`, `check:brand-icons`, `check:contrast`, `check:i18n` and
`check:voice`. Run any of them with `npm run check:<name>`. There is **no build
step**: TypeScript runs through `ts-node/esm` locally and `@vercel/node` in production. The
dashboard has no build and no typecheck, so a syntax error there ships silently and blanks the
page — `find dashboard -name '*.js' | xargs -n1 node --check` is the guard for that, and CI
runs it (`.github/workflows/ci.yml`).

Inspect production configuration without deploying:

```bash
vercel env pull .env.local --environment=production
```

---

## 12. WhatsApp

Setup, Meta's dashboards, the costs and the go-live rules are in
[`docs/WHATSAPP_GUIDE.md`](docs/WHATSAPP_GUIDE.md); its §3 has the checks for "nothing shows up".
Every hop a message takes is FLOWS.md §10. This section works backwards from a symptom. The
settings are on **Settings → Connections → WhatsApp**: any member reads them, only the owner
changes them. Its log lines start with `wa.` (messages, sends, alerts) or `whatsapp.` (the
connection and the settings).

Three facts explain most of what you will see:

- **The assistant starts `off`.** `ai_agents.whatsapp_mode` is `off`, `test` or `everyone`. `off`
  stores messages and answers nobody. `test` answers only the numbers on the test-sender list.
  `everyone` is refused: `PUT /api/whatsapp/agent` answers 409 `go_live_not_ready`, with what is
  missing, until the go-live gate exists (`src/routes/whatsapp.ts`).
- **A sender who is not a test sender is stored as a bare record**: no words, no name, no phone
  number, and the queued job's copy is cut down the same way (`src/webhook/whatsappRedact.ts`).
  That is deliberate until the public privacy pages name WhatsApp (guide §3, step 4). So a thread
  with no text in the Inbox is expected for a stranger.
- **Replies are free only up to 1,000 a month per number** (`FREE_REPLIES_PER_MONTH`). Past that
  the app sends nothing Meta would charge for, unless the owner ticked **Allow paid messages
  beyond the 1,000 free replies a month**.

The queries below select metadata only, never message text. Run them like the TikTok ones: in the
Supabase SQL editor, or through `connectReadOnly()` as in §2.1. A WhatsApp message is a
`dm.process` job and a delivery status or account event is a `wa.event` job, so a stuck one shows
in the Job queue screen (§5.3).

### 12.1 "A WhatsApp message did not arrive" — nothing in the Inbox

Read the Vercel logs from the time you sent it and match what you find:

| What you find | Means | Do |
|---|---|---|
| no `POST /webhook` at all | Meta did not send it | In Meta, the WhatsApp use case → Webhooks: the seven fields are subscribed (guide §1.3) and the app is subscribed to the account. Pressing **Connect number** again does `POST /{waba_id}/subscribed_apps` (guide §3, check 1) |
| `webhook.signature_rejected` | the event was signed by another Meta app | §2.3; the WhatsApp events must come from the same app (guide §1.1) |
| `wa.no_creator { phone_number_id }` | no connection for that number: never connected, disconnected (`revoked`), or connected in another workspace | **Connect number** (guide §2) |
| `wa.creator_inactive` | the tenant is switched off, and its webhooks with it | a platform admin sets the tenant active again |
| `wa.ignored { reason: 'group' }` or `'no_user_id'` | a group message, or one with no sender id: no thread is made, by design | nothing |
| `wa.inbound_stored` | it arrived and was stored | 12.2 |

### 12.2 "It arrived, but nobody answered"

Read `wa.inbound_stored`. Its `no_reply_reason` says why, `stored` says `full` or
`metadata_only`, and `answered` says whether the assistant replied. The same reason is on the
message row:

```sql
SELECT m.created_at, m.message_type, m.no_reply_reason
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
 WHERE c.platform = 'whatsapp' AND m.direction = 'inbound'
 ORDER BY m.created_at DESC
 LIMIT 20;
```

| `no_reply_reason` | Means | Do |
|---|---|---|
| `agent_off` | the mode is `off`, which is how every number starts | **Who the assistant answers** → *Test senders only*, and add your own number |
| `not_test_sender` | mode `test`, and this sender is not on the list | add the number in digits with the country code and no `+` (or the WhatsApp user id, `EG.…`). `everyone` stays refused until go-live |
| `connection_invalid` | Meta refused the stored token: the message is stored, nothing is sent | 12.5 |
| `bot_paused` | a person took the thread over (`conversations.is_bot_active` is false) | switch the assistant back on for that thread in the Inbox |
| `unsupported_type` | a reaction, or something the assistant cannot read | expected |
| `opted_out` | the person sent a stop word | expected; the wording is kept in `contact_consents` |
| `window_closed`, `billable_blocked` | the reply was refused at the send | 12.3 |
| `provider_unavailable`, `failure` | the AI could not answer, or the reply failed for another reason | `wa.answer_failed` has the reason, and the owner was alerted (§16.4). For the AI side see §16.2 |
| `superseded` | a newer message replaced this one | expected |

### 12.3 "The assistant answered, but the customer never got it"

A reply fails in one of two ways: the app refuses to send it (no call to Meta is made), or Meta
accepts it and fails it later. A refusal logs `wa.send_refused` with a `reason`:

| `reason` | Means | Do |
|---|---|---|
| `connection_invalid` | not connected, or Meta refused the connection | 12.5 |
| `window_closed` | more than 24 hours since the customer's last message, and no free-entry window: WhatsApp takes no free-form message | nothing; a reply is possible once the customer writes again. A person typing in the Inbox gets 409 `WHATSAPP_WINDOW_CLOSED` |
| `billable_blocked` | the month's 1,000 free replies are used and paid messages are off | 12.4 |
| `invalid_message` | the reply did not fit one WhatsApp message | a code fix; the log has the reason |

A send that fails on Meta's side logs `wa.send_failed` (`reason`, `code`, `permanent`,
`may_have_landed`). A reply Meta accepted and then failed arrives later as a delivery status:
`wa.message_failed { code }`, and the message row says so:

```sql
SELECT m.created_at, m.delivery_status, m.delivery_error_code, left(m.delivery_error, 120) AS delivery_error
  FROM messages m
  JOIN conversations c ON c.id = m.conversation_id
 WHERE c.platform = 'whatsapp' AND m.direction = 'outbound'
 ORDER BY m.created_at DESC
 LIMIT 20;
```

The codes you will meet (`src/services/whatsappErrors.ts`): `131047`, the 24-hour window is
closed; `131026`, Meta could not deliver it (not a WhatsApp number, or the person has not accepted
WhatsApp's new terms), which no retry fixes; `131042`, a payment problem on the WhatsApp account
(when it comes back on the send itself, the connection is marked invalid: 12.5); `131056` and
`130429`, too many messages to one person or too many at once, both of which can be retried. On a
**test number**, replies reach only the recipients added in Meta (guide §1.2).

### 12.4 Free replies and paid messages

The card's **Free replies this month** counts delivered service messages per month (the
`channel_usage` ledger; a month starts at 00:00 UTC on the 1st, because the account's own time zone
is not read yet: `periodOf` in `src/services/channelUsage.ts`). Up to the 1,000th reply nothing
changes.

- **One alert a month**, when the month's free replies reach `free_tier_alert_at` (900 unless the
  owner changed it; `PUT /api/whatsapp/billing` sets it from 0 to 1000). It does not repeat at
  1,000. If the check itself failed, the log says `wa.free_tier_check_failed`.
- **Past 1,000 with paid messages off** (the default): the assistant sends nothing. The log is
  `wa.send_refused` with `reason: 'billable_blocked'` and `free_used`, the message row says
  `billable_blocked`, the conversation is handed over ("Needs you" in the Inbox) and the owner is
  told (§16.4).
- **Past 1,000 with paid messages on**: replies go, and Meta bills each one (the rates are in guide
  §7 and are Meta's, so check them there). Meta delivers none of them if the WhatsApp account has
  no payment method (guide, *The state of things*).

### 12.5 "Needs reconnecting", and the alerts

The card's pill reads **Needs reconnecting** when the connection is `invalid`, with *Last answer
from Meta: …* under it. What marks it: Meta refusing the token or a permission (codes 190, 200,
10) on a send or on the daily read, or a payment problem (131042) on a send. While it stands,
messages are still stored (Meta sends each once and never again), and nothing is sent.

**Fix:** make a new system-user token (guide §1.4), then **Settings → Connections → WhatsApp →
Reconnect with a new token**. **Refresh status** re-reads the number from Meta
(`POST /api/whatsapp/refresh`); it answers *Meta still refuses the stored token* while the token
is still bad. A connection that was `invalid` goes back to `active` only when Meta also reports
the token valid with both WhatsApp permissions (`whatsapp.connection_recovered`).

**A new token does not help when Meta itself blocked the account.** A restriction that stops
replies, a ban or a disconnection that Meta reports (the `account_update` events) is kept as
`account_block` on the connection, and a valid token does not lift it. The log says
`whatsapp.connection_blocked` with the `block`, and the connection stays `invalid`. Meta's own
*reconnected* or *reinstated* event lifts it, or the end of a restriction
(`whatsapp.account_block_expired`). The owner's alert says what Meta did; read the reason in
WhatsApp Manager and appeal there (FLOWS.md §10.10).

The daily cron reads every connected number once (`refreshAllWhatsAppConnections`,
`src/services/whatsappHealth.ts`): the log is `cron.whatsapp_health` with `checked`, `invalid`,
`alerts` and `alertFailures`, and `wa.health_checked` per number. It catches a refused token before
the next customer does. A change the owner needs to know about (the quality rating, the messaging
limit, the number's status, the name review, a restriction, a ban, a disconnection, a refused or
restored token, the free replies) is one alert, once.

**WhatsApp account alerts go to Telegram only** (`notifyWhatsAppOwner`,
`src/services/whatsappNotify.ts`: the operator's bot, Arabic and English in one message). Email
does not carry them. A customer your assistant could not answer on WhatsApp (window closed, paid
messages off, connection refused) is a different alert, a hand-off, and hand-offs go to Telegram
and email (§16.4). With Telegram off or incomplete, an account alert is not sent at all: the log
is `wa.alert_not_sent { why: 'alerts_off' }`, and the facts are still on the card (the status,
quality and limit chips). Switch it on under **Settings → Messages & alerts →
Handoff alerts** (*Send me alerts on Telegram*, the bot token and your chat id), then press
**Send test message**. `wa.alert_failed` means Telegram refused it; the alert is given back and
tried again (the next daily read, or the next event).

---

## 13. Ads Manager

The Meta ads module: Boost, the **Ads** screen and the spending guard. Setup, the money rule,
every alert and a troubleshooting list are in [`docs/ADS_GUIDE.md`](docs/ADS_GUIDE.md) (its
*Alerts*, *Account health* and *Troubleshooting* sections, and *Ads and the DM assistant (A3)* for
conversations that start from an ad). The token's own rules are in
[`docs/TOKEN_GUIDE.md`](docs/TOKEN_GUIDE.md) ("Ads token"). The hop-by-hop walk is FLOWS.md §11
(the money rule, the guard, the paced queue) and §12 (an ad → a conversation).

Four facts explain most of what you will see:

- **Ads are off per tenant** until a platform admin switches them on. Until then every
  `/api/ads/*` route answers 404 `ADS_DISABLED` (`src/routes/ads.ts`).
- **Everything is created `PAUSED`.** Nothing spends until someone confirms **Activate**.
- **The guard, the rules, the write queue and the sync run inside `GET /api/jobs/drain`** (§5.1).
  If no drain runs, none of them runs. The daily cron adds the health check, the Boost sync, the
  proposals and the 28-day results sync. (A drain called by hand runs them too, so it is not a test.)
- **Read-only look at Meta:** `node scripts/ads-probe.mjs`, with `--tenant <uuid>` for one tenant,
  `--env <path>` for a `.env` and `--json` for machine output. It uses only GET calls and a
  read-only database connection, and prints the access tier, the API version Meta served, the
  account's status and funding (the type only), the token's scopes and expiry, and the assets it
  reaches. It never prints a token.

Two read-only queries show most of the state (paste them into the SQL editor, or run them through
`connectReadOnly()` as in §2.1):

```sql
-- When the guard last SUCCEEDED (cap_checked) and last TRIED (cap_attempt), per tenant
SELECT key, value FROM app_settings
 WHERE key LIKE 'ads.cap_checked.%' OR key LIKE 'ads.cap_attempt.%'
 ORDER BY key;

-- The newest alerts, and which channel each went to
SELECT created_at, kind, day, channels FROM ads_alerts ORDER BY created_at DESC LIMIT 20;
```

### 13.1 "Spending is not being watched" (`guard_blind`)

The banner on the Ads screen, and the alert of the same name. The guard has had no successful
check for 2 hours. The banner reads `GET /api/ads/overview` → `guard: { lastCheckedAt, blind }`
(`guardState`, `src/services/ads/health.ts`). While it stands, a campaign that reaches your cap may
not be paused for you; pause in Meta if you cannot confirm.

Check in this order:

1. **Is any drain running?** If `cap_attempt` and `cap_checked` are both more than 2 hours old,
   nothing is calling the guard (§5.1). With the Heroku worker off, GitHub delivers a drain only
   every 2 to 5 hours, so the banner can appear with nothing wrong at Meta. The `guard_blind` alert
   is raised from inside a *failing* check, so with no drain there is only the banner and no alert.
2. **Is `cap_attempt` newer than `cap_checked`?** Then checks are failing. `ads.cap_check_failed`
   (warn) has the reason: Meta's code, a throttle (`ads.throttled`), or "this month's spend
   unreadable". A failing tenant is tried again 10 minutes later; a drain in between skips it.
3. **A dead token** is its own case: 13.3.

There is no button. When the cause is gone, the next check writes `cap_checked` and the banner
clears.

### 13.2 "Campaigns were paused at the cap" (`cap_paused`)

Not a fault: the cap did its job. Once an hour, from the drain, the guard checks whether this
month's spend has reached the monthly cap, or whether one more day of every active campaign (a
daily budget counted at 1.75×, a lifetime budget at its whole unspent part) would pass it. If so it
pauses **every active campaign in the ad account**, including campaigns made in Meta Ads Manager.
Saving a monthly cap at or below this month's spend does the same at once (the answer carries
`warnings: ['will_pause_all']`).

You can see it three ways: the alert `cap_paused` (it cannot be switched off), the log
`ads.cap_paused_all` (warn, with `spent`, `next_day`, `cap`, `paused` and `of`), and the audit row
written by `system:ads-guard`:

```sql
SELECT created_at, detail FROM audit_log WHERE action = 'ads.cap_paused' ORDER BY created_at DESC LIMIT 5;
```

**To run ads again:** raise the **Monthly spend cap** (Settings → Connections → Meta ads (Boost);
above the platform ceiling the save is refused with `OVER_CEILING`), then resume the campaigns in
**Ads → Campaigns**. A resume needs a confirm and passes the money rule. If the cap is still at or
below the spend, the guard pauses them again within the hour.

If the audit row's `not_paused` is above 0, or the log has `ads.cap_pause_failed`, Meta refused to
pause some campaign. That check counts as failed and is tried again in 10 minutes. Look at those
campaigns in Meta Ads Manager yourself.

### 13.3 "Meta no longer accepts your ads access" (`TOKEN_INVALID`)

What you see: that notice on the Ads screen; a button that answers **409 `TOKEN_INVALID`** (never
401, which the dashboard reads as "signed out": `metaRefusal`, `src/services/adBoosts.ts`); the
alert `token_dead` (once a day, it cannot be switched off). The tenant's `ads.health.<tenant>`
setting then holds `token.health: 'dead'`, and that tenant's write queue stays stopped until a new
token is saved.

Cause: Meta answered a call with code 190 or 102. The token also dies when its system user is
deleted, when its asset assignments are removed, or when the app's secret is reset
(`docs/TOKEN_GUIDE.md`). `10/1341012` means the Page is not assigned to the system user.

**Check:** Settings → Connections → Meta ads (Boost) → **Test connection**
(`POST /api/ads/settings/test`) lists the scopes the token has and lacks and the assets it
reaches. `node scripts/ads-probe.mjs` prints the same from a terminal.

**Fix:** make a new system-user token ("Never" expiry, the five scopes) and install it **before**
revoking the old one: `docs/TOKEN_GUIDE.md`, "Ads token" → "Rotating it". Paste it into
**System-user ads token** and press **Test connection**.

### 13.4 "Meta is limiting requests" (`RATE_LIMITED`, `EDIT_LIMIT`)

- **`RATE_LIMITED`** (429, with `retryAt`). On the Limited access tier Meta allows about 60 points
  per 300 s per ad account (a read is 1, a write 3). The app's pacer keeps to 45 and refuses
  anything more **without calling Meta**. A throttle from Meta blocks the account until Meta's own
  reset time (300 s when it gives none) and is **never retried** (`withRetry({ ads: true })`). The
  log is `ads.throttled`, with `retry_at`.
- **`EDIT_LIMIT`** (429, with `retryAt`). Meta's limits on edits: 4 budget changes per ad set per
  hour (613/1487632), an object that is busy (613/4841018, tried again after 30 s), and 10 changes
  a day to the account's own spending limit (17/1885172, which fails the change).

Nothing is lost. A change waits in the queue and goes out when the block ends:
`GET /api/ads/ops?state=pending,running,verify` lists what is waiting. A double press returns the
same op, so pressing again does not queue a second one. **Fix:** wait for `retryAt`.

### 13.5 "The assistant does not answer a conversation that came from an ad"

If it is one Instagram thread whose replies are refused with Meta error **100 / 2534037**, Meta's
own Business AI holds that thread. It is not retried and it is not handed over (the hand-off line
would be refused the same way). The conversation gets `no_reply_reason = 'business_ai_owns_thread'`,
the Inbox shows a notice, one `business_ai` alert goes out (once a day), and the log has
`dm.pipeline_failed` and an error line that starts `ads.alert_` and ends in the alert's kind
(`raiseAlert`, `src/services/ads/attribution.ts`):

```sql
SELECT id, platform, no_reply_reason FROM conversations WHERE no_reply_reason = 'business_ai_owns_thread';
```

**Fix:** in Meta Business Suite, Business AI → "Take control of conversations with your Business
AI". The next reply Meta accepts clears the notice by itself (`clearNoReplyReason`).

A related alert is `window_error`: a reply to an ad conversation was refused for being outside the
window (`10/2018278` or `551`). The longer-window switch of that platform turns itself off
(Settings → Connections → Meta ads → *Conversations from ads*) and the alert goes out. Turn the
switch back on only after a real day-2 reply was accepted (guide, A3).

### 13.6 Two more checks

- **An alert did not arrive.** Read the `ads_alerts` row above: one alert is kept per kind, object
  and day (`ads.alert_duplicate` means today's already went), and `channels` says `sent`, `failed`
  or `off` for Telegram, email and the admin copy. A channel is used only when the recipient is set
  (**Alert recipients**, then **Send a test**; `POST /api/ads/settings/alerts` with `test: true`)
  and the deployment has the bot token or the email key (Settings → Messages & alerts).
  `ads.alert_telegram_failed` and `ads.alert_email_failed` carry the channel's reason.
  **An ad was rejected** (`ad_rejected`) and **An ad has issues** (`ad_issues`) come from the
  hourly structure sync (`syncStructure`, `src/services/ads/sync.ts`; the rule is `adStatusAlertFor`,
  `src/services/ads/adStatusAlerts.ts`) and only for a CHANGE on an ad the stored copy already had:
  into `DISAPPROVED` or into `WITH_ISSUES`. So none arrives for an ad the sync met for the first
  time (the first import of an account is silent, and so is an ad made in Ads Manager and rejected
  before its first sync), for an ad that was already in that state, or within the hour before the
  next sync. `ads.ad_status_alert` in the log (`kind`, `ad_id`, `from`, `to`) says one was raised,
  the `status_alerts` count in `ads.sync_structure` says how many a run raised, and the
  `ads_alerts` row has the ad's Meta id as `object_key`. `ads.alert_failed` (error) means the alert
  could not be handed to the alert channel; it is not tried again, because the stored ad already
  holds the new state (`docs/ADS_GUIDE.md`, *Alerts*). The rule template **Ad rejected → tell me**
  (Ads → Rules) is the other way to hear about an ad that is rejected right now.
- **A change or a create is stuck.** `GET /api/ads/ops/<id>` shows one op. An op `running` for over
  5 minutes is reaped. A create that timed out is `verify`: the app searches Meta for its
  `AR·<op id>` tag, resends at most once, and never creates twice (FLOWS.md §11.2 C). Ads Manager
  showing a campaign without an ad means a later op failed or waits; nothing spends.

---

## 14. YouTube

A Short is its own `scheduled_posts` row (`platform = 'youtube'`, `post_type = 'video'`). It is
made in Posts, or by the Monteur or the infographics, usually beside the Instagram and Facebook
row of the same video. The ordinary sweep publishes it (§4.1; `publishYouTubePost`,
`src/services/youtubePublish.ts`). The connection is on **Settings → Connections → YouTube**: any
member reads it, the owner connects. The Google OAuth
client and the **Upload Shorts as public** switch are on **Settings → Platform**, platform admin
only. There is no YouTube guide; the contract is the header of `src/services/youtube.ts` and
`src/services/youtubePublish.ts`, and FLOWS.md §3.7 walks a Short from the row to the video id and
the daily check.

Read-only queries (SQL editor, or `connectReadOnly()` as in §2.1):

```sql
-- the connection; the tokens are never selected
SELECT status, scopes, display_name, refresh_expires_at, last_refreshed_at, left(last_error, 160) AS last_error
  FROM platform_connections
 WHERE platform = 'youtube';

-- the last twenty Shorts; `YTU:` in external_publish_id is an upload session left open
SELECT id, status, scheduled_time, attempts, external_publish_id IS NOT NULL AS session_open,
       published_post_id, left(error_log, 200) AS error_log
  FROM scheduled_posts
 WHERE platform = 'youtube'
 ORDER BY scheduled_time DESC
 LIMIT 20;
```

### 14.1 "Needs reconnecting" — the saved login was wiped

The card says **Needs reconnecting**, with *Last problem: …* under it. Shorts fail with "Google
refused the saved login (access was removed, or it expired) — reconnect YouTube in Settings."
(Google's `invalid_grant`), and the log has `youtube.token_refresh_refused`.

What it does: a refresh or an API call that Google answers with `invalid_grant`,
`unauthorized_client`, `authError`, a missing permission, or a 401 calls `markConnectionInvalid`
(`src/services/youtubeConnections.ts`). That **deletes the access and refresh tokens and the
channel's name and picture**, and keeps the channel id and the reason. YouTube's developer policies
want the data gone soon after access is revoked, and `/privacy` promises it by the next daily
check. A dead refresh token cannot be revived: there is nothing to restore, only to reconnect.

Causes, most likely first:

- **The Google app is still in Testing.** A refresh token then lives 7 days (`refresh_expires_at`
  is set only in this case). The card warns beforehand: *The Google app is still in Testing, so
  this connection stops on {date}.* **Fix the cause first:** publish the app in Google Cloud
  (Audience → Publish app), or it will die again a week after every reconnect.
- Access was removed at myaccount.google.com/permissions, or the client ID or secret was changed
  (`unauthorized_client`).

**Fix:** the owner presses **Reconnect**. Then retry the Shorts that failed meanwhile with
**Publish now**. A failed connect shows a reason on return: `channel_in_use` (the channel is
connected to another workspace), `no_channel`, `scope_missing` (tick *Manage your YouTube
videos*), `redirect_mismatch` (the card shows the redirect URI to register on the Google client;
it is built from `app.public_base_url`, never from the Host header), `bad_client`,
`state_mismatch` and `state_expired` (start again from the same browser). The log
`youtube.oauth_callback_failed` carries Google's reason. Google's sign-in page warns *Google hasn't
verified this app* until Google verifies it: choose Advanced, then *Go to AutoReply Pro*.

### 14.2 "A Short failed" — the quota and the other refusals

Read `error_log` on the card in Posts, or in the second query. It names the step and then
Google's reason, in the app's own sentence (`REASON_MESSAGES`, `src/services/youtube.ts`). The log
is `youtube.publish_failed`.

| `error_log` says | Means | Do |
|---|---|---|
| *…daily quota is used up (about six uploads a day)…* (`quotaExceeded`) | `videos.insert` costs 1,600 of the 10,000 units Google gives the project a day, and a thumbnail 50: about six Shorts a day. The quota resets at midnight Pacific time | wait for the reset, then **Publish now** (below) |
| *…upload limit for this channel is reached for today…* (`uploadLimitExceeded`) | YouTube's own limit for the channel | retry tomorrow |
| *…YouTube is rate-limiting this app…* (`rateLimitExceeded`) | too many requests in a short time (Google sends a 403 or a 429) | wait a minute, then **Publish now** |
| *…reconnect YouTube in Settings.* | 14.1 | 14.1 |
| *…takes MP4, MOV or WebM here — this file is …* | the video is another type | upload an MP4 |
| *The YouTube upload did not finish — retry it, and it resumes where it stopped.* | the upload timed out part way | **Publish now**. It first asks Google how far the saved session (`external_publish_id = 'YTU:…'`) got and carries on from there, so it never posts the same Short twice |
| *Thumbnail not set: …*, on a `PUBLISHED` row | the cover was refused (over 2 MB, not JPEG or PNG, the channel may not set custom thumbnails, or the quota or a rate limit was hit just then: the note says so). The Short is up | nothing; set the thumbnail in YouTube Studio |

**Nothing retries a failed Short**, and the quota and rate-limit sentences say so (they used to promise a retry). The sweep takes
only `PENDING` rows, and a failed Short stays `FAILED` (`RETRYABLE_REASONS` in `src/services/youtube.ts` is read by no one;
`youtubeHttp` has no retry wrapper). After the reset, or a minute after a rate limit, press **Publish now** on the card, or edit
and save the post (that flips `FAILED` to `PENDING`). `helpTruth.test.ts` and `youtube.test.ts` pin both. A limit hit while the cover
is set does not fail the post (the Short is up), so its note sends the owner to YouTube Studio, not to **Publish now**.

### 14.3 "A Short is private", or "no longer public"

Two things decide it. The switch **Upload Shorts as public** (`youtube.public_uploads`; off by
default) says what the app asks for: off, every upload is `private`; on, the post's own choice,
which is public unless it says otherwise. To read it, query `app_settings` for the key
`youtube.public_uploads`: the value `true` is on, and no row is off. And **what YouTube reports
back wins over what was asked**. YouTube documents that an unaudited project's uploads stay
private. This project's have gone out public so far, but nothing promises it stays so. When
YouTube kept a Short private, its `PUBLISHED` row says *YouTube kept this upload private — make it
public in YouTube Studio.* That is not a failure: set it public in YouTube Studio by hand.

**The daily visibility check** (`checkYouTubeVisibility`, `src/services/youtubeVisibility.ts`, run
by the daily cron after the token refresh) asks YouTube about every published Short, 50 to a
call, 1 quota unit each, the newest 500 per tenant. One that is not as expected gets a sentence in
its `error_log` that starts *Visibility check {day}:* (*YouTube now shows this Short as private*,
*YouTube no longer has this video*, or *shows this upload as rejected*). Posts shows it beside
**Open on YouTube**, and the Settings card says *{n} of {total} Shorts are no longer public on
YouTube. See them in Posts.* Each day's sentence replaces the last, so a Short that is public
again loses its note at the next check. With the switch off, private is what was asked, so a
private Short gets no note. The logs: `cron.youtube_visibility` (`checked`, `notPublic`,
`missing`, `failed`), `youtube.visibility_changed` (warn, when any Short is not as expected) and
`youtube.visibility_check_tenant_failed`. To list them:

```sql
SELECT id, scheduled_time, left(error_log, 200) AS error_log
  FROM scheduled_posts
 WHERE platform = 'youtube' AND status = 'PUBLISHED' AND error_log LIKE '%Visibility check%'
 ORDER BY scheduled_time DESC;
```

---

## 15. Studio jobs and the Mac worker

The Studio's queue is **`studio_jobs`, not `jobs`**. `/api/jobs/drain` and the cron never touch it;
only the worker on the owner's Mac takes work from it. The *Carousel Studio* section below has the
worker's commands, the "worker is offline" query and the carousel, lesson and draft problems. This
section covers what came after it: the Monteur, infographics, ad proposals and illustrated
explainers, and the rule that decides who may ask Claude on the Mac. The contracts are
[`MONTEUR.md`](MONTEUR.md) (the jobs in §3, Claude on the Mac in §6.3), [`STUDIO.md`](STUDIO.md)
§11 (explainers) and [`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md) §9 (the symptoms in the
Studio's own words). The hop-by-hop walks are FLOWS.md §7 (who may ask) and §13 (explainers). The
worker itself lives in another repo, `aicourse-captions`; its README maps its log lines to fixes.

### 15.1 What the Mac is asked to do

| `studio_jobs.kind` | Work | Claude? |
|---|---|---|
| `scan_library`, `index_lesson`, `render_carousel` | the Carousel Studio | no (indexing uses the worker's own Gemini key) |
| `pick_folder`, `monteur_scan`, `monteur_transcribe`, `monteur_render` | the Monteur's folder, scan, transcript and render | no |
| `monteur_think` | the Monteur's pick, copy, edit and the Analyst, while `monteur.brain` is `claude_mac` | **yes** |
| `render_infographic` | an infographic's render; with `write` in the payload, Claude writes the page and its caption first | **yes**, only with `write` |
| `ads_think` | an ad proposal drafted for the owner | **yes** |
| `explainer_write` | an explainer's researched script | **yes** |
| `explainer_voice`, `explainer_draw`, `explainer_render` | the narration, a loop that asks the server to draw (15.5), the videos | no |

### 15.2 Jobs wait and nothing moves

1. **Is the Mac up?** Run the "worker is offline" query in the *Carousel Studio* section: `online`
   means a call within 90 s.
2. **What is queued:**

   ```sql
   SELECT kind, status, count(*) AS jobs, min(created_at) AS oldest, min(not_before) AS earliest_start
     FROM studio_jobs
    WHERE status IN ('pending', 'claimed')
    GROUP BY kind, status
    ORDER BY oldest;
   ```

3. A `pending` job whose `not_before` is in the future is waiting for a **time**, not for the Mac:
   a paused explainer drawing (15.5), or a voice step waiting for Gemini's free speech allowance
   (the explainer's note starts `VOICE_LIMIT:` and the step is queued again for the reset). The
   dashboard counts those as *waiting*, apart from the Mac's backlog.
4. A `claimed` job whose last heartbeat is more than 15 minutes old is handed out again at the next
   claim, and fails after three claims (*stopped reporting on this job 3 times*; see the table in
   the *Carousel Studio* section).
5. **What failed:**

   ```sql
   SELECT id, kind, attempts, left(error, 200) AS error, updated_at
     FROM studio_jobs
    WHERE status = 'failed'
    ORDER BY updated_at DESC
    LIMIT 20;
   ```

### 15.3 A job fails at once: "doesn't know the job kind"

What you see: a job `failed` straight away, and with it the explainer, the Monteur source, the
infographic or the ad proposal that waited for it, with *…doesn't know the job kind "<kind>"* in
`studio_jobs.error`. The **worker** writes that sentence, in the `aicourse-captions` repo, so it
cannot be found by searching `src/`.

Cause: the app queued a kind that the running worker has no handler for. A new kind arrives in
this repo first, with a deploy. The worker has it only after its own repo is updated **and** its
launchd agent is restarted.

**Fix:** on the Mac, update the worker's repo, then restart the agent and queue the work again
(**Retry** on the explainer, the source, the infographic or the proposal):

```bash
launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker
```

For a release that adds a kind the order is: migrate, deploy, update the worker and restart it
(MONTEUR.md §6.3, *Rollout*). A `monteur_think` that reaches an old worker is only a failed try,
never a lost day (15.4).

### 15.4 Claude jobs: the Mac is asleep, `claude` is signed out, or the tenant is refused

Every Claude job needs the Mac awake, the worker running and the `claude` command signed in to
the owner's plan. What happens when one of them is missing depends on the job:

- **`monteur_think`** is one *try* of a request (`src/services/monteur/think.ts`). A try that
  shows no sign of life for 20 minutes fails with *No answer within 20 minutes: the Mac may be
  asleep, or its Studio worker stopped.* The request is asked again after 10 minutes, then 30
  minutes, then 2 hours. The fourth failure stops the item (the source, or the Analyst's run) with
  **"Claude on the Mac didn't answer: …"** and the last reason. While it waits the item says
  *Waiting for Claude on the Mac: …*; a drain never waits for the Mac. **Retry** on the item
  starts again from try 1.
- **`explainer_write`**: the CLI's sign-in refusal (*Failed to authenticate*, *OAuth session
  expired*, *Please run /login*) fails the write, and the next look at the explainer hands the
  script to Gemini (`src/services/explainers/writing.ts`). The same takeover happens when the Mac
  has not picked the write up in 10 minutes **and** no live worker has been heard from; a Mac that
  is up but busy is not replaced, and the explainer says it is busy. A free Gemini key cannot
  research on the web, and the failure says so. If the owner chose Gemini as the writer, Gemini
  writes from the start and the Mac is never asked. With `writer_fallback` off there is no
  takeover at all: the explainer waits for the Mac or fails with its reason. **Fix:** sign
  `claude` in again on the Mac, then Retry (FLOWS.md §13.5).
- **`render_infographic` with `write`** and **`ads_think`** have no takeover. They wait for the Mac
  like any job, or fail with the worker's reason. An ad proposal that the Mac never answers within
  24 hours is failed by the daily cron (`cron.ads_proposals_expired`, `staleDrafts`).

**The Mac is refused: `NEEDS_API_BRAIN`.**

- **What you see:** a 409 with the code `NEEDS_API_BRAIN` (*This tenant's AI work can't run on the
  operator's Mac; it needs the AI providers layer*), a queued job failed with that text, and the
  log `studio.mac_brain_refused`.
- **Why:** this is the rule working, not a fault. Claude on the Mac runs on the owner's personal
  Claude plan, and Anthropic's terms forbid routing anyone else's work through it. So the server
  refuses it for every tenant except the owner (the first creator ever made) and the tenants a
  platform admin listed (the app setting `studio.mac_brain_tenants`; unset means the owner alone).
  The code is in `src/services/macBrain.ts`.
- **Fix for a client tenant:** use the AI providers layer. The Monteur uses `monteur.brain: 'api'`,
  infographics are written on the server, and ad proposals go through `ads_draft` and
  `ads_review`. With no provider key saved the answer is 409 `NEEDS_AI_PROVIDER` (for ad proposals,
  `AI_NOT_CONFIGURED`): the platform admin adds a key under Operations → AI providers.
- **Do not add a client to the list to make the error go away.** `GET /api/admin/mac-brain-tenants`
  shows the list, and `PUT` saves it (`{ "tenants": [ids] }`, or `{ "tenants": null }` for the owner
  alone). Each save is an audit row, `settings.mac_brain_write`.

### 15.5 "The explainer's pictures stopped" — Cloudflare's daily allowance

The pictures are drawn by the **app**, not the Mac: Cloudflare Workers AI, on its free plan of
10,000 units a day. The Mac's `explainer_draw` job is only a loop that asks the server for one
picture at a time (`POST /api/studio/worker/explainers/:id/draw-next`; FLOWS.md §13.10). Cloudflare
cannot be asked what is left, so the app counts an estimate (about 110 units a picture, 80 pictures
a day by default) and reserves it before each call.

What you see: the explainer stays **drawing**. The card says *Waiting for tomorrow's allowance*, or
*Drawing is paused until {when}: today's allowance is used up.* The explainer's `draw_paused_until`
is set, the worker's loop is answered `paused` with an `until`, a redraw of one scene by hand
answers 429 `EXPLAINER_ALLOWANCE_PAUSED` with `retryAt`, and the log has
`explainer.allowance_exhausted` with `resumes_at`. Two Cloudflare answers look alike and are not:

| Cloudflare says | The app reads it as | What happens |
|---|---|---|
| error code **3036** (**4006** in older answers), "Account limited" | the day's allowance is used up | drawing pauses until the next **00:05 UTC**, and the next `explainer_draw` job is queued for then. It resumes by itself; nothing is charged |
| error code **3040** "Out of capacity", or a bare **429** | Cloudflare is **busy** for a moment, not a day's pause | that scene fails with *Cloudflare is busy right now…; try again in a few minutes*, and its units are given back |

The app's own daily cap (80 pictures by default) pauses the same way at the same time. **There is
nothing to press.** Check the state:

```sql
SELECT id, status, failed_step, draw_paused_until, left(error, 160) AS note, updated_at
  FROM explainers
 WHERE status IN ('drawing', 'failed')
 ORDER BY updated_at DESC
 LIMIT 10;
```

`GET /api/studio/explainers/allowance` answers `used_units`, `pictures`, `cap`, `est_left` and
`paused_until`. A scene that failed for another reason stays failed. Three scenes failing in a row
make the worker stop, and nothing retries by itself: the owner redraws the scene, or presses
**Continue drawing**.

---

## 16. The DM bot

It answers direct messages on Instagram and Messenger (WhatsApp, §12, shares its brain). The
forward walk is FLOWS.md §2: the claim (§2.5), the sales switch (§2.6b), the hand-off and the
owner's alert (§2.6d), the send (§2.9) and a failure (§2.11). A DM is a `dm.process` job (§5); its
log lines start with `dm.` or `ai.`. The settings are on the **DM assistant** page: **Turn on
auto-replies**, **Reply engine** (Gemini, the default, or *AI providers*, with **Fall back to
Gemini**) and **Sales replies**; and per thread in the Inbox, **AI replies: on** or **off**. Read
them in one place (counts only, no text):

```sql
SELECT is_active, model, engine, gemini_fallback, sales_mode,
       cardinality(sales_test_senders) AS sales_test_senders
  FROM ai_agents;
```

### 16.1 "Replies are slow"

Measure first, with the median query of §5.2 (created to done, per job kind): seconds is healthy.
Then look for these, most likely first:

| Cause | You see | Do |
|---|---|---|
| The invocation was frozen after the 200 | a median near 70 s, and `runtime.wait_until_unavailable` (warn) in the logs: the platform gave the request no `waitUntil` (`src/webhook/ack.ts`, `src/utils/waitUntil.ts`) | the next drain finishes the job. The Heroku worker drains every minute (§5.1); a `running` row left behind is freed after 300 s (§5.3) |
| No drain is running | `pending` jobs with an old `run_after`; the `queue` warning of `diagnose.mjs` above 15 minutes | §5.1 |
| The send quota | `dm.quota_exhausted` with `source: 'dm'`; the job's `last_error` reads *Send quota exhausted (creator: N/L).* or `(app: …)` | the job retries after about 30 s, 2 m and 8 m, and on the last attempt is concluded with no reply (§2.4). The ceilings are 180 an hour per tenant and 1,000 for the whole app |
| The model is slow or failing | `job.retrying` with the model's error; `dm.pipeline_failed`; with the *AI providers* engine, `dm.engine_fallback` (it answered once with Gemini instead) | 16.2 |

```sql
SELECT kind, status, count(*) AS jobs, min(run_after) AS oldest_due, max(attempts) AS most_attempts
  FROM jobs
 WHERE status IN ('pending', 'running')
 GROUP BY kind, status;
```

**Where the seconds go.** Every DM ends with ONE `dm.timing` line (`src/utils/timing.ts`, opened by
`handleMessagingEvent`). `steps_ms` lists each step in the order it ran, and the steps add up to
`total_ms`:

- the pipeline's `creator`, `conversation`, `claim`, `settings` and `profile`;
- the sales turn's `state`, `burst`, `agent`, `prefilter`, `context`, `model`, `guard`,
  `sender_wait`, `quota`, `send` and `record`;
- then `settle` and `profile_wait`.

`steps_db` counts the database statements each step sent, and `db_statements` counts them for the
whole DM. Each statement is a round trip to the pooler in `eu-west-1`. `model` is that step's wall
time and `model_api_ms` is the provider's own time; the gap is the AI layer's settings read and
budget reservation. `sender_actions_ms` is how long `mark_seen` and `typing_on` took beside the
model. `event_age_ms` is how old the customer's message was when the job took it.

The hops before the job:

- `webhook.enqueued` carries `event_age_ms` (Meta's delivery) and `enqueue_ms`;
- `job.drain_complete` carries `reap_ms` and `claim_ms`;
- `job.succeeded` carries `queued_ms` and the job's `db_statements`.

The logs reach back about an hour:

```bash
vercel logs --environment production --since 30m --json --limit 400 | grep '"dm.timing"'
```

### 16.2 "A DM got no reply at all"

Find the message in the logs and read what follows `dm.received`:

| You find | Means | Do |
|---|---|---|
| `dm.duplicate_ignored` | Meta redelivered a message that is already handled, or being handled | nothing |
| `dm.bot_paused` | a person took the thread over (the Inbox says **AI replies: off**) | switch it on again for that thread (`PUT /api/conversations/:id/toggle-bot`). A reply the owner types pauses the thread only when *Pause the assistant for a customer when I reply to them myself* is on (Settings → Handoff alerts) |
| `ai.agent_disabled` (info), or `ai.unconfigured` (warn) | **Turn on auto-replies** is off, or the tenant has no agent row. Silence is deliberate here | the DM assistant page: turn it on and save |
| `dm.quota_exhausted` | the hourly ceiling | 16.1 |
| `dm.pipeline_failed` (error) | the reply failed; the line has the reason | below |
| `dm.engine_failed` | the *AI providers* engine failed, and so did the fallback (or **Fall back to Gemini** is off) | the line says why: no key, no route, a spent budget, an outage. Operations → AI providers |
| the thread's `no_reply_reason` is `business_ai_owns_thread` | Meta's Business AI holds the Instagram thread | §13.5 |
| `dm.failure_handoff` | the last attempt failed: the customer was handed over, the owner told | below |

**A failed reply.** `dm.pipeline_failed` carries the model's or Meta's error. What to do depends
on it:

- A transient error (a Gemini 429 or 503, a Meta 5xx, a reset connection) is retried:
  `job.retrying` after about 30 s, 2 m and 8 m.
- A permanent Meta error is final at once and is never retried: code 190 (a dead token), 200 (a
  missing permission) or 10903 (the person blocked DMs).
- *No Gemini API key* means none is saved or set: Operations → Gemini API key, or `GEMINI_API_KEY`.
- A **404** from the model means that key has no access to it. Google serves the 2.5 family only to
  keys that used it before, and the default model is `gemini-2.5-flash` (`DEFAULT_MODEL`,
  `src/services/ai.ts`). The page's model picker offers three; try one in the page's **Agent
  sandbox** before relying on it.

**It is not silence any more.** On the last attempt of a failure that is not a permanent Meta
one, `handoffAfterFailure` (`src/services/dmSales/failureHandoff.ts`; every `sales_mode`) marks
the conversation `stage = 'handoff'` with `handoff_reason = 'unsure'`, and does **not** pause the
bot: an outage is not a request for a person, so the customer's next message gets a normal reply.
It sends the customer the hand-off line **once** (the profile's own, or the language kit's, with
the automated-service disclosure in front when that has not been given) and tells the owner
(16.4). The log is `dm.failure_handoff` (error, with `state` and `line_sent`). A message with no
words (a photo, a voice note, a sticker) is not handed over, because it asked nothing. In the
Inbox these threads are under the filter **Needs you**:

```sql
SELECT id, platform, stage, handoff_reason, handoff_at, is_bot_active
  FROM conversations
 WHERE stage = 'handoff'
 ORDER BY handoff_at DESC
 LIMIT 20;
```

### 16.3 Sales mode

The sales assistant is a separate switch and is **off by default**; the DM assistant answers
exactly as it always did until the owner changes it. **Sales replies** (`ai_agents.sales_mode`)
has three values: *Off (replies as they are today)*, *Test (only the senders below)* and *On
(everyone)*. In Test only the listed **Test senders** get sales replies, and everyone else still
gets the usual ones. A test sender is an Instagram-scoped user id: digits only, 5 to 32 of them,
at most 20 (`src/services/dmSales/mode.ts`). The read fails toward `off`: a missing agent row, a
database from before migration v39 or an error all mean the old path, and the log says
`dm.sales_mode_read_failed` (warn).

The sales assistant always writes through the AI providers route *Direct-message replies* (`dm`,
Operations → AI providers), whichever reply engine is chosen. If that route fails it answers once
with Gemini when **Fall back to Gemini** is on (`dm.engine_fallback`, `sales: true`); otherwise it
hands the conversation over (`dm.engine_failed`, `sales: true`). A conversation that will not
stop, 15 bot replies in an hour, ends itself and is handed over (`dm.sales_reply_cap`, error).

### 16.4 The hand-off alert did not come

An alert goes out when a conversation needs a person (`stage = 'handoff'`: a refund, a complaint,
a request for a person, abuse, a chat that loops, an assistant that was unsure, or a reply that
could not be sent), and, as a separate **hot lead** alert, when the link has just been sent to
someone who wanted it. `notifyOwner` (`src/services/dmSales/handoff.ts`) sends each alert to
**every channel that is switched on**, Telegram and email, independently. The state is recorded
first, so the Inbox filter **Needs you** and the badge never depend on the alert.

Check in this order:

1. **Is a channel on and complete?** Settings → Messages & alerts → **Handoff alerts** (*Send me
   alerts on Telegram*, the bot token and your chat id) and **Email alerts** (a Resend API key and
   *Send me alerts by email*). **With both off the alert stops with no log line at all:** that
   silence is `notifyOwner` returning `off`. Press **Send test message** or **Send test email**.
2. **Whose conversation is it?** Alerts are the platform owner's. Another tenant's customers are
   never sent to the owner's chat or email, and that tenant gets the Inbox flag and the badge only
   (`dm.handoff_notify_skipped`, at `debug`, with `why: 'not_owner_tenant'`).
3. **The logs:** `dm.handoff_notified` (Telegram sent) and `dm.handoff_notified_email` (email
   sent); `dm.handoff_notify_failed` and `dm.handoff_notify_email_failed`, with `outcome` and
   `status` (a wrong bot token or chat id, a refusal from Resend; the text is scrubbed of the
   key and of addresses); `dm.handoff_notify_rate_limited` (at most 3 hand-off alerts and 1
   hot-lead alert per conversation per hour); `dm.handoff_notify_error`.
4. **The email sender.** Without a domain of your own, Resend's default sender delivers only to the
   address the Resend account was made with. Another address needs a verified domain, entered
   under **Send from**.
5. **Hot leads** have their own switch on each channel: Telegram's is on unless turned off, email's
   is off unless turned on.

The alert says why in a line, for example *Needs you: the assistant could not reply (a technical
failure)*, *refund request*, *complaint*, *asked for a person*, *abusive messages*, *the assistant
was not sure how to answer*, and, for WhatsApp, *the 24-hour window had closed, so no reply could
be sent*, *the free WhatsApp replies are used up and paid replies are switched off* or *the
WhatsApp connection needs reconnecting*.

---

## Publishing and DM safety

Three behaviours that look like failures but aren't, and one that used to be a failure:

- **Instagram still processing.** A reel whose container isn't FINISHED within the 25 s poll
  budget is held, not failed: `PENDING`, `error_log` says so, `external_publish_id =
  'IGC:<container>'`, and Facebook stays recorded in `published_post_id`. The next sweep publishes
  the same container. After 15 sweeps it fails as before. Nothing to do unless it fails.
- **Facebook "didn't answer".** A post that times out or gets a 5xx is not re-sent, because it may
  be live. If a post FAILED with a timeout, **check the Page before retrying**.
- **DM refused.** When Meta won't deliver a DM (code 100: the commenter can't receive messages
  from Pages; code 10903: they blocked Pages), the interaction is FAILED with "Replied publicly with
  the link instead", and a public reply went out: the campaign's link on Facebook, "link in bio" on
  Instagram.
- **Trial reel refused.** The post FAILS and says it was not published; turn Trial Reel off to post
  it normally.

## DM sales evaluation

Fifteen golden conversations (Gulf, Egyptian, MSA and English: a price, "is it for beginners", "too expensive", free on YouTube, the
link at once, off-topic, abuse, "stop", a refund, a payment problem, an injection, a question the course does not cover, a
collaboration, an English speaker, and qualify → recommend → link) go through the real sales prompt, schema, coerce and guard against
a model you name. Run it before every prompt or kit change, and to choose the model of the `dm` route (Operations → AI providers). The plan behind it is in the maintainers' local notes, which are not in this repo.

```bash
npx tsx scripts/eval-dm-sales.mts --model claude-haiku-5-5,claude-sonnet-5-5,claude-opus-5-5 --report eval-report.md  # needs an Anthropic key (Operations → AI providers)
npx tsx scripts/eval-dm-sales.mts --model claude-sonnet-5-5 --cases 1,5,15 --no-judge                                 # a quick look: hard checks only
npx tsx scripts/eval-dm-sales.mts --stub                                                                               # no key, no database: the two cases CI runs
```

- **The bar:** every hard check passes (action, handoff reason, no invented number, no model-written link, 900-byte cap, language and
  dialect, opt-out honoured), the Claude judge's mean for tone, helpfulness, pressure and recommendation is at least 4, and no score is
  under 3. The terminal table and the markdown report give each model's pass rate, p50/p90 latency, tokens, cost and every failure with its
  reason. Exit 0 = every model met the bar, 1 = one did not, 2 = usage, 3 = refused.
- **What it touches:** the committed fixtures only (`src/services/dmSales/__evals__/fixtures.ts`), never a tenant or a conversation, and it
  sends nothing; a flag that names a tenant is refused. Its model calls go through the AI providers layer and land in `ai_usage` as purpose
  `eval`, charged to no tenant, so they count against the platform budget but not a tenant's.
- **Adding a case:** one JSON file in `src/services/dmSales/__evals__/conversations/`. The loader rejects a misspelt expectation instead of
  letting it check nothing. `npm test` runs the harness's tests and a two-case dry run with a stub model.

## Muse benchmark

A hand-run check of the sales agent on what followers send without a word (photos, a video, shared reels, a story mention and, once its module is in, voice notes), the shipped
path beside what the agent did before Muse, with every failure listed. It is for the hackathon entry and for anyone who wants to see the numbers made again: it calls the **live**
Meta API with your key (about twenty cents a run), so it is never run by `npm test` or CI.

```bash
npm run eval:muse -- --env .env                        # the key is META_MODEL_API_KEY in that file (run it from the main checkout, where .env is; from a worktree pass the full path)
npm run eval:muse -- --settings --env .env             # or the key saved in Settings (a read-only connection, closed before anything runs)
npm run eval:muse -- --env .env --voice --memory --library library.json --open-weights --judge
npm run eval:muse -- --stub --out scratch/bench           # a dry run: canned answers, no key, no network, writes only where --out says
npm run eval:muse -- --list                               # the cases
npm run eval:muse -- --env .env --cases image-price,reel-own   # an id is that case alone; anything else is the start of some ids
```

- **Cases** are one file, `scripts/eval-muse/cases.json`: each says what was sent, what was typed with it, which actions are right, and which facts must not be invented (a price the
  picture showed). The loader rejects a misspelt expectation instead of letting it check nothing. The media is read from `--media-dir` (default `~/Desktop/Meta hackathon tests/media`);
  no media file is in the repository, and a case whose file is missing is skipped by name, never passed. Two pictures (a made-up identity card and a story) are drawn at run time.
  `--cases` takes ids: an id is that case alone (`image-price` is not also its four variations), anything else is the start of some ids (`image-price-` is those four, `reel-own` the four
  reels).
- **Arms.** Meta: `perceive()` and the sales turn's own prompt, schema, coercion and guard, drafted through the DM sales evaluation's runner (`src/services/dmSales/__evals__/`), so
  nothing is sent. Today: the fixed line the agent sent before Muse (once a day), and for a message with words the same sales turn with the media unopened. `--voice` runs the
  product's own `transcribeVoice` on the three voice notes (it needs the `ffmpeg-static` package, which `npm install` brings: without it the arm is left out with a note that says so,
  and is not counted as voice notes the product could not hear). `--memory --library <rows.json>` runs the product's own recall, ten questions against the library and against a copy
  that keeps only what each reel says aloud; its module is picked up by itself the day `recall.ts` is in the checkout, and until then the arm is skipped with a note. `--open-weights` analyses one reel on Muse Spark Open (Baseten,
  `BASETEN_API_KEY`) and on hosted Muse Spark with the reel indexer's own request.
- **The library for `--memory`** is the `reel_analyses` rows with `status = 'ok'`, as JSON: `psql "$DATABASE_URL" -At -c "SELECT json_agg(t) FROM (SELECT * FROM reel_analyses WHERE status = 'ok') t" > scratch/library.json`
  (a read; the file holds the owner's own reel notes, so it goes in the ignored `scratch/` folder and never in the repository), then `--memory --library scratch/library.json`. The ten
  questions in `scripts/eval-muse/cases.json` are starters grounded in two known reels: replace them with questions about the reels the library really holds before the numbers mean much.
- **What it touches.** Keys from the file you name (no `.env` is read unless you name one) or from Settings read-only. It writes no database (the application's pool is closed before
  the run), sends no message and reads no tenant; a Contributor-mode model id is refused unless every selected case is a drawn one. What can be found wrong for free (a missing key, an
  unreadable `--library`, a flag it refuses) is found before the first call that costs, and a case that stops on an error is a row in the report (`crashed`) with what it had cost, so one
  bad case never takes the others' results with it. A dry run (`--stub`) never writes to `docs/hackathon`: it needs an `--out` of its own. A key is taken out of everything it prints or writes.
- **Outputs.** `benchmark.md` and `benchmark.svg` in the `docs/hackathon` folder (light and dark): the table per arm, the bar the shipped path is held to, every failure with its case
  id and a line of why, what did not run, the date, the models and the command. Exit 0 = the bar was met, 1 = it ran and was not met, 2 = usage or nothing could run, 3 = refused
  (no key). The code is `src/services/perception/__bench__/`; its tests make no live call.

## Media storage

Uploads live in the public Supabase Storage bucket `media` (`<creator_id>/<id><ext>`);
`media_uploads` keeps the metadata (`storage_path`, `size_bytes`). URLs stay
`/api/uploads/<id>` on our domain, and the route streams the object.

- **Setup:** Settings → Media storage (platform admin). The Project URL is
  `https://<project-ref>.supabase.co` (the ref is in the dashboard's address bar, or under
  **Connect**). The key is a secret key (`sb_secret_…`, Project Settings → API Keys), sent only in
  the `apikey` header; a legacy service_role JWT also works. "Save and connect" creates the bucket.
- **Backfill** legacy BYTEA rows: `node --env-file=.env scripts/migrate-media-to-storage.mjs`
  (dry run), then `--apply`. Resumable, verified by sha256. Then `VACUUM FULL media_uploads` to
  return the space (done 2026-09-26: 894 files, 283 MB → 16 MB).
- **Rotating the key:** create a new secret key in Supabase, paste it in the card, then revoke the
  old one.
- **An upload 404s:** check the row's `storage_path`, then that the object exists in the bucket.
  Deleted rows queue their object in `media_object_deletions`; the daily sweep removes it and
  records `last_error` on failure. A third cause is that the row is **private** (next bullet): the
  public route answers 404 for it on purpose.
- **Private files.** A customer's file (a WhatsApp voice note, photo or document; migration v51)
  is stored with `is_private` set, in a second bucket, `media-private`
  (`private/<creator_id>/<id><ext>`). The app creates that bucket on first use as non-public
  (`public: false`), and refuses to use it if it exists and is public. `GET /api/uploads/:id`
  answers 404 for a private row exactly as for an id that never existed, and a scheduled post
  cannot name one
  (`src/services/storage.ts`, header). Only the authenticated Inbox route and the voice-note
  transcription read it, and only for the tenant that owns it. To see whether a 404 is this:
  `SELECT id, is_private, storage_path FROM media_uploads WHERE id = '<id>'`. Without Supabase
  Storage configured a private file stays in `data` and `is_private` alone keeps the public route
  away from it. An erasure deletes these rows with the person's messages (§7).

## Carousel Studio

The Studio's own guide is [`docs/STUDIO_GUIDE.md`](docs/STUDIO_GUIDE.md): what each part does,
every setting, and a symptom table written for the creator. This section is the operator's side of
the same symptoms: what to run, what healthy looks like, and what to do when it isn't.

Three things to know before touching anything:

- **The Studio has its own queue**, `studio_jobs` (migration v21), and only the worker on the Mac
  drains it. `/api/jobs/drain` and the cron never touch it; nothing on Vercel runs these jobs
  (`src/config/migration_v21_studio.sql:8-13`).
- **Prefer the dashboard's buttons to SQL writes.** A button goes through the same code as the
  worker, side effects included: a failed index marks its lesson failed, a new render supersedes
  the pending ones. An `UPDATE` does only what it says. The few writes below are marked, and say
  what they skip.
- **The SQL reads every tenant.** Run it in the Supabase SQL editor, or `psql "$DATABASE_URL"`. With
  more than one tenant, add `AND creator_id = '<id>'` (from `SELECT id, name FROM creators;`).

### The worker, from the Mac

```bash
launchctl print gui/$(id -u)/com.aicourse.studio-worker | grep -E 'state|pid'   # running? "state = running" and a pid
tail -f ~/Library/Logs/aicourse-studio-worker.log                                  # follow it live
grep -E 'failed|rejected|stalled|interrupted|config:' ~/Library/Logs/aicourse-studio-worker.log | tail -40
launchctl kickstart -k gui/$(id -u)/com.aicourse.studio-worker                     # restart it

# From the worker's folder, ~/Desktop/AI Course/aicourse-captions:
scripts/install-studio-worker.sh           # (re)install the launchd agent: after a Node upgrade or a moved folder
node scripts/studio-worker.mjs --drain     # run in the foreground until the queue is empty (stop the agent first)
scripts/uninstall-studio-worker.sh         # remove the agent; the log is kept
```

**A tenant's worker (W2)** is a second, render-only agent, never the owner's: `com.aicourse.studio-worker.<name>`,
log `~/Library/Logs/aicourse-studio-worker.<name>.log`, files under `~/.aicourse-studio/instances/<name>/`. Create the
worker as that tenant in Studio, Settings, Workers (the token is shown once), then from the worker's folder
`node scripts/studio/install-instance.mjs --instance <name>` is a dry run and `--apply` installs it (token from
`--token-file` or `STUDIO_WORKER_TOKEN`, never an argument); `--remove --apply` takes it away, and the token keeps
working until it is revoked in the dashboard. It asks for render kinds only, so the server's tenant scoping
(`CLAIM_SQL … WHERE creator_id = $1`) plus the Mac-brain guard (`studio.mac_brain_tenants`) leave it nothing to think
about: a think or a `write` is failed with the render-only message, never run. The aicourse-captions README has the
add, rotate and remove steps.

An idle worker polls silently, so a quiet log is not a dead worker; `last_seen_at` (below) is the
signal. Every step of a job is one timestamped line, prefixed with the job's kind and the first 8
characters of its id, for example `index_lesson 1a2b3c4d: uploading the 0.6 MB proxy to Gemini:
45%`. The worker README's *Troubleshooting* table maps its log lines to fixes.

On the app's side, the Vercel logs (filter on `studio.`) carry `studio.worker_auth_rejected` (a
worker with a stale or revoked token, with the reason and path), `studio.job_claimed`,
`studio.job_completed`, `studio.job_failed`, `studio.job_exhausted`, `studio.render_dropped`,
`studio.ai_request_failed` (one per model that refused), `studio.ai_usage`,
`studio.draft_generated`, `studio.generate_failed` and `studio.schema_missing`. Every Studio route
answers 503 *"The database is missing migration v21…"* until `npm run migrate` has run.

### "The worker is offline"

```sql
-- Every live worker, and whether the app counts it online (an authenticated call within 90 s)
SELECT c.name AS tenant, w.name AS worker, w.created_at, w.last_seen_at,
       now() - w.last_seen_at AS ago,
       coalesce(now() - w.last_seen_at < interval '90 seconds', false) AS online
  FROM studio_workers w
  JOIN creators c ON c.id = w.creator_id
 WHERE w.revoked_at IS NULL
 ORDER BY w.last_seen_at DESC NULLS LAST;
```

| What you see | What it means | Do |
|---|---|---|
| `ago` of seconds, `online` true | Healthy. An idle worker calls at least every 30 s, a busy one at least every 20 s | Nothing |
| `ago` of minutes or hours | The Mac is asleep, off or logged out (the agent only runs in a logged-in session), or the worker stopped | On the Mac: `launchctl print …`, then the log's last lines |
| `last_seen_at` is NULL | The token has never been used | Check `token` and `appUrl` in `studio.config.json`; run `node scripts/studio-worker.mjs --drain` and read it |
| The worker is running, its log says *the app rejected the worker token (HTTP 401)*, and Vercel logs `studio.worker_auth_rejected` | The token was revoked, mistyped, or belongs to a deactivated tenant | Settings → Workers → **Create worker** (owner), paste the new token; it is picked up at the next poll |
| No row at all | No worker, or every worker revoked | Create one (owner role) |

A worker's name in this table is the label typed at **Create worker**. The `name` in its config
file is only for its own log.

### "A lesson won't index" / "Indexing is stuck"

```sql
-- The library at a glance
SELECT status, count(*) FROM course_lessons GROUP BY status ORDER BY status;

-- Every lesson that isn't indexed, with the reason
SELECT id, lesson_no, title, status, left(error, 200) AS error, updated_at
  FROM course_lessons
 WHERE status <> 'indexed'
 ORDER BY section_no NULLS LAST, length(lesson_no), lesson_no;

-- Indexed lessons and their moments: 12 to 30 each; "clean" are the usable screenshots
SELECT l.lesson_no, l.title, count(m.id) AS moments,
       count(m.id) FILTER (WHERE m.clean) AS clean, l.indexed_at
  FROM course_lessons l
  LEFT JOIN lesson_moments m ON m.lesson_id = l.id
 WHERE l.status = 'indexed'
 GROUP BY l.id
 ORDER BY l.section_no NULLS LAST, length(l.lesson_no), l.lesson_no;
```

| The lesson's `error` contains | Cause | Do |
|---|---|---|
| `HTTP 429` | Every model in the indexer's chain (`gemini-3.5-flash` → `gemini-3.6-flash` → `gemini-3-flash-preview`) has spent its daily free quota | After the reset (midnight Pacific: 10:00 Riyadh in US summer time, 11:00 otherwise), press **Index missing**. Nothing re-queues failed lessons by itself. The lasting fix is billing (guide §8) |
| `HTTP 503` or `HTTP 500` | Gemini overloaded, or failing on its side. Each model was retried twice, then the next | Index it again later |
| `HTTP 400` from every model | The request itself is refused (Gemini 3's `minItems`/`maxItems` 400 was one) | The worker log has one *trying the next model* line per model with Google's message. A code fix in `scripts/studio/gemini.mjs` |
| `unusable twice` | Too few usable moments, or times past the end, twice | Index it again |
| `outside the course root`, `not found` | The video moved, or `courseRoot` doesn't contain the library folder | Fix the path, scan again |
| `stalled` | The upload saw two minutes of silence (Mac asleep, network gone) | Index it again |
| `stopped reporting on this job 3 times` | The worker died on it three times | The log around those claim times |

A lesson sitting on **Indexing…** has an open job, or should have:

```sql
-- Lessons marked indexing, with their open job
SELECT l.id AS lesson, l.lesson_no, l.title, l.updated_at,
       j.id AS job, j.status AS job_status, j.attempts, j.progress,
       now() - j.heartbeat_at AS since_heartbeat
  FROM course_lessons l
  LEFT JOIN studio_jobs j
         ON j.kind = 'index_lesson' AND j.status IN ('pending', 'claimed')
        AND j.payload->>'lessonId' = l.id::text
 WHERE l.status = 'indexing'
 ORDER BY l.updated_at;
```

- `pending`: waiting for the worker. It is offline, or busy: by default it runs one job at a time.
- `claimed`, with `since_heartbeat` under a minute: running, and `progress` names the step. An
  upload at 20 to 30 KB/s is slow, not stuck.
- `claimed`, with `since_heartbeat` over 15 minutes: its worker died. The job is handed out again at
  the next claim, and failed after three claims (`src/services/studio/jobs.ts:260-318`).
- `job` NULL: nothing will ever finish it. **Write:** put it back and queue it again with **Index
  missing**:

  ```sql
  UPDATE course_lessons SET status = 'new', error = NULL, updated_at = now()
   WHERE id = '<lesson id>' AND status = 'indexing';
  ```

**Re-index a lesson that is already indexed** (the dashboard only offers the button for lessons that
are not). Either from the dashboard's browser console, which goes through the API as your session:

```js
const { lessons } = await API.getStudioLessons();
await API.indexStudioLesson(lessons.find((l) => l.lesson_no === '4.3').id);
```

or, **write**, mark it not indexed and press **Index missing**; its notes and moments stay until the
new index replaces them:

```sql
UPDATE course_lessons SET status = 'new', updated_at = now() WHERE id = '<lesson id>';
```

**Cancel an index backlog**, for instance after the quota is spent and every queued lesson would
fail anyway. **Write:** it fails every *queued* index job (a running one is left alone) and puts
each lesson back to *Not indexed yet*; `applyFailure` is not involved, so nothing else changes:

```sql
WITH cancelled AS (
    UPDATE studio_jobs
       SET status = 'failed', error = 'Cancelled by hand', updated_at = now()
     WHERE kind = 'index_lesson' AND status = 'pending'
 RETURNING payload->>'lessonId' AS lesson_id
)
UPDATE course_lessons SET status = 'new', error = NULL, updated_at = now()
 WHERE id::text IN (SELECT lesson_id FROM cancelled);
```

### "Scan is greyed out" / "The scan found nothing"

**Scan library** is greyed out when the tenant has no library folder. No row here means the
defaults, which have none:

```sql
SELECT c.name AS tenant, s.library->>'root' AS library_root, s.updated_at
  FROM studio_settings s
  JOIN creators c ON c.id = s.creator_id;
```

Fix it in Studio → Settings → **Library folder**. The folder must sit inside the worker's
`courseRoot`, or the worker refuses the scan.

A scan that ran and added nothing has usually **failed on the Mac, which marks nothing anywhere
else**: no lesson and no draft carries its error. Only its job row and the worker's log do:

```sql
SELECT status, left(error, 300) AS error, payload->>'root' AS root,
       result->>'lessons' AS lessons_upserted, result->'skipped' AS skipped,
       created_at, updated_at
  FROM studio_jobs
 WHERE kind = 'scan_library'
 ORDER BY created_at DESC
 LIMIT 5;
```

`payload.root is outside the course root` means the Settings folder is not inside `courseRoot`;
`payload.root not found` means it doesn't exist on that Mac. On success, `lessons_upserted` counts
the lessons the scan wrote, and `skipped` lists entries the app refused. The worker's log says how
many videos it looked at: `scan: 34 lessons among 35 videos in /Users/elamir/Desktop/AI Course` on
2026-09-24. Fewer lessons than videos is usually the naming rules (guide §4).

### "Generation failed"

The draft's error says what happened. Recent failures, and anything still writing:

```sql
SELECT id, status, left(error, 300) AS error, input->'lessonIds' AS lessons,
       input->>'angle' AS angle, input->>'slides' AS slides, created_at, updated_at
  FROM carousel_drafts
 WHERE status IN ('failed', 'generating')
 ORDER BY created_at DESC
 LIMIT 10;
```

| `error` begins | Cause | Do |
|---|---|---|
| `Writing the carousel failed: Gemini request failed [HTTP 429]` | The writer's chain (`gemini-3.1-pro-preview` → `3.7-flash` → `3.6-flash` → `3.8-flash`) has spent its daily quota; on the free tier the Pro model has none at all | The reset, or billing (guide §8) |
| `… [HTTP 404]` | The error is the last model's, so every model answered 404: gone, or closed to this key | Vercel: one `studio.ai_request_failed` per model, with `model`, `http_status` and Google's `message`. If all are gone, update `STUDIO_MODELS` (`src/services/studio/generate.ts:154`) |
| `… [HTTP 400]` | Every model refused the request, so the request is at fault | The same log lines. A code fix, as stripping `minItems`/`maxItems` was (`withoutArrayBounds`, `src/services/studio/generate.ts:232`) |
| `… [HTTP 500]` | Google's side. The writer retries a 500 once, from the first model; it does not skip to the next | Generate again |
| `… No Gemini API key: save one on the Operations screen, or set GEMINI_API_KEY.` | Neither a saved key nor the environment variable is set | As a platform admin, **Operations → Gemini API key**: paste one and **Check and save**. Or set `GEMINI_API_KEY` in Vercel and redeploy |
| `… The draft still breaks N rule(s) after M repair round(s): …` | The model could not meet the rules within the 120 s budget | Generate again. Vercel's `studio.draft_generated` has `rounds`, `problems_left` and `ms` |
| `Writing this draft never finished: the request was cut off.` (status `generating` in the table, older than 10 minutes) | The serverless invocation died mid-write; the API presents the row as failed without rewriting it | Delete it from the dashboard and generate again |

### "A draft is stuck on Rendering"

```sql
-- Rendering drafts, each with its latest render job: the only one whose result can land
SELECT d.id AS draft, d.updated_at AS draft_updated,
       j.id AS job, j.status AS job_status, j.attempts, j.progress,
       now() - j.heartbeat_at AS since_heartbeat, left(j.error, 200) AS job_error
  FROM carousel_drafts d
  LEFT JOIN LATERAL (
        SELECT * FROM studio_jobs j
         WHERE j.kind = 'render_carousel' AND j.payload->>'draftId' = d.id::text
         ORDER BY j.created_at DESC, j.id DESC
         LIMIT 1
  ) j ON TRUE
 WHERE d.status = 'rendering'
 ORDER BY d.updated_at;

-- The queue as the worker sees it: what is running, then what it takes next, in claim order
SELECT id, kind, status, attempts, progress, now() - heartbeat_at AS since_heartbeat, created_at,
       coalesce(payload->>'lesson_no', payload->>'draftId', payload->>'root') AS about
  FROM studio_jobs
 WHERE status IN ('pending', 'claimed')
 ORDER BY status = 'claimed' DESC,
          CASE kind WHEN 'render_carousel' THEN 0 WHEN 'scan_library' THEN 1 ELSE 2 END,
          created_at;
```

| `job_status` | Meaning | Do |
|---|---|---|
| `pending` | Waiting. The worker is offline, or finishing the job it has: renders go next but never interrupt one (`indexConcurrency: 1` is one job at a time) | Start the worker, or let the running job end |
| `claimed`, heartbeat fresh | Drawing. `progress` names the step: `extracting shot 1/2`, `rendering ig 3/8`, `uploading slide 9/16` | Wait. About 170 s on a 20 to 30 KB/s uplink, mostly the uploads |
| `claimed`, heartbeat over 15 minutes | Its worker died. It is handed out again at the next claim and failed after three | Queue a fresh render (below) rather than wait |
| `failed`, `Superseded by a newer render…` | A newer render replaced it | Only the latest counts; that is the one shown |

To queue a fresh render of a draft that is not failed (the dashboard only shows **Render again** on
failed drafts), save it from the editor, or run this in the dashboard's console. Pending renders of
the same draft are superseded, and a late result from the old claim is dropped when it arrives:

```js
await API.renderStudioDraft('<draft id>');
```

### "Problems to fix" on save

A refused save is `400 { error, problems[] }` from `PATCH /api/studio/drafts/:id`, and nothing is
saved. The messages come from `validateCarousel` (`src/services/studio/rules.ts:289`) and name their
slide and field: `slide 3 (point).title: 45 > 40 «…»` is 45 UTF-16 units against a limit of 40. The
editor pins each one to its field. The one that surprises people: after the keyword is changed, the
Instagram caption must carry the tenant's `cta.instagramAsk` line with the *new* keyword, or the
save fails with *instagram caption is missing the keyword ask «…»*.

### "Comments on the new post get the wrong DM" (keyword clash)

Matching is substring by default, so a live campaign on a shorter word answers inside a longer one.
At scheduling, an existing campaign that already answers the keyword means no new one is created
(`planCampaign`, `src/services/studio/schedule.ts:116`). Which active campaigns could answer a given
keyword (replace `تمام`; approximate, because the app also normalises Arabic letter forms and
tatweel before it compares):

```sql
SELECT DISTINCT c.id, c.trigger_keyword, c.match_mode, c.post_id, c.created_at
  FROM campaigns c
 CROSS JOIN LATERAL unnest(string_to_array(c.trigger_keyword, ',')) AS t(word)
 WHERE c.is_active AND trim(t.word) <> ''
   AND (trim(t.word) = 'تمام'
        OR (c.match_mode = 'substring' AND strpos('تمام', trim(t.word)) > 0));
```

What scheduling decided is in the audit log, with the draft's schedule:

```sql
SELECT created_at, actor_email, target_id AS draft,
       detail->>'campaign_id' AS campaign, detail->>'campaign_created' AS created,
       detail->>'tiktok' AS tiktok, detail->>'scheduled_time' AS scheduled_time
  FROM audit_log
 WHERE action = 'studio.schedule'
 ORDER BY created_at DESC
 LIMIT 10;
```

`created = false` with a campaign id means that older campaign answers this post's keyword, with its
own DM. Switch it to `word` matching on the Campaigns page, or give the carousel a keyword it doesn't
contain; for a post already scheduled, create the campaign for its keyword by hand.

### "The TikTok batch was refused" / "TikTok posts failed"

```sql
-- Scheduled drafts with a TikTok intent, and where their TikTok post stands
SELECT d.id AS draft, d.carousel->>'keyword' AS keyword,
       d.schedule->>'scheduled_time' AS meta_time, d.schedule->>'tiktok' AS tiktok,
       d.schedule->>'tiktok_row_id' AS tiktok_post, d.schedule->>'tiktok_public_done' AS made_public,
       p.status AS tiktok_status, left(p.error_log, 200) AS tiktok_error
  FROM carousel_drafts d
  LEFT JOIN scheduled_posts p ON p.id::text = d.schedule->>'tiktok_row_id'
 WHERE d.status = 'scheduled' AND d.schedule->>'tiktok' <> 'none'
 ORDER BY d.schedule->>'scheduled_time' DESC;

-- The TikTok connection the batch needs: active, with video.publish in its scopes
SELECT c.name AS tenant, pc.status, pc.scopes, left(pc.last_error, 200) AS last_error, pc.updated_at
  FROM platform_connections pc
  JOIN creators c ON c.id = pc.creator_id
 WHERE pc.platform = 'tiktok';
```

| Symptom | Cause | Do |
|---|---|---|
| 409 *"TikTok is not connected. Connect it in Settings first."* | No `active` TikTok connection | Connect TikTok in Settings |
| 409 *"Direct Post is not available: switch it on in Settings → TikTok app, then reconnect TikTok."* | `tiktok.direct_post_enabled` is off, or the connection's `scopes` lack `video.publish` | A platform admin switches Direct Post on in Settings → TikTok app; then reconnect TikTok so the new scope is granted |
| Fewer sent than queued | Each draft that can't go is skipped with its reason and stays queued; the rest go (`runTikTokBatch`, `src/services/studio/schedule.ts:349`) | The API's answer lists them, `skipped: [{ draftId, error }]`: the browser's network panel shows it for the `tiktok/batch` request. The audit row only counts them. Fix, and press again |
| `tiktok_error` mentions a private account (`unaudited_client_can_only_post_to_private_accounts`) | While unaudited, direct posts are `SELF_ONLY`, and TikTok takes them only from a private account | Set the TikTok account private, retry the posts from Posts, then make them public |
| `tiktok_error` mentions a verified URL prefix (`url_ownership_unverified`) | TikTok fetches photos only from a URL prefix verified in its developer portal | Verify the app's address under URL properties ([`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md)), then retry |

The batch writes each row due now, 40 s apart, so they publish on the next sweeps like any due post
(§4.1, §5.1). TikTok's side of all of this, connecting, Direct Post, the audit, is in
[`docs/TIKTOK_GUIDE.md`](docs/TIKTOK_GUIDE.md).

### The audit trail

The Studio audits its settings, its workers, and everything that creates posts or campaigns:

```sql
SELECT created_at, actor_email, action, target_type, target_id, detail
  FROM audit_log
 WHERE action LIKE 'studio.%'
 ORDER BY created_at DESC
 LIMIT 20;
```

The actions are `studio.settings_write`, `studio.worker_create`, `studio.worker_revoke`,
`studio.schedule` and `studio.tiktok_batch` (`src/services/audit.ts:131-139`). A worker's token is
never in the detail, only its name.
