# FLOWS.md — every hop, in order

The other documents answer different questions. `README.md` lists the routes, `ARCHITECTURE.md`
explains why each piece is shaped as it is, `RUNBOOK.md` walks backwards from a symptom, and
`VERIFYING.md` is one end-to-end procedure you run by hand. None of them answers *"a comment
arrives — then what happens, in what order, in which file?"*

That is what this is. Nine flows, each one a numbered list of hops with a `file:line` citation
at every step. Written for someone who has never opened this codebase.

**Line numbers drift.** Every citation names the enclosing function too, so when a number is
stale the function name still finds it. If the two disagree, the function name is right.

**Read the orderings as load-bearing.** Several steps here are in an order that looks wrong
until you know why: the 200 to Meta goes out *before* the work, `markHandled` is the *last*
write in the DM pipeline, and the interaction is marked SENT after part *one* of a multi-part
template rather than after the last. Each of those encodes a real incident. They are called out
as **Why this order** boxes, because the obvious "simplification" of each one reintroduces the
bug it was written to fix.

**Jump to:**
[1. Comment → DM](#1-comment--dm) ·
[2. DM → AI reply](#2-dm--ai-reply) ·
[3. Scheduled post → publish](#3-scheduled-post--publish) ·
[4. Login → session → tenant](#4-login--session--tenant) ·
[5. Job lifecycle](#5-job-lifecycle) ·
[6. TikTok post → inbox → published](#6-tiktok-post--inbox--published) ·
[7. Claude on the Mac → who may ask](#7-claude-on-the-mac--who-may-ask) ·
[8. Meta login → a connected Page](#8-meta-login--a-connected-page) ·
[9. A tenant's profile draft](#9-a-tenants-profile-draft-read-ask-check-wait)

---

## 1. Comment → DM

Someone comments a trigger keyword on a post. They get a DM; the comment gets a like and
optionally a public reply.

### 1.1 — `POST /webhook` receives the delivery

**`src/index.ts:174`** — `app.post('/webhook', ...)`. The single entry point for both event
types. Body parsing happens earlier, at **`src/index.ts:48`**, where `bodyParser.json`'s
`verify` hook stashes the raw bytes on `req.rawBody` — the signature is over the exact bytes
Meta sent, so a re-serialised body would never verify.

### 1.2 — HMAC verification, against two secrets

**`src/index.ts:176`** calls `verifyMetaSignature(req, req.rawBody)`, defined at
**`src/utils/signature.ts:22`**.

It rejects before hashing anything when the raw body is not a Buffer
(**`src/utils/signature.ts:27`** — a non-JSON content type never fires the `verify` hook, and
feeding `undefined` to `hmac.update()` throws a `TypeError` that Meta reads as a 500 and
answers with a redelivery storm), when the `x-hub-signature-256` header is missing or
misprefixed (**:30**), and when the hex decodes to the wrong length (**:35** — otherwise
`timingSafeEqual` throws rather than returning false).

The actual check is at **`src/utils/signature.ts:37`**: `appSecrets().some(...)`, comparing
with `crypto.timingSafeEqual`. `appSecrets()` (**`src/utils/signature.ts:44`**) returns
`[META_APP_SECRET, INSTAGRAM_APP_SECRET]` with the unset ones filtered out. A payload is
genuine if it matches **either**.

> Two secrets because this deployment has historically received events from two different Meta
> apps — the Facebook app (`object: "page"`) and "Instagram API with Instagram Login"
> (`object: "instagram"`), which is a separate app with its own ID and secret. As of the
> 2026-09-21 audit both object types live under one app and everything signs with
> `META_APP_SECRET`, making `INSTAGRAM_APP_SECRET` vestigial. The dual check stays because it
> costs nothing and the setup has changed before — but do not start a "comments never arrive"
> investigation by suspecting it.

On failure: **`src/index.ts:185`** logs `webhook.signature_rejected` with `secrets_tried`, then
403. That log line exists because the 403 happens before anything touches the database, so
"signature rejected" and "nobody messaged us" are otherwise byte-identical. The `probe` field
distinguishes `scripts/diagnose.mjs --probe-signature` proving the guard still holds from a
real rejection; it is a label only (**`src/utils/probe.ts`**) and grants nothing.

### 1.3 — Body shape and `object` dispatch

**`src/index.ts:202`** — a missing or non-object body is a flat **400**, not a thrown
`TypeError`. Same redelivery-storm reasoning as above.

**`src/index.ts:208`** — `body.object === 'instagram' || body.object === 'page'`. Anything else
logs `webhook.unrecognised_object` and returns **200** (**:209-213**) — acknowledging an event
this app does not handle is correct; making Meta retry it forever is not.

### 1.4 — Enqueue, then acknowledge

**`src/index.ts:234`** — `await enqueueWebhookBody(body, requestId)`, where `requestId`
(**`src/index.ts:229`**, `currentRequestId()`) is the same correlation id the logging
middleware at **`src/index.ts:59`** put on every line for this request. It is carried across the
queue boundary so the work and its acknowledgement share an id.

`enqueueWebhookBody` (**`src/webhook/router.ts:126`**) calls `planJobs`
(**`src/webhook/router.ts:74`**), which flattens the body into `EnqueueInput[]` **without
touching the database**. For comments that is **`src/webhook/router.ts:98-107`**: one
`comment.process` job per element of `entry.changes`, carrying the change verbatim.

Two fields per job matter:

- **`dedupeKey`** — `commentDedupeKey(change)` at **`src/webhook/router.ts:35`**, which is
  `comment:<id>`. Instagram puts the id at `value.id`, Facebook at `value.comment_id`. Best
  effort by design: an event whose id cannot be found is **still enqueued**, just unprotected,
  because `interactions.comment_id UNIQUE` catches the redelivery one layer down and losing the
  event would be far worse than doing it twice.
- **`tenantKey`** — `entry.id` (**`src/webhook/router.ts:84`**), the Meta page id. This is the
  fair-queueing partition. It is `entry.id` and not the tenant's own uuid precisely because
  resolving the uuid needs a database read, and the whole point of enqueueing is to acknowledge
  Meta *before* doing any. Every job the webhook writes therefore has `jobs.creator_id` NULL.

Each planned job goes through `queue.enqueue` (**`src/jobs/queue.ts:39`**), whose
`ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
(**`src/jobs/queue.ts:47`**) makes a Meta redelivery a no-op *before* it costs anything. A
dropped enqueue returns `null` and is logged at `debug` (**`src/jobs/queue.ts:65`**) — on a
busy account it is the most frequent thing that happens.

**`src/index.ts:413`** — `void acknowledgeThenRun(res, …)`, which sends the 200 first
(**`src/webhook/ack.ts:32`**) and only then starts the work (§1.5).

> **Why this order — the 200 goes out before the work.**
> Meta's webhook timeout is ~20 seconds and this pipeline contains a 2-8s Gemini round trip plus
> however many Meta sends follow. It used to answer 200 and *then* keep working in the same
> invocation — which on Vercel can be frozen at any point after the response, losing the work
> permanently while having already told Meta it succeeded. Writing to `jobs` first changes the
> worst case from "silently lost" to "still pending". The reasoning is written out at
> **`src/index.ts:215-225`**.

If the enqueue throws, **`src/index.ts:246`** logs `webhook.enqueue_failed_falling_back` and
falls through to the legacy inline path (`processWebhookBody`,
**`src/webhook/router.ts:191`**) rather than dropping the delivery. A *partial* enqueue means
some events run twice; that is deliberately tolerated, because both `interactions.comment_id`
and `messages.meta_message_id` are UNIQUE, so the second pass claims nothing.

### 1.5 — `drainInline()` picks the job back up

**`src/index.ts:413-416`** — the work `acknowledgeThenRun` starts after the 200 is `drainInline()`,
defined at **`src/jobs/drain.ts:38`**. It reaps
stale claims first (**`src/jobs/drain.ts:54`**), then calls `drainJobs`
(**`src/jobs/runner.ts:129`**) with a deliberately short budget: 8 s default
(**`src/jobs/drain.ts:21-24`**, `JOB_INLINE_BUDGET_MS`), `batchSize: 3`, `maxJobs: 10`
(**`src/jobs/drain.ts:64-68`**). This is opportunistic work — the response is already sent, so
anything it does not finish stays `pending` and costs nothing. Full mechanics in
[flow 5](#5-job-lifecycle).

The claim itself is **`src/jobs/queue.ts:77`**, `PostgresJobQueue.claim`. The handler lookup and
dispatch is **`src/jobs/runner.ts:89`**.

> **The drain runs under `waitUntil`, and nothing awaits it after the 200.**
> `acknowledgeThenRun` (**`src/webhook/ack.ts:31`**) starts the work as one promise that never
> rejects (a throw is logged as `webhook.pipeline_error`) and hands it to `waitUntil` from
> `@vercel/functions` (**`src/webhook/ack.ts:45`**, through the seam in
> **`src/utils/waitUntil.ts:60`**), so Vercel keeps the invocation alive until the drain settles.
> Before, the route sent the 200 and then awaited the drain, and an invocation can be frozen as
> soon as the response is out: an inline-claimed job stayed `running` until the instance thawed
> (the next request, the Heroku worker's 60 s poll: about 70 s) or until `reapStale` (300 s)
> returned it to `pending`. Measured over 7 days that was `dm.process` p50 125 s and p90 362 s.
> `waitUntil` does nothing without a Vercel request context (dev, tests), so the work is started
> before it is handed over; on Vercel without one the seam logs `runtime.wait_until_unavailable`
> once per instance.

### 1.6 — The handler adapter

**`src/jobs/handlers.ts:28`** — the `comment.process` entry unpacks the stored payload and calls
`handleCommentChange(payload.change, payload.entryId, { lastAttempt: isLastAttempt(job) })`.

`isLastAttempt` (**`src/jobs/handlers.ts:23`**) is `job.attempts >= job.max_attempts`. `attempts`
was already incremented by the claim, so on the third attempt of a `max_attempts = 3` job this
is `true`. It decides whether the pipeline may leave a failure retryable — getting it wrong
optimistically strands an interaction at PENDING forever, which in the dashboard looks exactly
like the webhook having stopped.

The legacy inline path passes `FINAL_ATTEMPT` (**`src/webhook/router.ts:164`**,
**`:178`**) — correctly, because that path has no retry to leave work for.
`WebhookHandlerOptions.lastAttempt` defaults to `true` everywhere it is omitted
(**`src/webhook/options.ts:14-26`**), so a caller that forgets gets the safe behaviour.

### 1.7 — `handleCommentChange` → `normalizeComment`

**`src/webhook/comments.ts:99`** — `handleCommentChange`. First call is `normalizeComment`
(**`src/webhook/comments.ts:68`**), then everything runs inside a `withLogContext` carrying
`comment_id` and `platform` (**`src/webhook/comments.ts:109-115`**) so one comment's whole
journey pulls out of interleaved logs with a single filter.

**The Instagram / Facebook divergence.** The two payloads name nothing the same way:

| | Instagram (`field: 'comments'`) | Facebook Page (`field: 'feed'`, `item: 'comment'`, `verb: 'add'`) |
|---|---|---|
| detected at | **`comments.ts:69`** | **`comments.ts:82`** |
| comment id | `value.id` | `value.comment_id` |
| post id | `value.media.id` | `value.post_id` |
| text | `value.text` | `value.message` |
| sender name | `value.from.username` | `value.from.name` |
| sender id | `value.from.id` | `value.from.id` |
| `isFacebookComment` | `false` | `true` |

Facebook also requires `verb === 'add'` — an edit or a delete arrives on the same `feed` field
and must not trigger a campaign. Anything else logs `comment.unhandled_field` and returns null
(**`src/webhook/comments.ts:95-96`**), which ends the flow.

`text` is lowercased here (**`:75`**, **`:88`**); Arabic normalisation happens later, in the
matcher.

### 1.8 — The self-authored loop guard

Two independent checks, because one of them is not reliable.

1. **`src/webhook/comments.ts:195`** — `selfAuthoredCommentIds.has(commentId)`. An in-process
   `Set` (**`src/webhook/comments.ts:54`**), capped at 500 entries with FIFO eviction
   (**`:57-65`**), written at **`src/webhook/comments.ts:402`** with the id of every public
   reply this instance posts.
2. **`src/webhook/comments.ts:210-211`** — `senderId === pageOwnerId`, where `pageOwnerId` is
   `creator.facebook_page_id` or `creator.instagram_page_id` depending on platform.

Check 2 is the principled one and check 1 exists because it is not always true: on
Instagram-Login comment webhooks `from.id` is an app-scoped IGSID that may not equal the stored
business account id. If it does not, the app's *own* public reply comes back as a webhook with a
**new** comment id — which the `interactions` UNIQUE constraint cannot suppress, because it is
genuinely a different comment — and the app can answer itself indefinitely.

Check 1 is explicitly best-effort: it is per-instance memory, so a cold start between the reply
and the echo loses it. The docstring at **`src/webhook/comments.ts:39-53`** records the
outstanding TODO (verify the IGSID assumption against production logs) and names the real fix (a
`self_authored` marker column on `interactions`).

### 1.9 — Tenant resolution

**`src/webhook/comments.ts:201`** — `getCreatorByPageId(entryId)`, at
**`src/services/tenant.ts:112`**. One query, filtering `is_active = true` and matching
`entry.id` against `instagram_page_id` **or** `facebook_page_id`
(**`src/services/tenant.ts:121-127`**). No match logs `comment.no_creator` and returns
(**`:204-207`**) — not necessarily a bug (a webhook for a page this deployment does not serve),
but also exactly what a mis-set page id looks like, hence `warn`.

The page access token is decrypted here (**`src/services/tenant.ts:131`**,
`withDecryptedToken`) rather than at the call sites, so no path can forget and send
`enc:v1:...` to Meta as a bearer token.

**A tenant with no Meta connection is never resolved here (v34).** `instagram_page_id` and
`page_access_token` are nullable: a tenant created by name has neither until it connects. The query
adds `page_access_token IS NOT NULL`, so such a tenant is simply not a match (the webhook logs
`comment.no_creator`, as for any page this deployment does not serve), and the type it returns
(`ConnectedCreator`) says its token is there. The database keeps the ids and the token together
(`creators_meta_ids_need_token`), so the clause is a second guard, not the only one. Everything else
that reads those columns treats NULL the same way: skipped, or "not connected", never an error and
never a `null` sent to Meta. (`attemptPublish` is §3.4; the Growth cron's tenant list, `recheckTenantToken`,
`GET /settings/token/status`, `/settings/token/extend` and the manual inbox reply each have the check.) How a tenant
acquires a token with clicks instead of a pasted one is [§8](#8-meta-login--a-connected-page).

### 1.10 — Campaign query and `matchCampaign`

**`src/webhook/comments.ts:220-229`** — every active campaign for this creator:

```sql
ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC
```

The `ORDER BY` is not cosmetic. Without it Postgres returns heap order, so a global campaign
could shadow a post-specific one on the same keyword — and which one won could change after a
`VACUUM`. Most specific first, then longest keyword, then newest.

**`src/webhook/comments.ts:231`** — `matchCampaign(text, postId, campaigns)`, at
**`src/services/matching.ts:59`**. It re-sorts defensively with `bySpecificity`
(**`src/services/matching.ts:45`**, applied at **:68** on a copy) so a caller handing it an
arbitrarily ordered array — a unit test, a cached list — gets the same winner the database path
does.

Per candidate:

- `trigger_keyword` is a **comma-separated list**; any one matching is enough
  (**`src/services/matching.ts:75-78`**).
- Both sides go through `normalizeArabic` (**`src/utils/arabic.ts:5`**): tatweel/kashida stripped
  (**:11** — `تـــم` and `تم` are the same word, and stretched text is everywhere in social
  captions), Alef hamzas collapsed (**:13**), Teh Marbuta → Heh (**:15**), Yeh/Alef Maksura
  unified (**:17**), diacritics removed (**:21**), whitespace collapsed (**:23**).
- The test is `keywordMatches(text, keyword, mode)` at **`src/utils/arabic.ts:70`**.
  `mode` comes from the campaign's own `match_mode` column via `normalizeMatchMode`
  (**`src/utils/arabic.ts:47`**), which coerces anything unrecognised — including a column the
  query forgot to select — to `'substring'`.
  - `'substring'` (**`src/utils/arabic.ts:79`**) is the default and is dangerous for short
    keywords: `تم` is a substring of اهتمام, تمام and يتم.
  - `'word'` (**`src/utils/arabic.ts:81-86`**) anchors to token boundaries using explicit
    Unicode lookarounds, because JavaScript's `\b` is defined over `[A-Za-z0-9_]` and therefore
    fires in all the wrong places in Arabic.
  - An empty keyword returns false (**`src/utils/arabic.ts:77`**) — otherwise a trailing comma
    in a keyword list makes the campaign fire on every comment that arrives.
- `post_id` filter: `!c.post_id || c.post_id === postId` (**`src/services/matching.ts:88`**).

No match logs `comment.no_campaign_match` with the candidate count
(**`src/webhook/comments.ts:237-241`**) and returns. **A comment that matches no campaign
writes no row at all**, so that log line is the only evidence the comment was ever seen — and
silence in the activity log is therefore not proof of a delivery failure.

### 1.11 — `claimInteraction`

**`src/webhook/comments.ts:249`** calls `claimInteraction` (**`src/webhook/comments.ts:154`**).

```sql
INSERT INTO interactions (...) VALUES (..., 'PENDING', ...)
ON CONFLICT (comment_id) DO NOTHING
RETURNING id
```
(**`src/webhook/comments.ts:166-170`**)

A row back means a fresh claim. No row back means the UNIQUE index fired, and the function
re-reads the existing row (**`src/webhook/comments.ts:174-177`**):

- row gone → return null (deleted between statements; re-inserting would fight whatever deleted
  it) — **`:180`**
- `status !== 'PENDING'` → return null, "already finished" — **`:181`**
- `status === 'PENDING'` → **resume it** — **`:183`**

> **Why the status check exists.** `interactions.comment_id UNIQUE` was doing two jobs at once:
> suppressing a Meta redelivery, and — unintentionally — suppressing a *retry*. The row is
> written PENDING before anything is sent, so once a send failed, every later attempt inserted
> nothing, logged `comment.duplicate_ignored` and returned **successfully**. The job was marked
> done and the customer was never messaged. The distinction the index cannot make is between
> "finished with this comment" and "started and did not finish" — and `status` already records
> exactly that, because SENT is written before `recordDmSent` and every failure path writes
> FAILED or USER_BLOCKED_DMS. Full reasoning at **`src/webhook/comments.ts:139-153`**.

`creator_id` is written directly rather than derived through `campaigns` (**`:166`** and the
comment above it) — the dashboard filters on it, and a NULL is indistinguishable from the
webhook having stopped.

A resumed claim logs `comment.resumed` (**`src/webhook/comments.ts:260`**), which is the only
thing separating a retry from a first delivery in the logs.

### 1.12 — Per-recipient 24h cap

**`src/webhook/comments.ts:264`** — `canDmRecipient(creator.id, senderId)`, at
**`src/utils/rateLimiter.ts:159`**: one row in `dm_send_log` for this creator+recipient inside
24 hours means no.

Refusal writes `status = 'FAILED'` with an explanatory `error_log`
(**`src/webhook/comments.ts:266-269`**) and returns. Recorded as FAILED rather than skipped
because the dashboard's vocabulary is `status`, and a row with no terminal status is an
interaction that looks stuck.

The docstring (**`src/utils/rateLimiter.ts:151-158`**) is honest that this is defensive rather
than confirmed: several 2026 write-ups describe it as a hard Meta rule for comment/story
triggers, but it could not be confirmed in Meta's primary documentation. It costs nothing, and
it stops the app repeatedly DMing someone who comments the same keyword five times.

### 1.13 — `checkFairSendQuota` — two ceilings

**`src/webhook/comments.ts:277`** — `checkFairSendQuota(creator.id, 'dm')`, at
**`src/utils/rateLimiter.ts:123`**. Two counters, both **incremented before being checked**:

1. **Per creator** — `checkSendQuota` (**`src/utils/rateLimiter.ts:69`**), an upsert on
   `rate_limit_counters` keyed `(creator_id, bucket, date_trunc('hour', NOW()))`, default limit
   `DEFAULT_HOURLY_LIMIT = 180` (**`src/utils/rateLimiter.ts:27`**), a buffer under Meta's ~200/hr
   automation ceiling.
2. **App-wide** — `checkAppSendQuota` (**`src/utils/rateLimiter.ts:94`**), a separate
   `app_rate_limit_counters` table, default 1000 (**`src/utils/rateLimiter.ts:43`**), overridable
   with `META_APP_HOURLY_LIMIT`. A separate table rather than a sentinel row because
   `rate_limit_counters`'s primary key includes a NOT NULL `creator_id` with a foreign key, so an
   app-wide row would have to be a fake creator.

Increment-then-check (**`src/utils/rateLimiter.ts:64-68`**) is what makes it race-free: two
concurrent invocations both reading "179" and both sending is exactly the failure it prevents.
Both counters increment unconditionally (**`src/utils/rateLimiter.ts:133-134`**), so a refusal
by the creator bucket still consumes one unit of the app pool — deliberately conservative.

Meta's app-level limit is pooled across the whole app and does **not** scale with tenant count,
so one tenant's viral reel can 429 every other tenant. `blockedBy` (**:136-137**) is what lets
the refusal say so: **`src/webhook/comments.ts:289-291`** writes a different `error_log` for
`'app'` than for `'creator'`, because otherwise the victim debugs their own account. The log
line is `error` level (**`src/webhook/comments.ts:280`**) — it means real customers are being
dropped.

### 1.14 — `splitDmTemplate`

**`src/webhook/comments.ts:300`** — `{username}` is substituted into `dm_template`.

**`src/webhook/comments.ts:302`** — `splitDmTemplate(dmText)`, at
**`src/webhook/comments.ts:131`**: split on the literal `[SPLIT]`, trim each part, **drop empty
ones** (`.filter(Boolean)`). A template ending in `[SPLIT]`, or with two in a row, otherwise
produced an empty send that Meta rejects with "param message must be a non-empty object". An
all-whitespace template falls back to the original text (**`:136`**) so the failure stays a
Meta error naming the empty message rather than becoming a silent no-op that looks like success.

### 1.15 — `sendPrivateReply` — the one retryable step

**`src/webhook/comments.ts:309`** — `sendPrivateReply(commentId, firstPart, token, fbPageId)`,
at **`src/services/instagram.ts:147`**. `POST /{page-id|me}/messages` with
`recipient: { comment_id }` and `messaging_type: 'RESPONSE'`
(**`src/services/instagram.ts:159-165`**). Facebook requires `/{page-id}/messages`; Instagram
works with `/me` — hence `fbPageId` being threaded through from
**`src/webhook/comments.ts:299`**. Wrapped in `withRetry`
(**`src/services/http.ts:107`**), which fires only on 5xx / 429 / transport faults.

**Meta allows exactly one private reply per comment, ever** (and only within 7 days —
**`src/services/instagram.ts:144`**). That constraint shapes everything below.

On failure (**`src/webhook/comments.ts:310-341`**):

1. Log `dm.send_failed` (**:311**).
2. `noteMetaFailure(creator.id, dmError)` (**:315**) — a dead token stops the whole account
   rather than one send, and nothing used to notice it at a call site.
3. `classifyDmError(dmError)` (**:317**), at **`src/webhook/errors.ts:18`**:
   - Meta code `10903` → `status: 'USER_BLOCKED_DMS'`, `permanent: true`
     (**`src/webhook/errors.ts:28-34`**)
   - code `190` (dead token) or `200` (missing scope) → permanent
     (**`src/webhook/errors.ts:40`**, plus `isPermanentMetaError` at
     **`src/services/http.ts:81`**, whose `PERMANENT_CODES` is `{190, 200, 10903}` at
     **`src/services/http.ts:25`**)
   - everything else → `FAILED`, `permanent: false`

   The code is read structurally via `metaErrorCode` (**`src/services/http.ts:53`**) with a
   string match kept only as a backstop — `src/services/instagram.ts` used to interpolate the
   code into the message and discard `response.data.error`, so `permanent` came back false for
   every error including a dead token.

**The retry-vs-permanent split** — **`src/webhook/comments.ts:328`**:

```
if (!classified.permanent && !options.lastAttempt) { … status = 'PENDING' … throw dmError; }
```

- **Transient, attempts remaining** → write `status = 'PENDING'` with a "Retrying after a
  transient failure" note (**:329-332**) and **re-throw** (**:333**). Throwing is the handler
  contract for "retry me" (**`src/jobs/types.ts:98-106`**); the runner backs off and comes back,
  and `claimInteraction` then *resumes* this same row.
- **Permanent, or the last attempt** → write `classified.status` and `classified.error` as final
  (**:336-339**) and return. A permanent failure will not become true on the fourth try, and
  retrying a dead token is how an app attracts Meta's enforcement attention. On the last attempt
  there is nothing to come back for, so it is written down like any other failure.

### 1.16 — Status settled, immediately

**`src/webhook/comments.ts:349`** — `UPDATE interactions SET status = 'SENT'`.
**`src/webhook/comments.ts:350`** — `recordDmSent(creator.id, senderId)`, which writes the
`dm_send_log` row the 24h cap reads.

> **Why this order — SENT before the follow-ups, not after.**
> This used to sit after the whole `[SPLIT]` loop. Because exactly one private reply is allowed
> per comment, that made part 3 of a 3-part template able to mark the interaction FAILED even
> though the person had already received parts 1 and 2 — and worse, a retry of that row then
> re-sent the private reply, which Meta refuses outright. So the retry could only ever fail,
> three times, before recording a failure for a DM that was largely delivered. The conversation
> is open and cannot be opened again, so the status is settled here, before anything else has a
> chance to fail. Written out at **`src/webhook/comments.ts:343-348`**.

### 1.17 — `[SPLIT]` follow-ups — best effort

**`src/webhook/comments.ts:355-375`**. Each follow-up waits 500 ms to preserve ordering
(**:357**) then goes out via `sendDirectMessage` (**:358**,
**`src/services/instagram.ts:213`**) — a normal DM to `senderId`, not another private reply,
because the thread is already open.

A failure logs `dm.split_part_failed` (**:360**), calls `noteMetaFailure` (**:363**), appends to
`error_log` naming which part failed and stating the first message *was* delivered
(**:364-370**), and **breaks** (**:373**) rather than pressing on — delivering part 3 without
part 2 reads worse to the recipient than stopping short. `status` stays SENT throughout.

### 1.18 — Auto-like

**`src/webhook/comments.ts:379`** — `likeComment(commentId, token)`, at
**`src/services/instagram.ts:252`** (`POST /{comment-id}/likes`, same edge on both platforms).
Purely best-effort algorithmic boost: a failure is a `warn` (**:382**) and nothing else.

### 1.18b — The DM can't be delivered: a public reply instead

**`src/webhook/comments.ts:368`**. On the final-failure path only: when `shouldPostDmFallback(dmError)` (not a dead token,
not 10900), it posts `dmFallbackReply({ dmText, isFacebook, register })` (**`src/webhook/errors.ts:54`**): the first URL in the
DM on Facebook, "link in bio" on Instagram. The language is the DM's own (Arabic script or not); the Arabic register is the
tenant's comment surface, read by `fallbackRegister` (**`comments.ts:201`**, via `profileContextOrLegacy`) **before** the row is
written FAILED, and the lines are `KITS[register].commentFallback` (**`src/services/profile/kits.ts:149`**,
`commentFallback` at **`:301`**). A profile that can't be read is the owner's Gulf line for the owner; for any other tenant the
job is retried with the row still PENDING (a FAILED row would make the retry a duplicate), and on the last attempt the reply goes
out in the neutral wording with a `comment.fallback_register_unreadable` line. DM code 100 is permanent
(**`src/webhook/errors.ts`**, `classifyDmError`), so this doesn't wait for the ~10-minute backoff. The campaign's own
public reply (1.19) is skipped, since it says to check the DMs.

### 1.19 — Public reply

**`src/webhook/comments.ts:386`**, only when `public_reply_template` is set.

- The template is a `|`-separated list of variations; one is picked at random
  (**`src/webhook/comments.ts:389-390`**) so a post's comment thread does not fill with the
  same sentence.
- `{username}` substituted (**:391**).
- `sendPublicReply` (**:394**, **`src/services/instagram.ts:183`**) — Instagram posts to
  `/{comment-id}/replies`, Facebook to `/{comment-id}/comments`
  (**`src/services/instagram.ts:189`**).
- **`src/webhook/comments.ts:402`** — `rememberSelfAuthored(posted?.id)`, closing the loop from
  [1.8](#18--the-self-authored-loop-guard).

Failure keeps SENT (**:405-406**) and appends to `error_log`. A Meta code 200 gets rewritten
into an actionable message naming `pages_manage_engagement` (**:410-412**), because the raw
error says nothing about which permission is missing.

---

## 2. DM → AI reply

Someone sends a direct message. Gemini answers it.

### 2.1 — `planJobs`' messaging branch, and what never becomes a job

Hops 1.1 to 1.5 are identical — same route, same signature check, same enqueue-before-ack. The
divergence is at **`src/webhook/router.ts:86-96`**, the `entry.messaging` branch.

**`src/webhook/router.ts:88`** — `if (!isActionableMessagingEvent(event)) continue;`. That
function (**`src/webhook/router.ts:64`**) drops:

- **echoes** — `event.message.is_echo` (**:67**), the page's own outbound messages coming back.
  On an active account they are a large share of all messaging events.
- **everything with neither `message` nor `postback`** (**:68-70**) — read watermarks, delivery
  receipts, reactions, referrals, handover-protocol events.

> **Why filter at plan time rather than in the handler.** None of those could ever reach a reply
> — `normalizeDm` rejects every one of them — but they were each becoming a `jobs` row first,
> and because they carry no `mid` they got no dedupe key either. So a redelivered batch of read
> receipts wrote a fresh row per receipt per delivery: rows that get claimed, run, log
> `dm.skipped_empty` and get marked done, forever. Filtering here keeps the queue a record of
> *work*, which is what makes "how much is pending" a number worth reading.
> (**`src/webhook/router.ts:46-62`**.)

The filter deliberately errs towards enqueueing: anything with a `message` or a `postback` goes
through even if nothing answerable is visible, because the handler is the thing that knows and
dropping a real customer message is far worse than one wasted job.

Dedupe key is `dm:<mid>` from `message.mid` or `postback.mid`
(**`src/webhook/router.ts:41-44`**); `tenantKey` is `entry.id` as before.

The handler adapter is **`src/jobs/handlers.ts:33`** → `handleMessagingEvent`.

### 2.2 — `handleMessagingEvent` and `normalizeDm`'s four shapes

**`src/webhook/messaging.ts:122`**. A second echo check at **:130** (the inline fallback path
does not go through `isActionableMessagingEvent`), then `normalizeDm`
(**`src/webhook/messaging.ts:49`**).

| Shape | Source | Lines |
|---|---|---|
| plain text message | `event.message.text` | **`messaging.ts:52`** |
| quick reply | `event.message.quick_reply.payload` (text still from `message.text`) | **`messaging.ts:55-58`** |
| postback | `event.postback.title` → text, `event.postback.payload` → payload | **`messaging.ts:60-64`** |
| story mention | an attachment with `type === 'story_mention'` | **`messaging.ts:66-73`** |

Rejection is at **`src/webhook/messaging.ts:75`**: no `senderId`, or no text *and* no payload
*and* not a story mention. `dm.skipped_empty` deliberately logs `has_message` and the attachment
type list (**:80-86**), because this branch catches two very different things: a read receipt
(fine) and **a real message whose only content is an attachment this pipeline cannot describe to
Gemini** — an image, a voice note, a shared reel. The second is a person waiting for an answer.

`metaMessageId` is `message.mid ?? postback.mid ?? null` (**`src/webhook/messaging.ts:95`**).

Everything downstream runs inside a `withLogContext` keyed on `mid` and `sender_id`
(**`src/webhook/messaging.ts:140`**), so one inbound message and all its retries share a filter.

### 2.3 — `mayRetry`

**`src/webhook/messaging.ts:251`** — `Boolean(dm.metaMessageId) && !options.lastAttempt`.

The `mid` is load-bearing, not decoration: it is the only thing letting a second attempt
recognise the row the first one wrote. Without it the partial unique index never fires, so a
retry would insert a **second** inbound row and answer the same person twice. An event with no
`mid` therefore gets exactly one attempt, whatever the job budget says.

### 2.4 — Tenant, then conversation upsert

**`src/webhook/messaging.ts:255`** — `getCreatorByPageId(recipientId, entryId)`. Two ids, in
that order: `recipient.id` on a message event is the Instagram Business Account id (most
reliable); `entry.id` could be the IG id or the FB Page id depending on subscription type.

**`src/webhook/messaging.ts:265-272`** — the conversation, as **one** statement:

```sql
INSERT INTO conversations (creator_id, instagram_user_id, status, platform) VALUES ($1, $2, 'active', $3)
ON CONFLICT (creator_id, instagram_user_id)
DO UPDATE SET last_message_at = NOW(), platform = COALESCE(conversations.platform, EXCLUDED.platform)
RETURNING id, is_bot_active, ai_disclosed_at
```

`platform` (v26) comes from the webhook body's `object` (`instagram` or `page`), carried in the DM
job; a job queued before v26 falls back to which page id the message was addressed to
(`dmPlatform`). `COALESCE` keeps a thread's first known platform. Every row in `messages` also
records its `sender` (`customer`, `ai`, `operator`); the manual reply route sends a Facebook
thread through `/{page-id}/messages`, as the AI reply does.

Not SELECT-then-INSERT: two DMs a second apart raced on the `unique_creator_user` constraint and
the loser's duplicate-key error killed the whole batch. The `DO UPDATE` also replaces what used
to be a separate `last_message_at` write.

An empty result is impossible if the statement does what this code assumes, so it is logged as an
`error` and returns (**:274-280**) rather than throwing a `TypeError` three lines later from a
place that says nothing about the cause.

### 2.5 — `claimInbound` and the 300-second re-claim window

**`src/webhook/messaging.ts:284`** → `claimInbound` (**`src/webhook/messaging.ts:168`**).

**Insert** (**:174-189**) with
`ON CONFLICT (meta_message_id) WHERE meta_message_id IS NOT NULL DO NOTHING` (**:178**),
setting `reply_claimed_at = NOW()` and `reply_attempts = 1`. A row back is a fresh claim. The
index is **partial**, so an event with no `mid` can never conflict and always inserts.

**No row back** → the re-claim `UPDATE` (**:194-203**):

```sql
UPDATE messages SET reply_claimed_at = NOW(), reply_attempts = reply_attempts + 1
 WHERE meta_message_id = $1
   AND handled_at IS NULL
   AND (reply_claimed_at IS NULL OR reply_claimed_at < NOW() - make_interval(secs => 300))
```

`REPLY_CLAIM_VISIBILITY_SECONDS = 300` (**`src/webhook/messaging.ts:34`**). No row means either
*already handled* (the redelivery case the index exists for) or *another attempt holds a live
claim right now* — both mean "not ours to answer", so it returns null and the caller logs
`dm.duplicate_ignored` (**:286**).

> **Why `handled_at` had to be added.** `messages.meta_message_id UNIQUE` was carrying two
> meanings at once. It correctly stopped a Meta redelivery from re-running a paid Gemini call
> and re-DMing a real person — and it also, unintentionally, stopped every *retry* from doing
> anything, because the row is written *before* the AI call. A transient Gemini 503 meant:
> inbound row saved, no reply sent, job marked done, and every subsequent attempt logging
> `dm.duplicate_ignored` and returning successfully. The customer was never answered and nothing
> anywhere said so. v14 split the meanings: the index still dedupes, `handled_at` records whether
> the pipeline reached a conclusion, and `reply_claimed_at` is a visibility timeout so resuming
> cannot become two runs answering the same person at once.
> (**`src/webhook/messaging.ts:152-167`**.)

The window is deliberately generous, and matches `CLAIM_VISIBILITY_SECONDS` in
`src/jobs/runner.ts` for the same reason: taking a claim from a run that is still working is how
the same person gets answered twice, which is worse than being answered a few minutes late
(**`src/webhook/messaging.ts:26-33`**). It is only *reached* when an invocation dies mid-flight,
because a transient failure releases its own claim explicitly (see
[2.10](#210--failure-release-vs-record)).

**Alongside the claim: the sender's profile (v40).** Once the inbound row is claimed, an *Instagram*
thread starts `refreshSenderProfile` (`src/services/senderProfile.ts`), **not awaited yet**: it runs
while the reply is being written and `processDm` awaits it in a `finally`, after the DM's outcome is
decided. It is `GET /{IGSID}?fields=name,username,profile_pic,follower_count,is_user_follow_business,
is_business_follow_user,is_verified_user` on `graph.facebook.com` with the Page token
([the Instagram User Profile API](https://developers.facebook.com/docs/messenger-platform/instagram/features/user-profile)),
and its answer is written to `conversations` (`username`, `profile_name`, `profile_pic_url`, …) so
the inbox can say who is writing. **It can never change what happens to the DM**: it resolves
whatever happened (`dm.profile_failed` at `warn` for a refusal or a database without v40) and
nothing it does is read by the reply, the claim or the retry rules. It is throttled by one
`UPDATE … RETURNING` that claims the attempt (`profile_checked_at`): first contact, then once a day,
or once an hour while no lookup has ever succeeded. The inbox asks for the same thing on opening a
thread (`POST /api/conversations/:id/refresh-profile`), through the same claim.

### 2.6 — The bot-paused check

**`src/webhook/messaging.ts:294`** — `if (!conversation.is_bot_active)`. Logs `dm.bot_paused`,
calls **`markHandled`** (**:298**) and returns.

`markHandled`, not release: this is terminal. The operator took the thread over deliberately from
the inbox (`PUT /api/conversations/:id/toggle-bot`), and a retry must not decide later that the
bot should have answered after all.

### 2.6b — The sales switch (v39, DM plan S6)

Right after the pause check, `readSalesSettings` (**`src/services/dmSales/mode.ts`**) reads `ai_agents.sales_mode` and `sales_test_senders` in a
statement of its own, and `answersWithSales` decides who gets the sales turn: `off` nobody (the default, the owner's, and what a row from before
v39 or a failed read means: `dm.sales_mode_read_failed`), `test` only a sender whose id is on the list (exact string match), `on` everybody.
**`off` is everything below, exactly as it was.** `messaging.test.ts` ("the sales mode switch") writes out the calls of the old pipeline, in order,
and checks both `off` and `test` for an unlisted sender against it: the one statement the switch added is the read of the mode.

For a sender it does answer, `runSalesTurn` (**`src/services/dmSales/turn.ts`**) owns the reply and `processDm` keeps the claim (handled once the
turn concluded; released and re-raised when the send quota stopped it; the catch still decides what a thrown Meta error means). In order:

1. **State and burst.** `loadSalesState` reads the conversation's stage, counts and links and stamps `last_inbound_at` in one statement. A message
   with a later unhandled inbound in the thread, or any reply after it, stands down (`dm.sales_superseded`): one reply per burst, and a job
   resumed after a crash between the send and the bookkeeping does not answer twice.
2. **Agent and loop.** The owner's switch is honoured as ever (off or unconfigured says nothing). Fifteen bot replies to one conversation in an
   hour pause it and send nothing (`dm.sales_reply_cap`).
3. **Prefilter, before any model** (`prefilter.ts`): a refund or complaint is the hand-off line (the profile's `dm.handoff.message`, else the
   kit's) with the bot paused; "stop" is one opt-out line, `opted_out_at`, the bot paused; the first insult one calm line, the second pauses the
   bot and says nothing. No `mark_seen`, no model.
4. **Model.** `mark_seen` and `typing_on` go out while the model thinks (best effort: a failure is `dm.sender_action_failed` and nothing more).
   The layer is asked for purpose `dm` with the static prompt as the cached system text and the conversation's facts in front of the last user
   turn. The thread it reads is `salesTurns` (**`history.ts`**): a carousel or buttons the bot sent are shown as `[sent cards: …]` and
   `[buttons: …]` instead of the stored `[Structured Template]`, and a customer's button tap carries its code, `(tapped: OTHER_COURSES)`. The old
   path's history is untouched. A failure of any kind is the legacy Gemini path once when `gemini_fallback` is on, else a hand-off
   (`dm.engine_failed`): never silence.
5. **The code decides.** `coerceSalesReply` makes the answer true to its shape, `decideTurn` (**`flow.ts`**) applies the flow's rules (a link is
   only the `link` stage if one was sent; no way back from `link`; `handoff` and `closed` only by action; two qualifying questions, then
   recommend; nothing sold to a closed conversation unless the person says they want to buy).
6. **Guard.** The model's text loses every link except the creator's own site and socials and the offer link being inserted, on an exact match
   (`guard.ts`), and any number, price, discount or coupon the data does not hold is asked again once and then is the kit's safe line and a
   hand-off (`dm.claim_blocked`).
7. **Link and bytes.** `send_link` is the only way a link goes: `linkFor` (**`link.ts`**) makes it, a tracked `https://<app.public_base_url>/r/<code>`
   link (S7, one code per conversation and offer) or, if that cannot be made, the offer's own address (`dm.tracked_link_failed`), and puts it after
   the text; text plus link are within 900 UTF-8 bytes.
8. **Send and record.** The same quota, disclosure and `sendDirectMessage` as the old path, then ONE statement writes the reply (with
   `messages.ai_meta`) and the conversation's new state (`recordTurn`, **`store.ts`**), then the message is marked handled. A failed send records
   nothing.

### 2.7 — Gemini

**`src/webhook/messaging.ts:377`** — `generateAiResponse(conversationId, dmPromptText(dm),
creator.id, undefined, dmCtx)`, at **`src/services/ai.ts:404`**. Timed and logged as `ai.replied` with
`duration_ms` (**`src/webhook/messaging.ts:378`**), because this is both the dominant
marginal cost of the product and the reason the webhook cannot finish inside Meta's timeout.

**Which engine answers (v37, DM plan S3)** — the call above is now `generateDmReply` (**`src/services/dmEngine.ts`**), which reads
`ai_agents.engine` and dispatches. `gemini` (the default, and what a row from before v37 or a failed read means) is
`generateAiResponse` exactly as it was: the same request, pinned byte for byte by `ai.test.ts`. `providers` is `generateDmViaLayer`:
the same `dmSystemInstruction` text, history window and `enforceMetaConstraints`, written through the AI providers layer
(`generate`, purpose `dm`, system prompt cached, the `dm` route and budgets from Operations). A `providers` failure of any kind (no key,
no route, 5xx, timeout, a refused budget, an empty answer) is answered by Gemini once when `ai_agents.gemini_fallback` is on, logged
`dm.engine_fallback`. With the fallback off, or Gemini failing too, the result is a **handoff stub**: `dm.engine_failed`, nothing sent,
no canned apology, and the pipeline `markHandled`s the message (terminal, not retried; S8's handoff will pick it up). An agent that is
switched off is `null` for either engine, as below. The sandbox runs the engine on screen (`POST /api/settings/ai/test`, `engine` and
`gemini_fallback` in the body), labels the layer's spend `eval`, and answers 502 with the reason when nothing could answer.

**The wording is the tenant's** — `dmCtx = profileContextOrLegacy(creator.id, 'dm')` (**`src/webhook/messaging.ts:370`**,
the function at **`src/services/profile/context.ts:338`**) is read once per DM and handed to `generateAiResponse`, the
disclosure and (in the sandbox, which reads it itself, **`src/services/ai.ts:413`**) the starter persona. It says the language
and register the `dm` surface speaks and what the creator sells. A profile that can't be read is logged
`profile.context_unreadable` and is, for the platform owner (`getPlatformOwnerId`, or anyone when that lookup fails), his
Gulf/course wording (`legacyContext`, **`context.ts:293`**), never a failed reply; for any other tenant it throws
`ProfileUnreadableError` (**`context.ts:305`**), which the DM catch re-raises while a retry is left, so the job runner backs off.
The Studio's language is not the DM's: a settings write that moves an Arabic profile off `ar` pins `surfaces.dm` to the Arabic
and register it spoke (`intoProfile`, **`src/services/profile/views.ts:171`**), so switching the Studio to English leaves the bot Arabic.
`dmSystemInstruction(prompt, kb, ctx)` (**`src/services/ai.ts:398`**) writes the persona, the knowledge base and three
rules from `kitFor(ctx.language)`: the register rule 1 asks for, rule 2's offer noun by `who.offerKind` (courses,
programs, products, services, else offers), the character limits. Gulf + courses is today's text byte for byte.

**`decideAgent`** — **`src/services/ai.ts:345`**, called at **`src/services/ai.ts:378`**. The
whole safety rule, and both halves of it have been wrong in production:

| stored row | sandbox? | decision |
|---|---|---|
| any | yes (`overrides !== undefined`) | speak, with the row or the starter persona in the DM language (`starterPersona(lang)`, **`ai.ts:311`**; **`ai.ts:373-376`**) |
| none | no | **`{ speak: false, reason: 'unconfigured' }`** (**`ai.ts:349`**) |
| `is_active === false` | no | `{ speak: false, reason: 'disabled' }` (**`ai.ts:350`**) |
| otherwise | no | speak (**`ai.ts:351`**) |

The `is_active` filter used to be in the WHERE clause, so a *disabled* agent returned zero rows
and was indistinguishable from an *unconfigured* one — and a `|| default` then answered the
customer anyway with a generic persona, so the toggle changed *who* replied rather than
*whether anyone did*. It is now selected, not filtered on (**`src/services/ai.ts:366-370`**).
The unconfigured case is the more dangerous of the two and was fixed later: a tenant created
through `POST /api/admin/tenants` has no `ai_agents` row at all, so there was no `is_active` for
the off switch to be false on, and their bot answered real customers in a persona nobody chose
while every layer reported success.

`decideAgent` returning `speak: false` makes `generateAiResponse` return **`null`**
(**`src/services/ai.ts:385`**), logged `warn` for unconfigured and `debug` for disabled
(**:383**). The caller honours it at **`src/webhook/messaging.ts:315-319`**: log
`ai.agent_disabled`, `markHandled`, send nothing. **Every other failure throws** — there is no
fallback persona and no fixed promotional reply.

**History window** — **`src/services/ai.ts:395-402`**: the last `HISTORY_WINDOW = 8`
(**`src/services/ai.ts:86`**) messages for this conversation, `ORDER BY created_at DESC`, then
reversed into chronological order (**:405**). Trimmed from 15 because the system prompt and the
entire knowledge base are re-sent verbatim on every call, and Arabic runs ~2-2.5× more tokens
per character than English. The current message is appended only if it is not already the last
row (**:417-423**).

**`responseSchema`** — `dmResponseSchema(ctx)` at **`src/services/ai.ts:146`** (says "written in Arabic|English" and the
button id `GO_TO_COURSE_1|GO_TO_OFFER_1`), passed with `responseMimeType: "application/json"` in `generationConfig`
(**`src/services/ai.ts:505`**). It constrains `message_type` to
`text | quick_reply | carousel` and describes Meta's own limits inline (quick-reply titles ≤ 20
chars, carousel titles ≤ 80, 2-10 cards).

**Temperature** — **`src/services/ai.ts:435`** uses `Number.isFinite(agent.temperature)`, not
`|| 0.7`. The old form turned a deliberate `0` — the setting you pick precisely to stop the agent
improvising about prices — back into 0.7.

**Which key** — **`src/services/ai.ts:391-392`**, only once the agent has decided to speak:
`getGeminiKey()` (**`src/services/appSettings.ts:125`**) returns the key a platform admin saved
on **Operations → Gemini API key**, else `GEMINI_API_KEY`. One key serves every tenant. With
neither set it throws `MISSING_GEMINI_KEY`, which names both places to fix it; a switched-off
agent never gets this far, so it needs no key.

**The API key travels in a header, not a query string** — **`src/services/ai.ts:454-457`**:

```js
axios.post(url, payload, { headers: { 'x-goog-api-key': gemini.key }, timeout: GEMINI_TIMEOUT_MS })
```

Not `?key=`. Query strings end up in proxy logs, browser referrers and error reporters far more
readily than headers do — and an axios error carries `config.url`, so the old form leaked the
key into anything that logged one. The catch block at **`src/services/ai.ts:523-530`** logs
narrow fields for the same reason, never the error object.

`GEMINI_TIMEOUT_MS = 30_000` (**`src/services/ai.ts:89`**) — Gemini can sit on a request
indefinitely; a serverless invocation cannot.

**Token usage** is logged as `ai.usage` (**`src/services/ai.ts:465-475`**) including
`cached_tokens`, because `prompt_tokens` is mostly the static prefix and that is precisely the
number that says whether Gemini context caching is worth turning on.

### 2.8 — `coerceAiResponse`

**`src/services/ai.ts:206`**, called at **`src/services/ai.ts:503`**. `responseSchema` is a
strong constraint, not a guarantee. Every one of these used to reach `toMetaMessage` unchecked:

- `message_type: "carousel"` with `carousel_elements` absent or empty → Meta answers "param
  message must be a non-empty object", untraceable back to the model.
- `message_type: "quick_reply"` with no `quick_replies`.
- `text` (or a `quick_replies[].title`) returned as a **number** → `enforceMetaConstraints` then
  called `.substring` on it and threw a `TypeError` from inside the success path, surfacing as
  `dm.pipeline_failed` with a message about `substring` and no mention of Gemini.
- A model that ignores the enum and invents a fourth `message_type`.

Every case degrades to plain text (**`src/services/ai.ts:249`**) rather than throwing: the
person gets the words the model wrote, which is what they were waiting for, and the structure
was always a presentation detail. Numbers and booleans are coerced to string, objects and arrays
are not (**:211-213**) — `String({})` is `[object Object]`, worse than nothing. A downgrade logs
`ai.response_downgraded` (**:241**).

Two guards after it: **`src/services/ai.ts:508`** throws when a `text` response has no usable
text (an empty reply is a failure, not a message — sending it produces a Meta rejection
attributed to the send rather than the model, and writing it to `messages` would feed a blank
turn back as history), and `enforceMetaConstraints` (**`src/services/ai.ts:255`**) truncates to
Meta's limits.

Back in the pipeline, **`src/webhook/messaging.ts:322`** maps to the wire format with
`toMetaMessage` (**`src/webhook/meta-payload.ts:28`**), which copies template fields explicitly
rather than spreading, because Meta rejects unknown keys inside template elements and Gemini
returns both `url` and `payload` on every button regardless of type
(**`src/webhook/meta-payload.ts:57-67`**).

### 2.9 — Quota, disclosure, send

**Quota** — **`src/webhook/messaging.ts:326`**, the same `checkFairSendQuota` as
[1.13](#113--checkfairsendquota--two-ceilings). Deliberately **one check per reply, not per
network call**: a disclosure that has to travel as its own message is still one logical reply to
one person.

Refusal is **retried, not dropped** (**`src/webhook/messaging.ts:346-353`**): release the claim
and throw, if `mayRetry`. The counters are hourly and the runner's backoff (~30 s, ~2 m, ~8 m)
may well spend every attempt inside the same window — but it may not, and the alternative is a
real customer silently never answered, which is what used to happen. Nothing else will come back
for this message: the queue's `dedupe_key` is `dm:<mid>`, so a later Meta redelivery is refused
at enqueue and never becomes a second job.

**AI disclosure timing** — Meta's Messenger Platform policy requires telling people they are
talking to an automated service *"at the beginning of any conversation or message thread"*, and
again after a significant lapse of time.

- `needsDisclosure(conversation.ai_disclosed_at)` at **`src/webhook/messaging.ts:177`**, called
  at **:431**. True when the column is null (thread start), unparseable, **or** older than
  `DISCLOSURE_MAX_AGE_MS = 7 days` (**`src/webhook/messaging.ts:25`**). The policy never
  quantifies "a significant lapse"; a week is long enough that the thread reads as a new
  conversation to the person on the other end.
- `applyDisclosure` (**`src/webhook/meta-payload.ts:111`**) prefixes
  `disclosureLine(dmCtx.language.code)` (**`src/webhook/meta-payload.ts:92`**, called at **`messaging.ts:433`**: in the DM
  surface's language, `🤖 رد آلي من المساعد الذكي` or `🤖 Automated reply from the AI assistant`; the Arabic one is still
  `AI_DISCLOSURE_LINE`, **`:97`**) onto the payload's `text`. **A generic template carries no `text` field** — Meta rejects
  `text` alongside `attachment` — so for a carousel it returns `standalone` instead
  (**`src/webhook/meta-payload.ts:118`**), and the pipeline sends the line as its own message
  first (**`src/webhook/messaging.ts:435-443`**, logging `dm.disclosure_standalone`).

**Endpoint selection** — `resolveDmPageId` at **`src/webhook/messaging.ts:108`**, called at
**:356**. Meta requires `/{page-id}/messages` for Page access tokens; `/me/messages` only
resolves correctly for Instagram-Login tokens. There is no `field === 'feed'` marker on a
messaging event, so the signal is whether the page id the event is addressed to
(`recipientId` or `entryId`) equals the creator's `facebook_page_id`. The comment path always
threaded this through; the DM path never did, so every Facebook Messenger reply went to `/me`.

**Send** — **`src/webhook/messaging.ts:376`**, `sendDirectMessage`
(**`src/services/instagram.ts:213`**), `messaging_type: 'RESPONSE'`
(**`src/services/instagram.ts:233`** — without it the send is evaluated outside the standard
messaging window and rejected once that window matters).

**`ai_disclosed_at` is written only after a successful send**
(**`src/webhook/messaging.ts:382-384`**), so a failed first reply still discloses next time.

Then the outbound `messages` row (**`src/webhook/messaging.ts:387-397`**).

### 2.10 — `markHandled`, last

**`src/webhook/messaging.ts:401`** — `await markHandled(claim.id)`, defined at
**`src/webhook/messaging.ts:214`** (`handled_at = NOW(), reply_claimed_at = NULL`).

> **Why this order — `markHandled` is the final write.**
> A crash anywhere above it leaves the message claimable again. Writing it earlier — right after
> the send, say — would turn a failed *outbound log write* into a message nobody ever retries.
> The comment at **`src/webhook/messaging.ts:399-400`** says exactly this. The 300-second
> visibility window is what makes "claimable again" safe rather than a double-reply.

### 2.11 — Failure: release vs record

The catch at **`src/webhook/messaging.ts:402-421`** wraps everything from the Gemini call
onwards.

1. Log `dm.pipeline_failed` (**:403**), `noteMetaFailure` (**:405**).
2. `isPermanentMetaError(aiError)` (**:414**).
3. `!permanent && mayRetry` → **`releaseInbound`** (**:416**) then re-throw (**:417**).
4. Otherwise → `markHandled` (**:420**), terminal.

`releaseInbound` (**`src/webhook/messaging.ts:228`**) clears `reply_claimed_at` without setting
`handled_at`. It matters because the runner's first backoff is ~30 seconds, far shorter than the
300-second visibility window — without an explicit release, the retry would arrive, find a live
claim, and do nothing. Releasing is what makes the retry actually reach the work
(**`src/webhook/messaging.ts:221-227`**).

A Gemini rate limit, a Meta 500 and a socket reset all used to end here logged and swallowed,
with the job marked done and the inbound row permanently unanswerable.

---

## 3. Scheduled post → publish

A post is queued in the dashboard and published to Instagram, Facebook, or both. TikTok rows
share the creation route and the claim, then branch — see [flow 6](#6-tiktok-post--inbox--published).

### 3.1 — Creation

**`src/routes/api.ts:1925`** — `POST /api/posts/scheduled`. Behind `requireAuth` →
`requireLiveSession` → `resolveTenant` (see [flow 4](#4-login--session--tenant)), so
`getTenantId(req)` (**:1943**) is safe.

Validation:

- `platform`, `post_type`, `scheduled_time` all required (**:1929**).
- **`src/routes/api.ts:1937`** — `unsupportedPlatformCombination(platform, post_type)`, at
  **`src/routes/api.ts:403`**. Rejects `story` + `facebook`/`both` with a 400. Facebook Page
  stories need the two-step `/photo_stories` + `/video_stories` upload, which is not
  implemented, and on `both` Facebook runs first and throws — so a story scheduled for both
  fails at Facebook and never reaches Instagram, where it would have worked. Saying so once, at
  create time, to the person who can fix it, beats saying it daily in a cron log nobody reads.

Insert at **`src/routes/api.ts:1953-1966`** with `status = 'PENDING'`. `cover_url` is carried
through — it is what stops a reel getting a black tile in the profile grid, because Instagram
otherwise uses frame 0.

`publish_now` (**:1970**) takes a separate immediate path
(**`src/routes/api.ts:1981-2050`**) rather than waiting for a sweep. Note it answers **502**,
not 201, on failure (**:2044**) — a 201 for a row just marked FAILED read as success to every
caller.

### 3.2 — Two schedules converge on the same sweep

Nothing in-process publishes on a timer. Two external schedules call in:

| | GitHub Actions | Vercel cron |
|---|---|---|
| declared | `.github/workflows/drain.yml:34`, `cron: '*/5 * * * *'` | `vercel.json` `crons`, `"0 0 * * *"` |
| calls | `GET /api/jobs/drain` (**`src/routes/api.ts:328`**) | `GET /api/cron/publish` (**`src/routes/api.ts:666`**) |
| auth | `Authorization: Bearer $CRON_SECRET` (**`drain.yml:63`**) | same header, injected by Vercel |
| also does | `drainWorker()` first (**`api.ts:338`**) | reap, abandon, prune, retention sweep, `drainWorker()` |

Both then call **`publishDuePosts()`** — **`src/routes/api.ts:352`** and
**`src/routes/api.ts:714`**.

Once a day is a Vercel Hobby-plan limit, which is why `scheduled_posts.scheduled_time` was
effectively day-granular despite the dashboard's minute picker. Calling the sweep from the drain
endpoint too is what closes most of that gap without a paid plan
(**`src/routes/api.ts:344-348`**). GitHub explicitly does not guarantee schedule punctuality —
the workflow's own header says so at **`drain.yml:12-23`** — so the honest description is "every
~5-15 minutes", not "every 5 minutes".

The guard on both endpoints is `requireCronSecret` (**`src/routes/api.ts:256`**): **header
only**, never a `?token=` variant, because a query string ends up in Vercel's access logs for
their whole retention (**:265**). A missing `CRON_SECRET` is a **500**, not a skip — the earlier
`if (cronSecret && ...)` form skipped itself entirely when the variable was unset (**:259-263**).

`composeDrainResponse` (**`src/routes/api.ts:293`**) shapes the drain endpoint's answer from two
independent outcomes: **500 only when both halves failed** (**:299**), otherwise 200 with any
failure named in the body. The scheduler's alerting is an assertion on the HTTP status
(**`drain.yml:74`**), so returning 500 because the publish sweep broke would throw away the fact
that the queue drained fine; and a 200 that silently omitted the error would be exactly the
invisible failure this project keeps being bitten by.

A dormant third caller exists: `heroku-worker/worker.mjs`, a single dependency-free file polling
the same endpoint every 60 s (**`heroku-worker/worker.mjs:37-60`**). See
`CLAUDE.md` for its current dyno state.

### 3.3 — `publishDuePosts()` and the atomic claim

**`src/routes/api.ts:600`**.

1. **Select due rows** (**:602-608**) — `scheduled_posts` joined to `creators`,
   `status = 'PENDING' AND scheduled_time <= NOW()`, oldest first.
2. **Claim each one atomically** (**:623-629**):

   ```sql
   UPDATE scheduled_posts SET status = 'PUBLISHING', claimed_at = NOW(), attempts = attempts + 1
    WHERE id = $1 AND status = 'PENDING'
   RETURNING id
   ```

   `rowCount === 0` means someone else took it: log `cron.publish_already_claimed` and
   `continue` (**:631-634**).

> **Why the claim is an `UPDATE … WHERE status = 'PENDING'`.** The old form was SELECT-then-
> UPDATE, which let two concurrent cron hits both read the row as PENDING and both publish it —
> a **duplicate reel on the live account**, which cannot be undone from here. The guard was
> written as a precaution and became load-bearing the moment a second schedule started calling
> the same sweep (**`src/routes/api.ts:591-594`**).

3. `publishClaimedPost(post, {...})` (**`src/routes/api.ts:788`**, defined at **:688**), inside a
   try that only *logs* — the terminal row write already happened inside the publisher. It
   dispatches Meta rows to `attemptPublish` and TikTok rows to `publishTikTokPost`
   ([flow 6](#6-tiktok-post--inbox--published)).

### 3.4 — `attemptPublish()` and partial-publish recovery

**`src/routes/api.ts:486`**. Shared by `publishDuePosts` and
`POST /api/posts/scheduled/:id/publish-now` (**`src/routes/api.ts:2139`**).

Callers must claim the row first; `attemptPublish` deliberately does not, because the two callers
claim differently — a sweep of every due row versus one row scoped to a tenant. It **does** own
the terminal write (**`src/routes/api.ts:478-484`**).

**No token, no Meta call (v34).** A Meta row for a tenant with no connection (`page_access_token IS NULL`)
throws `MetaNotConnectedError` before anything is decrypted or sent: the row is written `FAILED` with
`NOT_CONNECTED_MESSAGE`, `noteMetaFailure` does not read it as a dead token (it has no Meta code 190),
and `POST /api/posts/scheduled` answers such a request 409 `META_NOT_CONNECTED` up front instead.
TikTok and YouTube rows are dispatched before this function and never read the Meta columns.

**The recovery, hop by hop:**

1. **`src/routes/api.ts:492`** — `const already = publishedPlatforms(post.published_post_id);`
2. `publishedPlatforms` (**`src/routes/api.ts:378`**) parses `FB:<id> | IG:<id>` back apart with
   two regexes (**:380-381**), returning `{ fb, ig }`.
3. **`src/routes/api.ts:493-494`** seeds `fbId` / `igId` from it.
4. **`src/routes/api.ts:501`** — Facebook publishes only `if ((platform === 'facebook' ||
   platform === 'both') && !fbId)`. An already-live Facebook post logs
   `publish.facebook_skipped_already_live` (**:516**) and is skipped.
5. **`src/routes/api.ts:522`** — the same `&& !igId` guard for Instagram (**:543** for the skip
   log).
6. On full success, **`src/routes/api.ts:548-553`** writes `status = 'PUBLISHED'`,
   `published_post_id = formatPublishedIds(fbId, igId)` (**`src/routes/api.ts:386`**),
   `error_log = NULL`.
7. On failure, **`src/routes/api.ts:565`** computes `partial = formatPublishedIds(fbId, igId)`
   and **:570-575** writes `status = 'FAILED'` **with `published_post_id = partial`** and an
   error message that names what is already public:
   `Partially published (FB:123) — the rest failed: …` (**:566-568**).
8. **`src/routes/api.ts:577`** throws `PublishAttemptError` (**`src/routes/api.ts:449`**),
   carrying `fbId`/`igId` plus `code`/`response` lifted off the original axios error so a
   caller's `describeError()` still surfaces `meta_code` / `meta_message` / `http_status`.

> **The incident this exists for**, recorded verbatim in the docstring at
> **`src/routes/api.ts:364-377`**: `published_post_id` was only ever written on **full** success.
> On `platform = 'both'` Facebook publishes first, so a Facebook success followed by an Instagram
> failure **threw away the Facebook post id** and recorded the row FAILED. The post *was* live on
> Facebook. Editing the row flips FAILED back to PENDING, so the honest-looking "retry" then
> **duplicated the Facebook post on the live account** — the exact outcome the atomic claim
> beside it was written to prevent. Recording the partial success and reading it back on the next
> attempt is what makes a retry *finish* the job instead of doing half of it twice.
>
> The same bug had a second home: the `publish_now` branch of the create endpoint re-implemented
> the loop body and started `fbId`/`igId` at `null` unconditionally, with no knowledge of what the
> original row had already published (**`src/routes/api.ts:468-477`**). That is why
> `attemptPublish` was extracted rather than copied.

`status` deliberately stays **FAILED** on a partial, not some third value: the dashboard filters
on that vocabulary, and a partially published post is genuinely not a finished one.

`noteMetaFailure(creator.id, err)` runs first in the catch (**:558**) — a dead token stops every
publish, not just this one.

### 3.4b — A reel Instagram is still processing, and Facebook creates

(Line numbers as of 2026-09-26; `attemptPublish` itself is now at **`src/routes/api.ts:580`**.)

- **Held, not failed.** When the container isn't FINISHED within the 25 s budget,
  `MediaProcessingTimeoutError` reaches `attemptPublish`'s catch, which writes the row back to
  `PENDING` with `external_publish_id = 'IGC:<container>'` and whatever went live in
  `published_post_id`, then throws `InstagramProcessingHeldError` (**`src/routes/api.ts:703`**).
  `publishDuePosts` logs it as held (**`src/routes/api.ts:867`**). The next sweep reads the saved
  container (**`src/routes/api.ts:649`**) and calls `resumeInstagramContainer`
  (**`src/services/instagram.ts:509`**): publish if FINISHED, start over if ERROR/EXPIRED, hold again
  if still processing. After `IG_PROCESSING_MAX_ATTEMPTS` (15) it fails as before.
- **Facebook creates are never repeated when they may have landed.** `publishFacebookPost` and the
  carousel's `/feed` call `withRetry(..., { creates: true })` (**`src/services/instagram.ts:410`**,
  **`:452`**): only a refusal (429, codes 4/17/32/613) or a connection that never went out is
  retried. `/videos` gets 60 s, `/photos` 30 s.

### 3.4c — `GET /api/uploads/:id`

**`src/routes/api.ts:1007`**. A row with `storage_path` streams the object from Supabase Storage
(`pipeline(media.body, res)`, **`src/routes/api.ts:1048`**); a legacy row serves `data`. The URL never
changes, which is what TikTok's verified prefix and Meta's stored URLs need.

### 3.5 — Daily maintenance, only on the daily cron

`GET /api/cron/publish` (**`src/routes/api.ts:666`**) does four things the drain endpoint does
not, because they are housekeeping measured in days:

1. **Release stale claims** (**:674-681**) — `PUBLISHING` rows claimed more than 15 minutes ago
   with `attempts < 5` go back to `PENDING`. Without this a lambda that timed out leaves the row
   in `PUBLISHING` forever.
2. **Abandon after 5 attempts** (**:687-694**) — past five tries it is not transient; stop
   retrying it daily forever. The `error_log` tells the operator what to check and that re-saving
   the post retries it.
3. **`pruneRateLimitData()`** (**:696**, **`src/utils/rateLimiter.ts:178`**) — drops counters and
   `dm_send_log` rows older than 48 h, including v14's app-wide bucket, which would otherwise be
   the one table that grows forever by design.
4. **`runRetentionSweep()`** (**:703**) — clears `messages.raw_payload` (the mechanism by which
   the published `/data-deletion` promise is otherwise untrue) and deletes completed `jobs` rows.

Then `drainWorker()` (**:712**) as a backstop, and `publishDuePosts()` (**:714**). Further down the same handler: the OAuth-state
purge, the TikTok and YouTube token refreshes ([6.6](#66--daily-token-check)), and the Meta token recheck of every connected tenant
([8.8](#88--the-daily-token-recheck-p29)).

### 3.6 — Carousels (v20)

A carousel is one `scheduled_posts` row with `post_type = 'carousel'` and its images in
`media_urls`, in slide order. It publishes as an Instagram CAROUSEL container, a Facebook
multi-photo feed post, or — on its own `tiktok` row — a TikTok photo post. `media_url` always
holds the first slide as well, so every reader that knows only that column (the cards,
thumbnails) still sees the lead image (**`src/config/migration_v20_carousel.sql`**).

**Creation** — the same route as [3.1](#31--creation), **`src/routes/api.ts:2150`**.

1. `unsupportedPlatformCombination` (**`src/routes/api.ts:419`**) takes `carousel` on every
   platform; TikTok now takes `image` and `carousel` beside `video` (**:428**).
2. **`src/routes/api.ts:2182`** — `validatePostMedia` (**`src/services/postMedia.ts:144`**)
   decides what the row stores, or answers 400 with the sentence the dashboard shows as-is:
   - counts: 2–10 for instagram/facebook/both (Instagram's API maximum is 10), 2–35 for a
     TikTok carousel, exactly one for a TikTok `image` (`media_url` alone, or a one-item list);
   - every entry an http(s) URL string;
   - our own uploads are looked up in one `SELECT id, mime_type` — never the bytes — through
     `MediaStore.mimeTypes` (**`src/services/storage.ts:95`**), then held to `imageProblem`
     (**`src/services/postMedia.ts:72`**): no video as a slide; JPEG only when Instagram is a
     target; for TikTok, only our own uploads, and only JPEG or WebP. An external URL passes
     for Meta, which fetches it itself — there is nothing here to inspect.
   - Every other post type passes through untouched, and a stray `media_urls` on one is ignored
     rather than refused.
3. **`src/routes/api.ts:2191-2203`** — with `also_tiktok`, the TikTok sibling takes
   `tiktok_media_urls` when sent (9:16 versions of the same slides), otherwise the Meta row's
   list, and is checked by TikTok's rules, not Meta's: a PNG carousel is fine on Facebook and
   refused here for its TikTok sibling.
4. TikTok options for a photo (**:2215**, **:2242-2244**) — `validateTikTokOptions(…, { media:
   'photo' })` (**`src/services/tiktokPublish.ts:101`**) drops duet, stitch and `is_aigc`, which
   a photo post does not have, and adds `title` (at most 90 UTF-16 units) and `auto_add_music`
   (on unless switched off). Inbox mode keeps only the title (`validateTikTokInboxOptions`,
   **`src/services/tiktokPublish.ts:154`**).
5. The insert (**`src/routes/api.ts:2263-2270`**) — each row writes its own `media_url` / `media_urls` pair.

**Editing** — `PUT /posts/scheduled/:id` (**`src/routes/api.ts:2353`**) re-checks the
*effective* media (**:2402-2419**) whenever `platform`, `post_type`, `media_url` or `media_urls`
is sent. Moving a PNG carousel from `facebook` to `both` is refused although the PUT resent no
slide — the same two-step edit `unsupportedAfterEdit` exists for. On those edits `media_urls` is
rewritten, and NULLed once the row is no longer a carousel (**:2460**).

**Dispatch** — `attemptPublish` (**`src/routes/api.ts:570`**): the same claim, the same
Facebook-then-Instagram order, the same `FB:… | IG:…` bookkeeping as
[3.4](#34--attemptpublish-and-partial-publish-recovery).

1. **:591** — a carousel row with no `media_urls` fails closed, rather than going out as its
   first slide and being recorded as the whole post.
2. **:604** → `publishFacebookCarousel` (**`src/services/instagram.ts:333`**): each image
   `POST /{page}/photos` with `published: false` (**:350**) — otherwise every slide appears on
   the Page as a post of its own — then one `POST /{page}/feed` carrying the caption and
   `attached_media: [{ media_fbid }, …]` (**:357**).
3. **`src/routes/api.ts:633`** → `publishInstagramCarousel` (**`src/services/instagram.ts:536`**): one child
   container per image, `is_carousel_item: true` and no caption (**:555**); then the parent,
   `media_type: 'CAROUSEL'`, `children` comma-joined, with the caption (**:563**); then the
   same `waitForContainer` poll on the parent (**:370**) and `publishContainer` (**:410**), with
   its 9007/100 not-ready retry, that a single post uses.
4. A partial success is recorded as for any `both` post: Facebook live and Instagram failed is
   FAILED with `FB:<id>`, and the retry skips Facebook.

**TikTok photo posts** — a `tiktok` row whose `post_type` is `image` or `carousel` takes the
photo branch of `publishTikTokPost` (**`src/services/tiktokPublish.ts:504`**), after the checks
every TikTok post shares: the pending-draft limit, the token, the scope for its mode
([6.4](#64--publishtiktokpost-the-upload), steps 1–3).

1. **Resume** (**:430**) — a row that already has an `external_publish_id` is asked about
   first. Unless TikTok refused it, the post or the draft exists, and a second init would
   duplicate it.
2. `tiktokPhotoUrls` (**:384**) re-checks every upload (**:393**) — one may have been deleted, or
   the row edited, since scheduling — then rebuilds each URL as
   `<public base URL>/api/uploads/<uuid>.jpg` (`.webp` for a WebP) (**:396**).
3. `initPhotoPost` (**`src/services/tiktok.ts:586`**) — `POST /v2/post/publish/content/init/`
   with `media_type: 'PHOTO'`, `PULL_FROM_URL`, `photo_cover_index: 0`. DIRECT_POST sends the
   full `post_info` from `directPhotoInfo` (**`src/services/tiktokPublish.ts:404`**: a fresh
   creator_info, the same privacy check as a video, comments forced off when the creator has
   them off, music on by default). MEDIA_UPLOAD sends only `title` and `description`
   (**`src/services/tiktok.ts:604`**). The title is the stored one or the caption's first line
   with text on it, cut to 90 UTF-16 units without splitting a surrogate pair (`photoTitle`,
   **:557**); the description is the caption, cut to 4000. **Not retried**, like both video
   inits. TikTok allows this endpoint 6 calls a minute per token.
4. `external_publish_id` is written first (**`src/services/tiktokPublish.ts:453`**), then
   PROCESSING (**:460**), then the same inline poll as a video (`settleInline`, **:345**). There
   is no upload and no duration check: TikTok pulls the images itself. From here the three
   writers of [6.5](#65--three-writers-one-idempotent-transition) carry the row on —
   `PROCESSING_DOWNLOAD`, then `SEND_TO_USER_INBOX` in inbox mode, then `PUBLISH_COMPLETE`.

> **Why the URL is rebuilt rather than taken from the row.** PULL_FROM_URL only fetches from
> the URL prefix verified in TikTok's portal (under "URL properties":
> `https://msg-response-auto.vercel.app/`). A row saved from a preview deployment or localhost
> carries a host TikTok refuses, with `url_ownership_unverified` (**`src/services/tiktok.ts:125`**,
> worded for the operator). TikTok's fetcher also wants a URL that ends like an image, so
> `GET /api/uploads/:id` answers `<uuid>.jpg|.jpeg|.png|.webp|.mp4` too, ignoring the extension
> and serving the stored type (**`src/routes/api.ts:944`**, `uploadIdFromSegment`,
> **`src/services/storage.ts:130`**).

**Retention** — `pruneOrphanedMedia` keeps every upload named in the `media_urls` of a post that
may yet publish (**`src/services/retention.ts:236`**). `media_url` mirrors only the first slide,
so matching it alone would delete slides 2..N before they were published.

---

## 4. Login → session → tenant

### 4.1 — `POST /api/auth/login`

**`src/routes/api.ts:157`**. Mounted **above** `requireAuth`, obviously.

**IP throttle first** (**:158-164**). The throttle now lives in `src/services/loginThrottle.ts` (P17: the invite routes share it); the line
numbers below are from before it moved, and the function names are right. `clientIp` (**:99**) reads the first
`x-forwarded-for` entry, falling back to the socket address. `loginRetryAfter` (**:106**):

- no record, or the 15-minute window has passed (`LOGIN_WINDOW_MS`, **:94**) → 0, and the record
  is deleted (**:112**)
- `count <= LOGIN_FREE_ATTEMPTS` (5, **:95**) → 0
- otherwise exponential: `2 ** (count - 5) * 1000` ms, capped at `LOGIN_MAX_DELAY_MS` = 5 min
  (**:96**, **:117**)

Over the limit → **429** with a `Retry-After` header (**:161-162**). `recordLoginFailure`
(**:122**) sweeps the map when it exceeds 1000 entries (**:134-138**) so a spray across many IPs
cannot grow it forever.

This is **per lambda instance** and therefore a speed bump, not a guarantee: Vercel keeps as many
warm instances as it likes and each starts the `Map` empty, so an attacker spreading attempts
across instances multiplies the limit by however many are running (**`src/routes/api.ts:86-93`**).

### 4.2 — Path A: email + password

Taken only when an email is actually supplied (**`src/routes/api.ts:173`**).

1. Look the user up case-insensitively (**:175-179**).
2. **`src/routes/api.ts:184-186`** — one boolean combining *user exists*, *is_active*, and
   `verifyPassword(password, user.password_hash)` (scrypt, `src/config/crypto.ts`).
3. Failure → `recordLoginFailure`, **401 "Invalid email or password."** (**:188-192**). **One
   message** for "no such user", "wrong password" and "disabled account" — the distinction is
   free account enumeration otherwise, and the throttle counts all three.
4. Success → clear the throttle (**:194**), resolve the starting tenant with `initialTenantFor`
   (**:196**, defined **:148**): the user's first membership ordered
   `created_at, creator_id` so it is the same one every time; a `platform_admin` holding no
   memberships falls back to `getActiveCreatorId()` (**:154**).
5. Mint (**:197-202**), stamp `last_login_at` (**:204**), return
   `{ token, expiresIn: '24h', userId, role, tenantId }` (**:207**).

### 4.3 — Path B: the legacy shared password

Everything below the email block (**`src/routes/api.ts:215-243`**), untouched. `DASHBOARD_PASSWORD`
compared with `secretEquals` (**:221**, a length-safe constant-time compare at **:43**), then
`createLegacySession(await getActiveCreatorId())` (**:237-238**).

`createLegacySession` (**`src/middleware/auth.ts:105`**) is
`createSession({ userId: null, role: 'platform_admin', tenantId, tokenVersion: 0 })`. Kept
deliberately: this is a live system, and removing the only way in before user accounts exist
would lock the operator out of their own dashboard.

`userId: null` has consequences downstream — nothing to revoke against
(**`src/services/tenant.ts:217`**) and no membership to check
(**`src/services/tenant.ts:192`**, since the role is `platform_admin`).

### 4.4 — Token mint and HMAC key derivation

`createSession` — **`src/middleware/auth.ts:93`**:

```
body  = base64url(JSON.stringify({ ...payload, iat: Date.now() }))
token = `${body}.${sign(body)}`
```

`sign` (**`src/middleware/auth.ts:75`**) is `HMAC-SHA256(data, getSecret())`.

**`getSecret()` — `src/middleware/auth.ts:36`** — is the derivation:
`` `${DASHBOARD_PASSWORD}:${META_APP_SECRET}` ``, and it **throws** when either is missing
(**:40-43**). No defaults. The old `|| 'admin'` / `|| 'salt'` fallbacks meant a deployment
missing either variable silently signed every session with a key published in this repo —
anyone could mint a valid session token from the source.

A corollary: **changing `DASHBOARD_PASSWORD` invalidates every outstanding session token**,
including ones minted by the email path.

`SessionPayload` (**`src/middleware/auth.ts:54-64`**) carries `userId`, `role`, `tenantId`,
`tokenVersion`, `iat`, and, only on a "keep me signed in" session (P17, §4.8), its own absolute `exp`: `verifySession` then
refuses the token at `exp` instead of 24 hours after `iat`, and refuses any `exp` further out than 90 days. The payload used to be a bare timestamp — every request was "somebody who
knew the one password", which is why ~13 call sites had to guess the tenant with
`SELECT … WHERE is_active = true LIMIT 1`.

`signWithSessionSecret` (**`src/middleware/auth.ts:88`**) is exported so the erasure preview
token can sign without the secret itself leaving the module; callers must namespace their payload
(`erasure:v1:…`) so a token minted for one purpose cannot verify for another.

### 4.5 — The middleware chain, in mount order

```
router.use(requireAuth)          src/routes/api.ts:920
router.use(requireLiveSession)   src/routes/api.ts:925
router.use('/admin', adminRouter) src/routes/api.ts:933   ← above resolveTenant
  /auth/me, /auth/switch-tenant, /auth/password            ← also above resolveTenant
router.use(resolveTenant)        src/routes/api.ts:1123
  …everything else
```

**`requireAuth`** — **`src/middleware/auth.ts:149`**. Extracts the bearer token with
`startsWith('Bearer ')` + `slice(7)` (**:154**), not `replace('Bearer ', '')`, which matched the
first occurrence *anywhere* in the string and mangled a token that happened to contain the
literal text. Then `verifySession` (**`src/middleware/auth.ts:110`**):

- exactly two dot-separated parts (**:111-112**)
- `timingSafeEqual` on the hex signature, with the `Buffer.from` length trap caught
  (**:125-130** — `Buffer.from` silently truncates invalid hex)
- JSON parse of the base64url body (**:134**)
- `iat` must be a number (**:139**), and `age > SESSION_TTL` (24 h, **:24**) **or**
  `age < -60_000` is rejected (**:143**) — future-dated tokens are refused too, because a clock
  skew bug should not mint something outliving the TTL

Valid → `req.session = session` (**:167**). Invalid → 401.

**`requireLiveSession`** — **`src/services/tenant.ts:232`**. The revocation check.

- No `session.userId` (legacy) → `next()` immediately (**:240-243**); there is no user row to
  revoke against, and such a session is bounded by `DASHBOARD_PASSWORD` and the 24 h TTL.
- Otherwise one query for `token_version, is_active` (**:246-249**) fed to
  `checkSessionValidity` (**`src/services/tenant.ts:211`**): unknown user → 401, `is_active`
  false → "This account has been disabled.", `token_version` mismatch → "Session has been
  revoked".
- A database error **fails closed** with a **503** (**:259-265**). A database that cannot confirm
  the session is live is not a reason to assume it is.

It is a separate middleware from `resolveTenant` specifically so it can run above the admin
router (**`src/services/tenant.ts:224-231`**) — skipping the revocation check there would leave
the highest-privilege surface as the one place a revoked token still worked.

> **Why the admin router mounts above `resolveTenant`.**
> `resolveTenant` returns **409** when the deployment has no creator at all — which is precisely
> the state `POST /api/admin/tenants` exists to fix. Behind it, the first-run endpoint would be
> unreachable on exactly the deployment that needs it. The sub-router carries its own
> `platform_admin` guard, so nothing is weakened. Stated at **`src/routes/api.ts:927-932`**.
>
> `/auth/me`, `/auth/switch-tenant` and `/auth/password` sit above it for the parallel reason
> (**`src/routes/api.ts:935-939`**, **:1013-1014**): a user holding no membership, or an admin on
> a creator-less deployment, must still be able to ask who they are, see what they can switch
> into, and change their password. Behind `resolveTenant` all three would 409 and the tenant
> switcher would have nothing to render.

**`resolveTenant`** — **`src/services/tenant.ts:275`**:

1. No session → 401 (**:277-280**).
2. **`src/services/tenant.ts:284-286`** — a session with no `tenantId` (i.e. legacy) adopts
   `getActiveCreatorId()`, the same thing every call site used to assume implicitly.
3. **`src/services/tenant.ts:288`** — still nothing → **409**, *"No creator account is configured
   yet."*
4. **`src/services/tenant.ts:295`** — `assertTenantAccess(session)` false → **404 "Not found."**

> **409 vs 404.** They answer different questions and the distinction is deliberate.
> **409** means *the deployment has no tenant to act as* — a first-run state, fixable by
> `POST /api/admin/tenants`, and safe to state plainly because it discloses nothing.
> **404** means *you may not act as this tenant* — and it is 404 rather than 403 because
> confirming a tenant exists is itself a disclosure. `/auth/switch-tenant` matches it exactly
> (**`src/routes/api.ts:988-990`**).

`assertTenantAccess` (**`src/services/tenant.ts:187`**): no `tenantId` → false;
`role === 'platform_admin'` → **true for any tenant** (this is what powers the switcher); no
`userId` → false; otherwise a live `memberships` lookup (**`src/services/tenant.ts:169`**).
Verified against the **database**, not trusted from the token, so revoking a membership takes
effect immediately rather than at token expiry.

Past that line, `getTenantId(req)` (**`src/services/tenant.ts:160`**) is safe to call inline
inside a query. It **throws** rather than falling back to "the first active creator" — that
silent fallback is the bug the whole layer exists to remove, and it would look like it worked
right up until it served the wrong customer's data.

### 4.6 — Switching tenants re-mints

**`src/routes/api.ts:974`** — `POST /api/auth/switch-tenant`.

1. `tenantId` must be a UUID (**:979**).
2. `assertTenantAccess({ userId, role, tenantId })` — the *requested* tenant, not the session's
   (**:984-986**). Denied → 404 (**:990**).
3. **`src/routes/api.ts:994-999`** — `createSession` with the new `tenantId`, same `userId`,
   `role` and `tokenVersion` (and, for a "keep me signed in" session, the same `exp`: a switch is not a new sign-in). Response is a **new token** (**:1000**).

Nothing server-side is mutated, because there is nothing to mutate: the session is a stateless
HMAC, so the tenant it carries can only change by issuing a different token. The old token stays
valid for its remaining TTL **against its own tenant**, which is correct — it was already
authorised for that one (**`src/routes/api.ts:966-973`**).

The switcher's data source is `GET /api/auth/me` (**`src/routes/api.ts:942`**) →
`listTenantsForSession` (**`src/services/tenant.ts:341`**): every active creator for a
`platform_admin`, otherwise creators joined through `memberships`.

### 4.7 — The creator profile: reading it, changing it, and what the agents are told

Once the tenant is pinned, one record says who it is: `creator_profiles.profile` (who the creator is,
how they speak, what they sell, what the agents must never do). The Studio and Growth settings are
*views* over it; the agents read *contexts* cut from it. Every tenant has one: the stored row, or,
until it has one, the virtual profile its legacy settings describe (`version: null`).

**Reading it.**

1. **`src/index.ts:73`** — `profileCacheScope` opens a per-request cache, right after the log context,
   so the webhook, the dashboard API and `/api/jobs/drain` all share one read per tenant per request.
2. **`src/services/profile/store.ts:158`** — `loadProfile`: the stored row through `upgradeProfile`
   (a stored profile is merged over the defaults, so a field a later release adds reads as its
   default), else `loadLegacyProfile` — the tenant's settings rows read directly and described by
   `profileFromLegacy`. A database without v33 reads as "no stored profile" (logged once).
3. **`src/services/studio/settings.ts:268`**, **`src/services/growth/settings.ts:266`** — the settings
   readers overlay the stored profile on their own row (`studioView` / `growthView`). A tenant with
   no stored profile, or one written by a *newer* release, gets its row unchanged.
4. **`src/services/profile/context.ts:276`** — `profileContext(creatorId, purpose)` is `loadProfile`
   then the pure `contextFor` (**:249**): a base every purpose shares (`language` resolved for the
   purpose's surface, `who`, `guard`) plus that purpose's slice. A stored profile written by a *newer*
   release is passed over exactly as the settings readers pass it over (**:280**): the context is cut
   from the legacy rows, `version: null`. Today two readers use it:
   `tenantLanguage` (**`src/services/growth/coach.ts:259`**: the coach's and the keyword finder's
   language) and `tenantTimezone` (**`src/services/growth/overview.ts:416`**: the heatmap, after the
   audience's own override). The DM's knowledge base is *not* in a context: it stays on `ai_agents`.

**`GET /api/profile`** — **`src/routes/profile.ts:72`**, mounted below `resolveTenant`
(**`src/routes/api.ts:1509`**), operator or owner (**:60**), like every read of the Studio's and Growth's
settings: a `viewer` sees the account's numbers, not how it is run (403 otherwise). Answers
`{ profile, version, stored, activationMissing }` — `stored: false` and `version: null` for the
virtual profile, `activationMissing` the fields the wizard still needs.

**`GET /api/profile/campaign-seeds`** — **`src/routes/profile.ts:81`**, operator or owner (**:69**). What the
Campaigns screen's "Import from CSV" starts each imported course from; it replaced a table of nine
mappings that the dashboard carried for the owner. Answers `{ seeds, source, fallback }`: `fallback` is what a row
no seed names starts from (P15), the owner's own wording for the platform owner and the neutral text of the language
its comment replies speak for everyone else (`ImportFallbackLines`, `kits.ts`).

1. **`src/services/profile/campaignSeeds.ts:108`** — `readCampaignSeeds` loads the session tenant's profile
   (`loadProfile`) and **`:77`** `campaignSeeds` turns each offer that has a `campaign` and a `name_match` into a
   seed, in the offers' order: `trigger_keyword` (the keywords joined on `", "`), `dm_template` (as it is, with
   `{url}` and `{username}`), `public_reply_template` (the replies joined on `" | "`), `match` and `name_match`.
   An offer with no `name_match` is not a seed: `""` is a substring of every course name.
2. **The owner's fallback (`:108`–`:112`).** While a profile yields no seed AND the tenant is the platform owner
   (`getPlatformOwnerId`, found and equal; a lookup that finds nobody is *not* him), the answer is his nine
   (`legacyCourseMappings.ts`), `source: 'legacy'`. Nobody else is ever answered them: a tenant with no campaign
   gets `[]`. `scripts/seed-owner-offers.mts --apply` puts the nine on his offers, after which `source` reads
   `profile` and the fallback is dead code.
3. **`dashboard/js/pages/campaigns.js:945`** — `handleCSVSelect` asks for the seeds once per import
   (`loadSeeds`, **:1044**; a failed read stops the import with a toast, it never imports generic text over
   curated copy) and `showBulkImportModal(courses, seeds, fallback)` (**:1068**) gives each course the first seed, in
   order, whose lower-cased `name_match` its lower-cased name contains (`seedFor`, **:1059**). A course
   that matches none starts from the server's `fallback`, its `{name}` and `{url}` filled in (`fillFallback`): the page
   carries no wording of its own.

**`PATCH /api/profile { version, patch }`** — **`src/routes/profile.ts:85`**, owner only (**:70**).

1. **`src/services/profile/patch.ts:215`** — `patchProfile` refuses a body that is not
   `{ version, patch }` (400, one problem), and a patch nested deeper than any profile (400).
2. **Without the lock** (**`patch.ts:233`**): it reads the profile and `plan`s the patch (**:178**):
   a newer-schema profile (409 `PROFILE_NEWER_SCHEMA`), a `version` that is not the stored one
   (409 `PROFILE_VERSION_CONFLICT`, `currentVersion` in the body) — both *before* merging, because the
   patch was written against a profile that has moved on — then `mergePatch` (**:115**: objects merge
   key by key; lists, scalars and `null` replace; in `language.surfaces`, `socials.links` and
   `audience.timezone` a `null` removes the entry), then the *merged* result is validated (400
   `PROFILE_INVALID`, every problem listed). A refusal here never takes the tenant's mutex.
   **The owner's rule is locked here too** (**`patch.ts:236-238`**, P19): a patch that takes `no_women_imagery` out of
   the PLATFORM OWNER's profile (`getPlatformOwnerId`) is 409 `OWNER_RULE_LOCKED` unless the body says
   `confirm_remove_owner_rule: true` (anything else but a boolean is a 400, **:229**). It is asked before the transaction
   opens, because the lookup is a second pool connection and a transaction already holds one of three; only a patch that
   removes the rule asks, and a failed lookup refuses (500) rather than letting the removal through. Another tenant's profile,
   adding the rule and every other change are never locked. His editor prompt's "never a woman" line comes from this rule.
3. **A patch that changes nothing writes nothing** (**`patch.ts:184`**) — no version, no history row,
   no audit entry.
4. **With the lock** (**`patch.ts:244-257`**): one transaction. `lockTenantSettings` first
   (creators → creator_profiles → studio_settings → growth_settings, the order every settings writer
   takes), then the profile row `FOR UPDATE` — or, for a tenant with none, the legacy rows, read
   *after* the lock — and step 2 is made again on *that*. This is what makes the merge sound: a Studio
   or Growth settings write that committed between the first read and the lock is in what the patch is
   merged onto; one that comes later waits for the mutex. (Merged onto the first read, the stale rows
   would have been saved over it as the next version and mirrored back.)
5. **`src/services/profile/store.ts:362`** — `saveProfile(…, { expectVersion, startFromCaller })` on that
   transaction: validates again, bumps the version, keeps the history row and mirrors the view back into
   `studio_settings` / `growth_settings`. Under the mutex the `WHERE version =` cannot lose to a writer
   that takes it; it is the backstop for one that does not. A tenant whose legacy rows are not a valid
   profile on their own (a colour that is no colour) is repaired by a valid merged result, which is
   stored as version 1 (`startFromCaller`); otherwise version 1 is the legacy baseline (source
   `backfill`) and the patch is version 2. The profile cache is cleared after the commit.
6. **`src/routes/profile.ts:90`** — the audit row `profile.write`: `detail.paths` names the
   top-level sections that changed and `detail.version` the new version. **Never a value.**

> **Why the version check comes before the merge.** A patch is a *diff against what its author saw*.
> Merged onto a newer profile it would still validate and still save — and silently overwrite the
> change that made it stale. The 409 is what tells the wizard to reload instead.
>
> **Why the second read.** Everything that refuses is decided on the first read, so a bad request costs the
> tenant nothing. But a merge made on a read taken *before* the lock can be of rows that have since
> changed, and `saveProfile` validates a profile, not its freshness: only the read under the mutex is.
>
> **Why a no-op is not a write.** The wizard retries, and a double-click is a second request. Without
> this each would mint a version and a history row that differ from the last by nothing.

**Creating a tenant stores its first profile (P16).** `POST /api/admin/tenants` (**`src/routes/admin.ts`**) inserts the
`creators` row, then `createProfile` (**`src/services/profile/store.ts`**) stores `defaultProfile({ lang, rules })` as
version 1 (history source `admin`) and mirrors it into the settings rows, seeding the Studio's `brand.direction` `rtl` for an
Arabic tenant, then an `onboarding` row `invited`, all in one transaction: a tenant is never left without a profile, and a
profile described from nothing would be the owner's (`legacy.ts`). `rules` is `onboarding.default_rules` (default
`['no_women_imagery']`). The body is a name and a language; the legacy body (a page id and a token) still works and gets
the same profile. `scripts/backfill-creator-profiles.mts` gives the same neutral default to an EXISTING tenant with no settings
rows (never the platform owner).

**An admin fills the profile in on a tenant's behalf (P19).** `GET` and `PATCH /api/admin/tenants/:id/profile`
(**`src/routes/admin.ts:1420`** and **:1452**), platform admin only: **`requirePlatformAdmin`** (**:109**) answers everyone else 404
and runs no query. The Profile section of the tenant screen (**`dashboard/js/pages/tenant_detail.js`**, `renderProfile`) is a
button; pressing it loads **`dashboard/js/pages/tenant_profile.js`** and fetches the profile.

1. **`GET`** — `knownTenantId` (**:1409**) 404s a non-uuid and an unknown tenant before any profile read; `profileAnswer` (**:1399**)
   answers `readProfileState` (the profile, its `version`, `stored`, `activationMissing`) plus `isPlatformOwner` and the
   tenant's `onboarding` `{ status, filledBy }` (`readOnboardingState`, **:1386**: no row, or no v34, reads as completed, D14).
2. **`PATCH { version, patch, confirm_remove_owner_rule? }`** is `patchProfile` — the very function `PATCH /api/profile` is, not
   a copy — so the merge, the validation, the optimistic **version lock** (409 `PROFILE_VERSION_CONFLICT` with `currentVersion`,
   decided on the first read, before the mutex, and again by the `WHERE version =` of `saveProfile`) and the **owner's rule**
   (409 `OWNER_RULE_LOCKED`) are the tenant route's, step for step. What the admin's call adds is *who it says wrote it*:
   - the history row's source is `admin` (`PatchActor.source`, **`patch.ts:254`**);
   - **`onboarding.filled_by = 'admin'`**, `WHERE status <> 'completed'`, runs inside the save's own transaction
     (`PatchActor.onSaved`, **`admin.ts:1463`**; **`patch.ts:255`**), after the history row and the mirror and before the
     commit: if it fails the profile write rolls back with it (a profile never changes without the wizard being told), and
     a tenant whose onboarding is completed keeps whatever `filled_by` it had;
   - the audit row (**`admin.ts:1469`**) is `profile.write` on the creator with `{ paths, version, on_behalf: true }`: section
     names, **never a value**. A patch that changes nothing writes none of the three.
3. **The dashboard sends only what changed** (`TenantProfile.changedPaths` → `buildPatch`), with the version it read. A 409 keeps
   the forms as typed, shows "changed elsewhere", and blocks Save until a reload (`reloadKeep` puts the admin's still-changed
   fields back on top of the latest). `OWNER_RULE_LOCKED` opens a confirmation, and only a yes sends
   `confirm_remove_owner_rule: true`.

### 4.8 — Invite links: a person gets in without anyone typing their password (P17)

The operator makes a link for a tenant; the person opens it, chooses a password and is in. There is no email
infrastructure, so the link travels by WhatsApp or Copy. Everything that makes that safe is in
**`src/services/invites.ts`**; the HTTP half is **`src/routes/invites.ts`** (public) and the operator's routes in
**`src/routes/admin.ts`**.

**Making one** — `POST /api/admin/tenants/:id/invites` (**`src/routes/admin.ts:1220`**, platform admin only: anything else
is a 404). Creating a tenant by name returns the first one in the same 201 (**`issueInvite`**, **admin.ts:205**).

1. `createInvite` (**`src/services/invites.ts:244`**) reads the tenant (404 if absent, 409 if switched off), applies the
   `onboarding.*` settings (default role, 7 days, or 24 h for a reset) and, for a `reset`, checks the account is a member,
   active and **not a platform admin**.
2. `insertInvite` draws **32 random bytes** (**:72**) and stores only `sha256(token)` in `invites.token_hash`.
3. The response carries the link **once**: `…/dashboard#/invite?t=<token>&lang=ar` (`buildInviteUrl`, **:92**). The token is in
   the URL **fragment**, which no server, log or `Referer` ever sees. Nothing stores it, so a link can never be shown again:
   *Regenerate* (**admin.ts:1285**, `regenerateInvite` **invites.ts:335**) revokes the old row and makes a new one in one
   transaction, and *Revoke* (**admin.ts:1316**) stops one at once. Each writes an `invite.*` audit row whose `detail` holds
   ids and facts, never the link.

**Opening one** — the dashboard (`App.init`, `dashboard/js/app.js`) routes `#/invite` to the invite page **before it looks for a
session** (`isInviteHash`), moves the token out of the hash into `sessionStorage` and cuts the hash back to `#/invite`
(`captureInvite`), then calls `POST /api/invites/peek` (**`src/routes/invites.ts:75`**), mounted above `requireAuth`
(**`src/routes/api.ts:1239`**).

- `peekInvite` (**invites.ts:444**) answers the tenant's name, the role, the address if the link is for one, the expiry and the
  length of "keep me signed in" — and counts the opening (`open_count`, `first_opened_at`: the operator's "Opened 2h ago").
  It never consumes the link.
- **Every way a link can be unusable is the same 410** `INVITE_INVALID`: malformed, unknown, expired, used, revoked, or its
  tenant switched off. A malformed value is refused without a query; a found row is re-compared with `timingSafeEqual`
  (**`hashesEqual`, :85**).
- Both routes share the login's per-IP throttle (**`src/services/loginThrottle.ts`**, moved out of `api.ts` unchanged): a link
  that does not open is a failed attempt, five are free, then each wait doubles. A good link, a weak password or a taken
  address never count.
- A request carrying `Authorization: Bearer …` is told apart from an anonymous one (`readViewer`, **routes/invites.ts:44**): a
  dead session counts as none, a platform admin's session is refused outright (403 `ADMIN_SESSION`, before the link is touched,
  so the operator testing his own link does not spend it).

**Using one** — `POST /api/invites/accept` → `acceptInvite` (**invites.ts:553**), in **one transaction**:

1. **`claim`** (**:516**): `UPDATE invites SET used_at = NOW() WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL
   AND expires_at > NOW() RETURNING id`. This one statement is what makes a link single-use: two people opening it at once
   cannot both get in, and a revoke or an expiry that lands between the courtesy check and here still wins. A failure after
   it rolls the claim back, so a refused attempt never burns the link.
2. Then, by purpose and by who asks:
   - **join, anonymous**: create the user (`role 'user'`, password through the existing scrypt) and the membership with the
     link's role. An address that already has an account is a **409 `EMAIL_EXISTS`**, answered *before* anything is claimed,
     and no existing `password_hash` is ever overwritten. The link's own address wins over the form's.
   - **join, signed in**: add the membership to that account (never downgrading one it already has); a link for another
     address is a 403 `EMAIL_MISMATCH`.
   - **reset**: replace the password of the account the link was made for and **bump `users.token_version`**, which ends every
     session it held (`requireLiveSession` compares it on every request). A platform admin's password is never replaced by a
     link.
   - A tenant that was `invited` becomes `in_progress`; one that is further on is never moved back.
3. The answer is a **201 with a session** for that tenant. `keepSignedIn` gives it the operator's "keep me signed in" length
   (`onboarding.session_days`, 30 by default) as its own `exp` (`createSession`'s `ttlMs`, **`src/middleware/auth.ts:116`**;
   capped at 90 days by `MAX_SESSION_TTL_MS`, and re-minting through *switch tenant* or *change password* carries the
   original `exp` instead of restarting it). An ordinary session is the 24 hours it always was. `POST /api/auth/login` takes
   the same `keepSignedIn` for a user account, never for a platform admin.
4. `invite.accept` is written with the **person** as the actor, after the commit.

**The settings** (Settings → Onboarding and invites, platform admin, `GET|PUT /api/admin/onboarding-settings`,
`src/services/onboardingSettings.ts`): `onboarding.invite_ttl_days` (7), `reset_ttl_hours` (24), `default_role` (owner),
`session_days` (30), `inviter_name`, `whatsapp_text` (must contain `{link}`) and `default_rules`. Read when a link or a
session is made, so a change never reaches one that already exists; an unreadable saved value falls back to its default.

**What the dashboard remembers**: after a link is used, and after any email sign-in, the address goes to
`localStorage.login_email` so the login form opens with the email field showing it ("use the dashboard password instead"
puts the one-field form back). The token is never in `localStorage`, only in `sessionStorage` for the tab.

> **Why the claim carries every predicate.** `loadUsableInvite` already refuses a used, revoked or expired link before the
> transaction, so each predicate in `claim` looks redundant. It is not: between that read and the claim another request can use
> or revoke the link, and the SQL is the only place both are decided at once. `src/routes/invites.test.ts` loses that race
> deterministically (the stand-in reads the predicates out of the SQL it is given), so deleting any one of the three fails.

### 4.9 — The setup wizard: where a new tenant is sent, and how it saves (P18)

After an invite is used, a tenant that has not finished setting up lands in `#/welcome`, and every other route sends them back
there until they finish. The server half is **`src/services/onboardingWizard.ts`** and **`src/routes/onboarding.ts`**; the
dashboard half is **`dashboard/js/pages/welcome.js`** and the gate in **`dashboard/js/app.js`**. W0 (choosing a password) is the
invite page of §4.8, before there is a session; this is W1 to W6 (docs/onboarding/02 §3).

**The gate: who is sent to the wizard.**

1. `GET /api/auth/me` (**`routes/api.ts:1272`**) now answers `onboarding: { status, step, gated }` (**:1295**,
   `describeOnboardingBrief`, **onboardingWizard.ts:198**). `gated` is **`onboardingGated`** (**:179**): the tenant's status is not
   `completed`, **and** the session is not a platform admin, **and** its role in that tenant is `owner` (the only role whose writes
   can finish the wizard, so an operator or a viewer is never held by a screen they cannot complete).
2. **The owner is never gated**, in three independent ways: v34 inserted a `completed` row for every tenant that existed (it is
   `completed` in production, read-only, 2026-10-14); a tenant with **no row** reads as completed (D14); and a database that
   cannot answer returns `onboarding: null` (`onboarding.brief_unreadable`, warn), which the dashboard reads as "gate nothing".
   `completed` is the first condition checked on both sides, and `src/routes/onboarding.test.ts` fails if it is removed.
3. The dashboard keeps it in the session (`App.loadSession`) and decides in `App.mustOnboard` (**app.js:785**), which repeats the
   two conditions that must never be wrong (a platform admin is exempt; `completed` is never gated). `App.showApp` (**:695**) reads
   the session **before** it shows `#app`, so a gated tenant never sees a flash of the dashboard, and `App.navigate` (**:1249**) is
   the choke point every route passes through. `showWelcome` (**:809**) renders into `#welcome-screen`, outside `#app`, and
   `leaveWelcome` (**:835**) asks the gate again.
4. The one way in for a platform admin is `#/welcome?mode=behalf` (`wantsWelcome`, **:794**); the writes then record `by: 'admin'`.
5. The invite link may be `#/invite?t=…` (P17) or `#/welcome?invite=…` (the spec's spelling): `isInviteHash` (**:591**) takes both,
   `captureInvite` moves either token out of the address bar, and `completeInvite` (**:683**) lands a tenant that has not finished in
   `#/welcome` and anybody else (a second member, a reset) on the dashboard.

**Reading it** — `GET /api/onboarding` (**routes/onboarding.ts:60**, an operator may read): `describeWizard` (**onboardingWizard.ts:310**)
answers the status, where to resume (`resumeStep`, **:160**: the step last seen, never past the first required one still open),
the registry (`order`), each step's entry (`steps`: `{status, at, by}` once confirmed, `{values}` while only typed), the profile with
its `version` and what activation still misses, the operator's hints (the name and handle they typed) and `canEdit`.

**The two saves, which never meet.**

- **Autosave** — `PUT /api/onboarding/steps/:step { values }` (**:65**, owner only) → `saveStep` (**:370**): one `UPDATE` of one step's
  entry (`jsonb_set`), guarded by `status <> 'completed'`, and **nothing else**: no statement names `creator_profiles`, so a keystroke
  never moves the profile's `version`, never writes a history row and cannot 409 against an admin. The page sends it 800 ms after
  typing and on blur (`WelcomePage.scheduleSave`/`flush`), one at a time, in order. `validateStepValues` (**:228**) keeps a draft a
  small flat form: no nesting, no odd field names, 16 KB.
- **Continue is the confirmation** — `WelcomePage.submit` (**welcome.js:1379**) checks the step, then `PATCH /api/profile
  { version, patch }` (§4.7; **`saveProfile`, :1417**), and only when that went through `PUT … { status: 'done' }`, which **replaces**
  the step's entry (so the typed copy goes) and moves `current_step` to the next step that is switched on.
- **The 409 path** — when an admin wrote the profile in between (P19), `PATCH /api/profile` answers `409 PROFILE_VERSION_CONFLICT`
  with `currentVersion`; `reloadAfterConflict` (**:1443**) reads `GET /api/onboarding` again, shows **the same step with the newer
  values** and a note, and saves what it shows as the draft so the older typing does not come back. The step is never marked done
  on a refusal.

**Finishing** — the last screen calls `POST /api/onboarding/complete` as it opens (`enterDone`, **welcome.js:1508**) →
`completeOnboarding` (**onboardingWizard.ts:461**). It is **idempotent**: a tenant already `completed` (or with no row) answers
`alreadyCompleted: true` and writes nothing, and the `UPDATE` itself carries `status <> 'completed'`, so a second Finish that
raced the first moves neither `completed_at` nor the funnel. The first needs `activationMissing` empty (name, kind, niche, language
and register, time zone, one offer) and otherwise answers `409 ONBOARDING_INCOMPLETE` with `missing` and `fixStep`, which the page
turns into "back to the step that fixes it". It writes **only the status**: the first campaign and the DM persona belong to the
proof step (P25).

**The seam.** `WIZARD_STEPS` (**onboardingWizard.ts:54**) lists W1 to W6; **W5 (proof, P25) is listed and switched off**, so the page
leaves it out of the order and the progress count and says on the last screen what is waiting. **W4 (connect, P28) is built and is
on only when the operator has switched "Connect with Facebook" on** (`meta.login_enabled`, default off): `stepsFor(flags)`
(**onboardingWizard.ts:79**) applies `readWizardFlags` (**:87**, fail-closed) to the registry, and `firstOpenStep`, `resumeStep`,
`nextStepAfter`, `describeWizard`, `describeOnboardingBrief` and `saveStep` (**:409**) all take the flags, so with the switch off
the order, the progress count, where Continue leads from W3 and the 404 a write to `connect` answers are exactly what they were. The
setting is read only for a tenant that has not finished (the owner's `/auth/me` issues no extra query) and, in `saveStep`, only
for the step it gates or when Continue or Skip must know what comes next. W4 is optional: Skip and Continue only mark it, and
`completeOnboarding` never looks at it ([8.7](#87--the-dashboard-the-connections-card-the-page-picker-and-w4-p28)).
`WelcomePage.register(id, def)` adds a renderer for a step; the server enabling it is all the shell needs.

**The funnel** — `onboarding_events` (`recordEvent`, **:257**): `step_viewed` (when the position changes, or a step is shown for
the first time), `step_completed { ms_on_step }`, `step_skipped`, `wizard_completed { total_ms, by }`. Event names, steps and numbers
only, **never a field's value**; a failed insert is logged (`onboarding.event_failed`) and never fails the request.

> **Why the gate is written down three times.** The server's `onboardingGated`, the dashboard's `mustOnboard` and the v34 backfill
> each look redundant next to the others. They are the same rule at three layers, so the owner (whose tenant is `completed`, whose
> operators are not owners) stays out of a wizard that was built for somebody else, whichever layer is wrong: the SQL file is
> pinned by a test, the server function by a table of every combination, and the page by the same table run against the server's
> own function.

### 4.10 — Progress, the agent gate and the funnel (P30, P31)

Three things make onboarding progressive and measured: a card that says how much of the profile there is and what to do next, a
409 that stops an agent being switched on before it has what it writes from, and a funnel that says how far new tenants get. None of
them is on a running path.

**The card.** `GET /api/profile/progress` (**`routes/profile.ts:83`**, operator level) → `describeProgress`
(**`services/profile/progress.ts:41`**) reads who the tenant is (`readGateFacts`), the profile, what is connected and whether the DM
bot is on (one statement, `CONNECTIONS_SQL`), and hands them to two pure functions in **`completeness.ts`**: `completeness`
(**:131**: a weighted percent over the fields a tenant can fix from the dashboard, 100 only when none is missing) and `nextBestActions`
(**:212**: at most three, in a fixed order of what each unlocks: finish setup, connect Instagram and Facebook, voice samples, the DM
hand-off, the presenter, the portrait, the audience, then TikTok and YouTube). The answer carries ids, paths and numbers; the words are
the dashboard's (`profileCard.*`), in both languages. The Overview paints it above the briefing as its own region
(`OverviewPage.fillProfile`); an answer that is not an answer leaves the region empty, so the card can never break the page.

**The owner is measured on what his setup can hold.** A tenant with no onboarding row, one v34 inserted as `completed` that nobody
filled in, or the platform owner (`exemptionOf`, **`agentGate.ts:99`**) is `legacy`: only the fields his Studio and Growth settings
have a home for count (name, time zone, language, the main offer and its link, the portrait), so a niche, a presenter's name, an
audience, voice samples or a DM hand-off rule, which that setup was built without, are never asked of him. His percentage is his real
state over those, and he is still told about a platform he has not connected.

**The gate.** An agent's own switch-on route calls `assertAgentReady(creatorId, agent)` (**`agentGate.ts:139`**) and a tenant missing
what that agent needs answers

    409 { code: 'PROFILE_INCOMPLETE', agent, missing: [paths], fixStep: 'about' | 'voice' | 'ask' }

on top of the six activation fields (`agentMissing`, **:79**): the Monteur needs a presenter, the Growth coach an audience, the DM bot a
hand-off rule, the Studio nothing more. `fixStep` says where the first missing field is fixed: a wizard step, or `ask`, the one-field
sheet (`ProfileAsk`, components.js) the dashboard opens over the screen the person is on. `api.js` catches the 409, opens the sheet, and
sends the same request again once it was answered (once: a second refusal is a message).

| Agent | Where it is switched on | Gated when |
|---|---|---|
| Studio | `POST /studio/drafts`, `/plan`, `/infographics` (**studio.ts:328, :396, :461**) | any call: the writer needs only the six fields |
| Monteur | `PUT /studio/settings` (**studio.ts:263**), `POST /studio/monteur/run` (**:408**) | `monteur.enabled` goes false to true, or Run now |
| Growth coach | `POST /growth/coach` (**growth.ts:90**) | any call |
| DM bot | `POST /settings/ai` (**api.ts:3391**, `assertDmSwitchOn`) | the save asks for the bot ON and it was not on |

**Never gated:** the owner (decided first, before his onboarding row or his profile is read, so his path depends on neither), a tenant
that predates onboarding, and anything that runs by itself: the webhook, the queue, the cron and every service never call the gate (a
test lists its callers). **It fails open**: a database that cannot answer lets the switch through and logs `profile.gate_unreadable`
(`warn`), because it is a convenience and never the reason a tenant cannot work.

**The funnel.** `onboarding_events` is written by one function, `recordEvent` (**`services/onboardingEvents.ts:92`**), from a closed
list of ten events, each with a closed list of props that are numbers or enum words (`sanitizeProps`, **:72**): a name, an address, a
link or a sentence cannot be stored even by a caller that tries. Who writes what: `invite_created` (`issueInvite` and Regenerate, a
join link only), `invite_opened` (the first `peek` of a join link), `invite_accepted` (`acceptInvite`), the four wizard events (§4.9),
and `draft_started`, `draft_ready`, `draft_failed` (`noteDraft` in the draft state machine, `drafts.ts:82`, carrying how long and the
failure's KIND, never a provider's words). A reset link is not onboarding and writes none. Best-effort: a failed insert is
`onboarding.event_failed` and the request goes on.

`GET /api/admin/onboarding/funnel?days=30|90` (**`routes/adminOnboarding.ts`**, platform admin, 404 for everyone else) → `loadFunnel`
(**`onboardingFunnel.ts:248`**): two SELECTs over `onboarding_events` and nothing else, aggregated by the pure `buildFunnel` (**:146**).
Each tenant is placed at its furthest stage (invited, opened, password, each wizard step that is switched on, finished) and a stage's
count is the tenants that reached it or went past it. The cohort is the tenants whose FIRST event is in the window. Median times are
over the tenants that have both ends, `abandoned` is derived (not finished, quiet for a day), and the answer holds no tenant id.
Operations draws it below the AI providers card, loading after the page so the tenants above never wait for it.

**Forgetting.** `runRetentionSweep` (**`retention.ts`**) ends with `pruneOnboardingData` (**`onboardingRetention.ts:81`**), once per sweep:
events older than 180 days, invites never used that expired more than 30 days ago (a used invite stays: it is how a person came to
hold their membership), and the raw text a settled draft fetched (`sources`, set to NULL 30 days after it finished; the draft row, its
answers and its cost stay, and a draft still being made is never touched). Three statements, three tables, nothing else; each cutoff
is computed in TypeScript and sent as a parameter, so a row exactly as old as the limit is kept. The draft statement lives in
`draftStore.ts`, the one module that names `profile_drafts`.

---

## 5. Job lifecycle

Everything in flows 1 and 2 rides on this. `src/jobs/` is four files: `types.ts` (vocabulary),
`queue.ts` (transport), `runner.ts` (driver), `handlers.ts` (work), plus `drain.ts` for
production wiring.

### 5.1 — Enqueue

**`src/jobs/queue.ts:39`** — `PostgresJobQueue.enqueue`.

```sql
INSERT INTO jobs (kind, payload, creator_id, dedupe_key, run_after, max_attempts, request_id, tenant_key)
VALUES ($1, $2::jsonb, $3, $4, COALESCE($5, NOW()), COALESCE($6, 3), $7, COALESCE($8, $3::text))
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
RETURNING id
```
(**`src/jobs/queue.ts:45-48`**)

- **`ON CONFLICT (dedupe_key)`** drops a second enqueue **whatever the state of the first —
  including `done`**, which is what makes a Meta redelivery a no-op before it costs a Gemini call
  (**`src/jobs/types.ts:75-80`**). The index is partial, so rows with no key never conflict.
- `max_attempts` defaults to **3**.
- `run_after` defaults to `NOW()`; supplying it is what makes the queue a scheduler
  (**`src/jobs/types.ts:92`**).
- `tenant_key` COALESCEs to `creator_id` **at insert time** (**:46**) so the claim can partition
  on the bare column and use its index — doing the COALESCE in the claim's `PARTITION BY` would
  cost a sort on every claim (**`src/jobs/queue.ts:41-44`**).

Returns `null` on a dedupe (**:66**), logged at `debug` (**:65**).

The payload stores the Meta event **verbatim**, not pre-normalised
(**`src/jobs/types.ts:26-34`**): a bug in the normaliser would otherwise be unrecoverable,
whereas the raw event means a fixed normaliser can be replayed against jobs that already failed.
It also keeps the enqueue path free of any logic that could throw before the acknowledgement.

`JobKind` is a closed union — `'comment.process' | 'dm.process'` (**`src/jobs/types.ts:19-20`**)
— rather than a free string, because an enqueue for a kind with no handler is a job that fails
`max_attempts` times and then sits in the table forever.

### 5.2 — The atomic claim, and why not `FOR UPDATE SKIP LOCKED`

**`src/jobs/queue.ts:77`** — `claim(limit)`. The query is **`src/jobs/queue.ts:106-126`**:

```sql
WITH ranked AS (
    SELECT id, run_after,
           ROW_NUMBER() OVER (PARTITION BY tenant_key ORDER BY run_after, created_at) AS tenant_rank
      FROM jobs
     WHERE status = 'pending' AND run_after <= NOW()
),
picked AS (
    SELECT id FROM ranked ORDER BY tenant_rank, run_after LIMIT $1
)
UPDATE jobs
   SET status = 'running', claimed_at = NOW(), attempts = attempts + 1, updated_at = NOW()
 WHERE id IN (SELECT id FROM picked)
   AND status = 'pending'
RETURNING …
```

> **What makes it atomic is `AND status = 'pending'` on the UPDATE (line 125) — not the ranking,
> and not row locking.** If a concurrent drain took a row between this statement's snapshot and
> its write, the UPDATE waits on that row's lock and then **re-evaluates its WHERE against the
> committed version** — which now reads `'running'`, so the row matches nothing and is returned
> to no one. Two concurrent drains therefore split the work; they cannot both run the same job,
> which would be a duplicate DM to a real person.
>
> **`FOR UPDATE SKIP LOCKED` is deliberately absent, and this is the load-bearing part.**
> Postgres **rejects it outright in the presence of a window function** — *"FOR UPDATE is not
> allowed with window functions"* — so the shape an earlier version of this comment described
> **could never have run at all**. The `status` guard gives the same guarantee. The only thing
> lost is that a contending claimer waits a moment rather than skipping ahead, and that wait is
> the length of one autocommit UPDATE. Spelled out twice, at **`src/jobs/queue.ts:17-20`** and
> **`src/jobs/queue.ts:99-104`**, and again at the route in **`src/routes/api.ts:323-326`** —
> because "just add SKIP LOCKED" is the obvious review comment and it does not compile.

**Round-robin fairness.** `ROW_NUMBER() OVER (PARTITION BY tenant_key ORDER BY run_after,
created_at)` ranks each tenant's pending jobs oldest-first; `ORDER BY tenant_rank, run_after`
then takes **every tenant's oldest job before anyone's second**. This was `ORDER BY run_after` —
strict FIFO — so a tenant whose reel went viral could fill the queue with ten thousand events and
every other tenant's DMs waited behind all of them (**`src/jobs/queue.ts:78-84`**).

Partitioning on the bare `tenant_key` column lets
`idx_jobs_claimable_fair (tenant_key, run_after) WHERE status = 'pending'` satisfy both the
`PARTITION BY` and the `ORDER BY` without a sort. Jobs with no key at all form **one** group
together — the conservative answer: they share a slot rather than each getting one
(**`src/jobs/queue.ts:85-91`**).

After the query, **`src/jobs/queue.ts:134-138`**: a row whose `kind` has no registered handler is
failed permanently and skipped, rather than crashing the drain — that is how one bad job stops
every other tenant's work.

### 5.3 — Running one job

**`src/jobs/runner.ts:66`** — `runOne`. Never throws.

It re-establishes the **correlation id from the enqueueing request**
(**`src/jobs/runner.ts:74-81`**), so a log search for one Meta delivery turns up the work it
caused and not just its acknowledgement.

Dispatch is **`src/jobs/runner.ts:89`**. The registry is keyed by the same union `job.kind` is
narrowed to, but the per-kind payload types make the pairing unprovable to the compiler without a
discriminated switch at every call site — so the cast is asserted once, here.

Success → `queue.complete(job.id)` (**:92**, `status = 'done'`, `last_error = NULL`,
**`src/jobs/queue.ts:153`**).

### 5.4 — Failure, backoff and jitter

**`src/jobs/runner.ts:95-118`**.

- `exhausted = job.attempts >= job.max_attempts` (**:97**). `attempts` was already incremented by
  the claim.
- `retryIn = exhausted ? null : backoffSeconds(job.attempts, random)` (**:98**).
- Log level flips on exhaustion: `job.failed` at `error`, `job.retrying` at `warn` (**:103**),
  with `retry_in_seconds` and `attempts_remaining`.
- `queue.fail(job.id, message, retryIn)` (**:111**), itself wrapped in a try — if *that* write
  fails the job stays `running` and the reaper is the backstop, so all it can do is say so
  (**:112-116**).

`backoffSeconds` — **`src/jobs/runner.ts:36`**:

```js
base   = 30 * 4 ** Math.max(0, attempts - 1)
capped = Math.min(base, 3600)
return Math.round(capped * (0.5 + random()))
```

≈ 30 s, 2 m, 8 m, capped at an hour, each multiplied by a random factor in `[0.5, 1.5)`.
**Jittered because the failure that triggers a retry is usually shared** — a Meta outage, an
expired token — so every job in the batch fails at once and would otherwise retry in lockstep,
turning one outage into a thundering herd against a service that is already unhappy. Mirrors
`withRetry` in `src/services/http.ts`.

`queue.fail` (**`src/jobs/queue.ts:160`**) has two branches: `retryInSeconds === null` →
`status = 'failed'` (**:162-169**); otherwise back to `'pending'` with
`run_after = NOW() + interval` (**:173-181**). `last_error` is truncated to 2000 chars both
ways — a Meta error body can be long and this column is read in a dashboard list view.

### 5.5 — The drain loop and its budget

**`src/jobs/runner.ts:129`** — `drainJobs`. Loop while `claimed < maxJobs`:

1. **Budget check before claiming** (**:144-147**) → `budgetExhausted`, break.
2. Claim `min(batchSize, maxJobs - claimed)` (**:151**). A claim failure logs and breaks
   (**:152-155**).
3. Empty batch → break (**:157**).
4. Run each job, **re-checking the budget inside the batch** (**:166-169**) — a batch of five DM
   jobs is potentially 40 seconds of Gemini, and the budget has to be able to stop it partway.

> **Why a budget at all.** A serverless invocation has a wall clock, and a drain that starts a
> 30-second Gemini call with 4 seconds left produces exactly the failure the queue was built to
> prevent — work abandoned mid-flight. So the loop stops rather than starting work it probably
> cannot finish. Anything left is still `pending`; the next drain takes it
> (**`src/jobs/runner.ts:9-13`**).

Two wirings (**`src/jobs/drain.ts`**):

| | `drainInline` (**drain.ts:38**) | `drainWorker` (**drain.ts:82**) |
|---|---|---|
| called by | the webhook, after the 200 | `GET /api/jobs/drain`, `GET /api/cron/publish` |
| budget | 8 s (`JOB_INLINE_BUDGET_MS`, **:21-24**) | 45 s (`JOB_WORKER_BUDGET_MS`, **:27-30**) |
| batch / max | 3 / 10 (**:64-68**) | 5 / 100 (**:97-98**) |
| reaps first | yes (**:54**) | yes (**:87**) |
| on error | swallows, returns null (**:70-73**) | reap failure logged, drain proceeds (**:88-91**) |

`drainInline` never throws and never rejects: it runs after the response has been sent, where an
unhandled rejection is an unexplained platform error and nothing more.

`drainInline` reaps too, and that matters more there than in the worker: the inline drain is
precisely the one that gets frozen, and on a deployment with no external scheduler a job claimed
and then frozen sits at `running` for up to 24 hours — invisible, for a delivery the app was
perfectly able to finish on the next webhook seconds later (**`src/jobs/drain.ts:41-52`**).

### 5.6 — `reapStale`'s two branches

**`src/jobs/queue.ts:184`**, called with `CLAIM_VISIBILITY_SECONDS = 300`
(**`src/jobs/runner.ts:26`**). Deliberately **two statements**, because the two outcomes are
genuinely different:

1. **Abandoned** (**`src/jobs/queue.ts:188-198`**) — `status = 'running'`, claim older than the
   window, **`attempts >= max_attempts`** → `status = 'failed'`, with
   `' [abandoned: the claim went stale and no attempts remain]'` appended to `last_error`. A
   permanent failure an operator has to look at.
2. **Requeued** (**`src/jobs/queue.ts:200-207`**) — same, but **`attempts < max_attempts`** →
   back to `'pending'`, `claimed_at = NULL`. It goes round again.

Either logs `job.reaped` with both counts (**:209-211**). Mirrors the scheduled-post reaper in
`api.ts` ([3.5](#35--daily-maintenance-only-on-the-daily-cron)).

The window has to exceed the longest a single job can legitimately take — a Gemini call up to its
30 s timeout plus a Meta send with retries. Five minutes is generous on purpose: **reaping a job
that is still running is how a DM gets sent twice**, which is worse than a stranded job being
retried a few minutes late (**`src/jobs/runner.ts:18-25`**).

### 5.7 — Prune

**`src/jobs/queue.ts:228`** — `pruneCompleted(olderThanDays, limit)`. **Only `done` rows**
(**:233**): a `failed` row is the one an operator needs to look at, and `pending`/`running` are
live work.

Batched via a `LIMIT`ed subselect (**:231-236**) because a first run against months of history
must not be one `DELETE` inside an invocation with a wall clock — a `DELETE` that times out rolls
back entirely and never makes progress. Called from `runRetentionSweep()` on the daily cron
(**`src/routes/api.ts:703`**); it converges over several runs rather than clearing everything at
once.

Each `done` row holds a verbatim Meta event, so this is a retention question and not only a
storage one.

### 5.8 — The handler contract

**`src/jobs/types.ts:107`** — `JobHandler`.

> **Throwing means "retry me".** The runner records the error and schedules a backoff until
> `max_attempts` is spent. Returning normally means done. **There is deliberately no third
> outcome**: a handler that wants to give up permanently should *return*, having recorded why in
> its own domain table (`interactions.error_log`, `messages.handled_at`), because that is where an
> operator looks. `jobs.last_error` is for the runner's own failures, not for business outcomes.
> (**`src/jobs/types.ts:98-106`**.)

That is the whole reason both pipelines take `WebhookHandlerOptions.lastAttempt`
(**`src/webhook/options.ts:14`**): on the final attempt "throw to retry" is no longer available,
so the outcome has to be written down as final instead — an interaction stranded at PENDING is
indistinguishable, in the dashboard, from the webhook having stopped.

`JobStatus` also carries `'cancelled'` (**`src/jobs/types.ts:56`**), set by
`POST /api/admin/jobs/:id/cancel` on a pending job an operator has decided must never run. It is
distinct from `failed` because the failed list is the queue's work list, and nothing on a hot
path can see it — the claim filters `pending`, the reaper `running`, the retention sweep `done` —
so the row is inert.

---

## 6. TikTok post → inbox → published

A video is scheduled for TikTok, alone or beside a Meta post. At the scheduled time it is
uploaded into the creator's TikTok inbox; they post it from the TikTok app, and TikTok tells us.
Photo posts (`image`, `carousel`, v20) share this lifecycle with no upload step — see
[3.6](#36--carousels-v20).

Inbox mode (scope `video.upload`), not Direct Post: unaudited apps are forced to SELF_ONLY, and
the audit rejects own-account tools (**`src/services/tiktok.ts:9-14`**).

### 6.1 — Connecting, once per tenant

1. **`src/routes/tiktok.ts:210`** — `POST /api/tiktok/connect`, owner only (`canAdminister`,
   **:179**). Needs `getTikTokAppConfig()` (**`src/services/appSettings.ts:103`** — `app_settings`
   first, then `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`).
2. `redirectUriFor` (**`src/routes/tiktok.ts:45`**) → `getPublicBaseUrl`
   (**`src/services/appSettings.ts:183`**): the `app.public_base_url` setting, then
   `PUBLIC_BASE_URL`, then — last resort — the request origin.
3. `createOAuthState` (**`src/services/tiktokConnections.ts:49`**) inserts a 32-byte nonce into
   `oauth_states` with the tenant and user, 10-minute TTL. The route sets the same value as an
   HttpOnly, `SameSite=Lax` cookie with `Path=/api/tiktok/callback` (**`src/routes/tiktok.ts:67-71`**,
   **:223**) and returns the authorize URL (`buildAuthorizeUrl`, **`src/services/tiktok.ts:143`**).
4. **`src/routes/tiktok.ts:85`** — `GET /api/tiktok/callback`, on `tiktokPublicRouter`, which is
   mounted above `requireAuth` (**`src/routes/api.ts:1090`** vs **:1093**). The cookie must equal
   `state` (**`src/routes/tiktok.ts:105-110`**), then `consumeOAuthState`
   (**`src/services/tiktokConnections.ts:64`**) spends it in a single
   `UPDATE … WHERE used_at IS NULL AND expires_at > NOW() RETURNING`.
5. `completeConnection` (**`src/services/tiktokConnections.ts:139`**) — `exchangeCode`
   (**`src/services/tiktok.ts:200`**, not retried: the code is single-use), a best-effort
   `getUserInfo`, then an upsert into `platform_connections` with both tokens `enc:v1:`. The same
   `open_id` on another tenant is a 23505 → `account_in_use` (**:198**).
6. **Where the browser comes back to (P28).** Settings, unless the setup wizard began the flow: `POST /connect { returnTo: 'welcome' }`
   (also YouTube's) writes `oauth_states.return_to` in **its own statement after the v18 INSERT**
   (`setStateReturnTo`, **`oauthState.ts:183`**), so a Settings flow still issues exactly the v18 statements and a database without
   v35 still connects; a failed write is only a flow that returns to Settings. The callback reads it back with `readStateReturnTo`
   (**:192**, from a state of its own platform only) after the state is spent (or, for a cancelled dialog, once the cookie matched
   it) and redirects with `returnDestination` (**:53**): `#/welcome?step=connect&tiktok=…` instead of `#/settings?tiktok=…`. A refusal
   that cannot trust the browser or the state (no cookie, a different one, a spent or expired state) cannot know where the flow began
   and goes to Settings.

> **Why the state lives in the DB *and* a cookie.** Dashboard sessions are Bearer tokens in
> localStorage, so TikTok's redirect back carries no session at all. The nonce is the only thing
> binding the returned code to a tenant; the cookie means a state lifted from a log or a referrer
> cannot be completed from another browser (**`src/config/migration_v18_tiktok.sql:66-71`**).

> **Why not the Host header.** TikTok matches `redirect_uri` byte for byte against the one
> registered in its portal, and a Host-derived URI differs on every preview deployment
> (**`src/services/appSettings.ts:24-31`**).

### 6.2 — Creation

**`src/routes/api.ts:2131`** — `POST /api/posts/scheduled`, the same route as
[3.1](#31--creation).

- `also_tiktok: true` (**:2137**) adds a TikTok row beside the Meta one; `platform: 'tiktok'`
  alone also works. `both` still means IG+FB.
- A bad `scheduled_time` is a 400 (**:2144-2148**), not the 500 the INSERT used to throw.
- TikTok needs a `media_url` and an **active** connection, checked now (**:2169-2182**) rather
  than at publish time.
- The rows are inserted in one transaction (**:2193-2208**) and share a `group_id`
  (**:2184-2186**). TikTok rows get no `cover_url` (**:2202**).
- `publish_now` (**:2218**) claims each row with the sweep's `claimed_at` UPDATE (**:2226-2232**)
  and hands it to `publishClaimedPost` (**:2236**). This branch used to set PUBLISHING without
  `claimed_at`, so a row whose invocation died was never reaped.

### 6.3 — Dispatch

Every publish path — `publishDuePosts` (**`src/routes/api.ts:788`**), create-time `publish_now`
(**:2236**) and `POST /api/posts/scheduled/:id/publish-now` (**:2445**) — calls
`publishClaimedPost` (**`src/routes/api.ts:688`**). `platform === 'tiktok'` goes to
`publishTikTokPost` (**:689-698**); everything else to `attemptPublish`, which now fails closed on
a non-Meta platform (**:580-582**). An unknown platform used to fall through to a PUBLISHED write
with an empty id.

### 6.4 — `publishTikTokPost()`: the upload

**`src/services/tiktokPublish.ts:471`**. The row is already `PUBLISHING`.

1. `video`, `image` or `carousel`; a video needs `media_url` (**:479-483**). A photo post
   branches off after step 3 — see [3.6](#36--carousels-v20).
2. **Pending-draft limit** (**:183-186**) — `pendingInboxShares` (**:65**) counts this tenant's
   `PROCESSING` / `IN_INBOX` rows claimed in the last 24h. At 5 (`MAX_PENDING_INBOX_SHARES`,
   **:54**) it throws `TikTokInboxFullError`, and the catch puts the row back to **PENDING** with
   the reason in `error_log` (**:259-267**). Held, not failed: the sweep logs
   `cron.publish_held_tiktok_inbox` (**`src/routes/api.ts:796-799`**); publish-now answers 409
   (**`src/routes/api.ts:2452-2455`**).
3. `getAccessToken` (**`src/services/tiktokConnections.ts:299`**) — refreshes when within 10 min of
   expiry, under the `refresh_claimed_at` claim (`refreshUnderClaim`, **:244**). If another
   invocation holds the claim it waits for it rather than refreshing in parallel.
4. `loadMedia` (**`src/services/tiktokPublish.ts:87`**) — an `/api/uploads/<uuid>` URL is read
   straight from the media store (`media_uploads` bytes), not fetched over HTTP.
5. `planChunks` (**`src/services/tiktok.ts:296`**): up to 64MB goes whole, otherwise 32MB chunks
   with the remainder on the last.
6. **Resume check** (**`src/services/tiktokPublish.ts:200-213`**) — a row that already has an
   `external_publish_id` reached TikTok before; ask `fetchPublishStatus` first rather than upload
   a duplicate draft against the 5-a-day limit.
7. `initInboxVideoUpload` (**`src/services/tiktok.ts:339`**) — `source: 'FILE_UPLOAD'`, caption as
   the undocumented `post_info.title`; on `invalid_params` it retries once without it
   (**:366-374**). Otherwise NOT retried: a 5xx may already have created a pending share.
8. `external_publish_id` is written **before** any bytes go up
   (**`src/services/tiktokPublish.ts:218-221`**), so a crash from here on is resumable.
9. `uploadChunks` (**`src/services/tiktok.ts:381`**) — sequential PUTs with `Content-Range`, each
   retried (a re-PUT is safe). Then `PROCESSING` (**`src/services/tiktokPublish.ts:228-232`**).
10. **Inline poll** (**:237-256**) — every 3s for 12s, `fetchPublishStatus` → `applyStatus`. A
    small reel usually reaches `IN_INBOX` here, so "Publish now" shows the real outcome. Anything
    still processing returns `PROCESSING` and is left to 6.5.

> **Why FILE_UPLOAD, not PULL_FROM_URL.** Pulling needs the URL prefix verified in TikTok's
> portal, and TikTok would fetch through `/api/uploads/:id`, whose response Vercel caps at 4.5MB.
> Pushing the bytes is an outbound request with neither problem (**`src/services/tiktok.ts:16-19`**).

### 6.5 — Three writers, one idempotent transition

After the upload the row is `PROCESSING`, then `IN_INBOX` while it waits for the creator, then
`PUBLISHED` once they post it (TikTok's `PUBLISH_COMPLETE`). Three things move it, all through
`applyStatus` (**`src/services/tiktokPublish.ts:111`**):

| Writer | Where | When |
|---|---|---|
| inline poll | **`tiktokPublish.ts:237-256`** | the 12s after upload |
| webhook | `POST /api/tiktok/webhook`, **`src/routes/tiktok.ts:146`** → `applyWebhookEvent` (**`tiktokPublish.ts:359`**) | TikTok pushes `post.publish.*` |
| sweep | `reconcileTikTokPosts` (**`tiktokPublish.ts:286`**), from `/api/jobs/drain` (**`src/routes/api.ts:366`**) and the daily cron (**`src/routes/api.ts:874`**) | `PROCESSING` every 30s; `IN_INBOX` every 10 min, for 7 days |

`applyStatus` maps TikTok's status (`mapPublishState`, **`src/services/tiktok.ts:503`**), and each
UPDATE names the states it may be reached from (**`tiktokPublish.ts:118-150`**): a late
`PROCESSING` cannot drag an `IN_INBOX` row back, and a success may overwrite a FAILED our side
wrote after a timeout. `published_post_id` becomes `TT:<id>` (**:141**) — only public, moderated
posts get an id, so PUBLISHED with no id is normal.

- **Webhook auth** — `verifyTikTokSignature` (**`src/services/tiktok.ts:532`**):
  `Tiktok-Signature: t=…,s=…`, HMAC-SHA256 of `"<t>.<raw body>"` keyed with the client secret,
  over `req.rawBody` (**`src/index.ts:51`**). No freshness window, because TikTok retries for 72h;
  a replay is harmless because the transitions are idempotent. A rejection is a logged 401
  (**`src/routes/tiktok.ts:150-157`**).
- **Webhook events** (**`tiktokPublish.ts:348-353`**) — unknown events are 200'd and ignored; the
  `publish_id` must match a row, and its `open_id` the same tenant (**:369-380**).
  `authorization.removed` deletes the connection row (**:360-364**, `deleteConnectionByOpenId`,
  **`src/services/tiktokConnections.ts:398`**).
- **Give-up** — a `PROCESSING` row TikTok is silent about for 24h is FAILED
  (**`tiktokPublish.ts:321-325`**); an `IN_INBOX` draft is simply left alone after 7 days.
- **Post ids** — TikTok sends them as int64 JSON numbers. `fetchPublishStatus`
  (**`src/services/tiktok.ts:446`**) keeps the raw text and `parseJsonKeepingIds` (**:437**) quotes
  the ids before parsing; plain `JSON.parse` would round them to a different video's id.

### 6.6 — Daily token check

`GET /api/cron/publish` runs `refreshAllConnections()` (**`src/routes/api.ts:870`**,
**`src/services/tiktokConnections.ts:327`**) before its reconcile sweep. Access tokens last 24h;
the refresh token lasts 365 days from the **first** authorization, and refreshing does not extend
it. A refused refresh marks the row `invalid` so Settings asks for a reconnect
(**`tiktokConnections.ts:270-283`**) — found by the cron, not by the next post.

> **Why refreshes are serialized.** TikTok may rotate the refresh token on every refresh. Two
> concurrent refreshes would each receive a new one, and the loser's write would store a dead
> token. The `refresh_claimed_at` claim (**`tiktokConnections.ts:245-253`**) allows one at a time;
> a claim older than 2 min belongs to a dead invocation and is taken over.

---


### 6.7 — Direct Post (v19), when the operator switches it on

Inbox mode leaves privacy, interactions and disclosure to TikTok's editor. Direct Post has no
editor step, so TikTok's Content Sharing Guidelines move those choices into our composer, and
a scheduled row carries them in `scheduled_posts.platform_options` until it publishes.

1. **Mode is decided at creation** (`src/routes/api.ts:2191`). The post is `direct` only if
   the connection holds `video.publish` **and** app setting `tiktok.direct_post_enabled` is
   `'true'` (`postModeFor`, `src/routes/tiktok.ts`). Otherwise it's `inbox`, and every TikTok
   row created before v19 (`platform_options` NULL) counts as inbox.
2. **Choices are validated** by `validateTikTokOptions` (`src/services/tiktokPublish.ts:61`):
   - consent is required;
   - a privacy level is required, and there is no default;
   - only `SELF_ONLY` is allowed while `tiktok.audited` isn't `'true'`;
   - branded content can't be `SELF_ONLY`;
   - every toggle defaults to off;
   - `consent_at` is stamped.
3. **The composer's panel** is built from live `creator_info`, via `GET /api/tiktok/creator-info`
   (`src/routes/tiktok.ts:234`).
4. **At publish time**, `startDirectPost` (`src/services/tiktokPublish.ts:228`) re-reads
   `creator_info` and checks everything again before anything is posted:
   - the privacy level must still be offered;
   - the duration comes from the MP4 `mvhd` box (`mp4DurationSeconds`,
     `src/services/tiktok.ts:514`) and must fit the creator's maximum;
   - SELF_ONLY is enforced while unaudited.

   Interactions the creator has disabled are forced off. The call is then `/v2/post/publish/video/init/`,
   which is not retried, because a 5xx may already have posted.
5. **Status:** `PROCESSING_UPLOAD` → `PUBLISH_COMPLETE` → PUBLISHED, and a post id arrives only
   for public, moderated posts. Direct rows are excluded from the 5-draft inbox count.

**Unaudited** (true until TikTok approves the app): TikTok also requires the creator's
**account** to be private at posting time, or the call fails with
`unaudited_client_can_only_post_to_private_accounts`.

## 7. Claude on the Mac → who may ask

Two kinds of Studio work are answered by Claude Code on the **owner's Mac, on his personal Claude plan**: a
`monteur_think` (`monteur.brain: 'claude_mac'`) and a `render_infographic` whose payload has `write`. Anthropic's
terms forbid routing anyone else's work through that plan, so the server refuses it for every tenant the Mac is not
for (G1, `src/services/macBrain.ts`).

**The owner is always allowed; the list adds tenants.** The owner is the first creator ever made
(`getPlatformOwnerId`, `tenant.ts`: `ORDER BY created_at, id`, **no `is_active` filter**, cached 30 s), so
deactivating him cannot hand the Mac to tenant #2, and no setting can take it from him. The app setting
`studio.mac_brain_tenants` (a JSON list of creator ids) names the tenants allowed besides him: unset, `null` and `[]`
all mean "the owner only", so a tenant created tomorrow is refused by default. With no creators at all, nobody is
allowed. The refusal is a `MacBrainRefused`, a `StudioError` that answers **409** `{ error, code: 'NEEDS_API_BRAIN' }`.

1. **A think is queued** only by `think()` (**`src/services/monteur/think.ts:246`**), which checks first, before a
   try is read or queued. `ask()`'s Mac route (`model.ts`) is the only way in, so the pick, the Marketer, the Editor
   and the Analyst are all covered. A refused source stops at once with the reason (`failAttempt`,
   **`sweep.ts:209`**); a refused Analyst run fails with it; neither falls back to Gemini.
2. **An infographic is written** by `createInfographic` (**`infographics.ts:149`**) and by `rerenderInfographic` with
   `rewrite: true` (**`:221`**): before any row is written or locked, so the operator gets the 409 and nothing is left
   `writing`. A row with no spec yet is a rewrite whatever the body says, and step 3 refuses that one. A render alone
   (an edit, a copy, the other theme, the second half of "both themes") asks Claude nothing and is never refused.
3. **The net:** `enqueueJob` (**`studio/jobs.ts:88`**) refuses any `monteur_think` or `render_infographic` with
   `write` whoever calls it.
4. **The claim:** a job already queued (before the guard, or for a tenant since taken off the list) is **failed with
   the same reason instead of being handed to the worker**, in the claim that found it, and the claim goes on to the
   next job (`claimJob`, **`jobs.ts:300`**, at most 50 refusals per poll). Its infographic goes `failed` with the
   message; a failed think is one try, and `think()` refuses before another is queued. If the allow-list **cannot be
   read** after the claim, the job is **released** (`RELEASE_CLAIM_SQL`: `pending`, attempt unspent) before the error
   goes on, so it is neither handed out unchecked nor left `claimed` for 15 minutes.
5. **The settings:** a tenant the Mac is not for cannot switch `monteur.brain` to `claude_mac`: 400 with the same
   message and code (`applyStudioPatch`, **`studio/settings.ts:331`**). Only the switch is refused.
6. **The operator surface:** platform admin `GET` / `PUT /api/admin/mac-brain-tenants` (**`routes/admin.ts:392`**,
   **`:405`**). `GET` reports `platform_tenant` (the owner) and `extra_tenants` (the saved list). `PUT { tenants: [ids] }`
   saves the list (`[]` is allowed; every id must be a creator), `{ tenants: null }` forgets it; each write is one
   `settings.mac_brain_write` audit row. No dashboard card yet: the AI providers card (P20d) will host it.

> **Fails closed, but never against the owner.** The list is read on every call. A read that errors throws; it is
> never a yes. A saved value that is not a list of UUIDs is logged (`studio.mac_brain_setting_unreadable`) and
> ignored, which leaves the owner alone. Tenants get the Monteur and infographics through the AI providers layer.

## 8. Meta login → a connected Page

A tenant connects its own Facebook Page and Instagram account with Facebook Login for Business instead of the operator
pasting a token (P26, P27; migration v35; `docs/onboarding/04`). The result is the same row a pasted token fills
(`creators`: the ids, an encrypted PAGE token, the `token_*` columns) plus what v35 added, so everything after the connection
(§1, §2, §3) is unchanged. **It is off until the operator switches it on** (`meta.login_enabled`), and nothing here touches a tenant
that is already connected unless its owner asks.

The state mechanism is shared with TikTok and YouTube (**`src/services/oauthState.ts`**); §6.1 is the same flow for TikTok.

### 8.1 — Starting: `POST /api/meta/connect`

1. **`src/routes/meta.ts:199`** — owner only (`canAdminister`). Body `{ returnTo?: 'settings' | 'welcome', reconnect?, authType? }`.
   `loginAvailability` (**`src/services/metaLogin.ts`**) answers three things or the route answers 409 with a code:
   `META_LOGIN_DISABLED` (the switch is off, the default), `NOT_CONFIGURED` (`META_APP_ID` / `META_APP_SECRET`) and
   `NO_BASE_URL`. The redirect URI is `app.public_base_url` + `/api/meta/callback` and **never** the request's Host (`metaRedirectUri`;
   TikTok's and YouTube's fall back to it as a last resort, this one does not).
2. `mayConnect` (**`metaLogin.ts:505`**) refuses a tenant that already has a token unless the body says `reconnect: true`:
   409 `ALREADY_CONNECTED`, and no state is minted. This is the first of two checks (§8.3 makes the second).
3. `createOAuthState` (**`oauthState.ts:72`**) inserts a 32-byte nonce, purpose `meta`, with the tenant, the user, `return_to` and an
   **encrypted** payload `{ v: 1, reconnect }`; 10-minute TTL. The route sets the nonce as an HttpOnly, `Secure`, `SameSite=Lax`
   cookie with `Path=/api/meta/callback` and returns `buildLoginUrl`: `https://www.facebook.com/v26.0/dialog/oauth` with
   `client_id`, `redirect_uri`, `state`, `response_type=code` and, with the `meta.login_config_id` setting, `config_id` (and
   `override_default_response_type=true`, which makes a Business Login configuration return a code). With no id it sends
   `scope=` instead (`LOGIN_SCOPES`: `REQUIRED_SCOPES` plus the two insights). A reconnect adds `auth_type=rerequest|reauthorize`.

### 8.2 — The callback: `GET /api/meta/callback`

On `metaPublicRouter`, mounted above `requireAuth` (**`src/routes/api.ts:1246`**, before the `requireAuth` line below it). Every way
out clears the cookie and redirects to `/dashboard#/settings` or `#/welcome` (the state's `return_to`) with `meta=connected|error|pick`,
`reason=…` and `warn=…` in the **hash** query, where `App.hashParam` reads them.

1. **`error=` from Meta** (`access_denied`, or any other): spend the state if cookie and state agree (that is how the callback
   learns `return_to`), then `reason=denied` or `meta_error`. No `state` or no `code`: `missing_code`.
2. **cookie == state, before anything is spent** (**`meta.ts:114`**). A state lifted from a log and replayed elsewhere fails here
   without burning the legitimate one: `state_mismatch`, no database call.
3. `consumeOAuthState(state, 'meta')` (**`oauthState.ts:134`**): one `UPDATE … WHERE nonce = $1 AND platform = $2 AND used_at IS NULL
   AND expires_at > NOW() RETURNING`. Spent, expired, unknown, or minted for another flow (a TikTok state, a Page pick): `state_expired`.
   **Single-use is that clause**: a replay finds nothing and asks Meta nothing.
4. The switch is re-read (`disabled`) and the redirect URI rebuilt (`no_base_url`); then `finishLogin` (**`metaLogin.ts:773`**):
   - `mayConnect` again, **before the code is spent**: a connected tenant whose state carries no `reconnect` ends here with
     `already_connected`, Meta never called, the row untouched. `reconnect` comes only from the state's encrypted payload, never
     from the query string.
   - `exchangeCode` (not retried: a code is single-use) then `extendUserToken` (`fb_exchange_token`), then `/me`, `/me/permissions`
     and `/me/accounts?fields=id,name,access_token,tasks,instagram_business_account{id,username}` in parallel. Tokens travel in the
     `Authorization` header; paging follows the cursor, never `paging.next` (a URL with the token in it).
   - Nothing granted → `not_tester` (the person holds no role on the app: **unverified**, docs/onboarding/04 §4). A core permission
     declined (`CORE_SCOPES`) → `permissions_missing`. No Page → `no_pages`.
   - `planPages`: **exactly one usable Page with an Instagram account** (usable = `MANAGE`, or `CREATE_CONTENT` + `MODERATE`) connects
     at once (§8.3). Anything else (two Pages, a Page with no Instagram account, nothing usable, or a reconnect that would **replace**
     the connected Page) is stored for the picker: `createOAuthState({ purpose: 'meta_pick', payload })`, the Pages and their tokens
     encrypted, a token kept only for a Page the user can run. Redirect to `#/connect-meta?meta=pick&pick=…`.
5. **The user token exists only inside `finishLogin`.** It is not stored and not passed on; only Page tokens are, encrypted.

### 8.3 — `completeMetaConnection` (**`metaLogin.ts:619`**): the one place a connection is written

1. `assertMayConnect` again (the second check), and `replacesConnection`: a reconnect to **different** ids needs
   `confirmPageChange` (409 `page_change_unconfirmed`); gaining an id the tenant lacked, or the same ids again, is not a change.
2. `validateSuppliedToken` (moved here from `routes/admin.ts`): `debug_token` must say type PAGE, the check a pasted token gets.
3. `assertPageFree` → `pageIdConflict` (also moved): a Page or Instagram account **another tenant holds** is 409 `page_in_use`
   before Meta is asked to subscribe it. The other tenant is never named. (The unique indexes are the second line: a `23505`
   at the write is the same answer.)
4. `subscribePage`: `POST /{page}/subscribed_apps` with `subscribed_fields=feed,messages,messaging_postbacks` and the Page token,
   then `GET` the edge to confirm. A failure is a **warning** (`subscribe_failed` / `subscribe_unconfirmed`); the connection is still saved.
5. **One `UPDATE`**: ids, encrypted token, `token_*` columns, `meta_user_id`, `meta_page_name`, the verified Instagram username,
   `meta_connected_at`, `meta_webhook_subscribed_at`. Its `WHERE` is `id = $1 AND ($13 OR page_access_token IS NULL)`, so a
   connection made by another request in the meantime is not overwritten. Then `invalidateTenantCache()` and a `meta.connect` audit row
   (ids and facts, never a token).

### 8.4 — The Page pick: `GET /candidates?pick=` and `POST /select`

Owner only. The pick is read for the tenant **and** the user who made it, else 404 (a legacy shared-password session, whose user is
NULL, matches only itself). `candidates` returns names, ids, why a Page is disabled and whether choosing it would replace the connection;
never a token. `select` validates **before anything is spent** (a Page with no role, no Instagram account without `facebookOnly`, a
missing confirmation, a Page another tenant holds: each leaves the pick standing), then `consumePick` (**`oauthState.ts:193`**) spends
the row **and sets its `payload` to NULL in the same statement**: the Page tokens leave the table at the moment of the choice. Only
a failure that comes from Meta after that point (a token that is not a PAGE token) costs the person a second pass through the dialog.
A pick nobody finishes is cleared by the next Meta state minted and by the daily cron (`purgeOAuthStates`, `api.ts:950`).

### 8.5 — Disconnect: `POST /api/meta/disconnect`

Owner only, and only with `{ "confirm": true }` (400 `CONFIRMATION_REQUIRED` otherwise). `disconnectMeta` (**`metaLogin.ts:899`**):
an unsubscribe of the Page from the webhook (best effort: a dead token cannot be unsubscribed and must not trap the tenant), then one
`UPDATE` clears the ids, the token and the `meta_*` columns; campaigns and posts stay. The user's permissions are **not** revoked,
which would cut off every other tenant the same person connected. Audit `meta.disconnect`.

### 8.6 — The operator's settings

`GET` / `POST /api/meta/app-settings`, platform admin only (anyone else gets 404). `meta.login_enabled` (`'true'`, **default off**) and
`meta.login_config_id` (digits; `META_LOGIN_CONFIG_ID` is the fallback) live in `app_settings`; the app id and secret stay in
`META_APP_ID` / `META_APP_SECRET`. `GET` reports what to register in Meta's dashboard (`redirectUri`) and what the dialog asks for.
Each save is one `settings.meta_login_write` audit row naming the fields. The dashboard's two fields for them are in the Connections
card ([8.7](#87--the-dashboard-the-connections-card-the-page-picker-and-w4-p28)).

### 8.7 — The dashboard: the Connections card, the Page picker and W4 (P28)

One module, **`dashboard/js/pages/meta_connect.js`** (`MetaConnect`, not a route: `App.pages.meta_connect`, loaded on first use), is
what Settings and the wizard share: the words for what the server says (`reasonText`, one sentence per `reason` or upper-cased `code`,
the generic sentence for any other: never the raw code), `connectionState` (`none` / `ok` / `attention`), the Page picker, and Connect,
Reconnect and Disconnect. Each host paints its own screen.

1. **Settings → Instagram & Facebook** (**`settings.js:423`** `metaSection`, **`meta_connect.js:291`** `settingsSection`). Reads
   `GET /api/meta/connection` (any member; **no token in it**): the Page, the `@handle`, `connected_at`, the webhook pill, how it was
   connected, and a "reconnect due" notice (below). Owner only: Connect (not connected, and only when `enabled`, `appConfigured` and
   `redirectUriConfigured` are all true: otherwise the card says "not switched on" or "being set up" and has no button), Reconnect, and
   Disconnect behind a danger confirm. **The operator's own connection** (made by pasting a token: `via: 'token'`) is shown as that, has
   **no Disconnect** (it would delete a token this screen cannot re-create), and its Reconnect asks first (it replaces that token). A
   platform admin also gets the two fields (`meta.login_enabled`, `meta.login_config_id`) and the redirect URI to register.
2. **Connect** (`MetaConnect.connect`) posts `{ returnTo, reconnect, authType? }` and navigates to the returned address only if it starts
   with `https://www.facebook.com/`. Settings' button carries `settings`, the wizard's `welcome` (`settings` for a platform admin filling
   the wizard in, who cannot reopen `?mode=behalf` from a redirect).
3. **Coming back.** The callback sends `#/settings?meta=connected|error` (a toast) or, for several Pages, `#/connect-meta?meta=pick&pick=…
   &return_to=…`, which is **not a screen**: `App.metaPickAddress` (**`app.js:714`**) rewrites it in place, before any routing, to the
   screen that began the flow (`#/settings?meta=pick&pick=…`, or `#/welcome?step=connect&meta=pick&pick=…`), and that screen opens the
   picker modal once painted (`announceMetaReturn`, **`settings.js:453`**; `enterConnect`, **`welcome.js:1223`**). A `pick` that does
   not look like one of ours (`^[A-Za-z0-9_-]{20,100}$`) never reaches a request.
4. **The Page picker** (`pickerMarkup`, **:373**; `openPicker`, **:497**): `GET /candidates?pick=` → names and ids. A radio card per
   Page; one the person cannot run is listed disabled with the reason; a single usable Page is preselected. A Page with no Instagram
   account connects **Facebook only** (`facebookOnly: true`, said on the button and above it); one that would **replace** the connected
   Page or account needs a ticked box (`confirmPageChange`); "Don't see your Page?" asks Facebook again with `auth_type=rerequest`.
   `pickGo` (**:558**) repaints the host first and closes the dialog after; a 404 (`PICK_EXPIRED`) becomes "start again". The pick is
   spent by the choice (§8.4).
5. **W4 in the wizard** (**`welcome.js`** `connectFields`, **:1203**): three cards (Instagram & Facebook; TikTok and YouTube, left out
   when the operator has not set them up), each with where it stands and one button; a note that stays on screen says what a return
   trip said (a TikTok or YouTube reason a person cannot act on reads as one friendly sentence, not "check the client secret"). On
   `show('connect')` the step reads the three connections and the module (`enterConnect`), and **captured the address's parameters
   before `syncHash` rewrote it** (`readConnectReturn`, **:1045**). Continue and Skip send **nothing to the profile**; the wizard
   finishes whatever happens here.
6. **The test comment** (**`metaCommentCheck.ts:42`** `readCommentCheck`, `GET /api/meta/comment-check`, operator and up). After Meta
   connects the step says "ask a friend to comment *test* on your latest post, from another account" and polls this route every 5 s
   (`startCheck`, **:1297**; `pollCheck`, **:1322**; one request at a time; a hidden tab asks nothing; stopped by a step change, a closed
   wizard, the answer, ten minutes, or a 401). It turns green when a **`comment.process` job** exists for the tenant created after
   `meta_connected_at` (24 h back for a token connection that has no such moment). **Not `jobs.creator_id`**: the webhook writes it NULL on
   every row (a job is enqueued before the tenant is resolved), and puts the Meta id the delivery was addressed to in `tenant_key`; so
   the tenant's jobs are those whose `tenant_key` is one of **its** Instagram or Facebook ids (or whose `creator_id` is the tenant).
   Both come from the session, never the request. It proves the delivery path (subscription, signature, endpoint, queue) and not that a
   campaign matched, and it still turns green for the tenant's own comment, which the pipeline drops later (§1.8) but the queue already
   holds. The response is a count and a time: never what a comment said.

### 8.8 — The daily token recheck (P29)

`GET /api/cron/publish` ends its sweeps with **`recheckAllMetaTokens`** (**`src/services/metaTokenRecheck.ts:190`**, **`api.ts:1003`**):
every tenant with a token, longest-unchecked first (`token_last_checked_at ASC NULLS FIRST`), one `debug_token` call each
(`fetchDebugToken`), sequential, at most 100 per run and 20 s (`moreRemaining`: the rest are first in line tomorrow). Fail-soft, like
the sweeps around it.

**Four verdicts** (`classifyDebugToken`, **:75**; `classifyCheckFailure`, **:65**; both pure):

| Verdict | When | Written |
|---|---|---|
| `valid` | `is_valid`, type PAGE, nothing about to lapse. `expires_at: 0` is "never expires" (the owner's token, and every Login connection's) | the five health columns |
| `expiring` | valid, but `data_access_expires_at` (or a real `expires_at`) is under 14 days away | the five health columns; status stays `valid` |
| `invalid` | Meta answered no: `is_valid: false`, a type other than PAGE, or data access already lapsed | the five health columns, status `invalid` |
| `transient` | **everything else**: a timeout, a 5xx, a rate limit, a refused app token (a code 190 on the *call* is about our credentials, not the tenant's token), a body that is not an inspection (an empty 200, an error page, `is_valid` that is not a boolean), "not valid" with a code that means "could not look" (1, 2, 4, 17, 32, 341, 368, 613) | **nothing, not even `token_last_checked_at`** |

"Reconnect due" is not a column: `getMetaConnection` (**`metaLogin.ts:870`**) derives `reconnectDue` / `reconnectReason`
(`invalid` or `expiring`) from the stored status and dates, so only a definitive result can raise it and the next valid result clears it.
Only the five health columns are ever written (`persistInspection`), never the Page ids, the token or the `meta_*` columns; a
transient verdict leaves every row exactly as it was, **the owner's included**. The log lines are `token.recheck_transient` (warn) and
`token.reconnect_due` (warn; error for `invalid`): the one to alert on. The notice shows on the Connections card and on Overview
(**`overview.js:483`**, once: not again when the live token check already said the same).

> **A transient failure of the *manual* Re-check still stores `invalid`** (`recheckTenantToken`, unchanged: "sends are failing right
> now"). It is healed by the next daily run that gets an answer; the daily check itself never does that.

> **Why a state in the DB, a cookie and a nonce in the callback's URL.** The dashboard's session is a Bearer token in
> localStorage, so Meta's redirect carries none. The nonce binds the returned code to a tenant; the cookie binds the nonce to the
> browser that began the flow; spending it in one `UPDATE` makes it single-use. All three are §6.1's, generalised.

> **Why the second check at the callback.** The first (`POST /connect`) can be minutes old: the tenant may have been connected by
> an operator in between. A state is not a licence to overwrite whatever is there now; the state's own payload says whether the owner
> asked for a reconnect, and nothing else can.

> **What is unverified (docs/onboarding/04).** That app 847772258381375 is a Business-type app, which Facebook Login for Business
> requires; that a Tester role-holder gets comment webhooks as the owner (an Admin) does; `override_default_response_type`
> on a manually built dialog; what a non-role-holder sees (the `not_tester` reason is inferred from "nothing granted"). The first real
> Tester connecting is the test (plan P27, live check).

## 9. A tenant's profile draft: read, ask, check, wait

`profile_drafts` (migration v34) reads what a tenant gave (an Instagram handle, a website, a YouTube channel, some pasted text), asks a
model for a Creator Profile of them, **checks the answer in code**, and keeps it as a *draft* until a person applies it field by field.
It is a **row with a lease**, not a job in `jobs`: the queue's inline drain runs after the response, where Vercel freezes the function
(`src/jobs/drain.ts`), and a two-minute job would hold the comment replies behind it. The code is `src/services/onboarding/`:
`drafts.ts` is the engine, `draftStep.ts` what it decides (pure), `draftStore.ts` every statement, `draftSources.ts` the fetch,
`draftView.ts` what the API shows.

**The timings are the plan's** (`draftStep.ts:30-50`): a model call times out at **150 s**, an invocation works until **270 s**, the lease
it holds is **290 s** (longer than the deadline on purpose: a second caller cannot take over while the first is still inside its time and
bill the same draft twice), the sweep stops at **280 s**, three tries a minute and then five minutes apart, and a draft not finished in
**30 minutes** is given up.

```
queued ─claim→ fetching ─sources saved→ drafting ─answers checked→ ready
   └──────────────┴───────────────┬──────────────┘
                                  ├→ failed       (final error · tries spent · no source · too old)
                                  └→ superseded   (new inputs replaced it)
```

### 9.1 — Starting: three doors, one engine

1. **The tenant:** `POST /api/onboarding/draft` (**`src/routes/onboardingDrafts.ts:219`**, below `resolveTenant`; `startDraftFor` :111). `requireTenantRole('owner')`
   and, in `admit` (**`onboardingDrafts.ts:96`**, after `creatorFacts` :63, one query joining `onboarding`), only while the tenant's onboarding is
   `invited` or `in_progress`: a completed tenant, and a tenant with no `onboarding` row (D14), get 409 `ONBOARDING_COMPLETED`. The tenant
   comes from the **session**, never the body. `GET /draft` and `POST /draft/advance` are the same door.
2. **The operator:** `GET`, `POST` and `POST …/advance` on `/api/admin/tenants/:id/draft` (**`admin.ts:1306`**, **:1310**, **:1314**),
   platform admin only (404 for anyone else), the tenant from the **path**, not gated on onboarding (a re-draft is the operator's call).
   The Tenants screen fires `advance` right after creating a tenant: it **starts** the draft when there is none (D6). The tenant's own
   `advance` never starts one.
3. **What is read:** `readDraftInputs` (`draftInputs.ts`) makes the four inputs canonical (`@Noor.Perfumes` and `instagram.com/noor.perfumes/`
   are one input) from the body, falling back on the handle and site the operator typed at creation (`creators.instagram_username`,
   `website_url`). The road for Instagram is part of the input: `own_token` if the tenant has connected Meta, else `discovery`.
4. **`startDraft`** (**`drafts.ts:103`**), one transaction under the tenant's advisory lock (`LOCK_TENANT_DRAFTS_SQL`, `draftStore.ts:81`):
   - the same `inputs_hash` (inputs **and** `PROFILE_DRAFT_V1`) as a draft in flight, or as a ready one under 24 hours old, **returns that
     row** (`SELECT_REUSABLE_SQL`, :46). Nothing is made, nothing counts. `force` (operator only) makes a new one over a finished draft, never
     over one in flight;
   - the day's limit: `COUNT_START_SQL` (:93) increments `app_rate_limit_counters` (`draft:<tenant>`, per UTC day) **then** compares; a sixth
     start is a 429 `DRAFT_LIMIT`, and the throw rolls the increment back with everything else;
   - **new inputs supersede the old draft:** `SUPERSEDE_SQL` (:85) marks everything in flight or ready `superseded` and clears its lease,
     *before* the insert, because the partial unique index (one active draft per tenant) would refuse the insert otherwise. An invocation
     still working the old draft finds out at its next write (§9.2);
   - `INSERT_SQL` makes it `queued`. A start asks nothing of a model and fetches nothing.
5. **Audit:** a new draft is `onboarding.draft_start` with which inputs were given, never their values. Reads, reuses and advances are not.

### 9.2 — The lease: `advanceDraft` (**`drafts.ts:185`**)

1. **Early answers** from a plain read and `nextDraftStep` (`draftStep.ts:108`, pure): terminal → `terminal`; somebody holds it → `busy`;
   in back-off → `waiting`. A poll that finds nothing to do never touches the lease.
2. **The claim is one UPDATE** (**`CLAIM_SQL`, `draftStore.ts:132`**): `status IN (active) AND (lease_until IS NULL OR lease_until < NOW()) AND
   (next_attempt_at IS NULL OR next_attempt_at <= NOW())`, setting `lease_owner` and `lease_until = NOW() + 290 s`. Whoever gets the row owns the
   draft. The SQL is the authority: two callers that both read "free" race here and one is refused (`busy`). Time is the database's.
3. **An abandoned lease counts a try.** `attempts` goes up by one when the claim takes the draft from an owner that never let go
   (`lease_owner IS NOT NULL`; a clean release clears it). A function that keeps dying therefore uses its three tries and the draft ends
   `abandoned`, instead of being retried for ever.
4. **Steps, while the deadline allows** (up to 4): `nextDraftStep` says `fetch` or `draft`; a step is only started with the time it needs
   (35 s for a fetch, 68 s for a model call: `hasBudgetFor`, :219) and a model call gets `min(150 s, remaining − 8 s)` (`callTimeoutMs`, :224).
   Out of time: the invocation saves what it has and lets go; the next caller resumes at the next step.
5. **Every write is guarded by the owner:** each statement a step saves with says `AND lease_owner = $2 AND status IN (active)`. A caller
   whose lease ran out, or whose draft was superseded, writes nothing and gets `LeaseLost` (`onboarding.draft_lease_lost`); the work it
   did is lost, and the draft is not brought back to life.
6. **Release** (`RELEASE_SQL`, :149) in `finally`, owner-guarded. If even that fails, the lease simply runs out at 290 s.

### 9.3 — Step 1, fetch: `fetchStep` (**`drafts.ts:280`**) → `fetchDraftSources` (**`draftSources.ts:216`**)

1. `queued` → `fetching`. The four sources run **in parallel under one 25 s phase** (`within`, :121: a source that does not answer is a
   retryable `timeout` and its late result is ignored):
   - **Instagram:** the tenant's own token if connected (`fetchOwnInstagram`), else **Business Discovery** as the platform's connected
     account (`resolveDiscoveryAccount` → `fetchBusinessDiscovery`; its tenant is the setting `onboarding.discovery_creator_id`, default the
     owner's). A shut road (`no_access`) falls back to the other when a handle was typed.
   - **Website:** `gatherWebsite` (every request through `safeFetch`: SSRF guard, robots.txt, 25 s phase).
   - **YouTube:** the typed channel by the platform's API key (`youtube.api_key`; none saved = skipped, not failed) or the tenant's own
     connection.
   - **Typed:** the text the tenant pasted.
2. **A source that fails is one line of `sources_status`**; the others still land. IG `not_found` plus a readable website still drafts from
   the website. Each line has a state, the road, the failure kind, whether a retry could help, `ms`, counts and `needsPaste`: **no text.**
3. What is kept (`profile_drafts.sources`, so no retry fetches again): the prepared sources (cleaned, capped, **typed text first, then the bio, the site,
   the channel, then captions**, so the 60 000-character budget cuts captions and not the business), the sample candidates, the signals
   (`computeSignals`), and the facts **code** found: colours, logo *addresses*, social links, counts, the host. Never an image.
4. `decideAfterFetch`: any usable source → `saveFetched` (`drafting`); none and something retryable → back-off; none otherwise → **failed,
   `no_source`**, with `sources_status` kept so the wizard can say "paste your About text".

### 9.4 — Step 2, draft: `draftStep` (**`drafts.ts:359`**)

1. Both calls (**voice** and **business**) run **in parallel**, each through `generate()` (`aiProviders/generate.ts`: route, budget, `ai_usage`
   row) with purpose `onboarding_draft`, `maxTokens` 16 000, the call's own prompt (`buildDraftPrompt`: fenced sources, nonce, signals) and
   schema. No retry and no second provider inside a call (06 §2).
2. **A call that answered is saved and never asked again.** The answers wait in `draft` (`stage: 'answers'`); a retry asks only what has not answered.
3. `decideAfterCalls` (`draftStep.ts:175`): everything answered → finish; something retryable and tries left → retry only that (1 min, then 5);
   otherwise with at least one answer → finish **partial**; otherwise **fail** with the most telling error (a missing key before a refusal).
   Retryable: network, 429, 5xx/529, timeouts, **one** malformed answer. Final: no key, a 400, a refusal, a cut-off answer, a spent budget.
4. **Finish:** `validateDraft` (§3.5 of the draft spec) checks the answers against what the model was shown; the result is stored with the
   facts code found. `status = 'ready'`, `partial`, `usage` with every step and call and its `elapsed_ms`. **Nothing is applied to the profile.**
5. **No AI key** (`no_provider`): the draft **fails cleanly after the fetch**, `needsAiKey` is true, and what code found is kept as a
   **prefill** (colours, logo candidates, links, the handle) so the wizard continues by hand with those filled in. Final: never retried.

### 9.5 — The poll, the sweep and who moves a draft on

1. **The wizard polls** `GET /api/onboarding/draft` every 3 s while the tab is visible (`dashboard/js/pages/draft_client.js`, `watch`). The
   view says `advanceable` when nobody holds the draft and its back-off is over; the client then fires `POST …/advance`, **one at a time**.
   That request does the steps inside it, up to 270 s. Whether Vercel keeps running it when the browser goes away is not known:
   `onboarding.advance_client_gone` is logged if the client left first, and a later `onboarding.draft_advance` for the same draft says the
   work went on.
2. **The backstop:** `POST /api/onboarding/drafts/sweep` (**`api.ts:386`**), above authentication with the other scheduler routes, guarded by
   the **same `requireCronSecret` as `/api/jobs/drain`** (Bearer `CRON_SECRET`, header only, fail closed). `sweepDrafts` (**`drafts.ts:478`**)
   takes up to 10 due drafts (`SELECT_DUE_SQL`: active, not held, not in back-off, oldest first), three at a time, each given what is left of
   280 s, and skips what it has no time for. It is **not part of the drain**: the drain's worker budget is 45 s and `publishDuePosts` runs first.
3. **`heroku-worker/worker.mjs`** has a second loop (`sweepLoop`, **:115**) calling it about every 60 s, independent of the drain's: neither
   waits for the other, and a hung sweep (a model call takes minutes) cannot hold the queue back. It logs only a sweep that found something.
   If the worker is scaled to 0, nothing but a wizard or the operator moves a draft, and nothing ends one that nobody opens.

### 9.6 — What a person does with it

1. The view carries the checked draft (`draft.profile`, `provenance`, `touched`, `flags`, `samples`, `faqPending`) or, with no key, the
   `prefill`. A tenant sees a kind and a fixed sentence about a failure; an operator also the provider's words, the steps and the cost.
   **Neither sees the text that was read** (ids and kinds only).
2. **Applying is the person's, field by field, through the existing PATCH** (`PATCH /api/profile`; an operator's client, `PATCH
   /api/admin/tenants/:id/profile`): `DraftClient.applyFields` builds one patch of the chosen `touched` fields (a list is replaced whole, so
   an entry of a list is applied as its list) against the version it just read, and retries once on a version conflict.
3. "Start without waiting": the person carries on by hand while the draft is written; `startWithoutWaiting` hands the wizard the fields
   they have **not** edited, once, when the draft is ready. A field the person edited is never offered.
4. A test fails if any module outside `onboarding/` names the table or imports the engine, apart from the two routes (`draftIsolation.test.ts`).
   Agents read `creator_profiles`, which holds what a person confirmed.

**Settings the operator needs** (Settings → Onboarding): the YouTube Data API key (`youtube.api_key`, a secret, never returned: `{set,
source, last4}`) and the tenant that reads other people's Instagram (`onboarding.discovery_creator_id`). With neither, the draft still
runs: YouTube is skipped, and Instagram by handle is read as the owner's tenant.

## Where each flow can silently do nothing

A quick index for the "it just isn't working" case. Every one of these is a normal return, not an
error, and several write **no row at all**.

| Flow | Stops at | Log line | Row written? |
|---|---|---|---|
| 1 | bad signature — **`index.ts:185`** | `webhook.signature_rejected` | no (403 precedes the DB) |
| 1 | unknown `field` — **`comments.ts:95`** | `comment.unhandled_field` | no |
| 1 | own comment — **`comments.ts:196`**, **`:212`** | `comment.skipped_self_authored` / `_page_owner` | no |
| 1 | no creator for `entry.id` — **`comments.ts:205`** | `comment.no_creator` | no |
| 1 | a tenant with no Meta token (created by name) — `getCreatorByPageId` skips it | `comment.no_creator` | no |
| 1 | **no campaign matched** — **`comments.ts:237`** | `comment.no_campaign_match` | **no** |
| 1 | already handled — **`comments.ts:251`** | `comment.duplicate_ignored` | no (row exists, untouched) |
| 1 | 24h recipient cap — **`comments.ts:265`** | `dm.skipped_recipient_cap` | yes, `FAILED` |
| 1 | quota — **`comments.ts:280`** | `dm.quota_exhausted` | yes, `FAILED` |
| 2 | filtered at plan time — **`router.ts:88`** | *(none)* | no job at all |
| 2 | nothing answerable — **`messaging.ts:80`** | `dm.skipped_empty` | no |
| 2 | no creator — **`messaging.ts:257`** | `dm.no_creator` | no |
| 2 | already handled / live claim — **`messaging.ts:286`** | `dm.duplicate_ignored` | inbound row only |
| 2 | bot paused — **`messaging.ts:295`** | `dm.bot_paused` | inbound row, `handled_at` set |
| 2 | the sender's profile lookup (Instagram only) is refused, throttled, or cannot run on a database without v40 — **`senderProfile.ts`** `refreshSenderProfile` | `dm.profile_failed` (`warn`); a throttled one is silent | no (the reply is unaffected; the attempt is recorded in `conversations.profile_checked_at`) |
| 2 | a **permanent** Meta refusal of the reply (a blocked recipient, a dead token) — the catch in **`messaging.ts`** (`isPermanentMetaError`) | `dm.pipeline_failed` | inbound row, `handled_at` set; **no outbound row, and nothing in `jobs`** (the job completes `done`): the inbox's "reply failed" chip cannot show it, only the logs can |
| 2 | **no `ai_agents` row** — **`ai.ts:383`** | `ai.unconfigured` (`warn`) | inbound row, `handled_at` set |
| 2 | agent switched off — **`ai.ts:383`** | `ai.disabled` (`debug`) | same |
| 3 | row claimed by another run — **`api.ts:632`** | `cron.publish_already_claimed` | no change |
| 3 | a Meta post of a tenant with no token — `attemptPublish` | `cron.publish_failed` (`META_NOT_CONNECTED`) | yes, `FAILED` + the "not connected" sentence |
| 4 | `PATCH /api/profile` that changes nothing — **`patch.ts:184`** | *(none)* | no (200, version unchanged, no audit entry) |
| 4 | `/auth/me`'s onboarding cannot be read (a database without v34, a failed query) — **`onboardingWizard.ts:198`** | `onboarding.brief_unreadable` (`warn`) | no (`onboarding: null`: the dashboard gates nothing) |
| 4 | an autosave or Continue for a tenant that has finished, or has no onboarding row — **`onboardingWizard.ts:370`** | *(none)* | no (200, the state as it is) |
| 4 | a funnel event that could not be written — **`onboardingWizard.ts:257`** | `onboarding.event_failed` (`warn`) | no (the step still saved) |
| 4 | an agent switched on without a hand-off rule, presenter or audience — **`agentGate.ts:139`** | *(none: the answer is `409 PROFILE_INCOMPLETE`)* | no (nothing was switched) |
| 4 | the agent gate cannot read the tenant (a failed query, a database without v34) — **`agentGate.ts:139`**, **`:157`** | `profile.gate_unreadable` (`warn`) | no (the switch goes through) |
| 4 | the owner or a tenant that predates onboarding switches an agent on with a field empty — **`agentGate.ts:99`** | *(none)* | no (never gated, and his row and profile are not even read) |
| 4 | the Overview's profile card cannot be read — **`routes/profile.ts:83`** | `profile.progress_failed` (`error`) | no (the region stays empty) |
| 4 | a draft or invite event that could not be written — **`onboardingEvents.ts:92`** | `onboarding.event_failed` (`warn`) | no (the draft or the link still worked) |
| 4 | the daily sweep forgets old events, long-expired invites and a draft's fetched text — **`onboardingRetention.ts:81`** | `retention.onboarding_pruned` (`info`) | rows deleted, or `sources` set to NULL; the draft row stays |
| 5 | budget spent — **`runner.ts:145`** | `job.drain_complete` (`budgetExhausted: true`) | jobs stay `pending` |
| 6 | 5 drafts already pending — **`tiktokPublish.ts:183-186`** | `cron.publish_held_tiktok_inbox` | yes, back to `PENDING` + `error_log` |
| 6 | bad webhook signature — **`routes/tiktok.ts:150`** | `tiktok.webhook_signature_rejected` | no (401 precedes the DB) |
| 6 | unknown `publish_id` / account — **`tiktokPublish.ts:379-380`** | `tiktok.webhook_applied` (`ignored:…`) | no |
| 6 | **creator never posts the draft** | *(none)* | row stays `IN_INBOX`; the sweep stops asking after 7 days |
| 7 | a think or an infographic write for a tenant that is neither the owner nor on `studio.mac_brain_tenants` — **`think.ts:246`**, **`jobs.ts:300`** | `studio.mac_brain_refused` / `studio.mac_brain_job_refused` (`warn`) | no job; a queued one is `failed` with `NEEDS_API_BRAIN`'s message |
| 8 | a callback with no cookie, or one that does not equal `state` — **`meta.ts:114`** | `meta.oauth_state_mismatch` | no (before the DB) |
| 8 | a replayed, expired or foreign `state` — **`oauthState.ts:134`** | *(none: `reason=state_expired` in the redirect)* | no (the UPDATE matched nothing) |
| 8 | a tenant that is connected and did not ask for a reconnect — `mayConnect` | `meta.oauth_callback_failed` (`reason: already_connected`) | no, and Meta is never called |
| 8 | Connect with Facebook is off (`meta.login_enabled`) | *(none: `reason=disabled`)* | the state is spent, nothing else |
| 8 | the webhook could not be subscribed — `subscribePage` | `meta.subscribe_failed` / `_incomplete` / `_unread` (`warn`) | yes: connected, `meta_webhook_subscribed_at` NULL, `warn=` in the redirect |
| 8 | a pick nobody finishes | *(none)* | `meta_pick` row, payload cleared after 10 min by the next Meta state or the daily cron |
| 8 | **the test comment never turns green** (W4) — `readCommentCheck` finds no `comment.process` job for the tenant's ids since `meta_connected_at` | *(none: a normal `received: false`)* | no; the page stops asking after 10 minutes and offers "Check again". Means the webhook path is not delivering: for a Tester, the operator connects through Page access (docs/onboarding/04 §1) |
| 8 | the daily recheck cannot reach Meta, or Meta's answer is not an inspection — `classifyDebugToken` | `token.recheck_transient` (`warn`) | **no** (not even `token_last_checked_at`); the tenant is first in line tomorrow |
| 8 | a token that cannot be decrypted (a rotated key) — `recheckOneMetaToken` | `token.recheck_unreadable` (`warn`) | no |
| 8 | a connection that needs renewing or that Meta rejects — the recheck | `token.reconnect_due` (`warn` / `error`) | yes: the health columns; "reconnect due" on the card and on Overview |
| 8 | a TikTok or YouTube flow the wizard began, whose return address could not be saved (no v35 column) | `tiktok.return_to_unsaved` / `youtube.return_to_unsaved` (`warn`) | the state without `return_to`: it returns to Settings, and still connects |
| 9 | **no AI provider has a key** — `draftStep` / `generate` (`no_provider`) | `ai.call_refused`, `onboarding.draft_failed` (`error_kind: no_provider`) | yes: `failed`, `needsAiKey`, the prefill kept; **no draft, no retry** |
| 9 | one source unreadable (private Instagram, a site that refuses, no YouTube key) — `fetchDraftSources` | `onboarding.ig_source_failed`, `onboarding.yt_source_skipped`, `onboarding.draft_fetched` | yes: the draft is made from the rest, the failure is a line of `sources_status` |
| 9 | **nothing at all readable** — `decideAfterFetch` | `onboarding.draft_step` (`outcome: fail`), `onboarding.draft_failed` | yes: `failed`, `no_source` (the wizard asks for the About text) |
| 9 | a second caller on a draft being worked on — `CLAIM_SQL` | `onboarding.draft_advance` (`outcome: busy`) | no change |
| 9 | **a draft nobody advances** (no wizard open, worker not running): it stays `queued` | *(none)* until the sweep runs: `onboarding.sweep` | row untouched; ended `expired` by whoever finds it after 30 minutes |
| 9 | a slow invocation whose lease ran out, or whose draft was superseded — owner-guarded writes | `onboarding.draft_lease_lost` | no (what it did is dropped) |
| 9 | the draft is ready and nobody applies it | *(none)* | the draft stays a draft: nothing is applied to the profile by the engine |

`RUNBOOK.md` works these backwards from the symptom.
