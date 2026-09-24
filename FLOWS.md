# FLOWS.md — every hop, in order

The other documents answer different questions. `README.md` lists the routes, `ARCHITECTURE.md`
explains why each piece is shaped as it is, `RUNBOOK.md` walks backwards from a symptom, and
`VERIFYING.md` is one end-to-end procedure you run by hand. None of them answers *"a comment
arrives — then what happens, in what order, in which file?"*

That is what this is. Six flows, each one a numbered list of hops with a `file:line` citation
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
[6. TikTok post → inbox → published](#6-tiktok-post--inbox--published)

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

**`src/index.ts:250`** — `res.sendStatus(200)`.

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

**`src/index.ts:253`** — `await drainInline()`, defined at **`src/jobs/drain.ts:38`**. It reaps
stale claims first (**`src/jobs/drain.ts:54`**), then calls `drainJobs`
(**`src/jobs/runner.ts:129`**) with a deliberately short budget: 8 s default
(**`src/jobs/drain.ts:21-24`**, `JOB_INLINE_BUDGET_MS`), `batchSize: 3`, `maxJobs: 10`
(**`src/jobs/drain.ts:64-68`**). This is opportunistic work — the response is already sent, so
anything it does not finish stays `pending` and costs nothing. Full mechanics in
[flow 5](#5-job-lifecycle).

The claim itself is **`src/jobs/queue.ts:77`**, `PostgresJobQueue.claim`. The handler lookup and
dispatch is **`src/jobs/runner.ts:89`**.

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
INSERT INTO conversations (creator_id, instagram_user_id, status) VALUES ($1, $2, 'active')
ON CONFLICT (creator_id, instagram_user_id) DO UPDATE SET last_message_at = NOW()
RETURNING id, is_bot_active, ai_disclosed_at
```

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

### 2.6 — The bot-paused check

**`src/webhook/messaging.ts:294`** — `if (!conversation.is_bot_active)`. Logs `dm.bot_paused`,
calls **`markHandled`** (**:298**) and returns.

`markHandled`, not release: this is terminal. The operator took the thread over deliberately from
the inbox (`PUT /api/conversations/:id/toggle-bot`), and a retry must not decide later that the
bot should have answered after all.

### 2.7 — Gemini

**`src/webhook/messaging.ts:306`** — `generateAiResponse(conversationId, dm.text || dm.payload,
creator.id)`, at **`src/services/ai.ts:289`**. Timed and logged as `ai.replied` with
`duration_ms` (**`src/webhook/messaging.ts:307-311`**), because this is both the dominant
marginal cost of the product and the reason the webhook cannot finish inside Meta's timeout.

**`decideAgent`** — **`src/services/ai.ts:280`**, called at **`src/services/ai.ts:318`**. The
whole safety rule, and both halves of it have been wrong in production:

| stored row | sandbox? | decision |
|---|---|---|
| any | yes (`overrides !== undefined`, **`ai.ts:316`**) | speak, with the row or a fallback persona (**`ai.ts:281-283`**) |
| none | no | **`{ speak: false, reason: 'unconfigured' }`** (**`ai.ts:284`**) |
| `is_active === false` | no | `{ speak: false, reason: 'disabled' }` (**`ai.ts:285`**) |
| otherwise | no | speak (**`ai.ts:286`**) |

The `is_active` filter used to be in the WHERE clause, so a *disabled* agent returned zero rows
and was indistinguishable from an *unconfigured* one — and a `|| default` then answered the
customer anyway with a generic persona, so the toggle changed *who* replied rather than
*whether anyone did*. It is now selected, not filtered on (**`src/services/ai.ts:306-310`**).
The unconfigured case is the more dangerous of the two and was fixed later: a tenant created
through `POST /api/admin/tenants` has no `ai_agents` row at all, so there was no `is_active` for
the off switch to be false on, and their bot answered real customers in a persona nobody chose
while every layer reported success.

`decideAgent` returning `speak: false` makes `generateAiResponse` return **`null`**
(**`src/services/ai.ts:326`**), logged `warn` for unconfigured and `debug` for disabled
(**:323**). The caller honours it at **`src/webhook/messaging.ts:315-319`**: log
`ai.agent_disabled`, `markHandled`, send nothing. **Every other failure throws** — there is no
fallback persona and no fixed promotional reply.

**History window** — **`src/services/ai.ts:330-337`**: the last `HISTORY_WINDOW = 8`
(**`src/services/ai.ts:35`**) messages for this conversation, `ORDER BY created_at DESC`, then
reversed into chronological order (**:340**). Trimmed from 15 because the system prompt and the
entire knowledge base are re-sent verbatim on every call, and Arabic runs ~2-2.5× more tokens
per character than English. The current message is appended only if it is not already the last
row (**:352-358**).

**`responseSchema`** — `RESPONSE_SCHEMA` at **`src/services/ai.ts:68`**, passed with
`responseMimeType: "application/json"` in `generationConfig`
(**`src/services/ai.ts:379-383`**). It constrains `message_type` to
`text | quick_reply | carousel` and describes Meta's own limits inline (quick-reply titles ≤ 20
chars, carousel titles ≤ 80, 2-10 cards).

**Temperature** — **`src/services/ai.ts:370`** uses `Number.isFinite(agent.temperature)`, not
`|| 0.7`. The old form turned a deliberate `0` — the setting you pick precisely to stop the agent
improvising about prices — back into 0.7.

**The API key travels in a header, not a query string** — **`src/services/ai.ts:389-392`**:

```js
axios.post(url, payload, { headers: { 'x-goog-api-key': apiKey }, timeout: GEMINI_TIMEOUT_MS })
```

Not `?key=`. Query strings end up in proxy logs, browser referrers and error reporters far more
readily than headers do — and an axios error carries `config.url`, so the old form leaked the
key into anything that logged one. The catch block at **`src/services/ai.ts:458-465`** logs
narrow fields for the same reason, never the error object.

`GEMINI_TIMEOUT_MS = 30_000` (**`src/services/ai.ts:38`**) — Gemini can sit on a request
indefinitely; a serverless invocation cannot.

**Token usage** is logged as `ai.usage` (**`src/services/ai.ts:400-410`**) including
`cached_tokens`, because `prompt_tokens` is mostly the static prefix and that is precisely the
number that says whether Gemini context caching is worth turning on.

### 2.8 — `coerceAiResponse`

**`src/services/ai.ts:141`**, called at **`src/services/ai.ts:438`**. `responseSchema` is a
strong constraint, not a guarantee. Every one of these used to reach `toMetaMessage` unchecked:

- `message_type: "carousel"` with `carousel_elements` absent or empty → Meta answers "param
  message must be a non-empty object", untraceable back to the model.
- `message_type: "quick_reply"` with no `quick_replies`.
- `text` (or a `quick_replies[].title`) returned as a **number** → `enforceMetaConstraints` then
  called `.substring` on it and threw a `TypeError` from inside the success path, surfacing as
  `dm.pipeline_failed` with a message about `substring` and no mention of Gemini.
- A model that ignores the enum and invents a fourth `message_type`.

Every case degrades to plain text (**`src/services/ai.ts:184`**) rather than throwing: the
person gets the words the model wrote, which is what they were waiting for, and the structure
was always a presentation detail. Numbers and booleans are coerced to string, objects and arrays
are not (**:146-148**) — `String({})` is `[object Object]`, worse than nothing. A downgrade logs
`ai.response_downgraded` (**:176**).

Two guards after it: **`src/services/ai.ts:443`** throws when a `text` response has no usable
text (an empty reply is a failure, not a message — sending it produces a Meta rejection
attributed to the send rather than the model, and writing it to `messages` would feed a blank
turn back as history), and `enforceMetaConstraints` (**`src/services/ai.ts:190`**) truncates to
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

- `needsDisclosure(conversation.ai_disclosed_at)` at **`src/webhook/messaging.ts:115`**, called
  at **:360**. True when the column is null (thread start), unparseable, **or** older than
  `DISCLOSURE_MAX_AGE_MS = 7 days` (**`src/webhook/messaging.ts:24`**). The policy never
  quantifies "a significant lapse"; a week is long enough that the thread reads as a new
  conversation to the person on the other end.
- `applyDisclosure` (**`src/webhook/meta-payload.ts:101`**) prefixes
  `AI_DISCLOSURE_LINE` (**`src/webhook/meta-payload.ts:87`**, `🤖 رد آلي من المساعد الذكي`) onto
  the payload's `text`. **A generic template carries no `text` field** — Meta rejects `text`
  alongside `attachment` — so for a carousel it returns `standalone` instead
  (**`src/webhook/meta-payload.ts:108`**), and the pipeline sends the line as its own message
  first (**`src/webhook/messaging.ts:364-372`**, logging `dm.disclosure_standalone`).

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

Then `drainWorker()` (**:712**) as a backstop, and `publishDuePosts()` (**:714**).

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

**IP throttle first** (**:158-164**). `clientIp` (**:99**) reads the first
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
`tokenVersion`, `iat`. The payload used to be a bare timestamp — every request was "somebody who
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
   `role` and `tokenVersion`. Response is a **new token** (**:1000**).

Nothing server-side is mutated, because there is nothing to mutate: the session is a stateless
HMAC, so the tenant it carries can only change by issuing a different token. The old token stays
valid for its remaining TTL **against its own tenant**, which is correct — it was already
authorised for that one (**`src/routes/api.ts:966-973`**).

The switcher's data source is `GET /api/auth/me` (**`src/routes/api.ts:942`**) →
`listTenantsForSession` (**`src/services/tenant.ts:341`**): every active creator for a
`platform_admin`, otherwise creators joined through `memberships`.

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
   **:179**). Needs `getTikTokAppConfig()` (**`src/services/appSettings.ts:93`** — `app_settings`
   first, then `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`).
2. `redirectUriFor` (**`src/routes/tiktok.ts:45`**) → `getPublicBaseUrl`
   (**`src/services/appSettings.ts:130`**): the `app.public_base_url` setting, then
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

## Where each flow can silently do nothing

A quick index for the "it just isn't working" case. Every one of these is a normal return, not an
error, and several write **no row at all**.

| Flow | Stops at | Log line | Row written? |
|---|---|---|---|
| 1 | bad signature — **`index.ts:185`** | `webhook.signature_rejected` | no (403 precedes the DB) |
| 1 | unknown `field` — **`comments.ts:95`** | `comment.unhandled_field` | no |
| 1 | own comment — **`comments.ts:196`**, **`:212`** | `comment.skipped_self_authored` / `_page_owner` | no |
| 1 | no creator for `entry.id` — **`comments.ts:205`** | `comment.no_creator` | no |
| 1 | **no campaign matched** — **`comments.ts:237`** | `comment.no_campaign_match` | **no** |
| 1 | already handled — **`comments.ts:251`** | `comment.duplicate_ignored` | no (row exists, untouched) |
| 1 | 24h recipient cap — **`comments.ts:265`** | `dm.skipped_recipient_cap` | yes, `FAILED` |
| 1 | quota — **`comments.ts:280`** | `dm.quota_exhausted` | yes, `FAILED` |
| 2 | filtered at plan time — **`router.ts:88`** | *(none)* | no job at all |
| 2 | nothing answerable — **`messaging.ts:80`** | `dm.skipped_empty` | no |
| 2 | no creator — **`messaging.ts:257`** | `dm.no_creator` | no |
| 2 | already handled / live claim — **`messaging.ts:286`** | `dm.duplicate_ignored` | inbound row only |
| 2 | bot paused — **`messaging.ts:295`** | `dm.bot_paused` | inbound row, `handled_at` set |
| 2 | **no `ai_agents` row** — **`ai.ts:323`** | `ai.unconfigured` (`warn`) | inbound row, `handled_at` set |
| 2 | agent switched off — **`ai.ts:323`** | `ai.disabled` (`debug`) | same |
| 3 | row claimed by another run — **`api.ts:632`** | `cron.publish_already_claimed` | no change |
| 5 | budget spent — **`runner.ts:145`** | `job.drain_complete` (`budgetExhausted: true`) | jobs stay `pending` |
| 6 | 5 drafts already pending — **`tiktokPublish.ts:183-186`** | `cron.publish_held_tiktok_inbox` | yes, back to `PENDING` + `error_log` |
| 6 | bad webhook signature — **`routes/tiktok.ts:150`** | `tiktok.webhook_signature_rejected` | no (401 precedes the DB) |
| 6 | unknown `publish_id` / account — **`tiktokPublish.ts:379-380`** | `tiktok.webhook_applied` (`ignored:…`) | no |
| 6 | **creator never posts the draft** | *(none)* | row stays `IN_INBOX`; the sweep stops asking after 7 days |

`RUNBOOK.md` works these backwards from the symptom.
