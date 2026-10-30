# FLOWS.md — every hop, in order

The other documents answer different questions. `README.md` maps the docs and the routers, `ARCHITECTURE.md`
explains why each piece is shaped as it is, `RUNBOOK.md` walks backwards from a symptom, and
`VERIFYING.md` is one end-to-end procedure you run by hand. None of them answers *"a comment
arrives — then what happens, in what order, in which file?"*

That is what this is. Thirteen flows, each one a numbered list of hops with a `file:line` citation
at every step. Written for someone who has never opened this codebase.

Walked elsewhere, not here: the Monteur's pipeline (`MONTEUR.md`), the daily growth sync (`GROWTH.md`), data-subject
erasure (`RUNBOOK.md` §7, `src/services/erasure.ts`), and ice breakers and the persistent menu (`src/routes/iceBreakers.ts`).

**Line numbers drift.** Every citation names the enclosing function too, so when a number is
stale the function name still finds it. If the two disagree, the function name is right.
`npm run check:docs` (in CI) fails on a cited file or line that no longer exists, and
`npm run docs:reanchor` moves an anchor to where its line of code went (run it on a clean tree, then review the diff).

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
[9. A tenant's profile draft](#9-a-tenants-profile-draft-read-ask-check-wait) ·
[10. WhatsApp message → stored thread → answered](#10-whatsapp-message--stored-thread--answered-w3b-to-w5) ·
[11. Ads: the money rule and the guard](#11-ads-the-money-rule-and-the-guard) ·
[12. Ads → conversation → results](#12-ads--conversation--results-meta-ads-manager-a3) ·
[13. Explainers: topic → script → voice → pictures → render → schedule](#13-explainers-topic--script--voice--pictures--render--schedule)

---

## 1. Comment → DM

Someone comments a trigger keyword on a post. They get a DM; the comment gets a like and
optionally a public reply.

### 1.1 — `POST /webhook` receives the delivery

**`src/index.ts:363`** — `app.post('/webhook', ...)`. The single entry point for both event
types. Body parsing happens earlier, at **`src/index.ts:56`**, where `bodyParser.json`'s
`verify` hook stashes the raw bytes on `req.rawBody` — the signature is over the exact bytes
Meta sent, so a re-serialised body would never verify.

### 1.2 — HMAC verification, against two secrets

**`src/index.ts:365`** calls `verifyMetaSignature(req, req.rawBody)`, defined at
**`src/utils/signature.ts:24`**.

It rejects before hashing anything when the raw body is not a Buffer
(**`src/utils/signature.ts:29`** — a non-JSON content type never fires the `verify` hook, and
feeding `undefined` to `hmac.update()` throws a `TypeError` that Meta reads as a 500 and
answers with a redelivery storm), when the `x-hub-signature-256` header is missing or
misprefixed (**:32**), and when the hex decodes to the wrong length (**:37** — otherwise
`timingSafeEqual` throws rather than returning false).

The actual check is at **`src/utils/signature.ts:39`**: `appSecrets().some(...)`, comparing
with `crypto.timingSafeEqual`. `appSecrets()` (**`src/utils/signature.ts:46`**) returns
`[META_APP_SECRET, INSTAGRAM_APP_SECRET]` with the unset ones filtered out. A payload is
genuine if it matches **either**.

> Two secrets because this deployment has historically received events from two different Meta
> apps — the Facebook app (`object: "page"`) and "Instagram API with Instagram Login"
> (`object: "instagram"`), which is a separate app with its own ID and secret. As of the
> 2026-09-21 audit both object types live under one app and everything signs with
> `META_APP_SECRET`, making `INSTAGRAM_APP_SECRET` vestigial. The dual check stays because it
> costs nothing and the setup has changed before — but do not start a "comments never arrive"
> investigation by suspecting it.

On failure: **`src/index.ts:371`** calls `logSignatureRejection` (**`src/utils/signature.ts:78`**),
which logs `webhook.signature_rejected` with `app_keys_tried` (how many app secrets the signature
was checked against) and `instagram_app_configured`, then **`:372`** answers 403. That log line
exists because the 403 happens before anything touches the database, so "signature rejected" and
"nobody messaged us" are otherwise byte-identical. The `probe` field distinguishes
`scripts/diagnose.mjs --probe-signature` proving the guard still holds from a real rejection; it
is a label only (**`src/utils/probe.ts`**) and grants nothing.

> **Why those two names.** The logger blanks any field whose *name* contains `secret`, `token`,
> `signature` and the like (**`src/utils/log.ts:52`**). The line used to carry `secrets_tried` and
> `instagram_secret_set`, and both printed `"[redacted]"`: the one line that says which secrets
> were tried said nothing. `signature.test.ts` sends the line through the real `log`, so a name the
> redactor would catch fails there. `meta.deauthorize_rejected` counts the same list under the same
> name (`app_keys_tried`, **`src/routes/meta.ts:175`**).

### 1.3 — Body shape and `object` dispatch

**`src/index.ts:384`** — a missing or non-object body is a flat **400**, not a thrown
`TypeError`. Same redelivery-storm reasoning as above.

**`src/index.ts:391`** — `isAcceptedWebhookObject(body.object)` (**`src/webhook/router.ts:106`**: `instagram`,
`page` or `whatsapp_business_account`). Anything else
logs `webhook.unrecognised_object` and returns **200** (**:391-395**) — acknowledging an event
this app does not handle is correct; making Meta retry it forever is not.

### 1.4 — Enqueue, then acknowledge

**`src/index.ts:420`** — `await enqueueWebhookBody(body, requestId)`, where `requestId`
(**`src/index.ts:415`**, `currentRequestId()`) is the same correlation id the logging
middleware at **`src/index.ts:65`** put on every line for this request. It is carried across the
queue boundary so the work and its acknowledgement share an id.

`enqueueWebhookBody` (**`src/webhook/router.ts:217`**) calls `planJobs`
(**`src/webhook/router.ts:148`**), which flattens the body into `EnqueueInput[]` **without
touching the database**. For comments that is **`src/webhook/router.ts:182-191`**: one
`comment.process` job per element of `entry.changes`, carrying the change verbatim.

Two fields per job matter:

- **`dedupeKey`** — `commentDedupeKey(change)` at **`src/webhook/router.ts:44`**, which is
  `comment:<id>`. Instagram puts the id at `value.id`, Facebook at `value.comment_id`. Best
  effort by design: an event whose id cannot be found is **still enqueued**, just unprotected,
  because `interactions.comment_id UNIQUE` catches the redelivery one layer down and losing the
  event would be far worse than doing it twice.
- **`tenantKey`** — `entry.id` (**`src/webhook/router.ts:168`**), the Meta page id. This is the
  fair-queueing partition. It is `entry.id` and not the tenant's own uuid precisely because
  resolving the uuid needs a database read, and the whole point of enqueueing is to acknowledge
  Meta *before* doing any. Every job the webhook writes therefore has `jobs.creator_id` NULL.

Each planned job goes through `queue.enqueue` (**`src/jobs/queue.ts:39`**), whose
`ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`
(**`src/jobs/queue.ts:53`**) makes a Meta redelivery a no-op *before* it costs anything. A
dropped enqueue returns `null` and is logged at `debug` (**`src/jobs/queue.ts:71`**) — on a
busy account it is the most frequent thing that happens.

**`src/index.ts:439`** — `void acknowledgeThenRun(res, …)`, which sends the 200 first
(**`src/webhook/ack.ts:32`**) and only then starts the work (§1.5).

> **Why this order — the 200 goes out before the work.**
> Meta's webhook timeout is ~20 seconds and this pipeline contains a 2-8s Gemini round trip plus
> however many Meta sends follow. It used to answer 200 and *then* keep working in the same
> invocation — which on Vercel can be frozen at any point after the response, losing the work
> permanently while having already told Meta it succeeded. Writing to `jobs` first changes the
> worst case from "silently lost" to "still pending". The reasoning is written out at
> **`src/index.ts:397-407`**.

If the enqueue throws, **`src/index.ts:432`** logs `webhook.enqueue_failed_falling_back` and
falls through to the legacy inline path (`processWebhookBody`,
**`src/webhook/router.ts:319`**) rather than dropping the delivery. A *partial* enqueue means
some events run twice; that is deliberately tolerated, because both `interactions.comment_id`
and `messages.meta_message_id` are UNIQUE, so the second pass claims nothing.

**`WEBHOOK_QUEUE=off` takes the queue out entirely** (**`src/index.ts:418`**; unset by default). Nothing is enqueued, and every
delivery takes that same legacy path: `processWebhookBody` after the 200, under `waitUntil`, with no job row, no retry and no
reaper. It is the rollback switch for the durability layer (RUNBOOK §5.4), changed in the Vercel environment with no deploy. The
price is the failure the queue was built to remove: work the instance is stopped in the middle of is gone, and an empty `jobs`
table no longer means "no delivery arrived".

### 1.5 — `drainInline()` picks the job back up

**`src/index.ts:439-442`** — the work `acknowledgeThenRun` starts after the 200 is `drainInline()`,
defined at **`src/jobs/drain.ts:38`**. It reaps
stale claims first (**`src/jobs/drain.ts:54`**), then calls `drainJobs`
(**`src/jobs/runner.ts:187`**) with a deliberately short budget: 8 s default
(**`src/jobs/drain.ts:21-24`**, `JOB_INLINE_BUDGET_MS`), `batchSize: 3`, `maxJobs: 10`
(**`src/jobs/drain.ts:64-68`**). This is opportunistic work — the response is already sent, so
anything it does not finish stays `pending` and costs nothing. Full mechanics in
[flow 5](#5-job-lifecycle).

The claim itself is **`src/jobs/queue.ts:83`**, `PostgresJobQueue.claim`. The handler lookup and
dispatch is **`src/jobs/runner.ts:109`**.

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

**`src/jobs/handlers.ts:35`** — the `comment.process` entry unpacks the stored payload and calls
`handleCommentChange(payload.change, payload.entryId, { lastAttempt: isLastAttempt(job) })`.

`isLastAttempt` (**`src/jobs/handlers.ts:30`**) is `job.attempts >= job.max_attempts`. `attempts`
was already incremented by the claim, so on the third attempt of a `max_attempts = 3` job this
is `true`. It decides whether the pipeline may leave a failure retryable — getting it wrong
optimistically strands an interaction at PENDING forever, which in the dashboard looks exactly
like the webhook having stopped.

The legacy inline path passes `FINAL_ATTEMPT` (**`src/webhook/router.ts:287`**,
**`:306`**) — correctly, because that path has no retry to leave work for.
`WebhookHandlerOptions.lastAttempt` defaults to `true` everywhere it is omitted
(**`src/webhook/options.ts:14-26`**), so a caller that forgets gets the safe behaviour.

### 1.7 — `handleCommentChange` → `normalizeComment`

**`src/webhook/comments.ts:91`** — `handleCommentChange`. First call is `normalizeComment`
(**`src/webhook/comments.ts:60`**), then everything runs inside a `withLogContext` carrying
`comment_id` and `platform` (**`src/webhook/comments.ts:101-107`**) so one comment's whole
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
(**`src/webhook/comments.ts:87-88`**), which ends the flow.

`text` is lowercased here (**`:75`**, **`:88`**); Arabic normalisation happens later, in the
matcher.

### 1.8 — The self-authored loop guard

Two independent checks, because one of them is not reliable.

1. **`src/webhook/comments.ts:213`** — `selfAuthoredCommentIds.has(commentId)`. An in-process
   `Set` (**`src/webhook/comments.ts:46`**), capped at 500 entries with FIFO eviction
   (**`:57-65`**), written at **`src/webhook/comments.ts:461`** with the id of every public
   reply this instance posts.
2. **`src/webhook/comments.ts:228-229`** — `senderId === pageOwnerId`, where `pageOwnerId` is
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

**`src/webhook/comments.ts:219`** — `getCreatorByPageId(entryId)`, at
**`src/services/tenant.ts:158`**. One query, filtering `is_active = true` and matching
`entry.id` against `instagram_page_id` **or** `facebook_page_id`
(**`src/services/tenant.ts:169-175`**). No match logs `comment.no_creator` and returns
(**`:204-207`**) — not necessarily a bug (a webhook for a page this deployment does not serve),
but also exactly what a mis-set page id looks like, hence `warn`.

The page access token is decrypted here (**`src/services/tenant.ts:180`**,
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

**`src/webhook/comments.ts:237`** calls `loadLiveCampaigns(creator.id)`; the query is **`LIVE_CAMPAIGNS_SQL`** in
**`src/services/liveCampaigns.ts:32`** — every active campaign for this creator:

```sql
ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC
```

The `ORDER BY` is not cosmetic. Without it Postgres returns heap order, so a global campaign
could shadow a post-specific one on the same keyword — and which one won could change after a
`VACUUM`. Most specific first, then the longest trigger list (the length of the whole comma-separated
`trigger_keyword`, not of its longest entry: `specificityTiers`, **`src/services/matching.ts:43`**), then newest.

**`src/webhook/comments.ts:239`** — `matchCampaign(text, postId, campaigns)`, at
**`src/services/matching.ts:142`**. It re-sorts defensively with `bySpecificity`
(**`src/services/matching.ts:59`**, applied on a copy) so a caller handing it an
arbitrarily ordered array — a unit test, a cached list — gets the same winner the database path
does. Whether one campaign fires on one comment is `judgeCampaign` (**`src/services/matching.ts:108`**);
`matchCampaign` takes the first campaign that does. The dashboard's dry run, `POST /api/campaigns/try`
(**`src/services/campaignTry.ts`**), loads the same query and decides with the same function
(`rankMatches`, **:169**, for every campaign that fires; `winReason`, **:196**, for why the first
outranks the second), plus an unsaved draft; it writes nothing.

Per candidate:

- `trigger_keyword` is a **comma-separated list**, split on the ASCII `,` and on the Arabic `،` an Arabic keyboard
  types (`triggerKeywords`, **`src/services/matching.ts:78`**); any one matching is enough. An entry that normalises to
  nothing (a lone tatweel, a bare diacritic) is dropped, because an empty keyword is a substring of everything.
- Both sides go through `normalizeArabic` (**`src/utils/arabic.ts:5`**): tatweel/kashida stripped
  (**:11** — `تـــم` and `تم` are the same word, and stretched text is everywhere in social
  captions), Alef hamzas collapsed (**:13**), Teh Marbuta → Heh (**:15**), Yeh/Alef Maksura
  unified (**:17**), diacritics removed (**:21**), whitespace collapsed (**:23**).
- The test is `keywordMatches(text, keyword, mode)` at **`src/utils/arabic.ts:132`**.
  `mode` comes from the campaign's own `match_mode` column via `normalizeMatchMode`
  (**`src/utils/arabic.ts:109`**), which coerces anything unrecognised — including a column the
  query forgot to select — to `'substring'`.
  - `'substring'` (**`src/utils/arabic.ts:141`**) is the default and is dangerous for short
    keywords: `تم` is a substring of اهتمام, تمام and يتم.
  - `'word'` (**`src/utils/arabic.ts:143-148`**) anchors to token boundaries using explicit
    Unicode lookarounds, because JavaScript's `\b` is defined over `[A-Za-z0-9_]` and therefore
    fires in all the wrong places in Arabic.
  - An empty keyword returns false (**`src/utils/arabic.ts:139`**) — otherwise a trailing comma
    in a keyword list makes the campaign fire on every comment that arrives.
- `post_id` filter: `!c.post_id || c.post_id === postId` (**`src/services/matching.ts:122`**).

No match logs `comment.no_campaign_match` with the candidate count
(**`src/webhook/comments.ts:245-249`**) and returns. **A comment that matches no campaign
writes no row at all**, so that log line is the only evidence the comment was ever seen — and
silence in the activity log is therefore not proof of a delivery failure.

### 1.11 — `claimInteraction`

**`src/webhook/comments.ts:257`** calls `claimInteraction` (**`src/webhook/comments.ts:146`**).

```sql
INSERT INTO interactions (...) VALUES (..., 'PENDING', ...)
ON CONFLICT (comment_id) DO NOTHING
RETURNING id
```
(**`src/webhook/comments.ts:158-162`**)

A row back means a fresh claim. No row back means the UNIQUE index fired, and the function
re-reads the existing row (**`src/webhook/comments.ts:166-169`**):

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

A resumed claim logs `comment.resumed` (**`src/webhook/comments.ts:268`**), which is the only
thing separating a retry from a first delivery in the logs.

### 1.12 — Per-recipient 24h cap

**`src/webhook/comments.ts:272`** — `canDmRecipient(creator.id, senderId)`, at
**`src/utils/rateLimiter.ts:159`**: one row in `dm_send_log` for this creator+recipient inside
24 hours means no.

Refusal writes `status = 'FAILED'` with an explanatory `error_log`
(**`src/webhook/comments.ts:274-277`**) and returns. Recorded as FAILED rather than skipped
because the dashboard's vocabulary is `status`, and a row with no terminal status is an
interaction that looks stuck.

The docstring (**`src/utils/rateLimiter.ts:151-158`**) is honest that this is defensive rather
than confirmed: several 2026 write-ups describe it as a hard Meta rule for comment/story
triggers, but it could not be confirmed in Meta's primary documentation. It costs nothing, and
it stops the app repeatedly DMing someone who comments the same keyword five times.

### 1.13 — `checkFairSendQuota` — two ceilings

**`src/webhook/comments.ts:285`** — `checkFairSendQuota(creator.id, 'dm')`, at
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
the refusal say so: **`src/webhook/comments.ts:297-299`** writes a different `error_log` for
`'app'` than for `'creator'`, because otherwise the victim debugs their own account. The log
line is `error` level (**`src/webhook/comments.ts:288`**) — it means real customers are being
dropped.

### 1.14 — `splitDmTemplate`

**`src/webhook/comments.ts:308`** — `{username}` is substituted into `dm_template`.

**`src/webhook/comments.ts:310`** — `splitDmTemplate(dmText)`, at
**`src/webhook/comments.ts:123`**: split on the literal `[SPLIT]`, trim each part, **drop empty
ones** (`.filter(Boolean)`). A template ending in `[SPLIT]`, or with two in a row, otherwise
produced an empty send that Meta rejects with "param message must be a non-empty object". An
all-whitespace template falls back to the original text (**`:136`**) so the failure stays a
Meta error naming the empty message rather than becoming a silent no-op that looks like success.

### 1.15 — `sendPrivateReply` — the one retryable step

**`src/webhook/comments.ts:319`** — `sendPrivateReply(commentId, firstPart, token, fbPageId)`,
at **`src/services/instagram.ts:239`**. `POST /{page-id|me}/messages` with
`recipient: { comment_id }` and `messaging_type: 'RESPONSE'`
(**`src/services/instagram.ts:254-261`**). Facebook requires `/{page-id}/messages`; Instagram
works with `/me` — hence `fbPageId` being threaded through from
**`src/webhook/comments.ts:307`**. Wrapped in `withRetry`
(**`src/services/http.ts:158`**), which fires only on 5xx / 429 / transport faults.

**Meta allows exactly one private reply per comment, ever** (and only within 7 days —
**`src/services/instagram.ts:232`**). That constraint shapes everything below.

On failure (**`src/webhook/comments.ts:320-351`**):

1. Log `dm.send_failed` (**:311**).
2. `noteMetaFailure(creator.id, dmError)` (**:315**) — a dead token stops the whole account
   rather than one send, and nothing used to notice it at a call site.
3. `classifyDmError(dmError)` (**:327**), at **`src/webhook/errors.ts:60`**. Every branch but the last is permanent:
   - Meta code `10903` → `status: 'USER_BLOCKED_DMS'` (**`src/webhook/errors.ts:70`**)
   - **the comment already had its private reply** (code 10900 on Facebook; code -1 and only the words "already has a
     reply" on Instagram, usually because the creator messaged the person by hand first) → `FAILED`
     (**`src/webhook/errors.ts:81`**). Checked before code 100: read as transient, it was retried twice, and on 2026-09-27
     the last attempt posted the public fallback over a DM that existed.
   - code `100` ("invalid parameter": Meta won't take a private reply to this comment, typically from a person who can't
     receive messages from Pages, whom Facebook reports as `can_reply_privately=false`) → `FAILED`
     (**`src/webhook/errors.ts:93`**). It fails the same way on every retry, and the backoff only delayed the public
     fallback (§1.18b).
   - code `190` (dead token) or `200` (missing scope) → permanent
     (**`src/webhook/errors.ts:105`**, plus `isPermanentMetaError` at
     **`src/services/http.ts:81`**, whose `PERMANENT_CODES` is `{190, 200, 10903}` at
     **`src/services/http.ts:25`**)
   - everything else → `FAILED`, `permanent: false`

   The code is read structurally via `metaErrorCode` (**`src/services/http.ts:53`**) with a
   string match kept only as a backstop — `src/services/instagram.ts` used to interpolate the
   code into the message and discard `response.data.error`, so `permanent` came back false for
   every error including a dead token.

**The retry-vs-permanent split** — **`src/webhook/comments.ts:338`**:

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

**`src/webhook/comments.ts:395`** — `UPDATE interactions SET status = 'SENT'`.
**`src/webhook/comments.ts:396`** — `recordDmSent(creator.id, senderId)`, which writes the
`dm_send_log` row the 24h cap reads.

> **Why this order — SENT before the follow-ups, not after.**
> This used to sit after the whole `[SPLIT]` loop. Because exactly one private reply is allowed
> per comment, that made part 3 of a 3-part template able to mark the interaction FAILED even
> though the person had already received parts 1 and 2 — and worse, a retry of that row then
> re-sent the private reply, which Meta refuses outright. So the retry could only ever fail,
> three times, before recording a failure for a DM that was largely delivered. The conversation
> is open and cannot be opened again, so the status is settled here, before anything else has a
> chance to fail. Written out at **`src/webhook/comments.ts:389-394`**.

### 1.16b — The comment → DM bridge (DM plan S10)

**`src/webhook/comments.ts:399-410`** ("Step 1.25"), right after SENT and best effort: `recordPrivateReplyRecipient`
(**`src/services/dmSales/bridge.ts:162`**) writes the id the private reply went to (`recipient_id` in Meta's answer) on the
interaction, with the campaign whose text was sent (migration v41). One UPDATE by primary key, no Graph call; a failure is
`comment.bridge_failed` (`warn`) and changes nothing else, so the status stays SENT and the steps below still run.

The other half is on the DM path, and only in a **sales** turn: `commentSource` (**`src/services/dmSales/bridge.ts:230`**, called
from **`src/services/dmSales/turn.ts:370`**) looks for the latest SENT interaction whose `recipient_id` is the DM's sender, within
7 days (`BRIDGE_WINDOW_DAYS`, Meta's private-reply horizon). A match is stored on `conversations.source_campaign_id`, and the turn
starts at `recommend` with "they commented «keyword» and were sent the link" among its facts, instead of qualifying from scratch.
It never throws; anything it cannot read means "no source". With `sales_mode = 'off'` it runs no statement at all.

It rests on one assumption (A1): a private reply's `recipient_id` equals the `sender.id` of the same person's DMs. Until that is seen
to hold, both sides log the ids side by side (`comment.bridge_recorded`, `dm.bridge_matched`); a `recipient_id` that never turns
up as a sender is the sign it does not.

### 1.17 — `[SPLIT]` follow-ups — best effort

**`src/webhook/comments.ts:414-434`**. Each follow-up waits 500 ms to preserve ordering
(**:357**) then goes out via `sendDirectMessage` (**:358**,
**`src/services/instagram.ts:323`**) — a normal DM to `senderId`, not another private reply,
because the thread is already open.

A failure logs `dm.split_part_failed` (**:360**), calls `noteMetaFailure` (**:363**), appends to
`error_log` naming which part failed and stating the first message *was* delivered
(**:364-370**), and **breaks** (**:373**) rather than pressing on — delivering part 3 without
part 2 reads worse to the recipient than stopping short. `status` stays SENT throughout.

### 1.18 — Auto-like

**`src/webhook/comments.ts:438`** — `likeComment(commentId, token)`, at
**`src/services/instagram.ts:575`** (`POST /{comment-id}/likes`, same edge on both platforms).
Purely best-effort algorithmic boost: a failure is a `warn` (**:382**) and nothing else.

### 1.18b — The DM can't be delivered: a public reply instead

**`src/webhook/comments.ts:350`**. On the final-failure path only: when `shouldPostDmFallback(dmError)` (not a dead token,
not 10900), it posts `dmFallbackReply({ dmText, isFacebook, register })` (**`src/webhook/errors.ts:54`**): the first URL in the
DM on Facebook, "link in bio" on Instagram. The language is the DM's own (Arabic script or not); the Arabic register is the
tenant's comment surface, read by `fallbackRegister` (**`comments.ts:201`**, via `profileContextOrLegacy`) **before** the row is
written FAILED, and the lines are `KITS[register].commentFallback` (**`src/services/profile/kits.ts:362`**,
`commentFallback` at **`:301`**). A profile that can't be read is the owner's Gulf line for the owner; for any other tenant the
job is retried with the row still PENDING (a FAILED row would make the retry a duplicate), and on the last attempt the reply goes
out in the neutral wording with a `comment.fallback_register_unreadable` line. DM code 100 is permanent
(**`src/webhook/errors.ts`**, `classifyDmError`), so this doesn't wait for the ~10-minute backoff. The campaign's own
public reply (1.19) is skipped, since it says to check the DMs.

### 1.19 — Public reply

**`src/webhook/comments.ts:445`**, only when `public_reply_template` is set.

- The template is a `|`-separated list of variations; one is picked at random
  (**`src/webhook/comments.ts:448-449`**) so a post's comment thread does not fill with the
  same sentence.
- `{username}` substituted (**:391**).
- `sendPublicReply` (**:394**, **`src/services/instagram.ts:293`**) — Instagram posts to
  `/{comment-id}/replies`, Facebook to `/{comment-id}/comments`
  (**`src/services/instagram.ts:299`**).
- **Never repeated when it may have landed** (2026-10-27): `withRetry(..., { creates: true })`, the
  rule of [3.4b](#34b--a-reel-instagram-is-still-processing-and-facebook-creates). A timeout, a reset or
  a 5xx may come after Meta posted the reply, so only a refusal (429, codes 4/17/32/613) or a connection
  that never went out is retried; otherwise the commenter could see the same reply twice.
- **`src/webhook/comments.ts:461`** — `rememberSelfAuthored(posted?.id)`, closing the loop from
  [1.8](#18--the-self-authored-loop-guard).

Failure keeps SENT (**:405-406**) and appends to `error_log`. A Meta code 200 gets rewritten
into an actionable message naming `pages_manage_engagement` (**:410-412**), because the raw
error says nothing about which permission is missing.

---

## 2. DM → AI reply

Someone sends a direct message. Gemini answers it.

### 2.1 — `planJobs`' messaging branch, and what never becomes a job

Hops 1.1 to 1.5 are identical — same route, same signature check, same enqueue-before-ack. The
divergence is at **`src/webhook/router.ts:170-180`**, the `entry.messaging` branch.

**`src/webhook/router.ts:172`** — `if (!isActionableMessagingEvent(event, options)) continue;`. That
function (**`src/webhook/router.ts:86`**) drops:

- **echoes** — `event.message.is_echo` (**:67**), the page's own outbound messages coming back.
  On an active account they are a large share of all messaging events. **Unless echo takeover is on**
  (`dm.echo_takeover`, off by default, §2.6d): then a person's echo is a job like any message, and only an echo
  whose `app_id` is this deployment's own app is still dropped. The queue reads that switch only for a
  delivery that holds an echo (**`enqueueWebhookBody`**), and reads it as off when it cannot.
- **everything with neither `message` nor `postback`** (**:68-70**) — read watermarks, delivery
  receipts, reactions, referrals, handover-protocol events. **Except one referral (A3):** a standalone
  `referral` whose `source` is `ADS` (a person who already has a Messenger thread tapped a click-to-Messenger ad) is a job,
  because it says which ad brought them (`isAdReferral`, §12.1). A referral from an `m.me` or `ig.me` link is
  still dropped.

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
(**`src/webhook/router.ts:50`**); `tenantKey` is `entry.id` as before. A standalone ad referral has no `mid`, so
`dmDedupeKey` makes it `dmref:<sender>:<ad id or ref>:<timestamp>`: who, which ad and when is what makes it one event,
and a redelivery is refused at enqueue like a message's.

The handler adapter is **`src/jobs/handlers.ts:40`** → `handleMessagingEvent`.

### 2.2 — `handleMessagingEvent` and `normalizeDm`'s shapes

**`src/webhook/messaging.ts:235`**. A second echo check at **:130** (the inline fallback path
does not go through `isActionableMessagingEvent`) hands the event to `handleEcho` (`src/webhook/echo.ts`,
§2.6d), which with takeover off reads one setting and drops it, as it always did. Then `normalizeDm`
(**`src/webhook/messaging.ts:112`**).

| Shape | Source | Stored as |
|---|---|---|
| plain text message | `event.message.text` | `message_type = 'text'` |
| quick reply | `event.message.quick_reply.payload` (text still from `message.text`) | `'text'`, payload kept |
| postback | `event.postback.title` → text, `event.postback.payload` → payload | `'text'`, payload kept |
| **ad referral, no words** (A3) | a standalone `event.referral` with `source: 'ADS'`, no `message` and no `postback` | no message row; recorded on the conversation only (§2.4b), job outcome `ad_referral_recorded` |
| **no words** | no text and no payload, but `message.attachments[]`, `message.reply_to.story` or `message.is_unsupported` (`src/webhook/attachments.ts`, `describeWordless`) | `message_type` = its kind (`image`, `video`, `audio`, `file`, `sticker`, `share`, `reel`, `story_share`, `story_mention`, `story_reply`, `attachment`), `text` = a placeholder (`[photo]`) |

A **message with no words** is stored whole (`raw_payload` is the Meta event, which already holds each attachment's `type` and
link), drawn in the inbox as a chip, and **never reaches a model**, in any `sales_mode`: `answerDm` hands it to `acknowledgeWordless`
(`src/webhook/attachmentAck.ts`) before it reads the mode. That sends one fixed kit line (`kit.attachments.mention` for a story
mention, `.media` for the rest, nothing for a sticker), claimed as an outbound row in one statement so a burst is acknowledged once and
never in place of a real answer. Skipped, with the message still marked handled, when the bot is paused, the agent is off, the claim
refuses or the send quota refuses (no retry for an acknowledgement); a transient send failure takes the claim back and retries.

**`adSource` (A3).** `normalizeDm` also returns `adSource`, from `adSourceOf` (**`src/services/ads/attribution.ts`**): the first of
`message.referral` (Instagram click-to-Direct, on the person's first message), `postback.referral` (Messenger click-to-Messenger, a NEW thread: the
greeting's or an ice breaker's postback) and the event's own `referral` (Messenger, an EXISTING thread). It is an ad only when `source` is `ADS`
(an `ig.me` or `m.me` link's referral is not) and there is an `ad_id` or a `ref`; the platform comes from the body's `object`. Everything else about
the event reads as before: a postback's `title` is still the person's words, so an **ice-breaker tap is answered as the question they tapped**. Null
for every event that is not from an ad, which is every event but the ones above.

Rejection: no `senderId`, or no text, no payload *and* nothing word-less *and* no `adSource` (read and delivery receipts, reactions, referrals that are
not ads, and an unsend, `message.is_deleted`, even one that still lists attachments). An attachment alone is no longer rejected: it used to be, which
was a person waiting for an answer to a message nobody had stored. `dm.skipped_empty` logs `has_message`, `is_deleted` and the
attachment types.

`metaMessageId` is `message.mid ?? postback.mid ?? null` (**`src/webhook/messaging.ts:157`**).

Everything downstream runs inside a `withLogContext` keyed on `mid` and `sender_id`
(**`src/webhook/messaging.ts:254`**), so one inbound message and all its retries share a filter.

### 2.3 — `mayRetry`

**`src/webhook/messaging.ts:395`** — `Boolean(dm.metaMessageId) && !options.lastAttempt`.

The `mid` is load-bearing, not decoration: it is the only thing letting a second attempt
recognise the row the first one wrote. Without it the partial unique index never fires, so a
retry would insert a **second** inbound row and answer the same person twice. An event with no
`mid` therefore gets exactly one attempt, whatever the job budget says.

### 2.4 — Tenant, then conversation upsert

**`src/webhook/messaging.ts:399`** — `getCreatorByPageId(recipientId, entryId)`. Two ids, in
that order: `recipient.id` on a message event is the Instagram Business Account id (most
reliable); `entry.id` could be the IG id or the FB Page id depending on subscription type.

**`src/webhook/messaging.ts:425-434`** — the conversation, as **one** statement:

```sql
INSERT INTO conversations (creator_id, instagram_user_id, status, platform) VALUES ($1, $2, 'active', $3)
ON CONFLICT (creator_id, instagram_user_id)
DO UPDATE SET last_message_at = NOW(), handled_at = NULL, platform = COALESCE(conversations.platform, EXCLUDED.platform)
RETURNING id, is_bot_active, ai_disclosed_at
```

`handled_at = NULL` (v45) is how a new question returns a thread to the owner's To do: "Mark handled"
(`POST /api/conversations/:id/handled`) stamps the column, and the next message **from the customer**
clears it, in this same statement. Nothing else clears it: the owner's own reply, an Instagram-app
echo and the bot's messages move `last_message_at` or the AI switch elsewhere and leave it alone.

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

### 2.4b — The ad touch, and the referral with no words (A3)

Only an event with an `adSource` does any of this; every other DM costs nothing extra here. **Meta only sends the referral if the Page is subscribed to
`messaging_referrals`** (`WEBHOOK_FIELDS` in **`src/services/metaLogin.ts`**, beside `feed`, `messages` and `messaging_postbacks`; a Page connected before A3
is subscribed again only by the next Facebook reconnect, which re-posts `subscribed_apps`; the App Dashboard's Page webhook needs the field too, and
`scripts/diagnose.mjs` warns when the app-level `page` subscription lacks it). Instagram needs nothing more: its ad referral rides on `messages`.

1. **Recorded** by `recordAdTouch` (**`src/services/ads/attribution.ts`**), in one statement that takes the conversation's row lock. The FIRST touch
   (no entry source yet, and no inbound message before this event's own) becomes `conversations.entry_source`
   `{ kind: 'ctm', platform, ad_id, ref, ads_context_data: { ad_title, photo_url, video_url, post_id }, at }` and **is never rewritten**. Every later
   touch goes in front of `conversations.ad_touches` (v54, newest 10). The same touch twice (a redelivery) is `duplicate` and writes nothing.
   `ads.touch_recorded` logs which of `entry` / `touch` / `duplicate` / `missing` happened. It never throws: attribution must not cost a reply.
2. **A referral with no words sends nothing.** No inbound row is claimed, there is nothing to answer, and the job ends done with the outcome
   `ad_referral_recorded` (the conversation is created or updated, its entry source or touch recorded). A person's first referral that arrives with a
   message or an ice-breaker postback is recorded the same way and the message is then answered like any other.
3. **The join to the ad is not done here.** The conversation keeps the raw `ad_id` and our own `ref`; the Inbox and the Ads screen join at read time
   (§12.3), so an ad made in Meta's own Ads Manager before the next sync costs this path nothing.

### 2.5 — `claimInbound` and the 300-second re-claim window

**`src/webhook/messaging.ts:446`** → `claimInbound` (**`src/webhook/messaging.ts:282`**).

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

`REPLY_CLAIM_VISIBILITY_SECONDS = 300` (**`src/webhook/messaging.ts:47`**). No row means either
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

**`src/webhook/messaging.ts:472`** — `if (!conversation.is_bot_active)`. Logs `dm.bot_paused`,
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
   turn. **Ad context (A3, `ads.bot_context`, off by default):** for a conversation that began from an ad, and only when the tenant's owner switched it
   on, the facts block gets up to three lines, `AD CONTEXT: The person came from the ad "<name>" about <offer>. The ad said: "<text, at most 200 characters>". They
   tapped: "<ice breaker>".` (`adFactsFor`, **`attribution.ts`**: the ad's name from the stored copy, else the title Meta sent; the offer from the ad's
   `app_meta.offer_id`; never the media links). **With the switch off the prompt is byte for byte what it was**, pinned by the golden tests in
   `prompt.test.ts`. The thread it reads is `salesTurns` (**`history.ts`**): a carousel or buttons the bot sent are shown as `[sent cards: …]` and
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
9. **A link queues its follow-up** (S9, below). The same `recordTurn` statement hands back the link's time (`last_link_at`) and the reply row's id; a
   reply that carried a link then calls `scheduleFollowup` (**`src/services/dmSales/followupJob.ts`**), after the record and before the message is
   marked handled.

### 2.6c — The follow-up nudge (DM plan S9)

One short nudge, a few hours after a sales DM sent a link, to someone who has not answered or opened it. Only the sales turn queues it, so
`sales_mode = 'off'` (and a test sender who is not on the list) queues nothing.

1. **Queued** by `scheduleFollowup`: one `dm.followup` job per link SENT, `run_after` = the link's time + `dm.sales.followup_minutes` (an operator
   setting, 0 to 1320, default 240, 0 is off; edited by a platform admin on the AI settings screen, `POST /api/settings/sales-followup`), and
   `dedupe_key = dm-followup:<conversation>:<message that held the link>`, so a re-run recording cannot queue a second. It never throws: a queue
   that fails costs the nudge (`dm.followup_schedule_failed`), never a retry of the turn that already answered.
2. **Drained** like any job (the Heroku worker, the GitHub schedule, the daily cron): the handler is `runFollowup`
   (**`followupJob.ts`**) and the rules are `followupEligible` (**`followup.ts`**, pure, one table-driven test).
3. **Re-checked when it runs; nothing is ever cancelled.** The job reads the conversation, its tracked-link clicks, the tenant's sales mode and the
   delay AGAIN. It sends only if: the sales mode answers this sender, follow-ups are not switched off, the agent is on, no opt-out, no hand-off,
   the AI not paused, no nudge sent yet (one per conversation, ever), the stage still `link`, no newer link, the person has not written since the
   link, no click by a PERSON (`link_clicks.is_prefetch = false`: Meta's own crawler opens every link, and does not count), and less than 23 hours
   since their last message (Meta's window is 24). **The 23 hours is the default of `windowEndsAt` (A3, `ads/attribution.ts`)**: for a conversation that
   began from an ad (`entry_source.kind = 'ctm'`) on a platform whose `ads.extended_window` switch is on, the window closes at the LATER of their last
   message + 23 h and the ad click + 7 days − 1 h (Meta's window for a click-to-message ad since 2026-09-28 runs from the click). The job reads the
   switch only for an ad conversation, so every other one costs no extra statement. Otherwise the job ends as done and says why (`dm.followup_skipped`, `reason`).
4. **Claimed before it is sent, so it goes at most once.** One conditional `UPDATE` (`followups_sent + 1`, stage `follow_up`) that repeats the rules
   that matter; two drains at once, a retry and a reaped claim cannot both win it. A send that fails gives the claim back and is retried by the
   runner, except Meta's final answers (a dead token, a blocked recipient, outside the window, error 551, Business AI's hold: §2.9), which are not.
5. **The line** is the kit's (`SalesLines.nudge`, per register and English): no model, no link, no number. It is sent as `RESPONSE` through
   `sendDirectMessage`, recorded as an outbound `messages` row with `ai_meta {kind: 'followup'}`, and the same quota check as every send applies.

### 2.6d — Handoff, the owner's alert, and echo takeover (DM plan S8)

**A handoff is decided by `flow.ts` and written by `turn.ts`** in one statement with the customer's line (`recordTurn`): the bot paused
(`is_bot_active = false`), `stage = 'handoff'`, `handoff_at`, `handoff_reason`, and the profile's own handoff line (`dm.handoff.message`) or the
kit's, never the model's words. **Then `src/services/dmSales/handoff.ts` tells the owner**, after the customer has been answered and the state
recorded, best effort (`notifyOwner` never throws; a failure is `dm.handoff_notify_failed` with a status and a description scrubbed of the bot token):

1. `noticeFor` (pure): stage `handoff` is a handoff alert (also a conversation paused for looping); a second insult (stage `closed`) and an opt-out
   alone are NOT; a reply that SENT the link (`linkSent`) to an intent in `HOT_INTENTS` (`ready_to_buy`, `price`, `level_fit`) is a hot lead.
2. `notifyOwner` (every alert, from every caller, goes through it): the two channels' settings in ONE read (`readNotifyChannels`). Telegram configured and
   on (`notify.telegram_*` in `app_settings`; the token encrypted, `{set, last4}` to the card), hot leads on (`notify.telegram_hot_leads`, on unless
   turned off); and/or email configured and on (`notify.email_*`: a Resend API key, encrypted, `{set, last4}` to the card; the address, else the site
   contact email; `notify.email_hot_leads`, OFF unless turned on). A channel that is not on and complete is skipped, and with both off nothing is spent.
   Then the conversation is the platform OWNER's tenant (another tenant's customers are never sent to his chat or inbox), then the per-conversation
   allowance (`rate_limit_counters`, buckets `notify:<id>` 3/hour and `notify_hot:<id>` 1/hour, spent once per alert whatever the number of channels),
   then the facts (username, last inbound message, its time), then each channel, at the same time and independently (one refusing, timing out or
   throwing costs the other nothing): one plain-text `sendMessage` (no `parse_mode`; links and bidi controls in the customer's words are taken out), and/or
   one plain-text email (`POST https://api.resend.com/emails`, `notifyEmail.ts`; the same text plus a channel line, the subject naming the channel and the
   customer): who, why, the last message, how long Meta's 24 h window has left, and `/dashboard#/inbox?c=<id>`. Logs: `dm.handoff_notified` /
   `dm.handoff_notify_failed` for Telegram, `dm.handoff_notified_email` / `dm.handoff_notify_email_failed` for email (the description scrubbed of the key and
   of any address). Saving a Resend key (`POST /api/settings/notify`, `email.apiKey`) switches email on and sends one test email whose result comes back as
   `emailTest`; `POST /api/settings/notify/test-email` is the button. Without a verified domain Resend delivers only to the address the account was made with.
3. The inbox reads `stage`, `handoff_at`, `last_operator_at` and `last_inbound_message_at` (`conversationsQuery`) for "Needs you" (stage `handoff`,
   and nobody has answered since `handoff_at`: **whether the bot is paused or not**, because a sales handoff pauses it and a reply that could not be
   written at all, §2.11, leaves it on) and the window countdown. The follow-up job (§2.6c) already refuses a conversation that was handed over.

**Resume:** `PUT /api/conversations/:id/toggle-bot` turning the bot ON for a thread that was paused also clears `ai_disclosed_at`, so the next
reply says it is automated again (Meta asks for the disclosure when a chat moves from human to automated). Turning it ON also moves a `handoff`
stage on to `new` (a separate best-effort statement: `stage` is v39), which the bot already treats alike, and which ends "Needs you" for a thread
whose bot was on all along. The bot's own next turn in the sales flow ends it the same way, by leaving the `handoff` stage.

**Echo takeover** (`src/webhook/echo.ts`, assumption A4; off by default, `dm.echo_takeover`). An echo is the account's own message coming back;
pausing on ours would silence the bot after every reply, so only positive evidence pauses it: `app_id` on the owner list (the Page inbox app's, plus
ids the operator adds) is the owner; `app_id` equal to `META_APP_ID` / `INSTAGRAM_APP_ID` is ours; no `app_id`, or another app's, is UNKNOWN and
does nothing, and every classified echo is logged as `dm.echo_classified` with the `app_id` seen. Meta documents `app_id` on Messenger echoes only,
so what an Instagram-app reply carries is unproven. An owner echo pauses that customer's conversation (tenant and sender scoped), stores his
words as an `operator` row keyed on Meta's message id, and sends nothing.

### 2.6e — The inbox's sales view and the funnel (DM plan S11, S12)

**Read-side only: nothing here sends, pauses or writes.** The dashboard draws what the sales turn already stored.

1. **`GET /api/conversations`** (**`routes/api.ts:3253`**) asks `loadLinkClicks` (**`services/inboxDetail.ts:130`**, `LINK_CLICKS_SQL`) for the page of
   thread ids, tenant-scoped: per conversation, the tracked links created, the clicks by a PERSON (`NOT is_prefetch`), the previews on their own
   count, and the newest person's click. It is its own optional lookup: a database without v38 logs `inbox.detail_failed` and answers the list
   without counts. `conversationView` (**:155**) pins the v39 columns (`salesView`, **:83**: `stage` only if it is one of `STAGES`, else null) and
   attaches `link_clicks`.
2. **The inbox** (`dashboard/js/pages/inbox.js`) draws a stage chip per thread (`stageChip`, **:921**), the Hot filter (`Attention.isHot`, **`dashboard/js/attention.js:52`**: a person
   opened the link, or `last_intent = ready_to_buy`, or `handoff_reason = hot_lead`; never a closed or opted-out thread), the link clicks in the
   header (`linkChips`, **:1479**) and, under each AI reply, what `messages.ai_meta` says the bot decided (`aiMetaDetail`, **:2272**: intent, stage,
   next action, offer, engine, handoff reason). Every value but the offer id is looked up in a closed list that `inboxSales.test.ts` compares with
   `dmSales/types.ts`; any other value is shown as escaped text and never used as a key.
3. **`GET /api/dm/funnel?days=7|30|90`** (**`routes/api.ts:3499`**, any role, `Cache-Control: no-store`) runs three read-only statements with the
   session's tenant as `$1` (`loadDmFunnel`, **`services/dmFunnel.ts:290`**) and counts them in `buildDmFunnel` (**:235**). **The cohort** is the
   conversations whose FIRST customer message is in the window. **A step is "reached at least"** and the row keeps only where a conversation is now,
   so `reachedOf` (**:170**) reads the stage, every stage a bot reply recorded in `ai_meta.stage`, and the columns a step sets (`qualifier_turns`,
   `offers_linked`/`last_link_at`, `followups_sent`, `handoff_at`, `opted_out_at`). Steps: conversations, qualified, recommended, link sent,
   clicked; outcomes beside them: follow-up, handoff, closed, opted out, complaints. **A click is a person's:** the statement hands the visits back
   grouped by `is_prefetch` and `buildDmFunnel` leaves the previews out (and `clicked` needs a link that was sent). **Reply time** is the bot's
   p50 and p90 over every customer message in the window: the next outbound message of any kind, counted only when `sender = 'ai'` and not a
   follow-up nudge.
4. **The card** sits in the inbox sidebar, closed, and asks only when opened or when the period changes (never from the 5 s poll). An answer that
   arrives after a newer question, or after the page was left or the tenant switched, is dropped.

**Checking it:** `dmFunnel.test.ts` counts from fact rows worked out by hand (`dmFunnelTestFixtures.ts`); `dmFunnel.sql.test.ts` runs the real
statements against a local migrated Postgres on the same world (`DM_FUNNEL_TEST_DATABASE_URL`, every row rolled back).

### 2.6f — A/B wording variants (v42, DM plan S14)

**Only inside the sales turn: `sales_mode = 'off'` (and a test sender who is not listed) never reads any of this.** The owner writes two or three
variants (how to open the first reply, how to word the offer of the link) in AI settings, saved per tenant as `app_settings` `dm.variants.<creator id>`
(`POST /api/settings/sales-variants`, **`routes/api.ts:4096`**, operator; `parseVariantConfig`, **`dmSales/variants.ts:78`**, refuses a link or a number
in the wording and a running experiment with fewer than two variants that have a share).

1. **Read** with the history, in `runSalesTurn` (**`dmSales/turn.ts:333`**): `readVariantConfig` never throws, and an unreadable value, a version it does
   not know or a database error is "no experiment" (`dm.variants_unreadable`, `dm.variant_config_read_failed`). A tenant with no experiment goes no
   further, and its recording statement is byte for byte the old one.
2. **Assigned** only when an experiment is RUNNING (`activeVariants`: enabled, two arms with a share) and the conversation has no bot reply yet
   (`firstReply`, **:338**): `chooseVariant` (**`variants.ts:205`**) keeps the arm already on `conversations.sales_variant` (read in its own statement,
   **:341**: a database without v42 logs `dm.variant_unavailable` and the turn has no arm), else hashes the conversation id onto the weights
   (`assignVariant`, **:175**: SHA-256, so the same id is the same arm on every server). **A conversation already under way is left out of the
   experiment** (no arm, the prompt it had), and an arm deleted from the editor is the prompt as it was.
3. **Told to the model in the conversation's facts**, never in the cached system text (`salesFactsBlock`): the opening only for the first reply, the link
   wording for every reply. The rules above it still hold: the model writes no link and no number the data does not hold.
4. **Written once**, in the statement that records the reply (`setState`, **`dmSales/store.ts:184`**: `sales_variant = COALESCE(sales_variant, $n)`), so an
   arm is never moved, and `ai_meta.variant` says which arm a reply came from. A turn that never reaches the model (refund, opt-out, insult) assigns none.
5. **Counted** by `GET /api/dm/funnel`'s `variants` section (**`dmFunnel.ts:122`** reads the arm in a statement of its own, **`dmVariantFunnel.ts:75`**
   counts it with the funnel's own `reachedOf`): per arm, conversations, recommended, linked, clicked and the two rates. **Below 30 conversations an arm
   shows its counts and no percentage**, and nothing in it names a better arm: no significance test is run.

**Checking it:** `variants.test.ts` (parsing, the hash and its spread over the weights, stickiness), the A/B block of `turn.test.ts` (including that
`off` never reads it), `dmVariantFunnel.test.ts` (a fixture world counted by hand, and the gate at 29 and 30).

### 2.6g — A tracked link is opened: `GET /r/:code` (DM plan S7)

**`src/routes/links.ts:54`**, public, mounted at `/r` before any auth (**`src/index.ts:202`**). Codes are minted by the sales
turn's `linkFor` (**`src/services/dmSales/link.ts:28`**; one per conversation and offer, step 7 of §2.6b) and by an ad draft's
`mintAdLink` (**`src/services/links.ts:176`**; one per ad and offer, §11.3).

1. **A malformed code** (`isLinkCode`, **`src/services/links.ts:43`**) is a 404 without a database read, and an unknown one the
   same 404 (the site's bilingual page for a browser). A database that cannot be read is a **503** with `Retry-After: 30`: a 404
   would say the link does not exist.
2. **A known code is a 302** to `tracked_links.target_url` exactly as stored (`resolve`, **`src/services/links.ts:203`**): no
   `res.redirect`, which re-encodes, and nothing appended. The target comes from the table and nowhere else, never from the URL,
   the query string or a header, so this is not an open redirect. Every answer carries `Cache-Control: no-store` and
   `X-Robots-Tag: noindex`.
3. **The click is counted after the 302 has gone out**, under `waitUntil`: one `link_clicks` row (`recordClick`,
   **`src/services/links.ts:287`**) with `ua_class` and `is_prefetch` from `classifyClick` (**`src/services/links.ts:258`**). A HEAD,
   a speculative-load header, a known preview fetcher, a crawler or a request with no user-agent is a prefetch, not a person; the
   Instagram and Facebook in-app browsers are people. A failed count is `links.click_not_recorded` and costs the person nothing.

Only `is_prefetch = FALSE` rows are clicks to anything that reads them: the follow-up nudge, which skips a person who clicked
(§2.6c), the sales funnel (§2.6e) and an ad's `trackedClicks` (§12.4).

### 2.7 — Gemini

**`src/webhook/messaging.ts:571`** — `generateAiResponse(conversationId, dmPromptText(dm),
creator.id, undefined, dmCtx)`, at **`src/services/ai.ts:515`**. Timed and logged as `ai.replied` with
`duration_ms` (**`src/webhook/messaging.ts:583`**), because this is both the dominant
marginal cost of the product and the reason the webhook cannot finish inside Meta's timeout.

**Which engine answers (v37, DM plan S3)** — the call above is now `generateDmReply` (**`src/services/dmEngine.ts`**), which reads
`ai_agents.engine` and dispatches. `gemini` (the default, and what a row from before v37 or a failed read means) is
`generateAiResponse` exactly as it was: the same request, pinned byte for byte by `ai.test.ts`. `providers` is `generateDmViaLayer`:
the same `dmSystemInstruction` text, history window and `enforceMetaConstraints`, written through the AI providers layer
(`generate`, purpose `dm`, system prompt cached, the `dm` route and budgets from Operations). A `providers` failure of any kind (no key,
no route, 5xx, timeout, a refused budget, an empty answer) is answered by Gemini once when `ai_agents.gemini_fallback` is on, logged
`dm.engine_fallback`. With the fallback off, or Gemini failing too, the result is `{ kind: 'handoff' }` and `dm.engine_failed`: no
second try (it would only spend the same budget again), but **not silence either**. The pipeline calls `handOver()`
(**`src/webhook/messaging.ts:577-578`**), the same `handoffAfterFailure` a reply that fails on its last attempt gets (§2.11): the
conversation is stamped (the bot stays on), the customer is sent the handoff line once, and the owner is alerted. Then `markHandled`
(terminal, not retried). An agent that is
switched off is `null` for either engine, as below. The sandbox runs the engine on screen (`POST /api/settings/ai/test`, `engine` and
`gemini_fallback` in the body), labels the layer's spend `eval`, and answers 502 with the reason when nothing could answer.

**The wording is the tenant's** — `dmCtx = profileContextOrLegacy(creator.id, 'dm')` (**`src/webhook/messaging.ts:530`**,
the function at **`src/services/profile/context.ts:344`**) is read once per DM and handed to `generateAiResponse`, the
disclosure and (in the sandbox, which reads it itself, **`src/services/ai.ts:524`**) the starter persona. It says the language
and register the `dm` surface speaks and what the creator sells. A profile that can't be read is logged
`profile.context_unreadable` and is, for the platform owner (`getPlatformOwnerId`, or anyone when that lookup fails), his
Gulf/course wording (`legacyContext`, **`context.ts:293`**), never a failed reply; for any other tenant it throws
`ProfileUnreadableError` (**`context.ts:305`**), which the DM catch re-raises while a retry is left, so the job runner backs off.
The Studio's language is not the DM's: a settings write that moves an Arabic profile off `ar` pins `surfaces.dm` to the Arabic
and register it spoke (`intoProfile`, **`src/services/profile/views.ts:171`**), so switching the Studio to English leaves the bot Arabic.
`dmSystemInstruction(prompt, kb, ctx)` (**`src/services/ai.ts:509`**) writes the persona, the knowledge base and three
rules from `kitFor(ctx.language)`: the register rule 1 asks for, rule 2's offer noun by `who.offerKind` (courses,
programs, products, services, else offers), the character limits. Gulf + courses is today's text byte for byte.

**`decideAgent`** — **`src/services/ai.ts:484`**, called at **`src/services/ai.ts:544`**. The
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
*whether anyone did*. It is now selected, not filtered on (**`src/services/ai.ts:532-536`**).
The unconfigured case is the more dangerous of the two and was fixed later: a tenant created
through `POST /api/admin/tenants` has no `ai_agents` row at all, so there was no `is_active` for
the off switch to be false on, and their bot answered real customers in a persona nobody chose
while every layer reported success.

`decideAgent` returning `speak: false` makes `generateAiResponse` return **`null`**
(**`src/services/ai.ts:551`**), logged `warn` for unconfigured and `debug` for disabled
(**:383**). The caller honours it at **`src/webhook/messaging.ts:445-449`**: log
`ai.agent_disabled`, `markHandled`, send nothing. **Every other failure throws** — there is no
fallback persona and no fixed promotional reply.

**History window** — **`src/services/ai.ts:561-568`**: the last `HISTORY_WINDOW = 8`
(**`src/services/ai.ts:97`**) messages for this conversation, `ORDER BY created_at DESC`, then
reversed into chronological order (**:571**). Trimmed from 15 because the system prompt and the
entire knowledge base are re-sent verbatim on every call, and Arabic runs ~2-2.5× more tokens
per character than English. The current message is appended only if it is not already the last
row (**:417-423**).

**`responseSchema`** — `dmResponseSchema(ctx)` at **`src/services/ai.ts:254`** (says "written in Arabic|English" and the
button id `GO_TO_COURSE_1|GO_TO_OFFER_1`), passed with `responseMimeType: "application/json"` in `generationConfig`
(**`src/services/ai.ts:616`**). It constrains `message_type` to
`text | quick_reply | carousel` and describes Meta's own limits inline (quick-reply titles ≤ 20
chars, carousel titles ≤ 80, 2-10 cards).

**Temperature** — **`src/services/ai.ts:605`** uses `Number.isFinite(agent.temperature)`, not
`|| 0.7`. The old form turned a deliberate `0` — the setting you pick precisely to stop the agent
improvising about prices — back into 0.7.

**Which key** — **`src/services/ai.ts:557-558`**, only once the agent has decided to speak:
`getGeminiKey()` (**`src/services/appSettings.ts:446`**) returns the key a platform admin saved
on **Operations → Gemini API key**, else `GEMINI_API_KEY`. One key serves every tenant. With
neither set it throws `MISSING_GEMINI_KEY`, which names both places to fix it; a switched-off
agent never gets this far, so it needs no key.

**The API key travels in a header, not a query string** — **`src/services/ai.ts:176`** (`postToGemini`):

```js
axios.post(url, payload, { headers: { 'x-goog-api-key': gemini.key }, timeout: GEMINI_TIMEOUT_MS })
```

Not `?key=`. Query strings end up in proxy logs, browser referrers and error reporters far more
readily than headers do — and an axios error carries `config.url`, so the old form leaked the
key into anything that logged one. The catch block at **`src/services/ai.ts:691-698`** logs
narrow fields for the same reason, never the error object.

`GEMINI_TIMEOUT_MS = 30_000` (`src/services/ai.ts`) — Gemini can sit on a request
indefinitely; a serverless invocation cannot. It is the budget for the whole exchange, **one
quick retry included** (`postToGemini`): HTTP 503, 429, 500, a socket reset or a timeout is
retried once — first attempt 18 s (`GEMINI_FIRST_ATTEMPT_MS`), a 0.5–1.5 s jittered wait, then
the rest of the 30 s, never under 10 s. Any other 4xx, a safety block or a non-JSON answer is
not retried. The body is byte-identical on both attempts; the retry is logged `ai.gemini_retry`
(status/code and attempt only, never the error object). Before this a transient 503 failed the
job and waited out the runner's backoff plus the worker's next poll (100–175 s).

**Token usage** is logged as `ai.usage` (**`src/services/ai.ts:635-642`**): `usage_in`, `usage_out`, `usage_total` and
`usage_cache_read`, because `usage_in` is mostly the static prefix and that is precisely the
number that says whether Gemini context caching is worth turning on. (Named `usage_*` because the logger blanks any field whose
name contains "token"; until 2026-10-25 these were `*_tokens` and printed `[redacted]`.)

### 2.8 — `coerceAiResponse`

**`src/services/ai.ts:331`**, called at **`src/services/ai.ts:671`**. `responseSchema` is a
strong constraint, not a guarantee. Every one of these used to reach `toMetaMessage` unchecked:

- `message_type: "carousel"` with `carousel_elements` absent or empty → Meta answers "param
  message must be a non-empty object", untraceable back to the model.
- `message_type: "quick_reply"` with no `quick_replies`.
- `text` (or a `quick_replies[].title`) returned as a **number** → `enforceMetaConstraints` then
  called `.substring` on it and threw a `TypeError` from inside the success path, surfacing as
  `dm.pipeline_failed` with a message about `substring` and no mention of Gemini.
- A model that ignores the enum and invents a fourth `message_type`.

Every case degrades to plain text (**`src/services/ai.ts:374`**) rather than throwing: the
person gets the words the model wrote, which is what they were waiting for, and the structure
was always a presentation detail. Numbers and booleans are coerced to string, objects and arrays
are not (**:211-213**) — `String({})` is `[object Object]`, worse than nothing. A downgrade logs
`ai.response_downgraded` (**:241**).

Two guards after it: **`src/services/ai.ts:676`** throws when a `text` response has no usable
text (an empty reply is a failure, not a message — sending it produces a Meta rejection
attributed to the send rather than the model, and writing it to `messages` would feed a blank
turn back as history), and `enforceMetaConstraints` (**`src/services/ai.ts:383`**) truncates to
Meta's limits.

Back in the pipeline, **`src/webhook/messaging.ts:598`** maps to the wire format with
`toMetaMessage` (**`src/webhook/meta-payload.ts:30`**), which copies template fields explicitly
rather than spreading, because Meta rejects unknown keys inside template elements and Gemini
returns both `url` and `payload` on every button regardless of type
(**`src/webhook/meta-payload.ts:59-69`**).

### 2.9 — Quota, disclosure, send

**Quota** — **`src/webhook/messaging.ts:602`**, the same `checkFairSendQuota` as
[1.13](#113--checkfairsendquota--two-ceilings). Deliberately **one check per reply, not per
network call**: a disclosure that has to travel as its own message is still one logical reply to
one person.

Refusal is **retried, not dropped** (**`src/webhook/messaging.ts:622-629`**): release the claim
and throw, if `mayRetry`. The counters are hourly and the runner's backoff (~30 s, ~2 m, ~8 m)
may well spend every attempt inside the same window — but it may not, and the alternative is a
real customer silently never answered, which is what used to happen. Nothing else will come back
for this message: the queue's `dedupe_key` is `dm:<mid>`, so a later Meta redelivery is refused
at enqueue and never becomes a second job.

**AI disclosure timing** — Meta's Messenger Platform policy requires telling people they are
talking to an automated service *"at the beginning of any conversation or message thread"*, and
again after a significant lapse of time.

- `needsDisclosure(conversation.ai_disclosed_at)` at **`src/webhook/messaging.ts:228`**, called
  at **:431**. True when the column is null (thread start), unparseable, **or** older than
  `DISCLOSURE_MAX_AGE_MS = 7 days` (**`src/webhook/messaging.ts:37`**). The policy never
  quantifies "a significant lapse"; a week is long enough that the thread reads as a new
  conversation to the person on the other end.
- `applyDisclosure` (**`src/webhook/meta-payload.ts:111`**) prefixes
  `disclosureLine(dmCtx.language.code)` (**`src/webhook/meta-payload.ts:92`**, called at **`messaging.ts:433`**: in the DM
  surface's language, `🤖 رد آلي من المساعد الذكي` or `🤖 Automated reply from the AI assistant`; the Arabic one is still
  `AI_DISCLOSURE_LINE`, **`:97`**) onto the payload's `text`. **A generic template carries no `text` field** — Meta rejects
  `text` alongside `attachment` — so for a carousel it returns `standalone` instead
  (**`src/webhook/meta-payload.ts:118`**), and the pipeline sends the line as its own message
  first (**`src/webhook/messaging.ts:640-648`**, logging `dm.disclosure_standalone`).

**Endpoint selection** — `resolveDmPageId` at **`src/webhook/messaging.ts:191`**, called at
**:632**. Meta requires `/{page-id}/messages` for Page access tokens; `/me/messages` only
resolves correctly for Instagram-Login tokens. There is no `field === 'feed'` marker on a
messaging event, so the signal is whether the page id the event is addressed to
(`recipientId` or `entryId`) equals the creator's `facebook_page_id`. The comment path always
threaded this through; the DM path never did, so every Facebook Messenger reply went to `/me`.

**Send** — **`src/webhook/messaging.ts:652`**, `sendDirectMessage`
(**`src/services/instagram.ts:323`**), `messaging_type: 'RESPONSE'`
(**`src/services/instagram.ts:343`** — without it the send is evaluated outside the standard
messaging window and rejected once that window matters).

**`ai_disclosed_at` is written only after a successful send**
(**`src/webhook/messaging.ts:659-661`**), so a failed first reply still discloses next time.

Then the outbound `messages` row (**`src/webhook/messaging.ts:666-676`**).

**Two refusals that belong to ad traffic (A3).**

- **Meta Business AI owns the thread.** An Instagram send that fails with error **100** and subcode **2534037** means Meta's own Business AI is
  answering that thread, and an untagged send is refused until the owner takes it back. `isBusinessAiBlock` recognises it and `noteBusinessAiBlock`
  (**`attribution.ts`**) sets `conversations.no_reply_reason = 'business_ai_owns_thread'` (v54), raises a `business_ai` alert **once** (the reason is
  set only when it was not already, and the alert channel dedupes per day on top), and **nothing is retried**: Meta's answer will not change. The next
  send that succeeds clears it (`clearNoReplyReason`, one statement that touches no row in the usual case). The owner's fix is in Meta Business Suite:
  Business AI → "Take control of conversations with your Business AI". The Inbox shows a notice on the thread meanwhile. The follow-up nudge's
  send handles the same two refusals (`isFinalSendFailure` is now also true for 551).
- **A send outside the window on an ad conversation.** Error 10 / subcode 2018278, or 551, on a `ctm` conversation whose platform has
  `ads.extended_window` on means the 7-day window was not what Meta counts: `isWindowRefusal` → `noteWindowRefusal` turns that platform's switch
  OFF by itself and raises a `window_error` alert. Without the switch, or on any other conversation, the refusal is what it always was.

### 2.10 — `markHandled`, last

**`src/webhook/messaging.ts:680`** — `await markHandled(claim.id)`, defined at
**`src/webhook/messaging.ts:330`** (`handled_at = NOW(), reply_claimed_at = NULL`).

> **Why this order — `markHandled` is the final write.**
> A crash anywhere above it leaves the message claimable again. Writing it earlier — right after
> the send, say — would turn a failed *outbound log write* into a message nobody ever retries.
> The comment at **`src/webhook/messaging.ts:678-679`** says exactly this. The 300-second
> visibility window is what makes "claimable again" safe rather than a double-reply.

### 2.11 — Failure: release vs record

The catch at **`src/webhook/messaging.ts:681-700`** wraps everything from the Gemini call
onwards.

1. Log `dm.pipeline_failed` (**:403**), `noteMetaFailure` (**:405**).
2. `isPermanentMetaError(aiError)` (**:414**).
3. `!permanent && mayRetry` → **`releaseInbound`** (**:416**) then re-throw (**:417**).
4. Otherwise → `markHandled` (**:420**), terminal. **Before it, for a failure that is not a permanent Meta one, the conversation is
   handed over** (`handoffAfterFailure`, `src/services/dmSales/failureHandoff.ts`, every `sales_mode`; found live 2026-10-14, when Gemini
   failed all three attempts and the DM got no reply at all): stamped (`stage = 'handoff'`, `handoff_at`, `handoff_reason = 'unsure'`, the closest
   value the CHECK allows) and **NOT paused** (an outage is not a request for a person, so the customer's next message gets a normal reply), the
   customer sent the handoff line ONCE (with the disclosure when not yet given), the owner told (`engine_failed` in the alert). The same call
   closes the providers-engine path whose engine AND fallback both failed (`dmReply.kind === 'handoff'`, §2.7), which used to be silence. It never
   throws and never loops, and answers nobody who has been answered (a reply already sent or recorded, or the owner's own); a message with no
   words (a photo) is not handed over.

`releaseInbound` (**`src/webhook/messaging.ts:344`**) clears `reply_claimed_at` without setting
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

**`src/routes/api.ts:2864`** — `POST /api/posts/scheduled`. Behind `requireAuth` →
`requireLiveSession` → `resolveTenant` (see [flow 4](#4-login--session--tenant)), so
`getTenantId(req)` (**:2929**) is safe.

Validation:

- `platform`, `post_type`, `scheduled_time` all required (**:1929**).
- **`src/routes/api.ts:2886`** — `unsupportedPlatformCombination(platform, post_type)`, at
  **`src/routes/api.ts:510`**. Rejects `story` + `facebook`/`both` with a 400. Facebook Page
  stories need the two-step `/photo_stories` + `/video_stories` upload, which is not
  implemented, and on `both` Facebook runs first and throws — so a story scheduled for both
  fails at Facebook and never reaches Instagram, where it would have worked. Saying so once, at
  create time, to the person who can fix it, beats saying it daily in a cron log nobody reads.

Insert at **`src/routes/api.ts:2994-3007`** with `status = 'PENDING'`. `cover_url` is carried
through — it is what stops a reel getting a black tile in the profile grid, because Instagram
otherwise uses frame 0.

`publish_now` (**:3020**) takes a separate immediate path
(**`src/routes/api.ts:3021-3075`**) rather than waiting for a sweep. Note it answers **502**,
not 201, on failure (**:3071**) — a 201 for a row just marked FAILED read as success to every
caller.

### 3.2 — Four callers converge on the same sweep

Nothing in-process publishes on a timer. Four callers drain the job queue, and three of them also publish due posts. Checked
2026-10-25:

| | Heroku worker | GitHub Actions | Vercel cron | The webhook |
|---|---|---|---|---|
| declared | `heroku-worker/worker.mjs:29`: 60 s after the last call ended | `.github/workflows/drain.yml:34`, `cron: '*/5 * * * *'` | `vercel.json` `crons`, `"0 0 * * *"` | every delivery (§1.4) |
| actually runs | about every 62 s (Vercel's logs) | every 2–4.5 h: GitHub throttles schedules | once a day, 00:00 UTC (a Hobby-plan limit) | after its 200, under `waitUntil` (§1.5) |
| calls | `GET /api/jobs/drain` (**`src/routes/api.ts:381`**) | the same route, with `curl` | `GET /api/cron/publish` (**`src/routes/api.ts:1022`**) | `drainInline()` (**`src/jobs/drain.ts:38`**), in-process |
| auth | `Authorization: Bearer $CRON_SECRET` | the same (**`drain.yml:66`**) | the same header, injected by Vercel | none |
| does | `drainWorker()` (**`api.ts:392`**), then **`publishDuePosts()`** (**`api.ts:406`**), then the sweeps (TikTok, ads, leads, the Monteur) | the same | reap, abandon, prune, retention sweep, then `drainWorker()` (**`api.ts:1071`**) and **`publishDuePosts()`** (**`api.ts:1073`**) | jobs only: 8 s, 3 at a time, no posts |

The Heroku worker is what makes the dashboard's minute picker honest: a due post goes out at the next drain, within about a
minute (probe jobs inserted on 2026-09-22 were claimed after 15, 26 and 61 s; the Posts screen allows five minutes). Without it,
the GitHub schedule (asked for every 5 minutes, delivered every few hours, **`drain.yml:19-23`**) and the daily cron are all
that is left. So `PostsPage.FREQUENT_SWEEP` (**`dashboard/js/pages/posts.js:3399`**)
goes back to `false` if the worker is ever scaled to zero, or the Posts screen promises minutes nobody keeps. The worker is
also the only caller of `POST /api/onboarding/drafts/sweep` (§9.5). Its state, cost and switch are in `heroku-worker/README.md`.

The guard on both routes is `requireCronSecret` (**`src/routes/api.ts:299`**): **header
only**, never a `?token=` variant, because a query string ends up in Vercel's access logs for
their whole retention (**:308**). A missing `CRON_SECRET` is a **500**, not a skip (**:302-306**) — the earlier
`if (cronSecret && ...)` form skipped itself entirely when the variable was unset.

`composeDrainResponse` (**`src/routes/api.ts:341`**) shapes the drain route's answer from two
independent outcomes: **500 only when both halves failed** (**:351**), otherwise 200 with any
failure named in the body. The scheduler's alerting is an assertion on the HTTP status
(**`drain.yml:77`**), so returning 500 because the publish sweep broke would throw away the fact
that the queue drained fine; and a 200 that silently omitted the error would be exactly the
invisible failure this project keeps being bitten by. The Monteur's sweep, the last part of the
drain, is a third outcome that never moves the status.

### 3.3 — `publishDuePosts()` and the atomic claim

**`src/routes/api.ts:936`**.

1. **Select due rows** (**:602-608**) — `scheduled_posts` joined to `creators`,
   `status = 'PENDING' AND scheduled_time <= NOW() AND s.archived_at IS NULL`, oldest first.
2. **Claim each one atomically** (**:623-629**):

   ```sql
   UPDATE scheduled_posts SET status = 'PUBLISHING', claimed_at = NOW(), attempts = attempts + 1
    WHERE id = $1 AND status = 'PENDING' AND archived_at IS NULL
   RETURNING id
   ```

   `rowCount === 0` means someone else took it: log `cron.publish_already_claimed` and
   `continue` (**:631-634**).

> **Archived posts are skipped, silently and on purpose** (v45, UX US1). `POST /api/posts/scheduled/:id/archive`
> stamps `archived_at`; the select leaves such a row out, and the claim repeats the test so a row archived
> between the two is not published either (it matches no row and is logged as `cron.publish_already_claimed`).
> This is the one sweep that stops: the TikTok and Instagram reconcilers (`reconcileTikTokPosts`,
> the YouTube visibility check, the growth sync) never mention `archived_at`, so a row already in flight
> still settles. Unarchiving a `PENDING` row whose time has passed makes it due again, and the next sweep
> publishes it, which is why the dashboard asks first. Nothing about an archived row is a delete.

> **Why the claim is an `UPDATE … WHERE status = 'PENDING'`.** The old form was SELECT-then-
> UPDATE, which let two concurrent cron hits both read the row as PENDING and both publish it —
> a **duplicate reel on the live account**, which cannot be undone from here. The guard was
> written as a precaution and became load-bearing the moment a second schedule started calling
> the same sweep (**`src/routes/api.ts:903-906`**).

3. `publishClaimedPost(post, {...})` (**`src/routes/api.ts:988`**, defined at **`src/routes/api.ts:864`**), inside a
   try that only *logs* — the terminal row write already happened inside the publisher. It
   dispatches YouTube rows to `publishYouTubePost` ([3.7](#37--youtube-shorts)), TikTok rows to `publishTikTokPost`
   ([flow 6](#6-tiktok-post--inbox--published)) and everything else to `attemptPublish`.

### 3.4 — `attemptPublish()` and partial-publish recovery

**`src/routes/api.ts:691`**. Shared by `publishDuePosts` and
`POST /api/posts/scheduled/:id/publish-now` (**`src/routes/api.ts:3336`**).

Callers must claim the row first; `attemptPublish` deliberately does not, because the two callers
claim differently — a sweep of every due row versus one row scoped to a tenant. It **does** own
the terminal write (**`src/routes/api.ts:478-484`**).

**No token, no Meta call (v34).** A Meta row for a tenant with no connection (`page_access_token IS NULL`)
throws `MetaNotConnectedError` before anything is decrypted or sent: the row is written `FAILED` with
`NOT_CONNECTED_MESSAGE`, `noteMetaFailure` does not read it as a dead token (it has no Meta code 190),
and `POST /api/posts/scheduled` answers such a request 409 `META_NOT_CONNECTED` up front instead.
TikTok and YouTube rows are dispatched before this function and never read the Meta columns.

**The recovery, hop by hop:**

1. **`src/routes/api.ts:699`** — `const already = publishedPlatforms(post.published_post_id);`
2. `publishedPlatforms` (**`src/services/publishedIds.ts:22`**) parses `FB:<id> | IG:<id>` back apart with
   two regexes (**:24-25**), returning `{ fb, ig }`.
3. **`src/routes/api.ts:700-701`** seeds `fbId` / `igId` from it.
4. **`src/routes/api.ts:726`** — Facebook publishes only `if ((platform === 'facebook' ||
   platform === 'both') && !fbId)`. An already-live Facebook post logs
   `publish.facebook_skipped_already_live` (**:516**) and is skipped.
5. **`src/routes/api.ts:749`** — the same `&& !igId` guard for Instagram (**:543** for the skip
   log).
6. On full success, **`src/routes/api.ts:797-802`** writes `status = 'PUBLISHED'`,
   `published_post_id = formatPublishedIds(fbId, igId)` (**`src/services/publishedIds.ts:30`**),
   `error_log = NULL`.
7. On failure, **`src/routes/api.ts:828`** computes `partial = formatPublishedIds(fbId, igId)`
   and **:570-575** writes `status = 'FAILED'` **with `published_post_id = partial`** and an
   error message that names what is already public:
   `Partially published (FB:123) — the rest failed: …` (**:566-568**).
8. **`src/routes/api.ts:840`** throws `PublishAttemptError` (**`src/routes/api.ts:634`**),
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

(Line numbers as of 2026-09-26; `attemptPublish` itself is now at **`src/routes/api.ts:691`**.)

- **Held, not failed.** When the container isn't FINISHED within the 25 s budget,
  `MediaProcessingTimeoutError` reaches `attemptPublish`'s catch, which writes the row back to
  `PENDING` with `external_publish_id = 'IGC:<container>'` and whatever went live in
  `published_post_id`, then throws `InstagramProcessingHeldError` (**`src/routes/api.ts:817`**).
  `publishDuePosts` logs it as held (**`src/routes/api.ts:1003`**). The next sweep reads the saved
  container (**`src/routes/api.ts:763`**) and calls `resumeInstagramContainer`
  (**`src/services/instagram.ts:744`**): publish if FINISHED, start over if ERROR/EXPIRED, hold again
  if still processing. After `IG_PROCESSING_MAX_ATTEMPTS` (15) it fails as before.
- **Facebook creates are never repeated when they may have landed.** `publishFacebookPost` and the
  carousel's `/feed` call `withRetry(..., { creates: true })` (**`src/services/instagram.ts:645`**,
  **`:452`**): only a refusal (429, codes 4/17/32/613) or a connection that never went out is
  retried. `/videos` gets 60 s, `/photos` 30 s.

### 3.4c — `GET /api/uploads/:id`

**`src/routes/api.ts:1240`**. A row with `storage_path` streams the object from Supabase Storage
(`pipeline(media.body, res)`, **`src/routes/api.ts:1305`**); a legacy row serves `data`. The URL never
changes, which is what TikTok's verified prefix and Meta's stored URLs need.

- **A `Range` request gets a 206 with only that piece** (`Accept-Ranges: bytes`; `parseByteRange`,
  **`src/utils/byteRange.ts:24`**): `store.open(id, { range })` (**`src/routes/api.ts:1253`**) asks Supabase for the piece
  alone, and a legacy row answers with a slice of `data` (**`src/routes/api.ts:1289`**). A range past the end is a 416.
  Before this, `bytes=0-1023` of a 6 MB reel streamed all 6 MB, once per piece. Players and Meta's fetchers ask in pieces,
  and Vercel's CDN does not answer a ranged request from its cache, so October 2026 burned 18.6 GB of the Hobby plan's 10 GB
  of Fast Origin Transfer in three days. Test: `curl -H "Range: bytes=0-1023" -D - -o /dev/null <upload url>` must
  answer `206` with `content-length: 1024`.
- **A private row is a 404.** A customer's file (a WhatsApp voice note, a receipt: `is_private`, v51, the bucket
  `media-private`) is "no such upload" to this route; only a caller that passes `privateFor: <its tenant>` reads it
  (`src/services/storage.ts`).
- **Types**: what `/api/upload` stores, plus the infographic's GIF and the explainers' audio (`SERVED_MIME_TYPES`,
  **`src/routes/api.ts:1216`**). Anything else is served as `application/octet-stream`, because this origin also serves the
  dashboard and an echoed `text/html` would be same-origin script.

### 3.5 — Daily maintenance, only on the daily cron

`GET /api/cron/publish` (**`src/routes/api.ts:1022`**) does four things the drain endpoint does
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

**Creation** — the same route as [3.1](#31--creation), **`src/routes/api.ts:2864`**.

1. `unsupportedPlatformCombination` (**`src/routes/api.ts:510`**) takes `carousel` on every
   platform; TikTok now takes `image` and `carousel` beside `video` (**:428**).
2. **`src/routes/api.ts:2896`** — `validatePostMedia` (**`src/services/postMedia.ts:144`**)
   decides what the row stores, or answers 400 with the sentence the dashboard shows as-is:
   - counts: 2–10 for instagram/facebook/both (Instagram's API maximum is 10), 2–35 for a
     TikTok carousel, exactly one for a TikTok `image` (`media_url` alone, or a one-item list);
   - every entry an http(s) URL string;
   - our own uploads are looked up in one `SELECT id, mime_type` — never the bytes — through
     `MediaStore.mimeTypes` (**`src/services/storage.ts:223`**, `mimeTypesOf`), then held to `imageProblem`
     (**`src/services/postMedia.ts:72`**): no video as a slide; JPEG only when Instagram is a
     target; for TikTok, only our own uploads, and only JPEG or WebP. An external URL passes
     for Meta, which fetches it itself — there is nothing here to inspect.
   - Every other post type passes through untouched, and a stray `media_urls` on one is ignored
     rather than refused.
3. **`src/routes/api.ts:2915-2927`** — with `also_tiktok`, the TikTok sibling takes
   `tiktok_media_urls` when sent (9:16 versions of the same slides), otherwise the Meta row's
   list, and is checked by TikTok's rules, not Meta's: a PNG carousel is fine on Facebook and
   refused here for its TikTok sibling.
4. TikTok options for a photo (**:2215**, **:2242-2244**) — `validateTikTokOptions(…, { media:
   'photo' })` (**`src/services/tiktokPublish.ts:101`**) drops duet, stitch and `is_aigc`, which
   a photo post does not have, and adds `title` (at most 90 UTF-16 units) and `auto_add_music`
   (on unless switched off). Inbox mode keeps only the title (`validateTikTokInboxOptions`,
   **`src/services/tiktokPublish.ts:154`**).
5. The insert (**`src/routes/api.ts:2993-3000`**) — each row writes its own `media_url` / `media_urls` pair.

**Editing** — `PUT /posts/scheduled/:id` (**`src/routes/api.ts:3085`**) re-checks the
*effective* media (**:2402-2419**) whenever `platform`, `post_type`, `media_url` or `media_urls`
is sent. Moving a PNG carousel from `facebook` to `both` is refused although the PUT resent no
slide — the same two-step edit `unsupportedAfterEdit` exists for. On those edits `media_urls` is
rewritten, and NULLed once the row is no longer a carousel (**:2460**).

**Dispatch** — `attemptPublish` (**`src/routes/api.ts:691`**): the same claim, the same
Facebook-then-Instagram order, the same `FB:… | IG:…` bookkeeping as
[3.4](#34--attemptpublish-and-partial-publish-recovery).

1. **:591** — a carousel row with no `media_urls` fails closed, rather than going out as its
   first slide and being recorded as the whole post.
2. **:604** → `publishFacebookCarousel` (**`src/services/instagram.ts:661`**): each image
   `POST /{page}/photos` with `published: false` (**:350**) — otherwise every slide appears on
   the Page as a post of its own — then one `POST /{page}/feed` carrying the caption and
   `attached_media: [{ media_fbid }, …]` (**:357**).
3. **`src/routes/api.ts:767`** → `publishInstagramCarousel` (**`src/services/instagram.ts:910`**): one child
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
3. `initPhotoPost` (**`src/services/tiktok.ts:656`**) — `POST /v2/post/publish/content/init/`
   with `media_type: 'PHOTO'`, `PULL_FROM_URL`, `photo_cover_index: 0`. DIRECT_POST sends the
   full `post_info` from `directPhotoInfo` (**`src/services/tiktokPublish.ts:404`**: a fresh
   creator_info, the same privacy check as a video, comments forced off when the creator has
   them off, music on by default). MEDIA_UPLOAD sends only `title` and `description`
   (**`src/services/tiktok.ts:674`**). The title is the stored one or the caption's first line
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
> carries a host TikTok refuses, with `url_ownership_unverified` (**`src/services/tiktok.ts:139`**,
> worded for the operator). TikTok's fetcher also wants a URL that ends like an image, so
> `GET /api/uploads/:id` answers `<uuid>.jpg|.jpeg|.png|.webp|.mp4` too, ignoring the extension
> and serving the stored type (**`src/routes/api.ts:1246`**, `uploadIdFromSegment`,
> **`src/services/storage.ts:508`**).

**Retention** — `pruneOrphanedMedia` keeps every upload named in the `media_urls` of a post that
may yet publish (**`src/services/retention.ts:303`**). `media_url` mirrors only the first slide,
so matching it alone would delete slides 2..N before they were published.

### 3.7 — YouTube (Shorts)

A YouTube post is its own `scheduled_posts` row (`platform = 'youtube'`, `post_type = 'video'`), a `group_id` sibling of the
Meta row like TikTok's. The composer accepts one (`unsupportedPlatformCombination`, **`src/routes/api.ts:522`**: a video only),
but three writers make nearly all of them: the Monteur when `youtube` is in `monteur.platforms`
(**`src/services/monteur/clips.ts:486`**), and infographics and explainers, which follow `infographic.platforms`
(**`src/services/studio/infographics.ts:491`**, **`src/services/explainers/schedule.ts:105`**). It rides the same sweep and
claim as every row (§3.3); `publishClaimedPost` hands it to `publishYouTubePost` (**`src/services/youtubePublish.ts:151`**).
Synchronous, unlike TikTok: Google answers the upload with the video's id.

1. **Checks:** a tenant, a video, a `media_url`, and a connection that was granted upload (`getAccessToken`,
   **`src/services/youtubeConnections.ts:236`**). MP4, MOV or WebM only.
2. **Privacy** (**`src/services/youtubePublish.ts:168`**): with "Upload Shorts as public" off (`youtube.public_uploads`,
   Settings → Platform → YouTube app) every upload is `private`; with it on, the row's `platform_options.privacy`, public by
   default (`uploadPrivacy`).
3. **A resumable upload, never twice.** A row whose `external_publish_id` starts `YTU:` holds the session of an earlier
   attempt, and `queryUpload` (**`src/services/youtube.ts:417`**) asks Google where it got to before anything is sent.
   Otherwise `startResumableUpload` (**`src/services/youtube.ts:363`**) opens one, and its URL is saved as `YTU:<session>`
   **before the first byte** (**`src/services/youtubePublish.ts:186`**). Then at most two `sendBytes` from wherever Google says
   it is (**`src/services/youtubePublish.ts:194`**).
4. **Done** → `PUBLISHED`, `published_post_id = 'YT:<video id>'`, `external_publish_id` cleared. `error_log` keeps a note when
   YouTube kept the upload private or the cover could not be set as the thumbnail (`applyThumbnail`): the Short is up either
   way. The title is `platform_options.title` or the caption's first line; `#Shorts` is added unless
   `platform_options.shorts === false` (an explainer's horizontal video over 3 minutes).
5. **Failure** → `FAILED` with the message, the session kept, so "Publish now" resumes it rather than uploading a second
   Short. `noteYouTubeFailure` marks the connection when Google refused the grant.

**The daily cron** refreshes every connection (`refreshAllYouTubeConnections`, **`src/routes/api.ts:1094`**; Google refresh
tokens don't rotate, and `invalid_grant` deletes the tokens, name and picture), then asks YouTube about every published Short
(`checkYouTubeVisibility`, **`src/routes/api.ts:1099`**, `src/services/youtubeVisibility.ts`): 50 per `videos.list` call, the
newest 500 per tenant. One that is no longer public when public was asked for, or is gone, gets a dated "Visibility check" note in
`error_log`, which Posts shows beside "Open on YouTube". Quota: an upload costs 1,600 of the day's 10,000 units and a thumbnail
50, so about six Shorts a day.

---

## 4. Login → session → tenant

### 4.1 — `POST /api/auth/login`

**`src/routes/api.ts:195`**. Mounted **above** `requireAuth`, obviously.

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

Taken only when an email is actually supplied (**`src/routes/api.ts:211`**).

1. Look the user up case-insensitively (**:175-179**).
2. **`src/routes/api.ts:222-224`** — one boolean combining *user exists*, *is_active*, and
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

Everything below the email block (**`src/routes/api.ts:258-286`**), untouched. `DASHBOARD_PASSWORD`
compared with `secretEquals` (**:221**, a length-safe constant-time compare at **:43**), then
`createLegacySession(await getActiveCreatorId())` (**:237-238**).

`createLegacySession` (**`src/middleware/auth.ts:139`**) is
`createSession({ userId: null, role: 'platform_admin', tenantId, tokenVersion: 0 })`. Kept
deliberately: this is a live system, and removing the only way in before user accounts exist
would lock the operator out of their own dashboard.

`userId: null` has consequences downstream — nothing to revoke against
(**`src/services/tenant.ts:516`**) and no membership to check
(**`src/services/tenant.ts:313`**, since the role is `platform_admin`).

### 4.4 — Token mint and HMAC key derivation

`createSession` — **`src/middleware/auth.ts:116`**:

```
body  = base64url(JSON.stringify({ ...payload, iat: Date.now() }))
token = `${body}.${sign(body)}`
```

`sign` (**`src/middleware/auth.ts:91`**) is `HMAC-SHA256(data, getSecret())`.

**`getSecret()` — `src/middleware/auth.ts:46`** — is the derivation:
`` `${DASHBOARD_PASSWORD}:${META_APP_SECRET}` ``, and it **throws** when either is missing
(**:40-43**). No defaults. The old `|| 'admin'` / `|| 'salt'` fallbacks meant a deployment
missing either variable silently signed every session with a key published in this repo —
anyone could mint a valid session token from the source.

A corollary: **changing `DASHBOARD_PASSWORD` invalidates every outstanding session token**,
including ones minted by the email path.

`SessionPayload` (**`src/middleware/auth.ts:64-74`**) carries `userId`, `role`, `tenantId`,
`tokenVersion`, `iat`, and, only on a "keep me signed in" session (P17, §4.8), its own absolute `exp`: `verifySession` then
refuses the token at `exp` instead of 24 hours after `iat`, and refuses any `exp` further out than 90 days. The payload used to be a bare timestamp — every request was "somebody who
knew the one password", which is why ~13 call sites had to guess the tenant with
`SELECT … WHERE is_active = true LIMIT 1`.

`signWithSessionSecret` (**`src/middleware/auth.ts:104`**) is exported so the erasure preview
token can sign without the secret itself leaving the module; callers must namespace their payload
(`erasure:v1:…`) so a token minted for one purpose cannot verify for another.

### 4.5 — The middleware chain, in mount order

```
router.use(requireAuth)          src/routes/api.ts:1483
router.use(requireLiveSession)   src/routes/api.ts:1488
router.use('/admin', adminRouter) src/routes/api.ts:1496   ← above resolveTenant
  /auth/me, /auth/switch-tenant, /auth/password            ← also above resolveTenant
router.use(resolveTenant)        src/routes/api.ts:1704
  …everything else
```

**`requireAuth`** — **`src/middleware/auth.ts:194`**. Extracts the bearer token with
`startsWith('Bearer ')` + `slice(7)` (**:154**), not `replace('Bearer ', '')`, which matched the
first occurrence *anywhere* in the string and mangled a token that happened to contain the
literal text. Then `verifySession` (**`src/middleware/auth.ts:144`**):

- exactly two dot-separated parts (**:111-112**)
- `timingSafeEqual` on the hex signature, with the `Buffer.from` length trap caught
  (**:125-130** — `Buffer.from` silently truncates invalid hex)
- JSON parse of the base64url body (**:134**)
- `iat` must be a number (**:139**), and `age > SESSION_TTL` (24 h, **:24**) **or**
  `age < -60_000` is rejected (**:143**) — future-dated tokens are refused too, because a clock
  skew bug should not mint something outliving the TTL

Valid → `req.session = session` (**:167**). Invalid → 401.

**`requireLiveSession`** — **`src/services/tenant.ts:531`**. The revocation check.

- No `session.userId` (legacy) → `next()` immediately (**:240-243**); there is no user row to
  revoke against, and such a session is bounded by `DASHBOARD_PASSWORD` and the 24 h TTL.
- Otherwise one query for `token_version, is_active` (**:246-249**) fed to
  `checkSessionValidity` (**`src/services/tenant.ts:510`**): unknown user → 401, `is_active`
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
> `platform_admin` guard, so nothing is weakened. Stated at **`src/routes/api.ts:1490-1495`**.
>
> `/auth/me`, `/auth/switch-tenant` and `/auth/password` sit above it for the parallel reason
> (**`src/routes/api.ts:1498-1502`**, **:1013-1014**): a user holding no membership, or an admin on
> a creator-less deployment, must still be able to ask who they are, see what they can switch
> into, and change their password. Behind `resolveTenant` all three would 409 and the tenant
> switcher would have nothing to render.

**`resolveTenant`** — **`src/services/tenant.ts:574`**:

1. No session → 401 (**:277-280**).
2. **`src/services/tenant.ts:583-585`** — a session with no `tenantId` (i.e. legacy) adopts
   `getActiveCreatorId()`, the same thing every call site used to assume implicitly.
3. **`src/services/tenant.ts:587`** — still nothing → **409**, *"No creator account is configured
   yet."*
4. **`src/services/tenant.ts:596-597`** — `resolveTenantAccess(session)` not `allowed` → **404 "Not found."**

> **409 vs 404.** They answer different questions and the distinction is deliberate.
> **409** means *the deployment has no tenant to act as* — a first-run state, fixable by
> `POST /api/admin/tenants`, and safe to state plainly because it discloses nothing.
> **404** means *you may not act as this tenant* — and it is 404 rather than 403 because
> confirming a tenant exists is itself a disclosure. `/auth/switch-tenant` matches it exactly
> (**`src/routes/api.ts:1566-1568`**).

`assertTenantAccess` (**`src/services/tenant.ts:308`**): no `tenantId` → false;
`role === 'platform_admin'` → **true for any tenant** (this is what powers the switcher); no
`userId` → false; otherwise a live `memberships` lookup (**`src/services/tenant.ts:278`**).
Verified against the **database**, not trusted from the token, so revoking a membership takes
effect immediately rather than at token expiry.

Past that line, `getTenantId(req)` (**`src/services/tenant.ts:269`**) is safe to call inline
inside a query. It **throws** rather than falling back to "the first active creator" — that
silent fallback is the bug the whole layer exists to remove, and it would look like it worked
right up until it served the wrong customer's data.

### 4.6 — Switching tenants re-mints

**`src/routes/api.ts:1552`** — `POST /api/auth/switch-tenant`.

1. `tenantId` must be a UUID (**:979**).
2. `assertTenantAccess({ userId, role, tenantId })` — the *requested* tenant, not the session's
   (**:984-986**). Denied → 404 (**:990**).
3. **`src/routes/api.ts:1573-1578`** — `createSession` with the new `tenantId`, same `userId`,
   `role` and `tokenVersion` (and, for a "keep me signed in" session, the same `exp`: a switch is not a new sign-in). Response is a **new token** (**:1000**).

Nothing server-side is mutated, because there is nothing to mutate: the session is a stateless
HMAC, so the tenant it carries can only change by issuing a different token. The old token stays
valid for its remaining TTL **against its own tenant**, which is correct — it was already
authorised for that one (**`src/routes/api.ts:966-973`**).

The switcher's data source is `GET /api/auth/me` (**`src/routes/api.ts:1505`**) →
`listTenantsForSession` (**`src/services/tenant.ts:651`**): every active creator for a
`platform_admin`, otherwise creators joined through `memberships`.

### 4.7 — The creator profile: reading it, changing it, and what the agents are told

Once the tenant is pinned, one record says who it is: `creator_profiles.profile` (who the creator is,
how they speak, what they sell, what the agents must never do). The Studio and Growth settings are
*views* over it; the agents read *contexts* cut from it. Every tenant has one: the stored row, or,
until it has one, the virtual profile its legacy settings describe (`version: null`).

**Reading it.**

1. **`src/index.ts:75`** — `profileCacheScope` opens a per-request cache, right after the log context,
   so the webhook, the dashboard API and `/api/jobs/drain` all share one read per tenant per request.
2. **`src/services/profile/store.ts:160`** — `loadProfile`: the stored row through `upgradeProfile`
   (a stored profile is merged over the defaults, so a field a later release adds reads as its
   default), else `loadLegacyProfile` — the tenant's settings rows read directly and described by
   `profileFromLegacy`. A database without v33 reads as "no stored profile" (logged once).
3. **`src/services/studio/settings.ts:392`**, **`src/services/growth/settings.ts:266`** — the settings
   readers overlay the stored profile on their own row (`studioView` / `growthView`). A tenant with
   no stored profile, or one written by a *newer* release, gets its row unchanged.
4. **`src/services/profile/context.ts:282`** — `profileContext(creatorId, purpose)` is `loadProfile`
   then the pure `contextFor` (**:249**): a base every purpose shares (`language` resolved for the
   purpose's surface, `who`, `guard`) plus that purpose's slice. A stored profile written by a *newer*
   release is passed over exactly as the settings readers pass it over (**:280**): the context is cut
   from the legacy rows, `version: null`. Today two readers use it:
   `tenantLanguage` (**`src/services/growth/coach.ts:259`**: the coach's and the keyword finder's
   language) and `tenantTimezone` (**`src/services/growth/overview.ts:419`**: the heatmap, after the
   audience's own override). The DM's knowledge base is *not* in a context: it stays on `ai_agents`.

**`GET /api/profile`** — **`src/routes/profile.ts:74`**, mounted below `resolveTenant`
(**`src/routes/api.ts:1720`**), operator or owner (**:60**), like every read of the Studio's and Growth's
settings: a `viewer` sees the account's numbers, not how it is run (403 otherwise). Answers
`{ profile, version, stored, activationMissing }` — `stored: false` and `version: null` for the
virtual profile, `activationMissing` the fields the wizard still needs.

**`GET /api/profile/campaign-seeds`** — **`src/routes/profile.ts:93`**, operator or owner (**:69**). What the
Campaigns screen's "Import from CSV" starts each imported course from; it replaced a table of nine
mappings that the dashboard carried for the owner. Answers `{ seeds, source, fallback }`: `fallback` is what a row
no seed names starts from (P15), the owner's own wording for the platform owner and the neutral text of the language
its comment replies speak for everyone else (`ImportFallbackLines`, `kits.ts`).

1. **`src/services/profile/campaignSeeds.ts:144`** — `readCampaignSeeds` loads the session tenant's profile
   (`loadProfile`) and **`:77`** `campaignSeeds` turns each offer that has a `campaign` and a `name_match` into a
   seed, in the offers' order: `trigger_keyword` (the keywords joined on `", "`), `dm_template` (as it is, with
   `{url}` and `{username}`), `public_reply_template` (the replies joined on `" | "`), `match` and `name_match`.
   An offer with no `name_match` is not a seed: `""` is a substring of every course name.
2. **The owner's fallback (`:108`–`:112`).** While a profile yields no seed AND the tenant is the platform owner
   (`getPlatformOwnerId`, found and equal; a lookup that finds nobody is *not* him), the answer is his nine
   (`legacyCourseMappings.ts`), `source: 'legacy'`. Nobody else is ever answered them: a tenant with no campaign
   gets `[]`. `scripts/seed-owner-offers.mts --apply` puts the nine on his offers, after which `source` reads
   `profile` and the fallback is dead code.
3. **`dashboard/js/pages/campaigns.js:1230`** — `handleCSVSelect` asks for the seeds once per import
   (`loadSeeds`, **:1044**; a failed read stops the import with a toast, it never imports generic text over
   curated copy) and `showBulkImportModal(courses, seeds, fallback)` (**:1068**) gives each course the first seed, in
   order, whose lower-cased `name_match` its lower-cased name contains (`seedFor`, **:1059**). A course
   that matches none starts from the server's `fallback`, its `{name}` and `{url}` filled in (`fillFallback`): the page
   carries no wording of its own.

**`PATCH /api/profile { version, patch }`** — **`src/routes/profile.ts:97`**, owner only (**:70**).

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
5. **`src/services/profile/store.ts:379`** — `saveProfile(…, { expectVersion, startFromCaller })` on that
   transaction: validates again, bumps the version, keeps the history row and mirrors the view back into
   `studio_settings` / `growth_settings`. Under the mutex the `WHERE version =` cannot lose to a writer
   that takes it; it is the backstop for one that does not. A tenant whose legacy rows are not a valid
   profile on their own (a colour that is no colour) is repaired by a valid merged result, which is
   stored as version 1 (`startFromCaller`); otherwise version 1 is the legacy baseline (source
   `backfill`) and the patch is version 2. The profile cache is cleared after the commit.
6. **`src/routes/profile.ts:102`** — the audit row `profile.write`: `detail.paths` names the
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
(**`src/routes/admin.ts:1504`** and **:1452**), platform admin only: **`requirePlatformAdmin`** (**:109**) answers everyone else 404
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

1. `createInvite` (**`src/services/invites.ts:245`**) reads the tenant (404 if absent, 409 if switched off), applies the
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
(**`src/routes/api.ts:1474`**).

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
invite page of §4.8, before there is a session; this is W1 to W6 of the onboarding design.

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
`completeOnboarding` (**onboardingWizard.ts:502**). It is **idempotent**: a tenant already `completed` (or with no row) answers
`alreadyCompleted: true` and writes nothing, and the `UPDATE` itself carries `status <> 'completed'`, so a second Finish that
raced the first moves neither `completed_at` nor the funnel. The first needs `activationMissing` empty (name, kind, niche, language
and register, time zone, one offer) and otherwise answers `409 ONBOARDING_INCOMPLETE` with `missing` and `fixStep`, which the page
turns into "back to the step that fixes it". It writes the status **and the tenant's first comment campaign, switched off, in one
transaction** ([4.11](#411--the-proof-samples-and-the-first-campaign-p25)); the DM persona is not compiled (the DM bot is parked).

**The seam.** `WIZARD_STEPS` (**onboardingWizard.ts:54**) lists W1 to W6; **W5 (proof, P25) is on** for every tenant that has not
finished ([4.11](#411--the-proof-samples-and-the-first-campaign-p25)): it is optional, and with no AI key it says so and lets the
tenant carry on. **W4 (connect, P28) is built and is
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

### 4.11 — The proof samples and the first campaign (P25)

W5 ("Does this sound like you?") shows two samples written by the production builders from the **confirmed** profile, lets the tenant
judge them, and turns what they confirm into examples for their writer and the wording of their first campaign. Routes
(**`routes/onboarding.ts:102`** and below, owner only): `GET /api/onboarding/proof`, `POST /api/onboarding/proof`,
`POST /proof/:id/verdict`, `POST /proof/:id/regenerate`. The logic is **`services/onboarding/proof.ts`**.

**Who may, and when.** Only while the wizard is open: `assertOpen` (**proof.ts:179**) answers `409 ONBOARDING_COMPLETED` for a tenant
whose onboarding is `completed`, or has no row (D14). The owner's tenant is `completed` since v34, so the proof can neither spend his
key nor write him a row; `proof.test.ts` drives every route as him. An operator or a viewer is refused by the owner-only guard.

**A round.** `startProof` (**proof.ts:380**):

1. The cards that exist are the newest `voice_examples` row of each kind (`currentCards`); with both there it answers them and spends,
   counts and calls nothing, so a reload or a second tab is free.
2. **No provider** (`resolveRoute('onboarding_proof')` throws `no_provider`) answers `state: 'needs_ai_key'` BEFORE counting: W5 says
   samples need an AI key, and Continue and Finish still work.
3. The round is **counted**, atomically, at most **three a UTC day** (**proofRules.ts:35**, `PROOFS_PER_DAY`; **proofStore.ts:56**,
   `COUNT_ROUND_SQL`: the counter is raised only `WHERE count < $2`, so a refused tenant's counter stops at the limit). The fourth is
   `429 PROOF_LIMIT`.
4. Each missing card is asked for in parallel, on the `onboarding_proof` route (`generate`, so the operator's route, key and budgets
   apply). A card whose answer breaks a rule gets ONE repair call with the problem stated (`askChecked`, **proof.ts:249**, within a
   120 s deadline); a card that still fails is left out and the answer says `state: 'failed'` with the failure's KIND, never a provider's
   words. The card that did come back is kept.

**Which builders.** The caption (**`makeCaption`, proof.ts:273**) is written under the Studio writer's own prompt pieces
(`buildCaptionSystemPrompt`, **studio/prompts.ts:463**: its kit, voice guide, facts, never-mention list, and the very caption steps
`igCaptionSteps`, **:328**, with the tenant's own save line and keyword ask) beside one of the tenant's own confirmed sample posts, and
finished by the writer's own `normalizeInstagramCaption`. The comment card (**`makeComment`, proof.ts:321**) is written from the
profile's `comment_reply` context and the register's own campaign wording (`kit.importFallback`); `readCommentAnswer`
(**proofRules.ts:167**) puts the offer's link in for `{url}` (a model never writes a link), refuses a link in a public reply, a
placeholder nothing fills in, a message over Meta's 1,000 bytes, and a public reply over 140 characters. Both read the confirmed profile
and nothing else (never `profile_drafts`); everything a person typed reaches a model through `sanitizeSourceText`.

**A verdict.** `recordVerdict` (**proof.ts:437**) writes `approved`, `edited` (with `edited_text`; an edit that changes nothing is an
approval) or `rejected`, merging the chips the person chose into `input.reasons`. The **tenant's** verdict sets `verdict_by = 'tenant'`
and `tenant_confirmed_at`; an **admin's** (filling in for them) sets `verdict_by = 'admin'` and leaves it empty (`VERDICT_SQL`,
**proofStore.ts:44**), so it waits for the tenant's own tap. A sample that was replaced, or is another tenant's, cannot be judged.

**Regenerate.** `regenerateProof` (**proof.ts:479**) writes one card again with a hint (a chip's code, or up to 200 characters of the
tenant's own words, cleaned and fenced): the call first, then, in one transaction, the old sample becomes `rejected` and the new one is
inserted, so a failed call leaves the card as it was. Three regenerations a card (`REGENERATIONS_PER_CARD`; the fourth is
`429 REGENERATE_LIMIT`); they are not rounds and do not touch the day's three.

**What a confirmed sample becomes.**

- **In the writer's prompt.** `voiceExamplesFor` (**profile/voiceExamplesStore.ts:40**) returns the newest `approved` or `edited` rows the
  TENANT confirmed, edited first, at most three, as "you wrote → they changed it to" pairs. `buildGenContext` (**studio/drafts.ts:437**)
  adds them to the context only when there are some, and `buildSystemPrompt` appends one section (`captionExamplesSection`,
  **studio/prompts.ts:345**). **The owner's prompts do not move**: nothing can write him a row (above), the read also requires
  `onboarding.filled_by IS NOT NULL` (v34 inserted his row without one), it never throws, and a prompt with no examples is
  byte-identical to the golden (`profile/voiceExamples.test.ts`; live parity is unchanged).
- **In the first campaign.** `completeOnboarding` plans it (`planFirstCampaign`, **proofCampaign.ts:88**) from the comment sample the
  tenant confirmed (`confirmedComment`, **:67**), else from the register's own wording with the main offer's name and link, and inserts it
  (`FIRST_CAMPAIGN_SQL`, **:125**) **inactive** (`is_active = false`), on every post, in `word` mode when the keyword sits inside a longer
  word in their own captions. It runs in the SAME transaction as the status change that only one caller can win, behind the tenant's
  publishing lock, and creates nothing when the tenant already has a campaign on that keyword, so a double tap, a retry or two tabs make
  one campaign, and a campaign that cannot be written leaves the setup open to be finished again. A tenant with no keyword, or an offer
  ordered by DM with nothing confirmed to say how, has none, and the answer says why (`campaign: { created: false, reason }`).

**The funnel.** `proof_verdict { kind, verdict, reason }` and `proof_regenerated { kind, attempt }` join the closed list of events
(enums and numbers only).

**The page.** `dashboard/js/pages/welcome_proof.js` (loaded by the wizard when it starts; `WelcomeProof.enter`, **:213**, is called by
`WelcomePage.enterProof`, **welcome.js:1449**) draws the cards, the two answers, the chips and the editor, in both languages, at 375 px.
A module that did not load is a step that says the samples are unavailable; the last screen (`doneProofItem`, **welcome.js:872**) says
whether they were reviewed and whether a first campaign was made.

---

## 5. Job lifecycle

Everything in flows 1 and 2 rides on this. `src/jobs/` is four files: `types.ts` (vocabulary),
`queue.ts` (transport), `runner.ts` (driver), `handlers.ts` (work), plus `drain.ts` for
production wiring.

### 5.1 — Enqueue

**`src/jobs/queue.ts:39`** — `PostgresJobQueue.enqueue`.

```sql
INSERT INTO jobs (kind, payload, creator_id, dedupe_key, run_after, max_attempts, request_id, tenant_key)
VALUES ($1, $2::jsonb, $3, $4, COALESCE($5, NOW()), COALESCE($6, 3), $7, $8)
ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
RETURNING id
```
(**`src/jobs/queue.ts:51-54`**)

- **`ON CONFLICT (dedupe_key)`** drops a second enqueue **whatever the state of the first —
  including `done`**, which is what makes a Meta redelivery a no-op before it costs a Gemini call
  (**`src/jobs/types.ts:75-80`**). The index is partial, so rows with no key never conflict.
- `max_attempts` defaults to **3**.
- `run_after` defaults to `NOW()`; supplying it is what makes the queue a scheduler
  (**`src/jobs/types.ts:189`**).
- `tenant_key` defaults to `creator_id` **at insert time, in JS** (`input.tenantKey ?? input.creatorId`,
  **`src/jobs/queue.ts:63`**) so the claim can partition on the bare column and use its index — doing
  the default in the claim's `PARTITION BY` would cost a sort on every claim (**`src/jobs/queue.ts:41-44`**).
  Not as `COALESCE($8, $3::text)` in the SQL: reusing `$3` made Postgres deduce it as both uuid and
  text and reject the statement with 42P08, so **every enqueue failed from 2026-09-21 to 09-27**
  (**`src/jobs/queue.ts:46-50`**).

Returns `null` on a dedupe (**`src/jobs/queue.ts:72`**), logged at `debug` (**`src/jobs/queue.ts:71`**).

The payload stores the Meta event **verbatim**, not pre-normalised
(**`src/jobs/types.ts:26-34`**): a bug in the normaliser would otherwise be unrecoverable,
whereas the raw event means a fixed normaliser can be replayed against jobs that already failed.
It also keeps the enqueue path free of any logic that could throw before the acknowledgement.

`JobKind` is a closed union of six (`JOB_KINDS`, **`src/jobs/types.ts:19`**): `comment.process` and `dm.process` (flows 1
and 2; a WhatsApp message is a `dm.process` too, §10.2), `dm.followup` (not a Meta event: the sales nudge, §2.6c), `wa.event`
(a WhatsApp status, account event or preference change, §10.9–10.10), `ads.draft` (an AI ad proposal, §7.5) and `ads.lead` (a
lead-ads notification, §7.8). A closed union rather than a free string, because an enqueue for a kind with no handler is a job
that fails `max_attempts` times and then sits in the table forever.

**A handler may cut its job's payload down as the job ends.** It returns `{ redactPayload }` (`JobResult`,
**`src/jobs/types.ts:219-227`**), which replaces `jobs.payload` in the same UPDATE that marks the job `done` (`complete`,
**`src/jobs/queue.ts:159`**). A failure that ends the job does the same through `redactOnFailure` (**`src/jobs/redaction.ts:16`**),
which the runner reads only when no retry follows (**`src/jobs/runner.ts:136`**): a job that will run again keeps the payload its
next attempt needs. Only WhatsApp uses it today: a message from a sender who is not a tester (§10.5), and the `wa.event` statuses
and preference changes, which name a customer's phone (**`src/jobs/handlers.ts:51-66`**). Every other job keeps the Meta event
verbatim until the prune, which deletes `done` rows after 7 days and never deletes a `failed` one (§5.7).

### 5.2 — The atomic claim, and why not `FOR UPDATE SKIP LOCKED`

**`src/jobs/queue.ts:83`** — `claim(limit)`. The query is **`src/jobs/queue.ts:112-132`**:

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
> **`src/jobs/queue.ts:105-110`**, and again at the route in **`src/routes/api.ts:376-379`** —
> because "just add SKIP LOCKED" is the obvious review comment and it does not compile.

**Round-robin fairness.** `ROW_NUMBER() OVER (PARTITION BY tenant_key ORDER BY run_after,
created_at)` ranks each tenant's pending jobs oldest-first; `ORDER BY tenant_rank, run_after`
then takes **every tenant's oldest job before anyone's second**. This was `ORDER BY run_after` —
strict FIFO — so a tenant whose reel went viral could fill the queue with ten thousand events and
every other tenant's DMs waited behind all of them (**`src/jobs/queue.ts:84-90`**).

Partitioning on the bare `tenant_key` column lets
`idx_jobs_claimable_fair (tenant_key, run_after) WHERE status = 'pending'` satisfy both the
`PARTITION BY` and the `ORDER BY` without a sort. Jobs with no key at all form **one** group
together — the conservative answer: they share a slot rather than each getting one
(**`src/jobs/queue.ts:91-97`**).

After the query, **`src/jobs/queue.ts:140-144`**: a row whose `kind` has no registered handler is
failed permanently and skipped, rather than crashing the drain — that is how one bad job stops
every other tenant's work.

### 5.3 — Running one job

**`src/jobs/runner.ts:77`** — `runOne`. Never throws.

It re-establishes the **correlation id from the enqueueing request**
(**`src/jobs/runner.ts:94-101`**), so a log search for one Meta delivery turns up the work it
caused and not just its acknowledgement.

Dispatch is **`src/jobs/runner.ts:109`**. The registry is keyed by the same union `job.kind` is
narrowed to, but the per-kind payload types make the pairing unprovable to the compiler without a
discriminated switch at every call site — so the cast is asserted once, here.

Success → `queue.complete(job.id)` (**:115**, `status = 'done'`, `last_error = NULL`,
**`src/jobs/queue.ts:159`**).

### 5.4 — Failure, backoff and jitter

**`src/jobs/runner.ts:118-141`**.

- `exhausted = job.attempts >= job.max_attempts` (**:97**). `attempts` was already incremented by
  the claim.
- `retryIn = exhausted ? null : backoffSeconds(job.attempts, random)` (**:98**).
- Log level flips on exhaustion: `job.failed` at `error`, `job.retrying` at `warn` (**:103**),
  with `retry_in_seconds` and `attempts_remaining`.
- `queue.fail(job.id, message, retryIn)` (**:111**), itself wrapped in a try — if *that* write
  fails the job stays `running` and the reaper is the backstop, so all it can do is say so
  (**:112-116**).

`backoffSeconds` — **`src/jobs/runner.ts:41`**:

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

`queue.fail` (**`src/jobs/queue.ts:174`**) has two branches: `retryInSeconds === null` →
`status = 'failed'` (**:186-193**); otherwise back to `'pending'` with
`run_after = NOW() + interval` (**:197-205**). `last_error` is truncated to 2000 chars both
ways — a Meta error body can be long and this column is read in a dashboard list view.

### 5.5 — The drain loop and its budget

**`src/jobs/runner.ts:187`** — `drainJobs`. Loop while `claimed < maxJobs`:

1. **Budget check before claiming** (**:202-205**) → `budgetExhausted`, break.
2. Claim `min(batchSize, maxJobs - claimed)` (**:209**). A claim failure logs and breaks
   (**:210-213**).
3. Empty batch → break (**:215**).
4. Run each job (**:217**), **re-checking the budget inside the batch** (**:224-230**) — a batch of
   five DM jobs is potentially 40 seconds of Gemini, and the budget has to be able to stop it
   partway.
5. **Hand back what the loop did not reach** (**:228**, `handBackUnrun`, **:167**). The claim took
   the whole batch in one statement (`status = 'running'`, `attempts + 1`,
   **`src/jobs/queue.ts:126-128`**), so when the budget stops the loop partway, the jobs after the
   last one it ran are `running` with an attempt counted, and nothing is going to start them.
   `queue.releaseUnrun(claims)` (**`src/jobs/queue.ts:260`**) is handed each job's id **and the
   attempt number its claim gave it** (`claim` returns the row with it already counted), and
   returns them to `pending` in one UPDATE: `claimed_at = NULL`,
   `attempts = GREATEST(attempts - 1, 0)`, matched on
   `WHERE (id, attempts) IN (SELECT * FROM unnest($1::uuid[], $2::int[])) AND status = 'running'`.
   Only the claim this drain made matches. A job that finished or failed meanwhile is left alone,
   and so is one the reaper freed and **another drain has claimed since**: the reaper does not touch
   `attempts` and the next claim counts one more, so that row is on a later attempt than this drain
   holds, it is running over there, and putting it back would let a third drain run it too.
   `run_after` and `last_error` are untouched, so a released job keeps its place in the line and the
   next drain's claim takes it. It logs `job.released` (`released`, `unrun`, `job_ids`; `released`
   is lower than `unrun` when a row was no longer that claim). If the release itself fails it logs
   `job.release_failed` (`error`) and the drain ends normally: those jobs wait for `reapStale`
   (300 s), as every one of them used to. Nothing is released when the budget ends on the last job
   of a batch, or when the queue empties first.

> **Why a budget at all.** A serverless invocation has a wall clock, and a drain that starts a
> 30-second Gemini call with 4 seconds left produces exactly the failure the queue was built to
> prevent — work abandoned mid-flight. So the loop stops rather than starting work it probably
> cannot finish. What it never claimed is still `pending`; what it claimed and did not reach is
> handed back to `pending` as it stops (step 5); the next drain takes either
> (**`src/jobs/runner.ts:9-16`**).
>
> That second kind used to be left `running`. The inline drain claims three at a time, so one slow
> DM held the other two back until the 300 s reaper freed them, and a job claimed on its last
> attempt was failed `[abandoned …]` by that reaper without ever having run.

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

**`src/jobs/queue.ts:208`**, called with `CLAIM_VISIBILITY_SECONDS = 300`
(**`src/jobs/runner.ts:31`**). Deliberately **two statements**, because the two outcomes are
genuinely different:

1. **Abandoned** (**`src/jobs/queue.ts:212-222`**) — `status = 'running'`, claim older than the
   window, **`attempts >= max_attempts`** → `status = 'failed'`, with
   `' [abandoned: the claim went stale and no attempts remain]'` appended to `last_error`. A
   permanent failure an operator has to look at.
2. **Requeued** (**`src/jobs/queue.ts:224-231`**) — same, but **`attempts < max_attempts`** →
   back to `'pending'`, `claimed_at = NULL`. It goes round again.

Either logs `job.reaped` with both counts (**:209-211**). Mirrors the scheduled-post reaper in
`api.ts` ([3.5](#35--daily-maintenance-only-on-the-daily-cron)).

A drain that merely ran out of budget no longer leaves claims for either branch: it hands the jobs
it did not reach back itself, attempt refunded ([5.5](#55--the-drain-loop-and-its-budget), step 5).
What the reaper still catches is a claim whose drain was frozen or killed before it could.

The window has to exceed the longest a single job can legitimately take — a Gemini call up to its
30 s timeout plus a Meta send with retries. Five minutes is generous on purpose: **reaping a job
that is still running is how a DM gets sent twice**, which is worse than a stranded job being
retried a few minutes late (**`src/jobs/runner.ts:18-25`**).

### 5.7 — Prune

**`src/jobs/queue.ts:289`** — `pruneCompleted(olderThanDays, limit)`. **Only `done` rows**
(**:233**): a `failed` row is the one an operator needs to look at, and `pending`/`running` are
live work.

Batched via a `LIMIT`ed subselect (**:231-236**) because a first run against months of history
must not be one `DELETE` inside an invocation with a wall clock — a `DELETE` that times out rolls
back entirely and never makes progress. Called from `runRetentionSweep()` on the daily cron
(**`src/routes/api.ts:1059`**); it converges over several runs rather than clearing everything at
once.

Each `done` row holds a verbatim Meta event, so this is a retention question and not only a
storage one.

### 5.8 — The handler contract

**`src/jobs/types.ts:208`** — `JobHandler`.

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

`JobStatus` also carries `'cancelled'` (**`src/jobs/types.ts:146`**), set by
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

1. **`src/routes/tiktok.ts:257`** — `POST /api/tiktok/connect`, owner only (`canAdminister`,
   **:179**). Needs `getTikTokAppConfig()` (**`src/services/appSettings.ts:415`** — `app_settings`
   first, then `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`).
2. `redirectUriFor` (**`src/routes/tiktok.ts:55`**) → `getPublicBaseUrl`
   (**`src/services/appSettings.ts:648`**): the `app.public_base_url` setting, then
   `PUBLIC_BASE_URL`, then — last resort — the request origin.
3. `createOAuthState` (**`src/services/tiktokConnections.ts:50`**) inserts a 32-byte nonce into
   `oauth_states` with the tenant and user, 10-minute TTL. The route sets the same value as an
   HttpOnly, `SameSite=Lax` cookie with `Path=/api/tiktok/callback` (**`src/routes/tiktok.ts:60-64`**,
   **:223**) and returns the authorize URL (`buildAuthorizeUrl`, **`src/services/tiktok.ts:191`**).
4. **`src/routes/tiktok.ts:83`** — `GET /api/tiktok/callback`, on `tiktokPublicRouter`, which is
   mounted above `requireAuth` (**`src/routes/api.ts:1464`** vs **:1093**). The cookie must equal
   `state` (**`src/routes/tiktok.ts:90-95`**), then `consumeOAuthState`
   (**`src/services/tiktokConnections.ts:58`**) spends it in a single
   `UPDATE … WHERE used_at IS NULL AND expires_at > NOW() RETURNING`.
5. `completeConnection` (**`src/services/tiktokConnections.ts:163`**) — `exchangeCode`
   (**`src/services/tiktok.ts:248`**, not retried: the code is single-use), a best-effort
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

7. **The profile scope (P33), off unless the operator says the portal approved it.** `POST /connect` asks `tiktokScopes(directPost, audited,
   profileScope)` (`tiktok.ts`) for the list, and `profileScope` is `getTikTokProfileScopeEnabled()`: the setting `tiktok.profile_scope_enabled`
   (`'true'` only; anything else, or a settings table that cannot be read, is off). **Off, the list and the authorise URL are exactly what they
   were**: pinned by a literal in `tiktokProfileScope.test.ts`. On, `user.info.profile` follows `user.info.basic`. After the exchange,
   `completeConnection` asks for the profile fields in a **second** `GET /v2/user/info/` (`getProfileInfo`: `username`, `bio_description`,
   `profile_deep_link`, `is_verified`) **only if the granted scope list contains `user.info.profile`**; the first call is unchanged. The fields go to
   `platform_connections.profile` (v44) in a statement of their own after the INSERT (`saveProfile`), so a database without v44 still connects, and a
   reconnect that reads none clears a profile the previous connection left (another account's bio never stays). Follower counts are
   `user.info.stats`, a scope not requested. The profile is deleted with the row (Disconnect, `authorization.removed`).

> **Why the state lives in the DB *and* a cookie.** Dashboard sessions are Bearer tokens in
> localStorage, so TikTok's redirect back carries no session at all. The nonce is the only thing
> binding the returned code to a tenant; the cookie means a state lifted from a log or a referrer
> cannot be completed from another browser (**`src/config/migration_v18_tiktok.sql:66-71`**).

> **Why not the Host header.** TikTok matches `redirect_uri` byte for byte against the one
> registered in its portal, and a Host-derived URI differs on every preview deployment
> (**`src/services/appSettings.ts:24-31`**).

### 6.2 — Creation

**`src/routes/api.ts:2864`** — `POST /api/posts/scheduled`, the same route as
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

Every publish path — `publishDuePosts` (**`src/routes/api.ts:988`**), create-time `publish_now`
(**`src/routes/api.ts:3038`**) and `POST /api/posts/scheduled/:id/publish-now` (**`src/routes/api.ts:3386`**) — calls
`publishClaimedPost` (**`src/routes/api.ts:864`**). `platform === 'youtube'` goes to `publishYouTubePost`
(**`src/routes/api.ts:865-876`**, [3.7](#37--youtube-shorts)), `platform === 'tiktok'` to
`publishTikTokPost` (**`src/routes/api.ts:877-888`**); everything else to `attemptPublish`, which now fails closed on
a non-Meta platform (**`src/routes/api.ts:711-713`**). An unknown platform used to fall through to a PUBLISHED write
with an empty id.

### 6.4 — `publishTikTokPost()`: the upload

**`src/services/tiktokPublish.ts:471`**. The row is already `PUBLISHING`.

1. `video`, `image` or `carousel`; a video needs `media_url` (**:479-483**). A photo post
   branches off after step 3 — see [3.6](#36--carousels-v20).
2. **Pending-draft limit, inbox mode only** (**`src/services/tiktokPublish.ts:485-490`**) — `pendingInboxShares`
   (**`src/services/tiktokPublish.ts:190`**) counts this tenant's inbox-mode `PUBLISHING` / `PROCESSING` / `IN_INBOX`
   rows claimed in the last 24h, this one aside. At 5 (`MAX_PENDING_INBOX_SHARES`,
   **`src/services/tiktokPublish.ts:173`**) it throws `TikTokInboxFullError`, unless the row already has an
   `external_publish_id` (a retry of an upload that was made), and the catch puts the row back to **PENDING** with
   the reason in `error_log` (**:259-267**). Held, not failed: the sweep logs
   `cron.publish_held_tiktok_inbox` (**`src/routes/api.ts:996-999`**); publish-now answers 409
   (**`src/routes/api.ts:996-999`**).
3. `getAccessToken` (**`src/services/tiktokConnections.ts:360`**) — refreshes when within 10 min of
   expiry, under the `refresh_claimed_at` claim (`refreshUnderClaim`, **:244**). If another
   invocation holds the claim it waits for it rather than refreshing in parallel.
4. `loadMedia` (**`src/services/tiktokPublish.ts:207`**) — an `/api/uploads/<uuid>` URL is read
   straight from the media store (`media_uploads` bytes), not fetched over HTTP.
5. `planChunks` (**`src/services/tiktok.ts:400`**): up to 64MB goes whole, otherwise 32MB chunks
   with the remainder on the last.
6. **Resume check** (**`src/services/tiktokPublish.ts:515-528`**) — a row that already has an
   `external_publish_id` reached TikTok before; ask `fetchPublishStatus` first rather than upload
   a duplicate draft against the 5-a-day limit.
7. `initInboxVideoUpload` (**`src/services/tiktok.ts:443`**) — `source: 'FILE_UPLOAD'`, caption as
   the undocumented `post_info.title`; on `invalid_params` it retries once without it
   (**:366-374**). Otherwise NOT retried: a 5xx may already have created a pending share.
8. `external_publish_id` is written **before** any bytes go up
   (**`src/services/tiktokPublish.ts:535-538`**), so a crash from here on is resumable.
9. `uploadChunks` (**`src/services/tiktok.ts:485`**) — sequential PUTs with `Content-Range`, each
   retried (a re-PUT is safe). Then `PROCESSING` (**`src/services/tiktokPublish.ts:545-549`**).
10. **Inline poll** (**:237-256**) — every 3s for 12s, `fetchPublishStatus` → `applyStatus`. A
    small reel usually reaches `IN_INBOX` here, so "Publish now" shows the real outcome. Anything
    still processing returns `PROCESSING` and is left to 6.5.

> **Why FILE_UPLOAD, not PULL_FROM_URL.** Pulling needs the URL prefix verified in TikTok's
> portal, and TikTok would fetch through `/api/uploads/:id`, whose response Vercel caps at 4.5MB.
> Pushing the bytes is an outbound request with neither problem (**`src/services/tiktok.ts:16-19`**).

### 6.5 — Three writers, one idempotent transition

After the upload the row is `PROCESSING`, then `IN_INBOX` while it waits for the creator, then
`PUBLISHED` once they post it (TikTok's `PUBLISH_COMPLETE`). Three things move it, all through
`applyStatus` (**`src/services/tiktokPublish.ts:231`**):

| Writer | Where | When |
|---|---|---|
| inline poll | **`tiktokPublish.ts:237-256`** | the 12s after upload |
| webhook | `POST /api/tiktok/webhook`, **`src/routes/tiktok.ts:149`** → `applyWebhookEvent` (**`tiktokPublish.ts:359`**) | TikTok pushes `post.publish.*` |
| sweep | `reconcileTikTokPosts` (**`tiktokPublish.ts:286`**), from `/api/jobs/drain` (**`src/routes/api.ts:414`**) and the daily cron (**`src/routes/api.ts:1091`**) | `PROCESSING` every 30s; `IN_INBOX` every 10 min, for 7 days |

`applyStatus` maps TikTok's status (`mapPublishState`, **`src/services/tiktok.ts:807`**), and each
UPDATE names the states it may be reached from (**`tiktokPublish.ts:118-150`**): a late
`PROCESSING` cannot drag an `IN_INBOX` row back, and a success may overwrite a FAILED our side
wrote after a timeout. `published_post_id` becomes `TT:<id>` (**:141**) — only public, moderated
posts get an id, so PUBLISHED with no id is normal.

- **Webhook auth** — `verifyTikTokSignature` (**`src/services/tiktok.ts:836`**):
  `Tiktok-Signature: t=…,s=…`, HMAC-SHA256 of `"<t>.<raw body>"` keyed with the client secret,
  over `req.rawBody` (**`src/index.ts:56`**). No freshness window, because TikTok retries for 72h;
  a replay is harmless because the transitions are idempotent. A rejection is a logged 401
  (**`src/routes/tiktok.ts:153-160`**).
- **Webhook events** (**`tiktokPublish.ts:348-353`**) — unknown events are 200'd and ignored; the
  `publish_id` must match a row, and its `open_id` the same tenant (**:369-380**).
  `authorization.removed` deletes the connection row (**:360-364**, `deleteConnectionByOpenId`,
  **`src/services/tiktokConnections.ts:459`**).
- **Give-up** — a `PROCESSING` row TikTok is silent about for 24h is FAILED
  (**`tiktokPublish.ts:321-325`**); an `IN_INBOX` draft is simply left alone after 7 days.
- **Post ids** — TikTok sends them as int64 JSON numbers. `fetchPublishStatus`
  (**`src/services/tiktok.ts:750`**) keeps the raw text and `parseJsonKeepingIds` (**:437**) quotes
  the ids before parsing; plain `JSON.parse` would round them to a different video's id.

### 6.6 — Daily token check

`GET /api/cron/publish` runs `refreshAllConnections()` (**`src/routes/api.ts:1087`**,
**`src/services/tiktokConnections.ts:388`**) before its reconcile sweep. Access tokens last 24h;
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

1. **Mode is decided at creation** (`src/routes/api.ts:2965`). The post is `direct` only if
   the connection holds `video.publish` **and** app setting `tiktok.direct_post_enabled` is
   `'true'` (`postModeFor`, `src/routes/tiktok.ts`). Otherwise it's `inbox`, and every TikTok
   row created before v19 (`platform_options` NULL) counts as inbox.
2. **Choices are validated** by `validateTikTokOptions` (`src/services/tiktokPublish.ts:73`):
   - consent is required;
   - a privacy level is required, and there is no default;
   - only `SELF_ONLY` is allowed while `tiktok.audited` isn't `'true'`;
   - branded content can't be `SELF_ONLY`;
   - every toggle defaults to off;
   - `consent_at` is stamped.
3. **The composer's panel** is built from live `creator_info`, via `GET /api/tiktok/creator-info`
   (`src/routes/tiktok.ts:230`).
4. **At publish time**, `startDirectPost` (`src/services/tiktokPublish.ts:304`) re-reads
   `creator_info` and checks everything again before anything is posted:
   - the privacy level must still be offered;
   - the duration comes from the MP4 `mvhd` box (`mp4DurationSeconds`,
     `src/services/tiktok.ts:696`) and must fit the creator's maximum;
   - SELF_ONLY is enforced while unaudited.

   Interactions the creator has disabled are forced off. The call is then `/v2/post/publish/video/init/`,
   which is not retried, because a 5xx may already have posted.
5. **Status:** `PROCESSING_UPLOAD` → `PUBLISH_COMPLETE` → PUBLISHED, and a post id arrives only
   for public, moderated posts. Direct rows are excluded from the 5-draft inbox count.

**Unaudited** (true until TikTok approves the app): TikTok also requires the creator's
**account** to be private at posting time, or the call fails with
`unaudited_client_can_only_post_to_private_accounts`.

## 7. Claude on the Mac → who may ask

Three kinds of Studio work are answered by Claude Code on the **owner's Mac, on his personal Claude plan**: a
`monteur_think` (`monteur.brain: 'claude_mac'`), a `render_infographic` whose payload has `write`, and an `explainer_write`
(an illustrated explainer's researched script, [§13](#13-explainers-topic--script--voice--pictures--render--schedule)); a fourth,
`ads_think`, is §7.5. Anthropic's terms forbid routing anyone else's work through that plan, so the server refuses it for every
tenant the Mac is not for (G1, `src/services/macBrain.ts`). Of an explainer's four jobs only the write is Claude's: the voice, the
drawing and the render use no Claude, and the per-tenant switch keeps all four the owner's ([13.1](#131--the-switch-and-who-may-ask)).

**The owner is always allowed; the list adds tenants.** The owner is the first creator ever made
(`getPlatformOwnerId`, `tenant.ts`: `ORDER BY created_at, id`, **no `is_active` filter**, cached 30 s), so
deactivating him cannot hand the Mac to tenant #2, and no setting can take it from him. The app setting
`studio.mac_brain_tenants` (a JSON list of creator ids) names the tenants allowed besides him: unset, `null` and `[]`
all mean "the owner only", so a tenant created tomorrow is refused by default. With no creators at all, nobody is
allowed. The refusal is a `MacBrainRefused`, a `StudioError` that answers **409** `{ error, message, code: 'NEEDS_API_BRAIN', params }` (the shared refusal
envelope: `error` stays the English string, `code` and `params` are what the dashboard translates; the registry is
`src/services/errorCodes.ts`).

1. **A think is queued** only by `think()` (**`src/services/monteur/think.ts:246`**), which checks first, before a
   try is read or queued. `ask()`'s Mac route (`model.ts`) is the only way in, so the pick, the Marketer, the Editor
   and the Analyst are all covered. A refused source stops at once with the reason (`failAttempt`,
   **`sweep.ts:209`**); a refused Analyst run fails with it; neither falls back to Gemini.
2. **An infographic is written on the Mac** by `createInfographic` and by `rerenderInfographic` with `rewrite: true`
   **only for the owner and the listed tenants**; any other tenant's is written on the server (7.1), so these two no longer
   answer a tenant 409. A row with no spec yet is a rewrite whatever the body says. A render alone (an edit, a copy, the
   other theme, the second half of "both themes") asks Claude nothing and is never refused.
3. **The net:** `enqueueJob` (**`studio/jobs.ts:87`**) refuses any `monteur_think`, `explainer_write` or `render_infographic` with
   `write` whoever calls it (`isMacBrainJob`, **`macBrain.ts:161`**; an `ads_think` too, §7.5). A tenant's server-written infographic
   queues a `render_infographic` with a `spec` and **no `write`**, so the net does not touch it. Nor does it touch an explainer
   Gemini writes: that job is inserted by the server, already claimed (`insertServerWriteJob`, [13.3](#133--who-writes-queuewrite)).
4. **The claim:** a job already queued (before the guard, or for a tenant since taken off the list) is **failed with
   the same reason instead of being handed to the worker**, in the claim that found it, and the claim goes on to the
   next job (`claimJob`, **`jobs.ts:311`**, at most 50 refusals per poll). Its infographic goes `failed` with the
   message; a failed think is one try, and `think()` refuses before another is queued. If the allow-list **cannot be
   read** after the claim, the job is **released** (`RELEASE_CLAIM_SQL`: `pending`, attempt unspent) before the error
   goes on, so it is neither handed out unchecked nor left `claimed` for 15 minutes.
5. **The settings:** a tenant the Mac is not for cannot switch `monteur.brain` to `claude_mac`: 400 with the same
   message and code (`applyStudioPatch`, **`studio/settings.ts`**). Only the switch is refused. The mirror image is 7.1.
6. **The operator surface:** platform admin `GET` / `PUT /api/admin/mac-brain-tenants` (**`routes/admin.ts:392`**,
   **`:405`**). `GET` reports `platform_tenant` (the owner) and `extra_tenants` (the saved list). `PUT { tenants: [ids] }`
   saves the list (`[]` is allowed; every id must be a creator), `{ tenants: null }` forgets it; each write is one
   `settings.mac_brain_write` audit row. No dashboard card yet: the AI providers card (P20d) will host it.

> **Fails closed, but never against the owner.** The list is read on every call. A read that errors throws; it is
> never a yes. A saved value that is not a list of UUIDs is logged (`studio.mac_brain_setting_unreadable`) and
> ignored, which leaves the owner alone. Tenants get the Monteur and infographics through the AI providers layer. An explainer's
> script has no road through it: Explainers are switched on for the owner alone ([13.1](#131--the-switch-and-who-may-ask)).

### 7.1 The other half: a tenant's AI work on the AI providers layer (P32)

A tenant the Mac is not for gets the same three kinds of work through `src/services/aiProviders/` (`generate`), on the
operator's keys (Operations → AI providers), charged to **that tenant** in `ai_usage` and held to the per-tenant budget.
Three purposes, each at its own default effort: `tenant_monteur_think` (high), `tenant_infographic` (high),
`tenant_studio` (medium). **The owner's work never moves**: the router refuses the Mac's two purposes for him and for a
listed tenant (`MacBrainTenantRefused`), and nothing hands him the Studio writer's `callModel`.

1. **The Monteur: `monteur.brain: 'api'`.** `pickSource` and `runAnalyst` ask `effectiveBrain`
   (**`monteur/brain.ts:20`**; **`sweep.ts:403`**, **`analyst.ts:252`**): `gemini` and `claude_mac` come back as stored with no
   read; **`api` is the layer for a tenant the Mac is not for, and the Mac for the owner or a listed tenant**, whatever is
   stored. The steps (`pickClips`, `writeCopy`, `writeEdits`, the Analyst) then carry an `api` route beside `think`, and
   `ask()` (**`model.ts:82`**, `askApi` **`:108`**) calls `generate` with the step's own system prompt, turns and schema,
   purpose `tenant_monteur_think`. Neither route set is a bug (nothing is asked); there is no route from `api` to Gemini or
   to the Mac. A new tenant starts on `api` (`seedApiBrain`, **`routes/admin.ts:805`**, in the creating transaction);
   `defaultMonteurConfig()` stays `gemini`, so no existing row moves. Saving `api` for the owner or a listed tenant is a 400
   `MAC_BRAIN_TENANT` (`applyStudioPatch`, **`settings.ts:349`**).
2. **Infographics: written on the server, then drawn.** `createInfographic` (**`infographics.ts:210`**) and
   `rerenderInfographic` with `rewrite` (**`:357`**, **`:385`**) send a tenant the Mac is not for to `createOnServer`
   (**`:253`**) / `rewriteOnServer` (**`:279`**): the profile context is read, `writeInfographicOnServer`
   (**`infographicWriter.ts:163`**) asks the layer (`tenant_infographic`) with `writeSystemPrompt`, `writeUserPrompt` and
   `WRITE_SCHEMA` (as plain JSON Schema, array bounds out, objects closed), `answerToWritten` (**`:100`**) makes the
   template's spec exactly as the worker's `specFromAnswer` does, and only then does a transaction open: the row is born
   `rendering` with its spec, caption and review, and a **render-only** `render_infographic` job (`spec`, no `write`) goes to the
   worker. `theme: 'both'` writes once and makes both rows at once (no `pair_theme`). One difference from the Mac's path: the
   worker finds `logo` and the examples' logos in `simple-icons`, a dev dependency, so the server leaves `logo` out and gives
   examples as names alone.
3. **The Studio writer (D13).** `createDraft`, `rewriteDraftSlide` and `planDrafts` pass `writerOptionsFor(creatorId)`
   (**`drafts.ts:556`**, **`:660`**, **`:761`**; **`tenantAi.ts:108`**) as `GenOptions`: `{}` for the owner (Gemini, the call as it
   was) and `{ callModel: layerCallModel(creatorId) }` (**`tenantAi.ts:83`**) for everyone else. If the owner cannot be read the
   answer is `{}`: a failed read never moves his Studio.

**It never falls back.** A call the layer cannot answer is an error that says why (`studioErrorFromAi`, **`tenantAi.ts:50`**):
no provider is `409 NEEDS_AI_PROVIDER` ("Nothing was sent to the Mac"), a spent budget `429 AI_BUDGET_SPENT`, the provider
down or refusing the operator's key `503 AI_UNAVAILABLE` / `AI_PROVIDER_REJECTED`, an unusable answer `502
AI_ANSWER_UNUSABLE`. An infographic refused for any of them has no row and no job; a Monteur call fails its attempt with the
same words (`monteur.brain: 'api'` is never retried on Gemini or the Mac).

### 7.5 Proposals: an ad drafted by Claude, applied only after a person approves (Ads A7)

(§7.2–7.4 are left for later phases; §7.6 is audiences.) The same split as §7 and §7.1, for ads: **the owner's drafts are Studio `ads_think` jobs
on his Mac; every other tenant's go to the AI providers layer on its own key.** `ads_draft` / `ads_review` are NOT in
`MAC_BRAIN_PURPOSES` (that set means "refuse on the layer"): a Mac tenant simply never asks the layer for them. Code in
`src/services/ads/proposals/` (types.ts names every file); routes in `src/routes/adsProposals.ts`.

1. **Request.** `POST /api/ads/proposals` (operator+) → `requestProposal` (**`service.ts:120`**): the owner's words (≤ 1000) or a
   published post (`loadPost`). A tenant the Mac is not for is checked first with `resolveRoute(ads_draft)`: no provider is
   **409 `AI_NOT_CONFIGURED`** and no row. Then a `drafting` row (`insertProposal`, **`store.ts:61`**, `model.via` = `mac`|`api`)
   and `queueAdvance` (**`advance.ts:17`**): an `ads.draft` app job (**`jobs/handlers.ts:74`**) drained inline under `waitUntil`.
2. **Advance** (`advanceProposal`, **`service.ts:161`**, idempotent; never moves a row that is not `drafting`). The input is
   `buildInput` (**`input.ts:55`**): **aggregates only** (FR-049) — the stored copy's names, budgets, statuses, targeting summaries
   and 7-day totals (`mirrorPort`, **`ports.ts:74`**), the offers' title/price/summary with emails and phone numbers stripped, the
   limits (`moneyPort`), the policy rule descriptions, the request, a post's caption and organic counts, and for a request with no
   post up to 5 recently published posts as creatives. One prompt (`prompt.ts`) and schema (`schema.ts`) for both paths.
   - **Mac tenant**: no `ads_think` job for (proposal, attempt) → `enqueueJob(..., 'ads_think', { proposalId, attempt, task,
     purpose, model: THINK_MODEL, system, user, schema })` — the Mac-brain guard in `enqueueJob`/`claimJob` lets it through
     (`isMacBrainJob`, **`macBrain.ts:159`**). Pending/claimed → wait. The worker (aicourse-captions
     `scripts/studio/adsThinkJob.mjs`, the same claude CLI call as a `monteur_think`) answers `{ output, model, usage }`;
     `completeJob` stores it (`parseMonteurThinkResult`) and, **after its transaction commits**, `queueAdvance(..., 'mac_done')`
     (**`studio/jobs.ts:448`**); `failJob` and an exhausted claim do the same with `mac_failed` (**`:1020`**) → the proposal fails
     with the worker's error.
   - **Any other tenant**: `generate({ purpose: ads_draft | ads_review })` on its own route; `no_provider` → `failed`
     (`AI_NOT_CONFIGURED`), a non-retryable refusal → `failed`, anything else throws and the job runner retries.
3. **Checks** (`runChecks`, **`checks.ts:235`**, contract order): schema → evidence (a review item quoting a number not in the
   input, or an object not in the account, is **dropped**) → policy (A4 `checkPolicy`; a `block` asks again once) → money (A1
   `moneyFor`; over the daily max or the month's remaining → **reduced** with a note; below Meta's minimum → `failed`). Then
   spec.ts `validateSpec` (the builder's own rules; asked again once). A regeneration is attempt 2 with the failed checks as
   feedback (a second `ads_think` job on the Mac). Pass → `open` with payload, rationale, evidence, effect, checks, model; a review
   with 2–3 items inserts the others as `open` rows; a review with none deletes its `drafting` row.
4. **Approve** (`POST /:id/approve`, owner, `confirm: true`; `approveProposal`, **`service.ts:273`**): refused 409 `NOT_WIRED`
   without the ports; an `open` row past `expires_at` becomes `expired`. `recheckForApproval` (**`checks.ts:352`**) runs policy and
   money again and **adjusts nothing** (a budget that no longer fits is 409 `OVER_MONTHLY_CAP`); a new campaign also gets Meta's
   `validate_only` (`validateDraft`). Then `open → approved`, `applyPort` (**`ports.ts:142`**): a new campaign through A4's
   `createDraft` (every object PAUSED), a change through A2's `requestStatus` / `requestBudget`; every op is tagged
   `ads_ops.proposal_id` and actor `via: 'proposal'`, new objects `origin: 'proposal'` → `applying` with the op ids in `checks.ops`.
   `settleApplying` (**`service.ts:331`**, on every list read) moves it to `applied` when all ops are done, `failed` when one failed.
   Audit `ads.proposal_decided`.
5. **Reject** (`POST /:id/reject`, owner): `open → rejected` with the reason. Nothing is enqueued.
6. **Daily cron** (**`routes/api.ts:1138`**): `expireProposals` (**`store.ts:144`**: `open` past 7 days → `expired`; `drafting`
   older than 24 h → `failed`, "the Mac did not answer") then `runDailyReview` (**`service.ts:370`**): for each `ads.enabled`
   tenant with ≥ 3 days of results and an active object, one review a day (≤ 3 proposals), skipped quietly without an AI for it;
   when it opens, one `proposal_ready` alert (A1 `notifyAds`).

### 7.6 Audiences: engagement, lookalikes, and customer lists behind a legal lock (Ads A8)

Tables in **v56** (`ads_audiences`, `ads_legal_signoffs`; the same file holds A9's `ads_rules` / `ads_rule_runs`). Code in
`src/services/ads/audiences.ts` (rules, store, sync fold-in), `hashing.ts` (customer lists), `legalSignoff.ts` (the lock);
routes in `src/routes/adsAudiences.ts`, mounted in `adsRouter` after the ADS_DISABLED gate; the screen is `#/ads_audiences`
(`dashboard/js/pages/ads_audiences.js`). **Every write goes through A2's `ads_ops`; nothing here calls Meta inline.**

1. **Engagement and video audiences.** `POST /api/ads/audiences` (owner; **`adsAudiences.ts:217`**) → `parseAudienceInput`
   (**`audiences.ts:233`**: kind, retention ≤ 730 days, video ≤ 365, 1–50 video ids) and `validateAudienceName` (**`:171`**:
   names implying health, money troubles, religion, orientation, politics or a DM-bot segment are 400 `INVALID`
   `reason: sensitive_name`; a blank name gets a neutral Arabic one). `tosAccepted.custom === false` (the account read A1 stores,
   `health.account.tosAccepted`) → 409 `TERMS_NOT_ACCEPTED` with Meta's acceptance link: **the API cannot accept the terms.**
   `buildCreateParams` (**`:363`**) builds the rule JSON on the tenant's own `instagram_page_id` (`ig_business`) or
   `facebook_page_id` (`page`), or the legacy array rule for video (`subtype: ENGAGEMENT`); then a `creating` row and one
   `audience_create` op (`object_key = audience:<id>`, POST `act_<id>/customaudiences`). The queue appends ` AR·<op id>` to the
   name and verifies a lost create by that tag.
2. **Lookalikes.** Same route, `kind: lookalike`: the seed must be the tenant's, not a lookalike, have a Meta id, not be flagged or
   still building, and have `size_lower ≥ 100` (409 `SEED_TOO_SMALL`). Params `subtype: LOOKALIKE`, `origin_audience_id`,
   `lookalike_spec {ratio 0.01–0.20, country}`.
3. **Size and status.** `syncStructure` → `syncAudiences` (**`sync.ts:582`**), only when the tenant has a live audience:
   `adoptCreatedMetaIds` (**`audiences.ts:604`**: `meta_id` from the done `audience_create` op's `result.id`), then
   `GET act_<id>/customaudiences` (≤ 2 pages, 1 point each) → `applyAudienceReads` (**`:612`**) → `classifyAudienceRead`
   (**`:420`**): `operation_status 471` → `flagged` (unusable; Meta reviews only in its own UI), `delivery_status 300` or an upper
   bound < 1,000 → `too_small`, 414/441 → still `creating`, else `ready`. Fail-soft: a failed read never fails the sync.
   `GET /api/ads/audiences` also adopts ids, and lists each audience with its newest op (a failed create with 200/1870090 shows
   the terms message).
4. **Builder.** The picker (`AdsAudiencePicker` in ads_audiences.js, mounted by `ads_create.js` in the audience step) sends our
   audience ids; `createDraft` / `validateDraft` run `resolveSpecAudiences` (**`audiences.ts:688`**): each id is the tenant's,
   an included one is `ready`, an excluded one has a Meta id; numeric ids (made in Ads Manager) pass through. A special category
   cannot exclude (spec.ts).
5. **Customer lists.** `POST /api/ads/audiences/customer-list` (owner; **`adsAudiences.ts:258`**):
   1. **The lock first:** no non-revoked `customer_lists` row in `ads_legal_signoffs` → 403 `LOCKED_LEGAL` **before the text is
      read**. Only the platform admin writes that table (`POST/DELETE /api/admin/ads/tenants/:id/legal-signoff`,
      **`admin.ts:1288`**; tenant detail → "Ads: legal sign-off"). Egypt PDPL 151/2020 (deadline 2026-11-01) and Saudi PDPL.
   2. The JSON body carries `{ name, columns | 'auto', defaultCountry?, text }` (≤ 3 MB; the browser reads a file with
      FileReader). `parseCustomerText` (**`hashing.ts:259`**) → `prepareCustomerList` (**`:331`**): normalise (email trim +
      lowercase; phone digits with the country code, no leading zero, `defaultCountry` for national numbers; names lowercase with
      no punctuation; country ISO-2), drop rows with no email or phone, drop rows whose country is outside the sign-off's
      `countries`, drop opted-out rows (`loadOptOutHashes`, **`:437`**: `conversations.wa_phone` with `opted_out_at`, the newest
      `contact_consents` marketing row `withdrawn`, and `customer_list_optout` hashes), dedupe, SHA-256 every cell.
   3. A row with only `{ columns, rows_sent, matched_estimate }` in `spec`, one `audience_create` op, then one `audience_users` op
      per ≤ 10,000 rows (`toBatches` / `buildUsersParams`: `session {session_id, batch_seq, last_batch_flag,
      estimated_num_total}`), each `dependsOn` the create, `path: '{dep}/users'`, `scrub: true` (ops.ts empties `exec.params` in
      the statement that ends the op). Audit `ads.customer_list_uploaded` with counts only. **The raw text is never stored,
      logged, audited or echoed** (pinned by `ads.audiences.test.ts`).
6. **Opt-outs.** `POST /api/ads/audiences/opt-outs` (owner; **`adsAudiences.ts:321`**) `{ contact }` (a `+`/`00` phone or an
   email) → only `sha256(normalised)` in `contact_consents` (`platform 'customer_list_optout'`, `withdrawn`), plus a
   `DELETE <audience>/users` op (scrubbed) on each of the tenant's customer lists at Meta. A WhatsApp STOP excludes the number
   from later uploads through `opted_out_at`; removal from lists already at Meta needs this route.
7. **Delete.** `DELETE /api/ads/audiences/:id` `{ confirm: true }`: a `delete` op on the Meta id (or just the row when the create
   never landed); the row is marked `deleted` and kept.

### 7.8 Lead ads: a lead → the Leads tab, behind a legal lock (Ads A10)

Tables in **v57** (`ads_lead_forms`, `ads_leads`); the lock is A8's `ads_legal_signoffs` (v56). Code in `src/services/ads/leads.ts`;
routes in `src/routes/adsLeads.ts` (mounted in `adsRouter` after the ADS_DISABLED gate); the screen is `#/ads_leads`
(`dashboard/js/pages/ads_leads.js`) and the builder's Leads goal (`ads_create.js`). **Forms and leads use the tenant's PAGE token,
not the ads token and not `ads_ops`. Nothing here is given to an AI, and nothing contacts a lead.**

1. **The lock.** `activeSignoff(creatorId, 'lead_ads')` (**`legalSignoff.ts:139`**). Locked: `POST /api/ads/lead-forms` →
   403 `LOCKED_LEGAL` (**`leads.ts:363`** `createLeadForm`, before any write); a `goal: 'leads'` draft → 403 `LOCKED_LEGAL`, or a
   country outside the sign-off's `countries` → 403 on `adsets.<i>.targeting.countries` (**`leads.ts:586`** `checkLeadSpec`,
   called by **`drafts.ts:321`** validate and **`:443`** create); `fetchAndStoreLead` answers `locked` without a Graph call.
2. **The subscription.** Only a Page subscribed to `leadgen` is ever sent a lead. `subscribePage(…, extraFields)`
   (**`metaLogin.ts:571`**) POSTs `WEBHOOK_FIELDS` + `leadgenFieldsFor(creatorId)` (**`:553`**: `['leadgen']` while a lead_ads
   sign-off is active), and the connect path passes it too (**`:685`**), so a reconnect never drops it. The admin's sign-off routes
   call `syncLeadgenSubscription` (**`leads.ts:631`**) after a lead_ads record and after any revoke (**`admin.ts:1310`**,
   **`:1338`**); the catch-up re-syncs every 6 h. Prerequisite outside the code: the app-level Page webhook has the `leadgen` field.
3. **A form.** `POST /api/ads/lead-forms` (owner; **`adsLeads.ts:82`**) → `validateForm` (**`leads.ts:142`**: `AR_AR` default,
   an allow-list of question types, CUSTOM labels checked by `restrictedCategory`, https privacy and thank-you links, the optional
   `contact_consent` question) → a `pending` row keyed by the dialog's idempotency key → ONE `POST /{page_id}/leadgen_forms`
   (`buildFormParams`, **`:236`**) → `active` + `meta_id`, or `failed` with Meta's sentence; no answer leaves it `pending` for the
   catch-up to adopt by name. Audit `ads.lead_form_saved`.
4. **A lead arrives.** Meta's Page webhook `changes[].field === 'leadgen'` → `planLead` (**`router.ts:126`**, branch at **`:186`**;
   the inline fallback at **`:301`**) → one `ads.lead` job, ids only, dedupe `lead:<leadgen_id>` → **`handlers.ts:80`** →
   `fetchAndStoreLead` (**`leads.ts:479`**): tenant by Page id, the lock, `GET /{leadgen_id}?fields=id,created_time,ad_id,form_id,
   field_data` with the Page token (a throttle → `throttled`, never retried; a refusal → `failed`; no answer → throws, the job
   retries) → `storeLead` (**`:450`**): `answers_enc = encryptBytes(field_data)`, `person_keys` = HMAC of the normalised email and
   phone, `consent_contact`, `retain_until = created_time + leadRetentionDays`, `ON CONFLICT (meta_lead_id) DO NOTHING`, and the
   form's `last_lead_seen_at` moves.
5. **The catch-up and retention.** The drain (**`api.ts:453`**) calls `sweepLeads` (**`leads.ts:770`**): `purgeExpiredLeads`
   (**`:609`**: per tenant, answers and keys NULLed, `purged_at` set, where `retain_until` passed or `created_time` is older than
   today's setting; the row stays as a count) then `catchUpLeads` (**`:721`**: tenants with a sign-off, at most every 6 h by
   `ads.leads_caught_up.<t>`; the Page's forms reconciled; per active form `/{form_id}/leads` with `filtering` `time_created
   GREATER_THAN` the newest seen − 10 min, ≤ 10 pages; a throttle ends that tenant's run).
6. **Reading.** `GET /api/ads/lead-forms` (viewer; **`adsLeads.ts:65`**) answers the lock, the countries and the forms;
   `GET /api/ads/leads` (owner; **`:99`**) decrypts in memory; `GET /api/ads/leads.csv` (owner; **`:115`**) is audited
   (`ads.leads_exported`, count and filters only) before the file is sent (`leadsCsv`: BOM, every cell quoted, formulas defused).
7. **Erasure.** `resolveErasureTarget` adds `leadPersonKeys` (**`erasure.ts:122`**, `leadPersonKeysForHandle`: an email, or a phone
   also completed with EG and SA dial codes); counts, preview and `executeErasure` include `ads_leads WHERE person_keys && $4`;
   the rows are deleted whole inside the erasure's transaction (**`:599`**; the statement lives in erasure.ts, the one cross-tenant path, not in the ads module).

### 7.9 Split tests: two versions of an ad, or two audiences; Meta names the winner, a proposal keeps it (Ads A12)

Table **v58** `ads_studies`. Code in `src/services/ads/studies.ts` (every rule, behind `StudyPorts`), `studiesStore.ts` (SQL) and
`studiesPorts.ts` (the wiring to A1/A2/A7); routes in `src/routes/adsStudies.ts`, mounted in `adsRouter` after the ADS_DISABLED gate;
the screen is `#/ads_tests` (`dashboard/js/pages/ads_tests.js`, the Tests tab). **Creating spends nothing; Start is the one spending
action, confirmed and money-checked.**

1. **Create.** `POST /api/ads/studies` (owner) → `createStudy` (**`studies.ts:561`**): `parseStudyInput` (**`:242`**: type, 2–7 ads or
   2–5 ad sets, a daily budget, a start from TOMORROW in the account's day, 1–30 days, `confirm: true`) → `checkArms` (**`:276`**:
   every arm the tenant's, in its current account, made at Meta and **PAUSED**; a creative test's ads in ONE ad set (the shared
   audience); an audience test's ad sets with their own daily budget) → A1's money rule on `lifetime:<daily × days>:<days>` →
   `resolveBusinessId` (**`:548`**: `ads.settings.businessId`, else `GET me/businesses`: one is saved, none or several is 409
   `BUSINESS_REQUIRED` with `choices`; the screen saves the pick through `POST /api/ads/settings {businessId}` and resends). A
   `creating` row, then for an audience test one A2 `requestBudget` per ad set (the daily budget split equally, the arms still
   paused), then ONE `study` op: `POST <business>/ad_studies` with `buildStudyParams` (**`:320`**) — creative `SPLIT_TEST_V2`, each
   cell `{ name, treatment_percentage, ads: [id] }`, `creative_test_config.daily_budget` in minor units, `cooldown_start_time =
   start_time`, `observation_end_time = end_time`; audience `SPLIT_TEST` with `adsets: [id]`; shares `equalSplit` (100/n, the rest
   to the first arms); unix seconds. `exec.edge: 'ad_studies'` makes it a tagged create (ops.ts appends ` AR·<op id>` to the name and,
   if the answer is lost, reads the business's newest studies and matches the tag in `readBack` **before** it would ever send it
   again).
2. **Reconcile** (no Meta call). `GET /api/ads/studies` (viewer+) → `listStudies` (**`:672`**): a `creating` row takes its op's outcome
   (`reconcileCreate`): `done` with `result.id` → `ready` + `meta_id`; `failed` → `failed` with Meta's words.
3. **Start.** `POST /api/ads/studies/:id/start {confirm: true}` (owner) → `startStudy` (**`:623`**): only `ready`, and not past its end.
   The money rule again on `startWorstCase` (the test's daily budget for the days left, plus a paused parent's budget that starting
   switches on — a creative test's ad set spends beside the test ads), then A2's `requestStatus(ACTIVE, confirm)` per object —
   the arms, then their ad set, then the campaign LAST — each with A2's own payment check, daily max and money rule under its lock.
   One refusal stops there; what was switched on before it sits under a paused parent and spends nothing. → `running`.
4. **Stop.** `POST /:id/stop` (owner): `requestStatus(PAUSED)` on the arms (and a creative test's ad set) → `stopped`. No confirm.
5. **Results** (the drain, **`routes/api.ts:445`**, after `syncAllAds`): `pollStudies` (**`:707`**) over `open()` (the (tenant,
   study) pairs still `creating`/`ready`/`running`, then each read inside its tenant): creates reconciled; a `ready` test past its end
   → `stopped` ("never started"); a `running` one every 6 h, and once more 12 h after its end → `checkStudyResult` (**`:679`**):
   `GET <study>/objectives?fields=id,name,is_primary` → `GET <objective>?fields=results` (2 points) → `parseObjectiveResults`
   (**`:379`**: an object, a JSON string or a list of either; `high_performer_ids`, `winner_ad_object_id`, `winner_confidence`,
   `confidence_by_ad_object_id`, a fraction or a percent → 0–100) → `decideResult` (**`:417`**: high performers that are arms, else
   the declared winner; every arm "high", or none, is **no winner** once final). A failure (a throttle too) is logged
   `ads.study_poll_failed` and left for the next drain, never retried in the run.
6. **Keep the winner.** On the final read with a winner, `winnerProposal` (**`:442`**) → A7's `insertProposal` as an **`open`**
   `test_winner` / source `study` proposal: a review item `{ kind: 'pause', targets: <the other arms>, change: { percent: -100 },
   evidence: { window: '<days>d', numbers: { days, dailyBudget, confidence_<A..G> } } }`, the rationale in the tenant's language.
   Once per study (`proposal_id`). Approving it is §7.5 step 4: A7's recheck and `applyChange` → one PAUSED `requestStatus` per
   losing arm. Nothing changes by itself.

## 8. Meta login → a connected Page

A tenant connects its own Facebook Page and Instagram account with Facebook Login for Business instead of the operator
pasting a token (P26, P27; migration v35). The result is the same row a pasted token fills
(`creators`: the ids, an encrypted PAGE token, the `token_*` columns) plus what v35 added, so everything after the connection
(§1, §2, §3) is unchanged. **It is off until the operator switches it on** (`meta.login_enabled`), and nothing here touches a tenant
that is already connected unless its owner asks.

The state mechanism is shared with TikTok and YouTube (**`src/services/oauthState.ts`**); §6.1 is the same flow for TikTok.

### 8.1 — Starting: `POST /api/meta/connect`

1. **`src/routes/meta.ts:261`** — owner only (`canAdminister`). Body `{ returnTo?: 'settings' | 'welcome', reconnect?, authType? }`.
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

On `metaPublicRouter`, mounted above `requireAuth` (**`src/routes/api.ts:1468`**, before the `requireAuth` line below it). Every way
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
   - Nothing granted → `not_tester` (the person holds no role on the app: **unverified**). A core permission
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
4. `subscribePage` (**`src/services/metaLogin.ts:571`**): `POST /{page}/subscribed_apps` with the Page token and
   `subscribed_fields` = `WEBHOOK_FIELDS` (`feed`, `messages`, `messaging_postbacks`, `messaging_referrals`;
   **`src/services/metaLogin.ts:74`**) plus `leadgen` while the tenant has a lead-ads sign-off (`leadgenFieldsFor`, §7.8),
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

`GET /api/cron/publish` ends its sweeps with **`recheckAllMetaTokens`** (**`src/services/metaTokenRecheck.ts:191`**, **`api.ts:1003`**):
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

> **What is unverified.** That app 847772258381375 is a Business-type app, which Facebook Login for Business
> requires; that a Tester role-holder gets comment webhooks as the owner (an Admin) does; `override_default_response_type`
> on a manually built dialog; what a non-role-holder sees (the `not_tester` reason is inferred from "nothing granted"). The first real
> Tester connecting is the test (plan P27, live check).

### 8.9 — Deauthorize: Meta says a person removed the app (P33)

`POST /api/meta/deauthorize`, on `metaPublicRouter` (above `requireAuth`: Meta sends no session). Register it in Meta's dashboard as the
**Deauthorize Callback URL**; the operator's card shows it (`register.deauthorizeUrl`). Meta posts a **form** with `signed_request`, which the
app-wide JSON parser does not read, so the route parses it itself (`express.urlencoded`, 16 KB).

1. `parseSignedRequest` (`metaDeauth.ts`): shape (`<signature>.<payload>`, base64), the signature (HMAC-SHA256 of the **encoded** payload
   with **each** of `META_APP_SECRET` and `INSTAGRAM_APP_SECRET`, `timingSafeEqual`), and only then the payload: `algorithm` must be
   HMAC-SHA256 if present, `issued_at` within a day (and not from the future), `expires` not past, `user_id` a string (a JSON number is refused: past
   2^53 it is rounded to somebody else's id). 400 for a request that is not one or is stale, **403 for a signature that is not ours**, 503 with no
   secret to check against. The rejection line logs the reason and `app_keys_tried`, never the request.
2. `disconnectMetaUser`: `SELECT id FROM creators WHERE meta_user_id = $1`, a parameterised `=` on a non-empty id. **The owner's pasted-token
   connection has `meta_user_id` NULL and so matches no id**; if his row carries one (he reconnected through Login), only that exact id is his.
3. Per tenant, `removeMetaConnection` (the code `disconnectMeta` runs too): unsubscribe the Page (best effort: the person's tokens are already
   dead), then clear the ids, the token and the `meta_*` columns in one `UPDATE … AND ($2::text IS NULL OR meta_user_id = $2)`: a tenant that
   somebody else reconnected between the lookup and the write is left as it is. Audit `meta.deauthorize`, by `system:meta-deauthorize`, naming the
   Pages and the outcome and **not the person**. Campaigns and posts stay; the person's permissions are not revoked.
4. 200 `{ received: true }` whether anything matched or not (an id nobody connected is not a failure Meta should retry); 500 if a database error
   left a tenant uncleared, and the retry finds only what is left. Idempotent: a cleared tenant no longer matches.

The format is Meta's signed-request format as the Data Deletion callback guide documents it
(<https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback>); the Facebook Login guide that introduces the Deauthorize
Callback (<https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow>, "Detecting When People Uninstall Apps") points to it and
does not repeat the payload. **Not yet seen against a live delivery**: the callback's Test button in the App Dashboard is the check.

### 8.10 — Where Meta sends each event type: the app-level subscriptions (2026-10-30)

A Meta app delivers each webhook **object type** (`instagram`, `page`, `whatsapp_business_account`, …) to **one callback URL for the whole app**. The Page-level
subscription of §8.3 (`subscribePage`) only chooses which fields a Page sends. On 2026-10-30 another project that uses this Meta app pointed `instagram` (and a
field-less `user`) at its own site: 45 hours without an Instagram DM or comment, while the Page token was valid, every connection read "Connected", `lastWebhookAt`
stayed fresh from Facebook's events, and Settings → "Test the handshake" only asks THIS deployment about its own handshake. A signature failure at least writes
`webhook.signature_rejected` (§1.2); this writes nothing, because the delivery never arrives. **`src/services/metaWebhooks.ts`** is what can see it.

1. **Read.** `readAppSubscriptions`: `GET {GRAPH_BASE}/{app-id}/subscriptions` with the app token `{app-id}|{app-secret}` in an `Authorization: Bearer` header, never a
   URL. `parseSubscriptions` refuses anything that is not `{ data: [...] }` (`graph_failed`): not an answer is never "no subscriptions". `describeSubscriptions` reads each
   object against the host of `expectedCallback`, which is the `app.public_base_url` setting (or `PUBLIC_BASE_URL`) plus `/webhook` and never the Host header of whoever is
   asking: `{ object, host, ours, active, fields, version, carriesEvents, missingRequired }`.
2. **Judge** (pure). `findProblems` / `isBroken`: **broken** is an object that carries events being elsewhere or switched off, `instagram` or `page` having no subscription,
   `instagram` lacking `comments`/`messages`, `page` lacking `feed`/`messages`. A field-less object pointing elsewhere (`user`) and a Page without `messaging_referrals`
   are **warnings**, shown on the card and never alarming. One problem per object, the worst: `elsewhere`, `inactive`, `missing_field`, or `missing_object`.
3. **Check, at most once an hour.** `checkMetaWebhooks`, called by `GET /api/jobs/drain` (after the lead sweep, before the Monteur's) and by `GET /api/cron/publish`,
   held back by the stored `attemptedAt` (a held-back run is one settings read), and **never throws**. The answer is the app setting `meta.webhooks.status`
   (`{ checkedAt, attemptedAt, ok, expectedUrl, expectedHost, objects, error }`): `checkedAt` is when Meta last ANSWERED, `attemptedAt` when a check last RAN. A check that
   got no answer (no `META_APP_ID`/secret, no public address, Meta down) keeps the last answer's `ok` and `objects` and says why in `error`: not knowing neither starts nor
   stops a warning. A deployment with nothing to check yet logs `meta.webhooks_unanswered` at `info`.
4. **Tell the owner.** `alertIfNew`: an email (Resend) and a Telegram message, through the same `notify.*` channels the DM alerts use, **Arabic first and then English**,
   naming which event type goes to which host and the link to the card (`settingsLinkFor`). One alert a day per problem (`meta.webhooks.alerted`, `{ day (UTC), keys }`, a key
   being object + kind + host), listing every problem that stands. A day on which nothing could be sent (no channel on, every send refused) is **not** marked told: the next
   hourly check tries again.
5. **Show it.** `GET /api/health/tenant` adds `webhooks: { ok, checkedAt, problems }` from the stored answer: app settings only, **no Graph call on a page load**, the same for
   every tenant. Only a definite `ok: false` is a notice: `HealthStrip.webhookNotice` (**`dashboard/js/pages/admin_common.js`**) feeds Today's alert
   (`OverviewPage.buildAlerts`) and the Inbox's strip (`InboxPage.paintWebhookStrip`); the platform admin gets a link to the card, everyone else is told whom to ask.
   `GET /api/meta/webhooks` (platform admin; 404 for anyone else) is the live read behind Settings → Platform → "Where Meta sends your events"
   (`MetaConnect.eventsBlock`): it forces a check, stores it, and adds the plan the button would apply and `lastEvents`, the newest `jobs` row per platform for THIS workspace
   (`readLastEvents`: `tenant_key` is the Instagram account's id, the Page's, or the WhatsApp number's).
6. **Repair.** `POST /api/meta/webhooks/repair` (platform admin, `{ "confirm": true }` or 400): `repairSubscriptions`.
   - **Plan** (`planRepair`, pure): one step per object that is elsewhere, off or short of a required field, in the order Meta listed them, then one per required object Meta
     has none for. An object that is ours, active and complete has none, so an empty plan means there is nothing to send. A step carries the **union** of the object's current
     and required fields (a POST replaces the list, so nothing Meta subscribed to is dropped) at the **version its fields already have** (the app's version when they differ
     or there are none).
   - **Before anything is sent**: `not_configured`, `no_base_url`, `no_verify_token` (409 each) and the first read failing (`graph_failed`, 502). The verify token is the first of
     `verifyTokenCandidates` (**`src/services/webhookVerifyToken.ts`**): the environment's `META_VERIFY_TOKEN`, then the first active creator's `webhook_verify_token`, which is
     the list `GET /webhook` accepts (`src/index.ts`), so the handshake Meta makes during the POST accepts it by construction.
   - **Each step**: `POST https://graph.facebook.com/{version}/{app-id}/subscriptions`, form-encoded: `object`, `callback_url`, `fields` (left out for a field-less object),
     `verify_token`, `include_values=true`, `access_token`. The tokens are in the **body**, never the URL. **Not retried** (re-pointing is idempotent, and a timeout is
     answered by reading back), 30 s because Meta calls this deployment while it applies. A Meta refusal is that step's `{ ok: false, error }` (scrubbed of every secret) in a 200,
     never a 401, which the dashboard reads as signed out.
   - **Then** it reads again (what it stores and returns is what Meta says now, not what the POSTs claimed) and goes over each active connected tenant's Page
     (`repairPages`): `GET /{page}/subscribed_apps`, and only a Page that does not list this app, or lacks a field it needs (`WEBHOOK_FIELDS`, plus `leadgen` while the tenant's
     lead-ads sign-off stands), is subscribed again with `subscribePage`. A complete Page is not touched (that would only risk losing a field). One tenant's failure is counted
     and stops nothing.
   - **Audit**: one `meta.webhooks_repair` row, per object the host and fields before and after and the outcome of each step, no token.

> **Why the host and not the whole URL.** It is what `scripts/diagnose.mjs` has always compared (`checkMetaConfig`), and what separates "another site" from "us". A wrong
> path on our own host is not detected.

> **What a repair does to another project.** A Meta app has one address per event type, so a project that uses this app stops receiving the types put back. The question
> before the button says so, and lists every object that will change.

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
   - **TikTok (P33):** a tenant with a TikTok connection gives the profile fields the connection kept (`tt_about`, kind `tt_bio`): read from
     `platform_connections.profile` (`ttMap.ts`), never from TikTok. Present in `sources_status` as `tiktok` only for a tenant with a connection:
     `ok` with the fields, or `skipped` (`not_configured`) when it holds none (the setting is off, or the account has not reconnected since).
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
2. **The backstop:** `POST /api/onboarding/drafts/sweep` (**`src/routes/api.ts:483`**), above authentication with the other scheduler routes, guarded by
   the **same `requireCronSecret` as `/api/jobs/drain`** (Bearer `CRON_SECRET`, header only, fail closed). `sweepDrafts` (**`src/services/onboarding/drafts.ts:525`**)
   takes up to 10 due drafts (`SELECT_DUE_SQL`: active, not held, not in back-off, oldest first), three at a time, each given what is left of
   280 s, and skips what it has no time for. It is **not part of the drain**: a draft takes minutes, and the drain's call is already shared by the
   queue (45 s), the publishes and the sweeps, so the next drain would wait on a model.
3. **`heroku-worker/worker.mjs`** has a second loop (`sweepLoop`, **`heroku-worker/worker.mjs:119`**) calling it about every 60 s, independent of the drain's: neither
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

## 10. WhatsApp message → stored thread → answered (W3b to W5)

Someone writes to the owner's WhatsApp number. The message is stored, and then either **answered** (only for a listed test sender, §10.11) or
marked "not answered, and here is why" (§10.7). The same delivery URL, signature and queue as §1 and §2; what differs is the object, the planner,
and what the handler does. A person typing in the inbox is §10.12. What a listed tester's **stop phrase, voice note, file and entry link** do (W6, W7 and W8
wired in) is §10.13, and what each of them does when it goes quiet is in the index at the bottom.

### 10.1 — The delivery and the object gate

Hops 1.1 and 1.2 are identical: `POST /webhook`, verified against the same app secret (WhatsApp events are signed with `META_APP_SECRET`: one app, three
objects). The gate is **`src/index.ts:391`**, `isAcceptedWebhookObject(body.object)` (**`src/webhook/router.ts:106`**): `instagram`, `page` or
`whatsapp_business_account`. Anything else logs `webhook.unrecognised_object` and gets a 200, as in 1.3. Then 1.4 to 1.6 unchanged: enqueue first,
acknowledge, drain under `waitUntil`.

### 10.2 — `planJobs`' WhatsApp branch

**`src/webhook/router.ts:158`** — `if (object === WHATSAPP_OBJECT)` hands the entry to **`planWhatsAppEntry`** (**`src/webhook/whatsappPlan.ts:141`**) and
`continue`s: the Instagram and Facebook code after it is exactly what it was (`router.test.ts` pins whole-job equality for both). A WhatsApp entry
is read by `change.field`:

| `field` | job | dedupe key | `tenantKey` |
|---|---|---|---|
| `messages`, each message (**`whatsappPlan.ts:88`**, `planMessagesChange`) | `dm.process` `{ object: 'whatsapp', entryId, phoneNumberId, change }` | `dm:<wamid>` (**:117**) | `phone_number_id` |
| `messages`, each status | `wa.event` `{ kind: 'status' }` | `wa:st:<wamid>:<status>` (**:132**) | `phone_number_id` |
| `account_update`, `account_alerts`, `phone_number_quality_update`, `phone_number_name_update`, `business_capability_update` (**:159**) | `wa.event` `{ kind: 'account' }` | `wa:acct:<field>:<time>:<sha1(value)>` (**:167**) | `entry.id` |
| `user_preferences` (**:170**) | `wa.event` `{ kind: 'preference' }` | `wa:pref:<sha1(value)>` (**:176**) | `phone_number_id` |
| anything else | none | | |

`change` is the `value` of the change **trimmed to one message and its own contact** (**`whatsappPlan.ts:65`** `contactsFor`, **:75** `trimmed`): a batch holds
several people, and one person's job must not carry another's profile name. The handler re-normalises it with the same `normalizeWhatsAppChange`, and
`router.test.ts` proves that equals what was planned from, for every message and status in every fixture. The `dm:` prefix is kept: the inbox's
delivery chip finds a message's job by `dm:<mid>`.

A message that is a **group** message or has **no BSUID anywhere** becomes no job (**:111**). Every other kind of ignored message (a reaction,
`unsupported`, an edit) still becomes a `dm.process` job, so the handler can store a row that says why or log it.

> **Why the account key has the time in it (review M13).** GREEN → YELLOW → GREEN → YELLOW is four events; a key on the value alone drops the fourth
> while the first job is still retained, and an alert is lost. With no time anywhere (`entry.time`, else the change's own) the key is omitted rather than
> guessed: a duplicate is harmless (the handler compares with what is stored), a dropped alert is not.

### 10.3 — The handler adapter, and the inline fallback

**`src/jobs/handlers.ts:43`** — `isWhatsAppDmPayload(payload)` (`object === 'whatsapp'` with a `change`) sends a `dm.process` to **`handleWhatsAppInbound`**
(**`src/webhook/whatsappInbound.ts:656`**), anything else to `handleMessagingEvent` exactly as before. **`handlers.ts:52`** — `wa.event` →
**`handleWhatsAppEvent`** (**`src/services/whatsappStatus.ts:203`**). If the queue is down, **`router.ts:222`** → `processWhatsAppEntry` (**:205**) runs the same planner
and the same two handlers inline, one job at a time, each isolated (`webhook.whatsapp_failed`).

### 10.4 — Tenant

**`src/services/tenant.ts:206`** — `getCreatorByWhatsAppNumber(phone_number_id)`: the connection for the number through `getConnectionByPhoneNumberId`
(**`whatsappConnections.ts:198`**, any row that is **not `revoked`**), then the creator, which must be active. An **`invalid`** connection still resolves:
Meta answers a 200 once and never redelivers, so a message that arrives while the token is dead can only be stored now or lost (review H10). No
connection, a revoked one or no id: **`wa.no_creator`** (**`whatsappInbound.ts:654`**, `warn`) and the job completes; an inactive creator also logs
`wa.creator_inactive` (**`tenant.ts:217`**).

### 10.5 — Who is a test sender, and what is kept (review C3)

**`whatsappInbound.ts:660`** reads `ai_agents.whatsapp_mode` and `whatsapp_test_senders` (`readWhatsAppSettings`). A read that fails is **retried**
while an attempt is left; on the last attempt (**:665**, `wa.settings_unreadable`, `error`) the message is stored as for a stranger. **`isTestSender`**
(**:104**) matches the BSUID or the phone. The public pages do not name WhatsApp yet and there is no go-live gate, so:

| sender | thread (`conversations`) | message (`messages`) |
|---|---|---|
| a listed test sender | BSUID, phone, username, parent id, profile name (into `profile_name`, 255 max), entry source | text, interactive reply id, raw event (with the media id, type and caption), and the **private copy of a file or voice note** they sent (`media_upload_id`, §10.13) |
| anyone else | the BSUID and entry source only (a link source is the owner's own tag, not their words) | `text = ''`, no payload, no raw event, `message_type` kept, and **no file: a stranger's media is never downloaded** |

**The job's own payload is redacted too.** The queue keeps a `done` row 7 days (§5.7) and a `failed` row for good, and the payload is the event verbatim. So
`handleWhatsAppInbound` (**`whatsappInbound.ts:629`**) returns `{ redactPayload }` for every job that did not store a listed test sender's message in full (a stranger's, no
connection, a duplicate, an edit), and the queue's `complete` writes it **in the same `UPDATE` that marks the job `done`** (**`queue.ts`** `complete`, **`runner.ts`** `runInScope`); what is
left is the object, account, number, wamid, type, time and BSUID (**`whatsappRedact.ts`**). A failure that will be **retried** keeps the whole payload (the next attempt needs it);
the failure that **ends** the job redacts too (`redactOnFailure`, **`jobs/redaction.ts`**), because a failed row is never pruned. A status or preference `wa.event` is cut down the
same way (a recipient's phone); an account event names no one and is left alone. Instagram and Facebook jobs return nothing and are untouched.
**What this cannot close:** from the webhook's enqueue until the handler concludes the job (seconds, or up to the drain interval if the inline drain is frozen), and for a
job whose last attempt dies without reaching the handler's end (`reapStale` abandons it), the full event is in `jobs`.

### 10.6 — The thread, and the 24 h window

**`whatsappInbound.ts:269`** `alreadyHandled` is asked **before** the thread is touched: a redelivery must not stamp `last_inbound_at` and reopen a window the
customer closed days ago (`wa.duplicate_ignored`). **`:373`** — one upsert, `ON CONFLICT (creator_id, instagram_user_id)`; the column holds the BSUID, which cannot
collide with a numeric IGSID or PSID. It stamps **`last_inbound_at = NOW()` on insert and on update, for every inbound** (review H3): nothing else stamps it for a
thread no sales turn has answered, and `isWindowOpen` (`channels/window.ts`) reads it. `platform` is set once; `entry_source` is set by the first inbound only (a
click-to-WhatsApp referral, else a known entry-link ref as `link`, else `organic`: §10.13). The upsert hands `entry_source` back, so the turn can take the thread's tracking code out of what
the model reads. **`free_window_expires_at` is not written here**: not from a referral, not from a link (§10.9). `conversations.handled_at` (v45) is **not** touched, because the
Instagram upsert does not clear it yet either.

### 10.7 — Claim, then conclude

**`whatsappInbound.ts:285`** `claimWhatsAppInbound`: the same `ON CONFLICT (meta_message_id) … DO NOTHING` insert and 300 s re-claim window as 2.5, with this channel's
columns. No row back and no resumable one: `wa.duplicate_ignored`. A resumed one logs `wa.resumed` and is handed to the file and voice steps as `resumed` (§10.13). **`:314`** `markConcluded` is the last write and the only one
that sets `messages.no_reply_reason` (NULL when the customer was answered). **`:123`** `noReplyReasonFor` decides, in this order: `unsupported_type` for a reaction or a message the
agent cannot read (whatever the mode); `agent_off` for mode `off`; `not_test_sender` for anyone not on the list (mode `everyone` is refused by the API until the go-live
gate and is treated as `test` here); `unsupported_type` again for a **sticker, a location or a contact card** (a photo, video, document and voice note are read since W6: §10.13); `connection_invalid` when the connection is not `active`
(stored, nothing sent); `bot_paused` when a person has the thread; otherwise **null: the agent may answer** (§10.11). **A tester's stop phrase is looked at BEFORE this verdict is acted on** (**`:462`**, §10.13) and wins over every one of its answers but the first two:
`opted_out`. `wa.inbound_stored` (**`:418`**, `conclude`) says which, and whether the row is `full` or `metadata_only`.

### 10.8 — A BSUID that changes (review M9)

A `system` message (`user_changed_number`, `user_changed_user_id`) is not the customer writing: **`:558`** `storeSystemEvent` stamps neither `last_inbound_at` nor
`last_message_at`. **`:507`** `rekeyContact`, one transaction: the thread is re-keyed old → new unless the new id already has one (a `NOT EXISTS` in the statement,
the unique index behind it; a race that reaches the index rolls back and re-runs without the thread step); `contact_consents.contact_ref` follows the person, so an
opt-out holds; the id in `whatsapp_test_senders` is replaced (`array_replace`, or just removed when the new id is already listed). **If both threads exist they are
not merged or deleted**: `wa.contact_rekey_conflict` (`warn`), and the system message goes on the new thread. Concluded as `no_reply_reason = 'system_event'`.

### 10.9 — Statuses, and the usage ledger

**`whatsappStatus.ts:79`** `applyStatus`, one transaction, the row read **`FOR UPDATE`** (**:87**): a status of one of OUR messages (`direction = 'outbound'`, found by
`meta_message_id = wamid`) moves `delivery_status` only **up** (`sent` < `failed` < `delivered` < `read` < `played`, **:93**); `failed` records `delivery_error_code` and
`delivery_error` but never moves a delivered or read message back; `pricing_category`, `pricing_type` and `billable` are copied from whichever status carries them.
**`:117`** — the first status that takes a message from not-delivered to delivered (a `read` that arrived first included) calls **`recordDelivery`**
(**`src/services/channelUsage.ts:124`**) **in the same transaction**, so a duplicate or out-of-order status cannot count twice and a count that fails rolls the status
back for the retry to redo. The ledger row is per number, month (UTC for now, `TODO(M12)`), category, pricing type and recipient market (BSUID prefix `EG.`/`SA.` or
phone `20`/`966`, else `other`). `GET /api/whatsapp/connection` reads it back as the meter (**`src/routes/whatsapp.ts:94`**, `usageOf`).

**The free-entry window (W8, T049, review M20).** In the same transaction (**`whatsappStatus.ts:155`**, `applyFreeEntryWindow`): a status of ours whose `pricing.type` is **`free_entry_point`** and whose
`conversation.expiration_timestamp` is a number stores that end in `conversations.free_window_expires_at` for the thread of the message the status is about (one statement keyed on the message, scoped to
the tenant and to WhatsApp). It is clamped to 7 days from the status, never moved earlier than what is stored, and not stored at all when it is already over. **Nothing else sets it**: a click-to-WhatsApp
`referral`, an entry link and an ad say where a thread began (§10.13), and a referral proves nothing about cost (it needs a real click on a phone). `isWindowOpen` (`channels/window.ts`) then lets the sender
reply after the 24 h are over. A failing count rolls the window back with the status, and the retry stores both.

### 10.10 — Account events: the connection's health, and who is told

**`whatsappStatus.ts:180`** — a `wa.event` of kind `account` goes to **`handleAccountEvent`** (**`src/services/whatsappAccount.ts:490`**). **`planAccountEvent`** (**:268**, pure) reads the
field and event into **changes**, or says `informational` (partner, pricing and linked-ad events, and a `PARTNER_REMOVED` with no `disconnection_info`: logged `wa.account_event`, nothing
written) or `unhandled` (an event or field this build has no sample for, or a payload missing what its event needs: `wa.account_event_unhandled` with `reason`, completed, never guessed).
The tenant is found by **`entry.id`** against `platform_connections.profile.waba_id` (an account event names no phone number), narrowed to one number when the event carries
`display_phone_number`.

| Event | `profile` | `status` | Alert |
|---|---|---|---|
| `ACCOUNT_DELETED`, `ACCOUNT_OFFBOARDED`, `PARTNER_REMOVED` + `disconnection_info` | `disconnection`, `account_block` (`deleted` / `offboarded` / `disconnected`) | `invalid` | disconnected |
| `ACCOUNT_RECONNECTED` | `disconnection` cleared, block cleared | `active`, **only if an account block held it** (a dead token stays dead) | reconnected |
| `ACCOUNT_RESTRICTION` | `restriction` (types, end) | `invalid` + `account_block: restricted` + `block_until` **only for `RESTRICTED_CUSTOMER_INITIATED_MESSAGING` still running** (replies are customer-initiated) | restriction |
| `ACCOUNT_VIOLATION` | `violation` | unchanged | violation |
| `DISABLED_UPDATE` | `ban` | `DISABLE` → `invalid` + `banned`; `SCHEDULE_FOR_DISABLE` unchanged; `REINSTATE` → block cleared, `active` | ban |
| `account_alerts` | `alerts["alert:<type>"]` | unchanged | Meta's words, when `ACTIVE` |
| `phone_number_name_update` | `name_status`; `display_name` when `APPROVED` | unchanged | name |
| `phone_number_quality_update` | `messaging_limit` (`current_limit`), `number_status` (`FLAGGED`/`UNFLAGGED`), `throughput` (`THROUGHPUT_UPGRADE`) | unchanged | limit / number status; then `checkConnectionHealth` reads the real rating |
| `business_capability_update` | `business_capability` (daily limit, number cap) | unchanged | capability |

**"Once per distinct change" is the stored value, never the clock.** `profile.alerts[key]` is the last value the owner was told. A change whose value equals it is a duplicate
(Meta redelivers, a job is retried: nothing written, nobody told); one that differs is news however soon it follows, so GREEN → YELLOW → GREEN → YELLOW is four alerts (review M13).
Until a first alert is stored, the profile's own field stands in (`Change.fallback`), so the first event does not announce what the Settings card already shows; a violation, a point
event with no state, carries `entry.time` in its value. The write is **`commitChange`** (**:150**): read the row, decide (**:155**), `UPDATE … WHERE profile IS NOT DISTINCT FROM <what was read>`,
retried up to three times against whatever won; the alert is sent **after** the claim, and a send that fails (`wa.alert_failed`) **releases** it and fails the job, so the retry sends it once.
Alerts switched off (`wa.alert_not_sent`) is not a failure: the state is stored. The alert goes to the operator's Telegram bot (`whatsappNotify.ts`), Arabic then English, naming WhatsApp and
the number, with what to do; it never carries a customer.

A **block** (`profile.account_block`) is why a valid token does not revive a connection: **`refreshHealth`** (**`whatsappConnections.ts:425`**, **:437**) leaves it `invalid` while the block holds
(`wa.connection_blocked`) and clears a `restricted` one only when its `block_until` has passed.

**The free-reply alert.** After the transaction in `applyStatus` commits, a first-delivered `service` message calls **`checkFreeTierAlert`** (**`whatsappAccount.ts:550`**): once the period's
delivered `service` count reaches the connection's `settings.free_tier_alert_at` (900 by default) the owner is told, and `profile.free_tier_alerted_period` stores the period, so the 901st does
nothing and a new month alerts again; a failed send gives the period back. It never throws into the status path (`wa.free_tier_check_failed`).

**The daily read.** **`refreshAllWhatsAppConnections`** (**`whatsappHealth.ts:149`**) runs from `GET /api/cron/publish` after the YouTube visibility check, 50 connections a day, least recently read first, and
**never throws**: one tenant's failure is `wa.health_sweep_row_failed`, counted, and does not stop the next. **`checkConnectionHealth`** (**:95**) calls `refreshHealth`; Meta refusing the token or a
permission (190, 200, 10) makes the connection `invalid` and tells the owner once (`reportConnectionInvalid`: the stored value stops a second alert on every later day, whichever path marked it);
anything else changes nothing. What changed since the last read (quality, messaging limit via `whatsapp_business_manager_messaging_limit`, number status, name review) is told once by the same rule
(**`healthChanges`**, **:46**), a first reading is recorded without an alert, and a connection that comes back says so once. `TODO(M12)`: the account timezone is not read yet.

`wa.event` kind `preference` (Meta's own "stop / resume marketing messages" button, W7 wired in) logs `wa.preference_event` (the number it came in on, never the person), finds the tenant by that number
(**`whatsappStatus.ts:233`** `getCreatorByWhatsAppNumber`; a number nobody connected is `wa.no_creator`, `source: 'user_preferences'`, and completes) and calls **`handleUserPreference`**
(**`src/services/consentPreferences.ts`**): a `marketing` row in `contact_consents`, `withdrawn` for `stop` and `granted` for `resume`, source `user_preferences`, dated by Meta's own timestamp (never in the future, so an old
`resume` that arrives late cannot outrank a newer `stop`). It does NOT set `opted_out_at`: the button ends promotions, not the conversation (a person who writes «إيقاف» is §10.13). A database failure throws, so the
job is retried and the stop is not lost.

### 10.11 — The agent answers a test sender (W5)

When `noReplyReasonFor` says null (**`whatsappInbound.ts:488`**), the handler asks `answerWhatsApp` (**`src/webhook/whatsappAnswer.ts:187`**; the handler takes it as a
dependency, so `whatsappInbound.test.ts` tests the decision and `whatsappAnswer.test.ts` the answer). It is **the same sales turn that answers Instagram**, `runSalesTurn`
(§2), given a WhatsApp `transport` (**`dmSales/transport.ts`**, **`whatsappAnswer.ts:105`** `whatsappTransport`), whatever the tenant's Instagram `sales_mode` says:

| hop | what happens |
|---|---|
| 11.1 | `seen()` — **`markReadWithTyping`** (`whatsapp.ts`) while the model thinks: the read receipt and the typing indicator, best effort (`wa.sender_action_failed`), never the reason a reply fails |
| 11.2 | the prompt is the Instagram one plus ONE fact in the conversation's block: **"Channel: WhatsApp … never mention Instagram, Facebook or Messenger"** (`prompt.ts` `salesFactsBlock`, `SalesFacts.channel`); the Instagram block is byte for byte what it was (`prompt.test.ts` pins it) |
| 11.3 | the model is asked for purpose **`dm_whatsapp`** (**`aiProviders/purposes.ts`**): the saved `dm_whatsapp` route, else the saved `dm` route, else the first allowed provider with a key; **only Groq, Anthropic and OpenAI** (`NO_TRAINING_PROVIDERS`, **`route.ts`** `pickRoute`) — a route on Gemini, OpenRouter or Custom is `no_provider`, never a quiet move to another |
| 11.4 | a model that cannot answer (no provider, a 429, a timeout, a budget, an empty answer) is a **hand-off**, never Gemini: **`turn.ts:402`** skips `readDmEngine` and `generateAiResponse` for a transport (`dm.engine_failed`, `fallback: 'never'`); the customer gets the profile's hand-off line, the bot is paused, the owner is told; the inbound row says `provider_unavailable` |
| 11.5 | the rest is the turn: prefilter, rules, guard, link. What it does NOT do on another channel: spend Instagram's hourly quota, read the comment bridge or an A/B arm, **schedule a follow-up** (`scheduleFollowup` answers `unsupported_channel`; a `dm.followup` that names WhatsApp is skipped) |
| 11.6 | `send()` — **`channels/send.ts:124`** `sendWhatsAppReply`, `kind: 'agent'`, `record: false`: **ONE message**, with the automated-service line folded into its text (never a bubble of its own; **`turn.ts:270`**). The transport refuses a second send in a turn |
| 11.7 | the turn records the reply and the new state in one statement (`recordTurn`), then `recorded()` puts Meta's **wamid** on that row (`attachWamid`), so a delivery status finds it |
| 11.8 | the outcome becomes `no_reply_reason` (**`reasonOfTurn`**): NULL answered, `provider_unavailable`, `bot_paused`, `superseded`, `agent_off` |

**The sender (`channels/send.ts`)** says no, with NO request to Meta, to: a thread that is not this tenant's WhatsApp one; a connection that is not `active`
(`connection_invalid`); a **closed 24 h window** (`isWindowOpen`, `window_closed`); a **billable** service message while `settings.allow_billable` is off
(`billable_blocked`); a reply with no words (`invalid_message`). Then **`toWhatsAppMessage`** (**`webhook/whatsappPayload.ts:150`**) shapes ONE message addressed with
`recipient: <BSUID>` and no `to` — a text, an `interactive.button` (1–3 buttons), an `interactive.list` (4–10), or an `interactive.cta_url` — and `whatsapp.sendMessage` sends it,
**never retried once it may have landed** (`creates: true`). A failure is classified (`classifyWhatsAppError`): a dead token or a payment problem marks the connection `invalid`.

**When the reply cannot be sent** (`whatsappAnswer.ts:152` `failureOf`): `window_closed`, `billable_blocked` and `connection_invalid` are final and say so on the inbound row; the
conversation is stamped (`stage = 'handoff'`, `handoff_reason = 'unsure'`, the bot left on: `handoff_reason` is a closed list, v39) and **the owner is told what happened**
(`notify.ts` names WhatsApp and the dashboard for a WhatsApp conversation). A throttle (nothing delivered) releases the claim and is rethrown while an attempt is left. A send that
**may have landed** (a timeout, a 5xx) is **never retried**: concluded as `failure`, stamped. An error after the message went out (the record failed) concludes it as answered:
the customer is never answered twice (`wa.answered_unrecorded`).

### 10.12 — A person replies from the inbox (W4)

**`routes/api.ts:3525`** — `POST /conversations/:id/messages` hands a WhatsApp thread to **`replyOnWhatsApp`** (**:3441**) before anything Instagram-shaped runs: `sendWhatsAppReply`,
`kind: 'operator'`, then the bot is paused exactly as the Instagram branch pauses it. A closed window is **`409 WHATSAPP_WINDOW_CLOSED`** with `closes_at`, no request to Meta;
a refused connection or a billable reply is a 409; a message Meta did not take is a 502 with nothing stored and the bot still on; text over 4,096 characters is a 400, not a cut.

### 10.13 — A tester says stop, sends a voice note or a file, or arrives through a link (W6, W7, W8 wired in)

All of this is behind **`isTestSender`**: a stranger's message is stored as metadata only, as in §10.5. For a listed tester the handler (**`whatsappInbound.ts:351`** `storeInbound`) does these things, in this order,
after the row is claimed and before the agent is asked. Each step is a dependency the handler is given (`InboundSteps`, **:235**), so `whatsappInbound.test.ts` tests the decision with stand-ins that fail the
test when asked for what they should not be asked for, and each step is tested where it lives.

| hop | what happens |
|---|---|
| 13.1 | **Where the thread began** (**`:331`** `entryLinkOf`, before the thread upsert). The pure `refFromText` looks for a ` #ref` in the words first, so a message with none costs no query. A ref that is one of THIS tenant's entry links (`platform_connections.settings.entry_links`, `getEntryLinkLabels`) makes the first inbound's `entry_source` `{ kind: 'link', ref, label, at }`: a QR code and a short link share a ref, so they are one kind, and the label is the owner's, copied when the thread began. A click-to-WhatsApp `referral` stays `ctwa`; an unknown ref is not trusted (anyone can type one) and the thread is `organic`; labels that cannot be read are `wa.entry_link_unreadable` (`warn`) and the message is stored without a link source. It is metadata, so it is recorded for a stranger too, with none of their words |
| 13.2 | **What the agent will read** (**`:430`**). The words the agent reads are the stored words **without the ` #ref`** (`withoutEntryRef`, **`whatsappAnswer.ts:157`**); the stored row keeps them as they arrived. The turn is told the thread's ref (`entryRef`, from the upsert's `entry_source`), and the WhatsApp transport's `readable` (**`whatsappAnswer.ts:119`**) puts the history's customer rows through the same function (**`dmSales/turn.ts:549`** `readableHistory`), so the model never reads the code and never reads the message being answered twice (`salesTurns` adds a row whose text differs from the stored one). Instagram and Messenger have no transport, so their history is the array they always got (`turn.test.ts` pins it) |
| 13.3 | **A stop** (**`:462`**). The typed words of a tester (text, a tapped button, a photo's caption) go through `matchStopMessage` (**`services/consent.ts`**): the WHOLE message, normalised, must equal a phrase in the list (at most three words), never a substring (`عايز إلغاء الطلب`, `موقف`, "stop by tomorrow?" are not stops). If it is one, **`optOutWhatsAppContact`** (**`whatsappOptOut.ts:96`**) decides and **the turn is never run** (one path: a message cannot be an opt-out twice). It runs in every mode (`off` included) and while a person has the thread, because an opt-out is honoured wherever the system knows it is them |
| 13.4 | **What a stop does: Instagram's rule, plus W7's records.** One transaction (**`consent.ts`** `withdrawAll` with `closeThread`): `withdrawn` rows for service, updates and marketing (append-only, with the wording and source `stop_phrase`), `opted_out_at` for a thread not opted out before, **the bot paused and the stage `closed` with `last_intent = 'opt_out'`** (the stage comes from `optOutDecision`, the decision Instagram's turn makes for «stop», **`whatsappOptOut.ts:49`**; `recordTurn` pauses for exactly `decision.optOut`), and the contact's pending `dm.followup` jobs cancelled. The row says **`opted_out`** |
| 13.5 | **The confirmation, once.** `confirmationText(lang)` in the language of the phrase, through `sendWhatsAppReply` (`kind: 'agent'`, the sender writes the outbound row), only when this is the thread's FIRST opt-out (`conversationsNewlyOptedOut > 0`) **and** the agent may speak now (not `off`, an `active` connection, no person on the thread). A refusal or an error is `wa.optout_confirmation_not_sent` and **the opt-out stands**; nothing is retried. A stop written while the agent is off is therefore silent |
| 13.6 | **When an opted-out contact writes again** (the Instagram rule). The thread is paused, so the message is stored and concluded `bot_paused` and shows in the inbox as "Needs you"; the owner may answer by hand or switch the bot back on, which does NOT clear `opted_out_at`, so no follow-up is ever sent (`followup.ts` `opted_out`) and the stage stays `closed` (no pitch: `staysClosed`, `flow.ts`). A second stop phrase is recorded again, concluded `opted_out`, and gets no second confirmation |
| 13.7 | **What only the turn understands.** A stop the strict list does not name («ما ابي رسايل», "stop messaging me") goes to the agent, whose own prefilter decides it (`turn.ts` step 4): the opt-out line, `opted_out_at`, the pause and the closed stage are written by the turn exactly as on Instagram, and **`answerWhatsApp` then records the consent history** (**`whatsappAnswer.ts:209`** `recordTurnOptOut`, `withdrawAll` without `closeThread`: the thread is already closed, so it sends nothing and the turn's line was the one confirmation). A history that cannot be written is `wa.optout_consent_unrecorded` (`error`) and is not retried (the customer has been answered; `opted_out_at` stands). **Gap:** a refund AND a stop in one message is a hand-off whose `optOut` flag stamps `opted_out_at` (the turn's result does not carry the flag), so its consent rows are not written |
| 13.8 | **A stop that cannot be written** throws while an attempt is left (the claim is given back first: `wa.optout_retrying`) and, on the last attempt, is `wa.optout_not_recorded` (`error`) with the row concluded `failure`: nothing is sent to someone who said stop, whatever happens. |
| 13.9 | **The file** (**`:469`**, **`whatsappMediaInput.ts:96`** `saveInboundFile`). A tester's photo, video, document or voice note is downloaded with the connection's token, as soon as the job has it (Meta keeps it 7 days, the URL 5 minutes) and saved **privately** (`media_uploads.is_private`: never served by the public `/api/uploads/:id`), and `messages.media_upload_id` points at it so the erasure flow finds it with the contact. **In every mode** and while a person has the thread, and not on an `invalid` connection (no token). **A stranger's file is never downloaded**: the call sits behind `isTestSender`. A sticker, a location and a contact card are never downloaded (`unsupported_type`). A retried message whose row already holds the file is not downloaded again; a file that cannot be had (too large, expired, an unsupported type, no id) is `wa.media_not_saved` and the message is handled without it |
| 13.10 | **Words from a file, only when the agent will answer** (**`:475`**, **`whatsappMediaInput.ts:171`** `readInboundMedia`). The owner's own switch (`ai_agents.is_active`) is checked first (`agent_off`: nothing is transcribed, nothing is said). A photo, video or document **with a caption**: the caption is the message, answered as typed text (the model does not see the image). **A voice note** (**:193** `transcribeVoice`): `transcribeAudio` (**`services/transcribe.ts`**) from the private copy, language `ar`, Groq only (a provider that does not train on what it is sent; paid OpenAI stays off), the transcript stored as the row's `text` (`UPDATE messages SET text`), and the turn runs on it; a transcript that is itself a stop phrase is a stop (13.3). A retried voice note whose row holds a transcript is not sent to Groq again |
| 13.11 | **A voice note that cannot be read** (no file, a format Groq refuses, a **429**, a timeout, silence, no provider): **ONE line** asking for text, whatever the reason, never a retry (`wa.voice_unreadable` with the reason). **A file with no caption**: the same line, the kit's `attachments.media` in the owner's register. Both go through **Instagram's own claim** (`CLAIM_ACK`, **`attachmentAck.ts`**, exported for this): the outbound row is inserted FIRST and only when no later message of theirs is waiting, no words are being answered, and the line was not said within a day; a send that fails for good takes the claim back, a send that MAY have landed keeps it. The line carries the automated-service disclosure when it is the first thing said (`ai_disclosed_at` is stamped after). The row says NULL when the line went out, `superseded` when the claim was refused (`wa.media_ack_skipped`), else why it could not be sent (`window_closed`, `billable_blocked`, `connection_invalid`, `failure`) |

## 11. Ads: the money rule and the guard

The Ads Manager (`src/services/ads/`, README there) runs on Meta's **Limited** access tier: about 60 points per 5 minutes per ad
account, and a 300 s block past that. Every Marketing API call goes through one client with its own pinned version, and **one money
rule** decides everything that can start or raise spend. This section walks that rule from a click to Meta, and the hourly guard that
holds the cap after switch-on; §11.2 walks the stored copy every screen reads and the paced queue every write goes through.

### 11.1 — Money rule and guard

**A. Every ads request**

1. `/api/ads/*` is mounted below `resolveTenant` (`routes/api.ts:1663`). The router's first middleware, **`routes/ads.ts:83`**, answers
   **404 `ADS_DISABLED`** unless `ads.enabled.<tenant>` is `'true'` (the platform admin's switch, `routes/admin.ts`
   `POST /ads/tenants/:id/enabled`; migration v53 set it for every tenant that already had ads settings). It then runs the rest of the
   request inside `withAdsContext({ creatorId, adAccountId })` (**`ads/graph.ts`** `withAdsContext`), so every Graph call it makes is
   paced against that account.
2. Each Graph call — `adsGet` / `adsPost` / `adsDelete` — goes through
   **`ads/graph.ts:155`** `call`:
   - the version is `ads.api_version` (`adsApiVersion`, default `v26.0`, never below `v25.0`), **not** `META_API_VERSION`;
   - `reserve` (**`ads/pacer.ts:131`**) takes 1 point for a read, 3 for a write, from 45 of the 60 per 300 s; refused →
     `AdsGraphError('throttle', retryAt)` **without calling Meta** (`graph.ts:167`);
   - the answer's usage headers go to `observe` (Meta's `acc_id_util_pct` replaces our count); a `facebook-api-version` that is not the
     pinned one logs **`ads.version_mismatch`**;
   - an error is classified (`classifyAdsError`): a throttle blocks the account until Meta's `reset_time_duration` /
     `estimated_time_to_regain_access` (300 s default), logs **`ads.throttled`** with `retry_at` (`graph.ts:194`) and is thrown at once.
     `withRetry({ ads: true })` (**`http.ts:138`** `isAdsLimitError`) never retries a rate or edit limit.
3. The route turns it into the answer (`metaRefusal`, `adBoosts.ts`): throttle → **429 `RATE_LIMITED`** + `retryAt`; 613/1487632,
   613/4841018, 17/1885172 → 429 `EDIT_LIMIT`; 190/102 → **409 `TOKEN_INVALID`** (never 401, which signs the dashboard out), and the
   tenant's `ads.health` is marked dead with a `token_dead` alert.

**B. The rule (`ads/money.ts`, pure)**

`worstCase = spentThisMonth + Σ remainingThisMonth(ACTIVE campaigns) + aboutToRun + candidate ≤ monthlyCap` (`checkCandidate`,
**`money.ts:215`**). The month is the **ad account's** calendar month; a daily budget counts today at **1.75×** and each later day once
(`remainingThisMonth`, **`money.ts:156`**); a lifetime budget counts its whole unspent part. `remaining` = cap − the worst case without
a candidate, the one figure every screen shows (`GET /api/ads/money`, `moneyFor`, **`money.ts:531`**, cached 60 s per tenant). Figures
exclude tax.

**C. Activating a boost (the step that spends): `activateBoost`, **`adBoosts.ts:470`****

1. The daily max (`checkDailyMax`: a lifetime budget as `total / days`), the payment method, then the month **read live, outside any
   transaction** — `readMonth`, **`adBoosts.ts:486`** (spend this month + every campaign).
2. `checkAndStartSpend` (**`money.ts:466`**, called at **`adBoosts.ts:498`**): ONE short transaction that takes
   `pg_advisory_xact_lock(hashtextextended('ads:<tenant>', 0))` (`lockMoney`), sums what is about to run (`aboutToRun`, **`money.ts:397`**:
   pending and running spend ops, `verify` ones for a day, and `done` ones that finished after the month was read minus 2 minutes), re-runs
   the rule, re-reads the boost `FOR UPDATE`, writes `activated_at`, and inserts the activation as a **`running` `ads_ops` row** carrying
   `worst_case_delta`. Refused → **400 `OVER_MONTHLY_CAP`** with the numbers.
3. Since A2 the activation is **three ops** recorded inside that same transaction (`record`, **`money.ts:475`**, the boost's at
   **`adBoosts.ts:507`**): ad → ad set (its window starts now) → campaign LAST, each `depends_on` the one before, the campaign's carrying
   `worst_case_delta`. A pending op counts as about to run. After the commit `runRecorded` (**`adBoosts.ts:522`**) runs them inline, in
   order (§11.2 B); one left waiting is sent by the drain, a failed one is the refusal (`refusalOf`), and a create's or write's timeout is
   `verify` (§11.2 C), which keeps counting for a day.

> **Why this order.** v1 read Meta *inside* the locked transaction (up to 40 s of Graph retries holding a pooled connection and the
> lock). Reading first and recording the activation as a running op keeps the transaction to milliseconds and still lets a second
> activation racing this one see it (`ads/money.db.test.ts`).

A resume and a budget raise on a running campaign (the candidate is the *extra* worst case), from the Campaigns tab's `requestStatus` /
`requestBudget` (**`ads/actions.ts:154`**, **`:218`**), follow the same three steps.

**D. The guard: `runGuard`, **`ads/guard.ts:66`**, from every `/api/jobs/drain` (`routes/api.ts:418`, with the drain's deadline)**

1. For each tenant with `ads.enabled.<t>` (**`guard.ts:80`** `guardTenant`): skip if the last **successful** check (`ads.cap_checked`)
   was under an hour ago, or the last attempt (`ads.cap_attempt`) failed under 10 minutes ago. No token, account or cap → skip.
2. Write `ads.cap_attempt`, read the account, this month's spend and the campaigns; if `shouldPauseAll` (spent ≥ cap, or spent + one more
   day — daily budgets at 1.75× — > cap), `pauseAll` (**`guard.ts:143`**) pauses every ACTIVE campaign (also those made in Meta Ads
   Manager) as `priority` calls, marks matching boosts paused, writes the **`ads.cap_paused`** audit row (actor `system:ads-guard`) and
   sends the **`cap_paused`** alert.
3. Only then **`ads.cap_checked`** = now (**`guard.ts:114`**). A failure leaves it, so the next drain 10 minutes on tries again; a
   `token_dead` marks `ads.health` and alerts; two hours without a success raises **`guard_blind`** (**`guard.ts:126`**), and the Ads
   screen shows "Spending is not being watched" (`guardState` in `health.ts`).
4. Saving a cap at or below the month's spend (`POST /api/ads/settings`, **`routes/ads.ts:158`**) runs the guard for that tenant at once
   (`force`) and answers `warnings: ['will_pause_all']`.

**E. Alerts and the daily health check**

- `notifyAds` (**`ads/notify.ts:256`**) inserts the `ads_alerts` row first — unique `(tenant, kind, object, day)` in the account's time zone,
  so a second alert that day is not sent — then sends in the tenant's language to its own Telegram chat / email (`ads.alerts.<t>`, the
  deployment's bot and Resend key), a bilingual copy to the admin unless `ads.copy_admin` is `'false'`, and records each channel's
  outcome on the row. Never throws. `cap_paused`, `guard_blind`, `token_dead` cannot be switched off.
- `runAdsHealth` (**`ads/health.ts:157`**, from the daily cron, `routes/api.ts:1129`): per tenant `checkTenantHealth` (**`health.ts:115`**) —
  token (`debug_token` for a Connect token, `GET /me` for a pasted one), account status and funding, served version — written to
  `ads.health.<t>` (the stored copy the screens read) and turned into alerts; then the retention sweep (`ads_alerts` after a year,
  finished `ads_ops` after 180 days).


### 11.2 — Sync and ops: the stored copy and the paced queue

**A. Screens read the stored copy (research R2)**

1. `GET /api/ads/overview` → `readOverview` (**`ads/overview.ts:92`**): Postgres only. The account is the last health check's snapshot
   (`ads.health.<t>`), spend today and this month come from `ads_insights_daily` in the **ad account's** days (`spendFromMirror`), the
   money rule runs over the stored ACTIVE campaigns (`rawFromMirror`), plus "needs attention" (rejected, issues, billing, ops failed in
   the last day) and the queued ops. **No Graph call**, so a page view costs no points (v1 cost about 4 per view).
2. `GET /api/ads/objects` and `/objects/:id` (**`routes/adsObjects.ts`**, mounted by `mountObjectRoutes` at **`routes/ads.ts:547`**,
   after the `ADS_DISABLED` gate): `ads_objects` rows of the tenant's **current** ad account, each with 28 days of results
   (`resultsFor`: ad rows summed; **reach never summed across days**), the ad set's budget edits left this hour, and its open ops. Every
   `:id` goes through ONE resolver, `objectOf` (**`adsObjects.ts:104`**) → `ownObject` (**`ads/actions.ts:51`**): another tenant's row, or
   a row of an account the tenant switched away from, is 404 `NOT_FOUND`.

**B. Every write is an op (research R3)**

1. A button → `requestStatus` / `requestBudget` / `requestArchive` / `requestDelete` (**`ads/actions.ts`**). Pause, archive, a cut and an
   end date are enqueued as they are; switching on and raising run the money rule (§11.1 C) and are enqueued **inside** the locked
   transaction. Delete is its own confirmed op and is refused on an ACTIVE object; Boost's Delete now
   **archives**. Every op has an idempotency key (`<tenant>:<what>:<requestId or 10 s bucket>`): a double press returns the same op.
2. `enqueue` (**`ads/ops.ts:399`**): `INSERT … ON CONFLICT (idempotency_key) DO NOTHING`, audit `ads.op_enqueued`. The route answers
   **202 `{ op }`** at once and hands `runOpInline` to `waitUntil` (**`ops.ts:1023`**); Boost (`writeNow`, **`actions.ts:346`**)
   waits for it instead, so its answers keep their v1 shape.
3. `claimNext` (**`ops.ts:501`**), ONE short transaction: the oldest due `pending` op of the account whose dependency is `done` and with
   nothing `running`/`verify` on the same `object_key`, `FOR UPDATE SKIP LOCKED`. Meta's per-object limits come from the op history
   (`limitWaitUntil`, **`ops.ts:195`**): 4 `budget` ops per ad set per rolling hour, 30 s after the last `done` on the object, 10
   `spend_cap` per account per day in the account's zone. A limit pushes `not_before`; the op is not started.
4. `execute` (**`ops.ts:778`**) calls Meta **outside any transaction**, every call through ONE function, `sendExec` (**`ops.ts:641`**),
   inside the tenant's Graph context (pacer, §11.1 A.2). A create's name gets `AR·<op id>`. The outcome (`outcomeFor`, **`ops.ts:258`**)
   is recorded in a second short transaction, audit `ads.op_applied` / `ads.op_failed`:
   - done → the stored row is updated at once (status, budget, a create's `meta_id`);
   - **throttle** → back to `pending` with `not_before` = Meta's reset (the pacer already blocked the account): **never retried in a loop**;
   - 613/1487632 (4 budget edits this hour) → +1 h; 613/4841018 (busy) → +30 s; 17/1885172 (10 spend-cap changes) → `failed` `EDIT_LIMIT`;
   - 190/102 → `failed` `TOKEN_INVALID`; the drain stops the account for this run, and A1's dead token (`isQueueStopped`,
     **`ops.ts:621`**) keeps the tenant's queue stopped until a new token is saved;
   - a timeout or 5xx on a create → **`verify`**.

**C. Never create twice (research R6)**

`verify` (**`ops.ts:875`**, `nextVerifyStep` **`:309`**): a create in `verify` searches its parent edge for the `AR·<op id>` tag. Found →
`done`, its id adopted. Not found → checked again 60 s later; not found twice → `pending`, **resent exactly once** with the same tag; not
found again → `failed`. A non-create write in `verify` reads the object back and compares. An op written by A1's synchronous path (no
`exec`) is never sent: it fails after a day. `reap` (**`ops.ts:909`**): `running` for over 5 minutes → `verify` (creates) or `pending`.

**D. The drain and the cron**

1. `/api/jobs/drain` (**`routes/api.ts:439`**), after the guard so the guard is never starved of points: `drainAdsOps(deadline)`
   (**`ops.ts:943`**: reap, then every account with something due, skipping one Meta has blocked), then `syncAllAds(deadline)`
   (**`ads/sync.ts:793`**, **`api.ts:441`**): per enabled tenant, the **structure** hourly (`syncStructure`, **`sync.ts:543`**: one paged
   `GET act_<id>/campaigns` with nested ad sets, ads and creatives; `parseStructure` **`:167`**; `upsertObjects` **`mirror.ts:255`**
   keeps `origin` and `app_meta`, so a Boost's rows stay `boost` and new ones carrying a boost id in their name are linked to it), and
   **today's results** every 4 h or on request (`syncInsights(…, 'today')`, **`sync.ts:697`**; `upsertInsights` **`mirror.ts:411`**).
   Each sync is skipped when the pacer cannot spend, and stops at a throttle.
2. Right after the rows are stored, never inside a transaction, an ad that was already in the stored copy and has just moved into
   `DISAPPROVED` or `WITH_ISSUES` raises `ad_rejected` or `ad_issues` (`raiseAdStatusAlerts`, `src/services/ads/adStatusAlerts.ts`; the state
   before comes back from the upsert statement itself, `upsertObjects` in `src/services/ads/mirror.ts`). A row met for the first time never
   alerts. The count is `status_alerts` in the `ads.sync_structure` log line.
3. A row missing from a COMPLETE structure read twice in a row is marked `DELETED` (`markMissing`, **`mirror.ts:369`**); a read cut
   short (a page not read, a nested edge with a next page) marks nothing.
4. The daily cron (**`api.ts:1149`**): `syncDailyAds` (**`sync.ts:815`**), the trailing **28 days** at `level=ad` (an async report
   when the range is large, resumed next time) plus level=campaign/account reach, and the **country** and **placement** breakdowns into
   `ads_insights_breakdown` (`upsertBreakdowns`, **`mirror.ts:477`**). The last 3 days are `provisional`. `runAdsHealth` deletes results
   older than **37 months** (**`ads/health.ts:178`**).
5. `POST /api/ads/sync` (Refresh results): the structure, then today's results, once per 15 minutes (`requestTodaySync`, **`sync.ts:756`**, else 429 `RATE_LIMITED` +
   `retryAt`), run under `waitUntil`; the drain is the backstop.

**E. Disconnecting deletes the stored copy**

Removing the token, choosing another ad account (`saveAdsSettings`, **`ads/settings.ts:188`**) or disconnecting Meta with a Connect token
(`forgetConnectedAdsAccess`) calls `forgetStoredCopy` (**`mirror.ts:915`**): `ads_objects`, `ads_insights_daily` and
`ads_insights_breakdown` for the tenant are deleted, and pending ops are cancelled. The op history stays for its 180 days.

### 11.3 — Create: spec → ops → Meta (A4: message ads and the policy check)

Every ad the app makes is one `CampaignSpec` (contracts/dashboard-api.md), mapped by ONE pure function to Graph parameters. The
builder's quick mode and Boost's "Send messages" preset end in the same two server functions, so they cannot drift apart.

**A. Quick mode** (`dashboard/js/pages/ads_builder.js`, `AdsBuilder.openQuick`). The Scheduler's **Boost** (`posts.js` `boostOpen`,
**`posts.js:3826`**) loads the module on demand (page registry `ads_builder`, `routable: false`); a module that cannot load says so (the older
Boost form was removed in A5). The owner picks the goal (Send messages first), the destinations, countries, daily budget × days, the greeting and up to
four ice breakers; the post's caption is shown read-only because it IS the ad text. What is left of the month comes from `GET /money`,
asked once when the dialog opens.

**B. The policy check while typing.** `POST /api/ads/policy` (**`routes/ads.ts:427`**, operator) → `checkPolicy` (**`ads/policy.ts:550`**):
pure, no Meta call, nothing stored, asked 400 ms after the typing stops. The text is folded first (tatweel, alef forms, diacritics,
Arabic-Indic digits, zero-width characters), matched by versioned rules (`POLICY_VERSION`), and every finding's `[start, end)` is mapped
back onto the ORIGINAL text, so the dialog wraps exactly those characters in `<mark>`.

**C. Review: `POST /api/ads/drafts/validate`** (**`routes/ads.ts:441`**, operator) → `validateDraft` (**`ads/drafts.ts:317`**). Creates
nothing. In order:
1. `validateSpec` (`spec.ts`): shape and limits (greeting ≤ 300, ≤ 4 ice breakers, title ≤ 80, answer ≤ 300), special-category rules,
   `leads` and a Facebook post for a message ad refused `UNSUPPORTED` (`FB_POST_MESSENGER_OK = false` until the live check, T094).
2. The facts (`readFacts`): the stored account (currency), the Page and IG ids, the post's caption **from `scheduled_posts`**, never the
   browser's, the WhatsApp number, the DM assistant and the WhatsApp agent modes.
3. `checkPolicy` over the caption, the greeting and the ice breakers.
4. `mapSpec` (**`spec.ts:535`**) with a placeholder link, so a mapping that cannot be made (no WhatsApp number, no IG account) is a problem.
5. The money rule: `moneyFor` with the candidate `lifetime:<total>:<days>` (the same rule as `GET /money`, §11.1), and Meta's minimum
   (`GET act_<id>/minimum_budgets`, cached a day per account, else the account's `min_daily_budget`).
6. Only when nothing above blocks: `execution_options=['validate_only']` on the **campaign and every creative** (`metaValidate`,
   **`drafts.ts:282`**, 3 points each). The creative is where a message ad's mapping is proved (CTA, greeting, opt-outs). A throttle answers
   429 `RATE_LIMITED`; any other refusal is Meta's message in `meta.error`.
7. The bots: per destination `on | off | test | sales_test | not_connected` (`botStates`). A warning, never a block.

**D. Create: `POST /api/ads/drafts`** (**`routes/ads.ts:464`**, owner) → `createDraft` (**`drafts.ts:437`**). The server trusts nothing
from Review:
1. `validateSpec`, the facts, `checkPolicy` again. A block → **422 `POLICY_BLOCKED`** with `findings`; a warning without
   `confirmPolicyWarnings: true` → **409 `POLICY_WARNINGS`** with `findings`. This is the gate before any create op.
2. `moneyFor` again: `OVER_MONTHLY_CAP` / `OVER_DAILY_MAX` (409), `ADS_NOT_CONFIGURED`; Meta's minimum: `BELOW_META_MINIMUM` (400). The
   draft spends nothing; the money rule runs once more at Activate, which is what spends.
3. ONE transaction, no Graph call in it: the stored copy (`ads_objects`: campaign, ad set(s), and per ad its ad and its creative, origin
   `app` or `boost`, status `PAUSED`, `app_meta` = goal, destinations, greeting, ice breakers, offer, post, `refShort`, policy version);
   a tracked link per (ad, offer) when the ad links to an offer (`mintAdLink`, **`links.ts:176`**, in the same transaction: its foreign key
   names the new ad row); then the chain of create ops, each `depends_on` the one before: campaign → ad set(s) → creative → ad (→ the
   next creative → ad). An op names the ids it needs from earlier ops as `{op:<op id>}` in its params; `execute` fills them from those
   ops' results (`resolveParams`, **`ops.ts:687`**) and fails the op without calling Meta when one is missing.
4. After the commit the chain runs inline under `waitUntil`, one op after another (`runOpInline`); the drain finishes the rest (§11.2 B).
   Each create's name gets `AR·<op id>` when it is sent, and a timeout is settled by `verify` (§11.2 C). Answer: **201 `{ campaignId,
   ops }`**. The dialog says the ad is PAUSED and links to the Ads screen, where Activate is a confirmed status op.

**E. Boost "Send messages" is a preset.** `POST /api/ads/boosts` with `objective: 'MESSAGES'` (or `goal: 'messages'`) → `boostMessages`
(**`routes/ads.ts:470`**) → `boostToSpec` (**`spec.ts:848`**: a lifetime budget of daily × days on the ad set, one country, age 18+,
Advantage+ audience) → step D with origin `boost`. The v1 objectives (engagement, reach, link clicks) keep v1's synchronous path and
`ad_boosts`.

**F. Results the app can count and Meta cannot.** `trackedClicksFor` (**`ads/mirror.ts:832`**), on every ad row of `/objects`:
`direct` = people's clicks (`link_clicks.is_prefetch = FALSE`) on the ad's own `/r/` link (`tracked_links.ads_object_id`), `viaChat` =
people's clicks on links the bot sent in conversations the ad started (`conversations.entry_source->>'ad_id'`).

**G. Where it can silently do nothing**
- The policy check passes a text it has no rule for: it is a lint, not Meta's reviewer. A missed pattern is added to `policy.ts` and
  `POLICY_VERSION` bumped; never special-cased in a route.
- The bot warning is ignored and Activate works anyway: people message and nobody answers (or nobody is sold to, in sales test mode).
- The chain stops part way (a dead token, a Meta refusal on the ad set): the campaign exists at Meta, PAUSED, with nothing under it.
  The failed op says why in `ads_ops.result`; the later ops fail `DEPENDENCY_FAILED`. Nothing spends.
- A boosted post carries NO greeting or ice breakers (`POST_GREETING_PLACEMENT = 'omit'`): live check 2026-10-22, Meta refuses
  `page_welcome_message` in the call to action's value and documents no other place on a post creative. The chat opens with Meta's
  greeting; quick mode hides the fields (`GREETING_ON_POST: false`). Uploaded-media ads (A5) carry them under `link_data`/`video_data`.

### 11.4 — The full builder: upload → Meta → spec → ops (A5)

The Ads screen's **Create** tab (`dashboard/js/pages/ads_create.js`, `AdsCreatePage`) is the same `CampaignSpec` as quick mode (§11.3),
every part of it, in eight steps: goal, destination, creative, text, audience, placements, budget and schedule, review. Review and Create
are §11.3 C and D unchanged; what A5 adds is below.

**A. An upload never passes through the app.** `POST /api/ads/uploads/sign` (**`routes/ads.ts:499`**, owner) → `signAdUpload`
(**`ads/adUploads.ts:74`**): type and size first (JPG/PNG ≤ 30 MB, MP4/MOV ≤ 50 MB), then a Supabase signed upload URL (the Monteur's
mechanism), then a PUBLIC metadata-only `media_uploads` row. The browser PUTs the file to Storage itself (XHR, progress bar), so Vercel's
4.5 MB request limit never applies. CSP: `connect-src https://*.supabase.co` (`vercel.json`, `routes/api.ts` `securityHeaders`).

**B. Handed to Meta.** `POST /api/ads/creatives/from-media` (**`routes/ads.ts:509`**, owner) → `prepareMedia` (**`ads/adMedia.ts:69`**):
the upload must be the tenant's and of the kind claimed; an image's bytes go to `act_<id>/adimages` (base64 → `image_hash`); a video goes
to `act_<id>/advideos` with `file_url = <public base>/api/uploads/<id>` (Meta pulls it; its bytes are never read here) and needs a cover
image, whose public address becomes the video's `image_url` (frame 0 is black). The answer is stored in `ads.media.<tenant>` (newest
200). Not an `ads_ops` row: neither call answers an object the queue could verify by its name tag; both still go through `ads/graph.ts`
(paced, a throttle never retried).

**C. Resolved at Review and Create.** `readFacts` calls `resolveSpecMedia` (**`ads/adMedia.ts:114`**): every media id of the spec (main,
9:16, covers) must have a stored Meta answer; a video not yet `ready` is read once (`GET /<video id>?fields=status`, 1 point) and stored
when it changes. Not handed to Meta, still processing or failed → a problem in Review, a 400/409 (`VIDEO_PROCESSING`) at Create; nothing
is created.

**D. The mapping additions** (`spec.ts`, pure): per-goal optimisation choices (`OPTIMIZATION_CHOICES`); only the offered positions
(`PLACEMENT_OPTIONS`; Explore, video feeds and Messenger Stories refused `UNSUPPORTED`); day parting `adset_schedule` + `pacing_type:
['day_parting']`, in whole hours, viewer's time zone, only with a lifetime budget (`validateSchedule`, **`spec.ts:400`**); a special
category forbids interests too, and `political` is refused; the 9:16 version (**`spec.ts:801`**): link-click ads only, same kind as the
main asset, `asset_feed_spec` from `placementAssetFeed` (**`ads/creatives.ts:79`**: labelled assets, `optimization_type: PLACEMENT`, a feed
rule and a vertical rule — Stories only while `REELS_CUSTOMISATION_LIVE_CHECKED` is false) with the story spec reduced to the Page and the
Instagram account, the opt-outs kept (`CREATIVE_OPT_OUTS`: the four keys Meta allows, live-checked).

**E. What Review adds.** After Meta's `validate_only` (§11.3 C 6): `reachEstimate` (**`ads/targetingSearch.ts:90`**, `act/reachestimate`
on the first ad set's targeting, never throws) and, only when Meta accepted the draft, `generatePreviews` (**`ads/creatives.ts:238`**) for
the two placements `previewPlacements` picks (**`drafts.ts:375`**). A preview Meta will not give is `html: null` and the dashboard draws
its approximate mock; an iframe is shown only from `www.facebook.com` (CSP `frame-src`). About 2 more points per Review.

**F. Targeting search.** `GET /api/ads/targeting/search?type=adinterest|adgeolocation|adlocale&q=` (**`routes/ads.ts:520`**, operator):
`GET /search` (cities only for places), cached 24 h per query in the instance; a miss is 1 point through the pacer.
`GET /api/ads/minimum-budgets` (**`routes/ads.ts:531`**) is drafts' one floor for every goal.

**G. Duplicate.** `POST /api/ads/objects/:id/duplicate` (**`routes/adsObjects.ts:178`**, owner) → `requestDuplicate`
(**`ads/actions.ts:322`**): one `update` op on `<meta id>/copies` with `status_option: PAUSED`, `deep_copy` (never for an ad) and
` · copy AR·<key>` added to every name. The sync brings the copy into the stored copy. Nothing spends until it is switched on.

**H. Where it can silently do nothing**
- The system user has no Page / Instagram asset: Meta refuses the creative at Review (`meta.ok: false`) and previews come back empty
  (the mock is drawn). Nothing is created.
- A video Meta never finishes processing stays "still processing" in Review; the owner uploads it again.
- The Storage project on a custom domain: the browser's PUT is blocked by the CSP and the upload says it failed.
- `ads.media.<tenant>` keeps 200 uploads; an older one is refused at Review ("upload it again").

### 11.5 — Managed clients: one tenant, its own token, its own account (A11)

Until Meta verifies the platform's business, every client tenant connects with a **system-user token from its own Meta business**,
its own ad account and its own payment method; Meta bills the client, never the platform.

1. The platform admin opens **Client ads** (`#/admin_ads`, `dashboard/js/pages/admin_ads.js`), sets the tenant's ceiling
   (`POST /api/admin/ads/tenants/:id/ceiling`, A1) and switches ads on (`…/enabled`; 409 `CEILING_REQUIRED` without a ceiling).
2. The client's owner follows Help → Ads → **For managed clients** (`ads#for-clients`), pastes the token, tests it, sets limits.
   `POST /api/ads/settings` refuses a limit above the ceiling with `OVER_CEILING`.
3. **Overview.** `GET /api/admin/ads/tenants` (`src/routes/adminAds.ts` → `src/services/ads/tenantsOverview.ts`) reads Postgres only:
   the switch, ceiling and last health check from `app_settings` (the token row is selected as NULL: only its presence is read),
   this month's spend from `ads_insights_daily` account rows in the account's own month and time zone, and `ads_alerts` of the last
   7 days. It always shows **cap use as a percentage**; the amounts (`spend`, and the monthly cap with them) only when the client's
   owner turned on `ads.share_spend.<t>` (`GET/POST /api/ads/settings/share-spend`, `src/routes/adsShareSpend.ts`, audited
   `ads.share_spend_changed`). Sign-offs are `null` until A8's `ads_legal_signoffs` exists.
4. **Isolation** (`src/services/ads/ownership.ts`). Every `:id` route resolves through `actions.ownObject`: the tenant's own row in its
   current ad account, else `ownership.ownObject` says whose it is: another tenant's (or an old account's) object is 403
   `NOT_OWN_OBJECT`, logged `ads.not_own_object` and audited; an id nobody has is 404. Every send of a queued op goes through
   `ops.sendExec` → `deps.checkTarget` → `assertOpTarget`: the op's account must still be the tenant's, `act_<id>/…` must be that
   account, and `<metaId>` must not be another tenant's or another account's stored object. `src/services/ads/isolation.test.ts`
   also scans every SQL statement on an `ads_*` table for `creator_id`.

### 11.6 — Rules: a condition on the stored copy → a protective op, or a proposal (A9)

The owner's standing conditions (`src/services/ads/rulesEval.ts` pure, `rules.ts` the pass, `rulesWiring.ts` the reach into the rest,
`rulesStore.ts` the tables; routes `src/routes/adsRules.ts`; screen `#/ads_rules`). **Our own evaluator, not Meta's `adrules_library`**:
Meta's rules cannot ask for approval, cannot see our monthly cap or alerts, and its `CHANGE_BUDGET` would bypass the money rule and the
4-budget-changes-an-hour accounting (research R14). The cost: a rule runs only when our drain does, which is every minute; the cap guard
(§11.1) stays the hard safety net either way.

1. **Save = approve.** `POST /api/ads/rules` (owner) → `parseRuleSpec` (**`rulesEval.ts:73`**: ≤ 5 conditions over spend, results, cost
   per result, cost per conversation, CTR, CPM, frequency (today only, campaigns or ads: reach is not additive), spending pace (campaigns
   and ad sets), rejected (notify only); windows today / 3d / 7d, each including today in the account's zone; a rule protects OR raises,
   never both) → `createRule` sets `approved_by` = the saver, `approved_at` = now, audited `ads.rule_saved`. A PATCH that changes the rule
   validates the whole rule after the change and re-approves it.
2. **Due.** The drain (**`routes/api.ts:432`**, after the guard, before the ops queue) calls `evaluateDueRules`
   (**`rulesWiring.ts:184`**): `dueRules` (**`rulesStore.ts:210`**) = enabled, approved, no run in the last 55 minutes; grouped by tenant
   until the drain's deadline.
3. **The account** (`account`, **`rulesWiring.ts:46`**): ads on, configured, token not dead, a stored account snapshot (currency, UTC
   offset, Meta's minimum daily budget). Otherwise every due rule records a `blind` run with the reason and nothing else happens.
4. **Order.** `evaluateTenantRules` (**`rules.ts:77`**) runs pause rules, then lower, then notify-only, then raise/resume ones, sharing
   one `taken` set: **one action per object per evaluation**, and a protective rule claims an object first.
5. **Fresh numbers or nothing** (`freshness`, **`rules.ts:128`**): today's rows older than 2 h (`sync.ts` `todayAt`) are read again once
   per tenant per pass (`syncInsights(…, 'today')` within the pacer, 20 s). Refused (pacer/throttle) or failed and still stale: the rule
   records `blind` (`throttled` / `stale`) and does not judge on old numbers.
6. **Judge** (`planRule`, **`rulesEval.ts:388`**, over `evaluateObject` **`:309`**): the stored objects of the scope (`listObjects`;
   a resume rule looks at PAUSED ones, a rejected-ad rule at every live one, the rest at delivering ones), the window totals from
   `resultsFor`, "results" by the object's optimisation goal (`resultOf`). Below `min_data` = no data; all conditions must hold; money
   spent with nothing bought is an infinite cost. Skips are recorded per object: `busy` (an op already queued on it), `already_paused`,
   `no_budget` (no daily budget of its own), `at_minimum` (a cut never goes under Meta's minimum), `edit_limit` (`editsLeftThisHour`:
   Meta's 4 an hour per ad set), `cooldown` (this rule acted on it in the last 24 h, `recentlyActed` **`rulesStore.ts:241`**), `taken`.
7. **Act.** Pause / lower budget → `enqueue` (**`rulesWiring.ts:105`**) → `actions.enqueueWrite` (kind `status` / `budget`, actor
   `{ userId: null, via: 'rule' }`, idempotency key per rule, object and hour, so a second drain in the hour finds the same op), audited
   `ads.rule_acted`; `drainAdsOps` sends it in the same drain. Raise / resume → **one** `ads_proposals` row per run (`propose`,
   **`rulesWiring.ts:125`**: kind `rule_raise`, source `rule`, state `open`, a review item over every matched object). Nothing raises
   spend until the owner approves it in Proposals (§7.5): `approveProposal` re-runs the checks and `applyChange` sends a raise through
   `requestBudget` (confirm + the money rule) and a resume through `requestStatus('ACTIVE')` (**`proposals/ports.ts:180`**).
8. **Tell.** Every object something happened to (changed, proposed, or a "tell me") → one `rule_acted` alert (`notifyAds`, deduped per
   rule and object a day by `ads_alerts`).
9. **Record.** Every evaluation writes an `ads_rule_runs` row (`recordRun`, **`rulesStore.ts:231`**): `acted` (an op or an alert),
   `proposed`, `ok`, `skipped_no_data` (objects to watch, none with enough data) or `blind` (`matched` = `{ reason }`). Only `ok`, `acted`
   and `proposed` move `last_ok_at`. **24 h** without one (since the approval if never) → `rule_blind` (**`rules.ts:116`**), once a day.
   Rows are kept 90 days (`health.ts` retention sweep).

## 12. Ads → conversation → results (Meta Ads Manager, A3)

A person taps a click-to-message ad and writes. The app records which ad brought them, shows it in the Inbox, counts what came of it per ad, and (only if the
owner switches each on) tells the bot about the ad and uses Meta's longer reply window. Meta's own numbers for the ad come from the stored copy (the ads core,
v53); this flow is what Meta cannot see. The DM half of it is §2.2, §2.4b, §2.6b, §2.6c and §2.9; this section is the whole path in one place. Line numbers
are left out on purpose while A3 is being wired: every step names its function.

### 12.1 — The click arrives

1. **The subscription.** `WEBHOOK_FIELDS` (**`src/services/metaLogin.ts`**) is `feed, messages, messaging_postbacks` and now `messaging_referrals`. Without the
   last, Meta never sends the Messenger referrals below.
2. **Three shapes** (all through `POST /webhook`, signature unchanged, then a `dm.process` job; `contracts/webhook-inbound.md`):
   - **Instagram click-to-Direct**: `message.referral` on the person's first message.
   - **Messenger click-to-Messenger, a new thread**: `postback.referral` on the greeting or an ice-breaker postback.
   - **Messenger, an existing thread**: a standalone `referral` event, no `message`, no `postback`.
   Each carries `{ ref?, ad_id, source: 'ADS', type: 'OPEN_THREAD', ads_context_data: { ad_title, photo_url?, video_url?, post_id? } }`.
3. **The router accepts the standalone one** (`isActionableMessagingEvent`, **`router.ts`**, only when `source` is `ADS`), with its own dedupe key
   (`dmref:…`, §2.1). It used to be dropped.
4. **`normalizeDm` returns `adSource`** (§2.2) and `recordAdTouch` writes it (§2.4b): the first touch is the conversation's `entry_source` (`kind: 'ctm'`), never
   rewritten; later ones go to `ad_touches`. A referral with no words ends the job as `ad_referral_recorded` and sends nothing.
5. **WhatsApp is a different shape and the same idea.** A click-to-WhatsApp message carries `referral.source_id` (the ad's id), `ctwa_clid` and
   `headline`; **`src/webhook/whatsapp.ts`** `entrySourceOf` stores them as `entry_source` `{ kind: 'ctwa', ad_id: source_id, … }` (v50, §10.13). It is
   not `ctm`: no touches, no bot context, no extended window (WhatsApp's free-reply rules are §10.9).

### 12.2 — What the bot does with it (two switches, both OFF)

Both are the owner's, per tenant, on Settings → Meta ads (`POST /api/ads/settings/switches`, **`src/services/ads/switches.ts`**). Every read fails toward OFF:
a database that is behind, or a value that does not parse, is the switch off.

1. **`ads.bot_context.<t>`** (`'on'` or absent). On: the sales turn's facts block says which ad the person came from (§2.6b). Off: the prompt is byte for
   byte what it was (golden tests).
2. **`ads.extended_window.<t>`** (`{instagram, messenger}`). On for a platform: a `ctm` conversation from that platform may be written to until the later of
   their last message + 23 h and the click + 7 d − 1 h, instead of 23 h from their last message (`windowFor`, `windowEndsAt`, §2.6c). **Turned on only after the
   live day-2 check** (a real ad conversation written to on day 2 and again past day 3, on each platform). A send Meta refuses for the window turns that platform
   off by itself and raises `window_error` (§2.9).
3. **Business AI** is not a switch: when Meta's own AI holds an Instagram thread the bot is silent, and the conversation says why (§2.9).

### 12.3 — The join, at read time

The stored conversation holds only what Meta sent (`ad_id`, `ref`, the title and media links, `at`). Whatever shows an ad's name or counts its results joins then:

1. **By our own `ref` first.** An ad the app creates carries `ar_<12 hex of ads_objects.id>` (`refFor`, `refPrefix`), so it joins before the mirror has Meta's id for it.
2. **Then by `ad_id`** against `ads_objects.meta_id` at level `ad` (`joinAd`). An ad made in Meta's own Ads Manager joins after the next sync; until then the
   conversation keeps the raw `ad_id`, and the chip shows the title Meta sent. A database without the ads core (v53) answers null, never an error.
3. **The Inbox** (`adNamesFor`): the "from ad" chip on a `ctm` or `ctwa` conversation, an Ads filter on the list, and the Business AI notice from `no_reply_reason`.
   A conversation with only later `ad_touches` shows "Came back from an ad" and is kept by the Ads filter too.

### 12.4 — Results per ad

`resultsByAd` (**`attribution.ts`**), one statement over the v54 partial index `(creator_id, entry_source->>'ad_id')`, for the ads the Ads screen is showing
(`ObjectView.results`): per Meta ad id, **conversations** (distinct, Instagram, Messenger and WhatsApp alike, since `ctwa` joins by `ad_id = source_id`),
**tracked-link clicks** by a person (`link_clicks.is_prefetch = false`, through `tracked_links.conversation_id`) and **handoffs** (`handoff_at` set). Only the
first touch counts: a conversation belongs to the ad that started it. A failure is no results (`ads.results_unreadable`), never an error on the screen.

> **Why the first touch is never rewritten.** A person who taps three ads in a week is one conversation, and the sale is owed to the ad that opened it.
> Overwriting would move credit to whichever ad they saw last and make an old ad's results shrink as people re-engage; `ad_touches` keeps the later ones for the
> Inbox without crediting them.

### 12.5 — Rollout and what can go wrong

`npm run migrate` (v54: `ad_touches`, `no_reply_reason`, the index) **before** the deploy: the DM path writes `ad_touches` and the Inbox reads both columns.
The two switches ship dark. The ads spec's webhook contract and research note R10 (local planning documents, not in this repo) define them; the Help Center article `ads`
(sections `message-ads-inbox`, `bot-and-ads`, `reply-window`, `business-ai`) is what the owner reads.

### 12.6 — Results history: the day-by-day joins (A6)

What the Results tab (`#/ads_results`), Growth's paid card and the Results screen's ad rows read. **Postgres only**: no hop below calls Meta.

1. **Stored by the sync (§11.2).** The daily job re-reads the trailing 28 days at `level=ad`, `time_increment=1`, in the **ad account's** time zone, into
   `ads_insights_daily`, and the same days split by `country` and by `publisher_platform,platform_position` into `ads_insights_breakdown` (key `EG`,
   `instagram:reels`). Rows of the last 3 days are `provisional`. Campaign and account rows hold only their own reach and spend.
2. **`GET /api/ads/results`** (**`routes/adsResults.ts`**, mounted inside `adsRouter` after the `ADS_DISABLED` gate; any member) → `getAdsResults`
   (**`ads/results.ts`**): reads `ads_objects` (names, parents, goals) and the `ad` rows for the window; a campaign, ad set or account figure is the
   **sum of its ads**, walked up `ads_objects.parent_id`. Reach is never summed: it comes only from a row at the asked level. Each ad's `results` is the
   metric its ad set was bought for (`resultKindOf`: conversations, link clicks, leads or follows), so a mixed campaign adds one of each. Money stays per
   currency (`totals.byCurrency`); `currency` is null when there are two.
3. **The app's own joins**, per day in the account's zone (`clicked_at AT TIME ZONE <tz>`; the zone is the stored account check's), people's clicks only
   (`link_clicks.is_prefetch = false`), the same definitions as A4's `trackedClicksFor` and A3's `resultsByAd` but cut by day:
   - **direct**: `tracked_links.ads_object_id` = the ad's `ads_objects.id` → `link_clicks`;
   - **via chat**: `conversations.entry_source->>'ad_id'` = the ad's Meta id → `tracked_links.conversation_id` → `link_clicks` (a link that already
     points at an ad is not counted again);
   - **hand-offs**: the same conversations with `handoff_at` in the window.
   A breakdown answer splits Meta's numbers only: a click has no country or placement, so the joins stay per ad.
4. **Screens.** The Results tab draws spend, results and the three costs per day (provisional days shaded), compares by ad / country / placement, and
   lists every ad. Growth's `GET /api/growth/overview` gains `paid` (**`growth/paid.ts`**, an account-level read of the same answer, one currency). The
   Results screen (`#/analytics`) adds one row per running or spending ad, labelled "Ad", under the DM campaigns; a failure there hides the rows silently.
   Every spend figure says it excludes tax. **No sales-based figure exists anywhere** (`src/dashboard/no-roas.test.ts`): sales happen on another website (for the owner, Udemy).

## 13. Explainers: topic → script → voice → pictures → render → schedule

An owner gives a topic and the app makes a narrated video of it: one still picture per sentence, a recurring cartoon character, a short label on some pictures, a 9:16 video, a 16:9 video and a cover, then posts. **Claude on the owner's Mac** researches the topic on the web and writes the script; the Mac voices it; **the server draws the pictures**, from a free daily allowance; the Mac renders; Schedule writes `scheduled_posts` rows that the usual sweeps publish ([flow 3](#3-scheduled-post--publish), [flow 6](#6-tiktok-post--inbox--published)). It is **owner-only and dark by default** ([13.1](#131--the-switch-and-who-may-ask)), and two steps are the owner's: he approves the script before anything is voiced (gate 1) and the pictures before anything is rendered (gate 2). The contract (tables, payloads, settings, routes) is STUDIO.md §11.

Code: `src/services/explainers/` (`explainers.ts` the lifecycle the routes call, `state.ts` the status machine, `apply.ts` what a job's result does, `writing.ts` and `writerGemini.ts` who writes, `scenes.ts` and `pictures/` the drawing, `schedule.ts` the posts, `spec.ts` the rules a script is held to, `payloads.ts` the Mac jobs' payloads), the routes in `src/routes/studio.ts` and `src/routes/adminExplainers.ts`, and migration v59 (`src/config/migration_v59_explainers.sql`). The Mac's half is the other repo's: aicourse-captions `scripts/studio/explainerWrite.mjs`, `explainerVoice.mjs` (with `tts.mjs`), `explainerDraw.mjs`, `explainerRender.mjs` (with `audioMix.mjs`) and the compositions in `src/illustrated/`.

```
writing ─writer result→ draft ─approve (gate 1)→ voicing ─voice result→ drawing ─no scene left to draw→ review
   ↑                      │                                                                               │
   └──── rewrite ─────────┘                                                                approve pictures (gate 2)
                                                                                                          ↓
                                              scheduled ←─ schedule ─ ready ←─ render result ─ rendering
                                                                       │  ↑
                                                                       └──┘ render again
 any running step ─its job fails or is refused→ failed (failed_step, error) ─retry→ the state that step runs in
 a narration edit after voicing makes the audio stale: drawing, review or ready may then go back to voicing (re-voice)
```

**`transitionExplainer`** (**`src/services/explainers/state.ts:117`**) is the only code that writes `explainers.status`. It locks the row (**:124-126**), requires the row to be in one of the states the *caller's* action is for **and** the move to be in the table (`canMove`, **:68**, checked at **:131**; otherwise 409 `EXPLAINER_BAD_STATE` and nothing is written), and clears `failed_step` and `error` when it moves on unless the move writes new ones (**:144-147**), so a failure or a pause note never outlives the state it was about.

> **One rule runs through every hop: a job's result is applied only if the job is `explainers.job_id`.**
> A step that queues a job writes `job_id` in the same transaction as its move, on the explainer's row lock (the header of **`src/services/explainers/explainers.ts:16-18`**), and `lockCurrent` (**`src/services/explainers/apply.ts:77`**) re-reads the row under the same lock when a result arrives. So a rewrite, a re-voice, a restart of the drawing, a re-render and a delete never meet the old job's answer half-applied: it finds another `job_id`, or no row, and is dropped. The drop is logged and the owner is told nothing ([13.6](#136--applying-a-draft)). It is the rule an infographic's render follows too (`applyInfographicRender`, **`src/services/studio/jobs.ts:1124`**), and it is why a takeover by Gemini ([13.5](#135--gemini-steps-in-and-when-it-never-does)) only has to change one column.

### 13.1 — The switch, and who may ask

Every dashboard route of the feature is wrapped in `explainerRoute` (**`src/routes/studio.ts:543`**). It asks `isExplainersEnabled(getTenantId(req))` first (**`studio.ts:545`**; defined at **`src/services/explainers/switch.ts:28`**: the app setting `explainers.enabled.<tenant id>` is the value `true` and nothing else) and answers **404 `EXPLAINERS_DISABLED`** without it. The role comes from the router's own guard, operator and up (`studioRouter.use(canOperate)`, **`studio.ts:280`**); only `POST /explainers/uploads/sign` (a music track, a character's reference picture) is owner-only (**`studio.ts:578`**). The switch is read inside the handler, not in a middleware, so a test that takes a handler off the router runs it too (**`studio.ts:539-540`**).

The switch can be turned **on for the platform owner only**. `setExplainersEnabled` (**`switch.ts:37`**) is the one writer of the key and refuses any other tenant with 409 `EXPLAINERS_OWNER_ONLY` (**`switch.ts:40-41`**: the owner is `getPlatformOwnerId()`, and with no owner nobody can be switched on). Turning one **off** is never refused. Its route is `PUT /api/admin/explainers/enabled` (**`src/routes/adminExplainers.ts:142`**), platform admin only, 404 for anyone else (**`adminExplainers.ts:41`**).

**The worker's `draw-next` route is not behind the switch.** A worker token reaches it (`requireWorker`, **`studio.ts:178`**) and it refuses by its `job_id` instead ([13.10](#1310--drawing-the-servers-loop-and-the-allowance)).

### 13.2 — Create: `POST /api/studio/explainers`

**`src/routes/studio.ts:559`** → `createExplainer` (**`src/services/explainers/explainers.ts:332`**). `parseCreate` (**`explainers.ts:298`**) is the whole validation, every problem at once as a 400 with `problems`: a topic of 3 to 300 characters, `notes` of at most 2,000, at most ten distinct http(s) `source_links`, and `language`, `length_tier`, `sound_mode` and `subtitles`, each defaulting to the tenant's `studio_settings.explainer.defaults` (**:304-311**); a `music_track_id` must name a track in the library (it is ignored for sound effects).

Then **one transaction** (**`explainers.ts:335-347`**): the `writing` row (**:336-341**), `queueWrite` ([13.3](#133--who-writes-queuewrite); **:343**), and `job_id` pointed at the job it queued (**:344**). When the writer is Gemini the run is started **after the commit** (`startGeminiRun`, **:349**): the run reads the row, which a transaction still open would hide. The audit row `explainer.created` names the language, the tier and the sound, never the topic (**`studio.ts:561`**).

### 13.3 — Who writes: `queueWrite`

`queueWrite` (**`src/services/explainers/writing.ts:94`**) reads `settings.explainer.writer` (**`writing.ts:97`**): `claude_mac`, the default, or `gemini`.

- **Claude on the Mac** (**`writing.ts:99-100`**). `writePayload` (**`src/services/explainers/payloads.ts:57`**) builds the job's `write` section, `{ model: THINK_MODEL, system, user, schema }` (**`payloads.ts:67`**), from `buildWriterInputs(…, 'research')` (**`src/services/explainers/prompt.ts:312`**), and `enqueueJob(…, 'explainer_write', payload)` (**`src/services/studio/jobs.ts:87`**) queues it. `explainer_write` is Mac-brain work whatever its payload (**`src/services/macBrain.ts:161-162`**, [flow 7](#7-claude-on-the-mac--who-may-ask)), so `enqueueJob` refuses it for a tenant the Mac is not for (**`jobs.ts:90`**) and `claimJob` checks again (**`jobs.ts:321`**).
- **Gemini** (**`writing.ts:98`**). `insertServerWriteJob` (**`writing.ts:72`**) writes the job already `claimed`, by the server, with `payload.writer = 'gemini'` and all three attempts spent (**`writing.ts:73-79`**). The Mac's claim takes a `claimed` job only when its heartbeat is stale **and** it has fewer than three attempts (**`jobs.ts:267-269`**), so it can never take a Gemini run back. No Claude is involved, so none of this is Mac-brain work.

### 13.4 — The Mac's write

The worker's poll (`POST /api/studio/worker/claim`, **`src/routes/studio.ts:193`**) hands the job out through `CLAIM_SQL` (**`src/services/studio/jobs.ts:260`**): rank 1, with `monteur_think` (**`jobs.ts:270-271`**), and only once its `not_before` has passed (**`jobs.ts:266`**; a job that sets none is due the moment it is queued). `explainerWriteJob` (aicourse-captions `scripts/studio/explainerWrite.mjs`) runs the app's prompts through the claude CLI on the owner's plan with **WebSearch and WebFetch only**, checks the answer against its own copy of the schema (`explainerSchema.json`), and gives a draft that does not fit **one repair**, with no web this time. The result is `{ written, model, usage?, research_rounds? }`. `research_rounds` is how many rounds of web reading the first call made: **0 means the script was written from memory** ([13.6](#136--applying-a-draft)).

### 13.5 — Gemini steps in, and when it never does

Gemini on the server writes in **three cases and no others** (the header of **`src/services/explainers/writing.ts:1-22`**):

1. **The owner chose it** (`explainer.writer = 'gemini'`). Not a takeover: `queueWrite` made Gemini's job at the start ([13.3](#133--who-writes-queuewrite)) and the Mac is never asked.
2. **The Mac is signed out.** Its write fails, `applyExplainerFailure` ([13.6](#136--applying-a-draft)) sends the explainer to `failed` at `write` as it does any failure, and the error is the claude CLI's own words. `isSignInFailure` (**`writing.ts:59`**) recognises them (**`writing.ts:227`**): whole sign-in messages only, such as "Failed to authenticate" or "OAuth session expired" (**`writing.ts:50-57`**). A rate limit, a spent weekly allowance and a failed page are failures of their own and are not this.
3. **The Mac did not pick the job up in ten minutes and is off or asleep** (**`writing.ts:215-224`**). The job is still `pending`, is not Gemini's own and is `UNCLAIMED_MINUTES` = 10 old (**`writing.ts:38`**, **`:217`**), and `workerSummary` says no live worker of the tenant was heard from in the last 90 seconds (**`writing.ts:221-222`**; the window is `WORKER_ONLINE_WINDOW_MS`, **`src/services/studio/worker.ts:21`**, the dashboard's own definition of "the Mac is up").

**A Mac that is up and busy is never taken over.** It runs two jobs at a time, so with both slots on a long render a script waits far past ten minutes while the Mac heartbeats; Gemini taking over would turn a short wait into a failure (a free key cannot ground its research, below). `takeoverReason` returns null (**`writing.ts:222`**), and the explainer says what the wait is instead: `BUSY_MAC_NOTE` (**`src/services/explainers/explainers.ts:123`**), shown by `busyMacNote` (**`explainers.ts:167`**) once the job has waited `BUSY_AFTER_SECONDS` = 60 (**`explainers.ts:125`**). And `explainer.writer_fallback = false` means never: `takeOverWrite` returns null at once (**`writing.ts:241`**), and the explainer waits for the Mac or fails with its reason.

**Who looks.** `reconcileWriting` (**`writing.ts:282`**) is the one check. It never throws and does nothing unless the explainer is `writing`, or `failed` at `write` with a sign-in message (**`writing.ts:286-288`**). It is called from three places: `GET /explainers/:id`, before the row is read (`getExplainer`, **`explainers.ts:221-223`**); right after a worker reports a failure (`afterJobFailed`, **`writing.ts:300`**, called from **`studio.ts:228`**), so a signed-out Mac is answered at once; and the daily cron's `sweepWriting` ([13.16](#1316--the-daily-crons-parts)).

**The row lock and the idempotency.** `takeOverWrite` (**`writing.ts:238`**) is one transaction on the **locked** explainer row (`lockExplainer`, **`writing.ts:243`**), and the reason is decided on the locked row (**`writing.ts:245`**). It closes the Mac's job so the Mac can never claim it later (`status = 'failed'` where it is still `pending`, **`writing.ts:249-253`**), writes Gemini's job (**`writing.ts:254`**) and points `explainers.job_id` at it, moving a `failed` row back to `writing` with the reason as its note (**`writing.ts:256-257`**). Two looks at once take turns on the lock, and the second finds the work already taken (a `writing` explainer whose job is Gemini's, or one that is no longer `failed`) and returns null, so one run starts. A late answer from the closed Mac job would be dropped anyway: only `explainers.job_id`'s result is applied. The run is started after the commit (`startGeminiRun`, **`writing.ts:188`**, under `waitUntil`).

**The run** (`runGeminiWrite`, **`writing.ts:132`**) reads the rows and gives up quietly when the row is gone, its `job_id` is another's, or it is no longer `writing` (`explainer.gemini_run_skipped`, **`writing.ts:143-146`**). Then `writeWithGemini` (**`src/services/explainers/writerGemini.ts:501`**) makes two calls with the platform's key and the Studio's model chain, a 400, 404, 429, 500 or 503 handing the call to the next model (**`writerGemini.ts:46`**):

1. **Research**, with Google Search grounding (`tools: [{ google_search: {} }]`, **`writerGemini.ts:372`**). The notes are in English; the sources are the grounding chunks, each Google redirect followed once to the page it leads to (`groundedSources`, **`writerGemini.ts:269`**), plus the creator's own links; `[n]` markers go where `groundingSupports` say a source backs the text (`annotateNotes`, **`writerGemini.ts:317`**).
2. **Write**, from the notes alone, with Claude's system prompt in `notes` mode (**`writerGemini.ts:523-533`**), a JSON `responseSchema` and one repair round (**`writerGemini.ts:545-558`**).

What the app does that the model is not trusted with (`onlyListedSources`, **`writerGemini.ts:441`**, called at **`writerGemini.ts:563`**): a source whose address is not in the numbered list is dropped, the sources no scene cites are dropped and the scenes' `source_ids` renumbered, the first comment is rebuilt from the sources that are left, and any address in a caption that is not one of them is removed. The answer ends the way the Mac's does: `completeJob` with `{ written, model }` (**`writing.ts:160`**), or `failJob` with the reason (**`writing.ts:157`**).

**Gemini's research refused on a free key.** Google Search grounding is not offered on the free tier for Gemini 3 models, so every model refuses the research call and the run fails **saying so** instead of writing from memory. `callModels` ends in "Gemini refused the research call on every model it tried" (**`writerGemini.ts:166`**), and `writeWithGemini` appends `GROUNDING_HINT` (**`writerGemini.ts:474`**, appended at **`writerGemini.ts:511-514`**): sign the Mac's Claude Code in, or use a paid-tier key. The explainer is `failed` at `write` with that sentence and **has no draft**. (Logged: `explainer.gemini_request_refused` for each model, **`writerGemini.ts:158`**, then `explainer.gemini_run_failed`, **`writing.ts:156`**.)

**A Gemini run that dies** (the function is killed) leaves a `claimed` job whose heartbeat goes stale. The next look fails it (`reapStalledRun`, **`writing.ts:267-275`**, after `STALLED_RUN_MINUTES` = 5, **`writing.ts:40`**) with "Press Retry", and **never starts a second run by itself**: each run spends two of the free tier's few requests a day. If nobody looks, the Mac's next claim fails it after 15 minutes instead (`failExhaustedClaims`, **`jobs.ts:348`**, because all three attempts are spent), in the worker's wording (`EXHAUSTED_ERROR`, **`jobs.ts:52`**).

### 13.6 — Applying a draft

The result comes back as `POST /worker/jobs/:id/complete` (**`src/routes/studio.ts:216`**) → `completeJob` (**`src/services/studio/jobs.ts:411`**), which locks the job row (**`jobs.ts:414`**) so a delivery retried after a timeout applies once, and hands an explainer kind to `applyExplainerResult` (**`jobs.ts:453-455`**) → `applyWrite` (**`src/services/explainers/apply.ts:111`**), inside that transaction:

1. **The answer must be the schema's.** `parseWriterOutput` (**`apply.ts:113`**), with the schema the app ships (`writerSchema.json`): an answer that is not is a 400 that lists the problems (up to twenty), nothing is stored and the job stays claimed for the worker to report.
2. **Is it still this job's?** `lockCurrent` (**`apply.ts:77-84`**) locks the explainer and answers `dropped` with `no_explainer`, `gone` or `superseded` unless `row.job_id === job.id` (**`apply.ts:82`**). The explainer must also still be `writing` (**`apply.ts:119`**). A dropped result is logged (`explainer.result_dropped`, **`apply.ts:86-89`**), the job is marked `done` with `{ dropped: reason }`, and **nothing else changes**: an older write, a rewrite asked for meanwhile and a deleted explainer all end here, and the owner sees nothing.
3. **What the script breaks.** Characters the settings do not have are removed from each scene (**`apply.ts:121-128`**), then `checkDraft` runs (**`apply.ts:131`**, **`src/services/explainers/spec.ts:373`**). Its **problems** (a closing line that is not a question, engagement bait, a woman or a girl in a picture brief, a field past its limit) are not stored: they are computed again on every read (`presentExplainer`, **`explainers.ts:179`**) and **block approval**. Its **warnings** (scene count, length, how long a picture stays, too few sources) are stored with the draft and never block.
4. **`research_limited`.** A script the Mac's writer wrote after **0** rounds of web reading gets one more warning, `research_limited` (**`apply.ts:132-134`**; the message, **`apply.ts:108`**): written from memory, check every fact and source before approving. A missing count is *unknown*, not 0 (an older worker; **`apply.ts:102-105`**), and Gemini's run is never flagged, since it has its grounding (`rounds` is null for it, **`apply.ts:132`**). The owner may approve over it, as over every warning.
5. `replaceScenes` (**`apply.ts:141`**; **`src/services/explainers/store.ts:51`**, one statement for up to 300 rows), then `writing → draft` with the title, the draft, `draft_version + 1` and `job_id` cleared (**`apply.ts:142`**).

A job that **fails** takes the other door: `failJob` → `applyFailure` (**`jobs.ts:1109-1111`**) → `applyExplainerFailure` (**`apply.ts:420`**), which applies the same `lockCurrent` test (**`apply.ts:421-430`**; a failure of a job that is no longer the explainer's is `explainer.failure_ignored` and moves nothing) and otherwise moves the explainer to `failed` at the step that job was for, with the worker's own words as `error` (**`apply.ts:450`**).

### 13.7 — Edit and rewrite

`PATCH /explainers/:id` → `editExplainer` (**`src/services/explainers/explainers.ts:523`**). A save **may not add a problem** to the script: `checkDraft` is run before and after, and a problem that is new is a 422 `EXPLAINER_DRAFT_REFUSED` with every finding and nothing stored (**`explainers.ts:552-554`**). A problem the draft already had stays listed and a save that does not touch it goes through; only approving needs the script clean. `assertEditable` (**`explainers.ts:491`**) refuses what the running step reads (the script while `writing`, the narration while `voicing`, the title, the labels and the sound while `rendering`, anything once `scheduled`), and the scene list cannot grow or shrink once the narration is voiced (**`explainers.ts:508-512`**): a picture and a time belong to a scene's place in the list. A change to a scene's `narration` or `spoken` adds one to `draft_version` (**`explainers.ts:565`**), which is what makes the voiced audio **stale** (`isAudioStale`, **`src/services/explainers/state.ts:76`**: `audio.version !== draft_version`). Labels, briefs, characters and pictures never do.

`POST /explainers/:id/rewrite { note }` → `rewriteExplainer` (**`explainers.ts:582`**): only from `draft` (**`explainers.ts:590`**); it queues a new write whose prompt carries the note and the previous draft (**`explainers.ts:592`**) and moves `draft → writing` with `rewrite_note` and the new `job_id` (**`explainers.ts:593`**). The old draft stays on the screen until the new one lands.

### 13.8 — Approve the script (gate 1)

`POST /explainers/:id/approve { version }` (**`src/routes/studio.ts:595`**) → `approveExplainer` (**`src/services/explainers/explainers.ts:604`**), one transaction on the locked row (**`explainers.ts:610`**):

1. `version` is required (**`explainers.ts:607`**) and must be the `draft_version` the owner read; any other number is **409 `CHANGED_MEANWHILE`**, "the script changed since you opened it" (**`explainers.ts:612-614`**).
2. Only a `draft` can be approved (**`explainers.ts:611`**).
3. The script must have **no problem left** (`checkDraft`, **`explainers.ts:616`**) and a title (**`explainers.ts:618`**), else 422 `EXPLAINER_DRAFT_REFUSED` with every finding (**`explainers.ts:619`**). Warnings, `research_limited` included, never block.
4. `explainer_voice` is queued (**`explainers.ts:620`**) with `voicePayload`, which carries `version: row.draft_version` (**`payloads.ts:78`**), the owner's voice and style, the spoken lines and `chunk_seconds_max` 180 (**`payloads.ts:18`**). A job nobody has claimed is superseded (`supersede`, **`explainers.ts:621`**, defined **`explainers.ts:233`**) and the explainer moves `draft → voicing` with the new `job_id` (**`explainers.ts:622`**). The audit row `explainer.approved` is written by the route (**`studio.ts:597`**).

### 13.9 — Voice, and its version check

`explainerVoiceJob` (aicourse-captions `scripts/studio/explainerVoice.mjs`, with `tts.mjs`): Gemini speaks the script in parts cut at scene boundaries (one request per part: the free tier counts requests, not seconds), whisper.cpp times every scene and every word, the script's own words are put on the times it heard, and the `.m4a` goes up through a signed upload (`audio/mp4` is one of the types `POST /worker/uploads/sign` takes, **`src/services/monteur/uploads.ts:28`**). The result is `{ audio: { url, duration, voice, fallback }, version, scenes: [{ position, start, end }], words }`.

`applyVoice` (**`src/services/explainers/apply.ts:237`**):

1. `lockCurrent` (**`apply.ts:239`**) and status `voicing` (**`apply.ts:242`**), else the result is dropped as in [13.6](#136--applying-a-draft).
2. `parseVoiceResult` (**`apply.ts:177`**, called at **`apply.ts:245`**) holds the result to the explainer's own scenes: every one, in order, `end` after `start`, no overlap past 0.05 s, the last ending within 0.5 s of the audio (**`apply.ts:194-207`**). One that is not is a 400, and the job stays claimed.
3. **The version check** (**`apply.ts:246`**): `voice.version !== row.draft_version` means the narration moved on while it was being voiced. The audio is **not stored**: the explainer goes `failed` at `voice` with "the narration changed while it was being voiced" (**`apply.ts:250-252`**) and the result is dropped (`stale_version`, **`apply.ts:253`**). An edit of the narration is refused while voicing ([13.7](#137--edit-and-rewrite)), so this is a guard and not a flow.
4. `checkFiles` (**`apply.ts:256`**): the audio is an upload of this tenant, of type `audio/mp4`. Its URL is **rebuilt on our own address** from its id (**`apply.ts:258-260`**), never the string the worker sent.
5. The scene times are written in one statement (**`apply.ts:265-270`**), the previous audio's file is deleted unless it is the same upload (**`apply.ts:275`**), `explainer_draw` is queued (**`apply.ts:273`**) and the explainer moves `voicing → drawing` with the audio, the words and `job_id` = the draw job (**`apply.ts:274`**).

**A voice that runs into Gemini's free allowance is not a failure.** The worker's error starts with `VOICE_LIMIT:`, and `applyExplainerFailure` (**`apply.ts:420`**, **`apply.ts:433-447`**) queues `explainer_voice` again with a `not_before`: the minute's limit after the wait it names (at least a minute), the day's at midnight Pacific plus five minutes (`voiceRetryAt`, **`apply.ts:406`**; `nextGeminiQuotaReset`, **`src/services/explainers/time.ts:18`**), up to three times (`MAX_VOICE_LIMIT_RETRIES`, **`apply.ts:399`**). The explainer stays `voicing`, with the reason and the time as its note (**`apply.ts:443-444`**).

**Re-voice.** After the narration changed, `POST /explainers/:id/revoice` (`revoiceExplainer`, **`explainers.ts:629`**) voices it again, from `drawing`, `review` or `ready` (**`explainers.ts:634`**) and only while the audio is stale (**`explainers.ts:635`**). It comes back through `drawing` (nothing is pending, so the loop ends at once) to `review`, and a render made before the edit is flagged stale ([13.12](#1312--render)).

### 13.10 — Drawing: the server's loop and the allowance

The pictures are drawn **on the server**, never on the Mac: the image provider's credentials and the allowance live here. The Mac's `explainer_draw` job is only a loop (`explainerDrawJob`, aicourse-captions `scripts/studio/explainerDraw.mjs`) that keeps calling one route, because the Mac is the one thing that runs all day and the app has no cron finer than once a day:

```
POST /api/studio/worker/explainers/:id/draw-next { job_id }        src/routes/studio.ts:269
  → { state: 'drawn', position, remaining } | { state: 'done' } | { state: 'paused', until } | { state: 'failed', position, error }
```

1. **The job-id check** (`drawNextStep`, **`src/services/explainers/scenes.ts:152`**). The `job_id` must be the explainer's own current job (**`scenes.ts:157`**), that job must be an `explainer_draw` that a worker has **claimed**, and the explainer must be `drawing` (**`scenes.ts:158`**). Anything else is **409 `EXPLAINER_BAD_STATE`** (**`scenes.ts:160`**, logged `explainer.draw_next_refused`, **`scenes.ts:159`**) before a unit is reserved: a stale loop, another explainer's job, a job nobody started and a finished one cannot spend the allowance. The check only reads and holds no lock across the drawing.
2. **Which scene.** `drawNext` (**`src/services/explainers/pictures/draw.ts:497`**) takes the pending scene with the lowest position (`PEEK_NEXT_SQL`, **`draw.ts:86`**) and answers `done` when none is pending (**`draw.ts:502`**). With no image provider saved it is 409 `EXPLAINER_NO_PROVIDER` (**`draw.ts:508-509`**). It goes round at most five times when it keeps losing a claim to another caller (**`draw.ts:66`**, **`draw.ts:499`**).
3. **A scene that `continues` is never drawn** (unless it is the first scene, which has nothing before it and is drawn like any other). `copyContinuing` (**`draw.ts:455`**, called at **`draw.ts:506`**) takes the chosen picture of the scene before, in one transaction, with no provider and no allowance. Whenever a scene's chosen picture changes (a draw, a redraw, a pick) the run of scenes after it that continue gets the new one in the same transaction (`propagate`, **`draw.ts:268`**). A scene whose predecessor has no picture is marked failed with that reason and healed when the predecessor is drawn (**`draw.ts:462-466`**). The render finds a scene's picture the same way (`pictureOf`, **`payloads.ts:97`**).
4. **Claim → reserve → provider → store** (`drawWithProvider`, **`draw.ts:339`**), holding nothing across the call out:
   1. What can be refused for free comes first: the words (a brief, a note or a character description that names a woman or a girl is 422 `EXPLAINER_PROMPT_REFUSED`, `buildScenePrompt`, **`draw.ts:351`**) and the characters' reference pictures (each under 512×512, `loadReferences`, **`draw.ts:352`**). A refusal here claims nothing; the scene is marked failed with the reason (**`draw.ts:342-356`**, **`draw.ts:522-525`**).
   2. **One short transaction** (**`draw.ts:361-374`**): the scene is claimed with an UPDATE that re-checks it is still pending (`CLAIM_UNATTENDED_SQL`, **`draw.ts:91`**: two callers cannot draw one scene), its prompt is built from the row as the claim found it, and **the allowance is reserved** (`reserveAllowance`, **`draw.ts:372`**). A refusal rolls the claim back with it.
   3. **The provider is called outside any transaction**, holding no pooled client and no row lock (**`draw.ts:391`**). "Used up" (`ALLOWANCE_EXHAUSTED`) keeps the units, marks the day exhausted and puts the scene back to `pending` (**`draw.ts:399-403`**); any other failure gives the units back and marks the scene failed with the reason (**`draw.ts:405-407`**).
   4. The file goes into the media store (**`draw.ts:413`**); only then does **one short transaction** write the result (`storePicture`, **`draw.ts:288`**): the chosen picture, the three pictures before it as history, the scenes that continue it, and the deletion of the files that dropped out (**`draw.ts:296-303`**). A crash between the steps leaves the scene `drawing`; after two minutes it is pending again (`STALE_DRAWING_SECONDS`, **`draw.ts:58`**).
5. **The allowance** (`src/services/explainers/pictures/allowance.ts`). `RESERVE_SQL` (**`allowance.ts:90`**) is one statement that adds the units to today's row (platform-wide, per UTC day) and refuses, in the same statement, when they would pass `daily_cap × units_per_picture` or when the provider already said the day is used up; yesterday's exhaustion is looked at first, because it still pauses the first minutes of today (**`allowance.ts:141-145`**). A refusal is 429 `EXPLAINER_ALLOWANCE_PAUSED` with `retryAt` (`pausedError`, **`allowance.ts:123`**). The count is the app's own estimate, since Cloudflare cannot be asked what is left: 80 pictures a day at 110 estimated units each by default (**`src/services/explainers/pictures/provider.ts:32-33`**). Drawing resumes at the next **00:05 UTC** (`resumeAt`, **`allowance.ts:78`**: the next midnight plus `PAUSE_MARGIN_MS`, **`allowance.ts:32`**).
6. **After the answer** (**`scenes.ts:165-166`**). `done` → `moveToReview` (**`scenes.ts:171`**): one transaction that re-checks the explainer is still `drawing` **and** still this job's (**`scenes.ts:174`**) and moves it `drawing → review` (**`scenes.ts:176`**). `drawn` → `clearPauseNote` (**`scenes.ts:182`**), so an earlier "waiting for the allowance" note stops being true. `paused` and `failed` write nothing here.

> **Why the provider is called outside any transaction.** A draw takes up to 30 seconds, and held inside a transaction it would keep a pooled connection and the scene's row lock for that long. So the claim and the reservation are one short transaction, the call runs holding neither, and the result is a second short transaction that reads the scene again under its lock, so that the history is made from what the scene holds *now* and not from what it held at the claim (**`src/services/explainers/pictures/draw.ts:10-16`**, **`draw.ts:288-305`**).

**Paused → the next `explainer_draw`.** The route writes nothing on `paused`: the worker completes the job with `{ state: 'paused', until }` and `applyDraw` (**`apply.ts:294`**, the `paused` branch **`apply.ts:319-326`**) queues the next round. `resumeAt(until, now)` (**`apply.ts:286`**: the instant the worker said, if it is between a minute and two days away, else the next UTC midnight plus five minutes) goes in as `notBefore` (`enqueueJob`, **`jobs.ts:93-99`**, which writes `studio_jobs.not_before`). `CLAIM_SQL` takes a `pending` job only when `not_before <= NOW()` (**`jobs.ts:266`**), so the Mac's polls skip it until then, and `jobCounts` reports it as `waiting`, not as the Mac's backlog (**`jobs.ts:1193`**). The explainer stays `drawing`, with `job_id` the waiting job, `draw_paused_until` and a note that says when drawing continues (**`apply.ts:323`**). **There is nothing for the owner to press.** If he does, `POST /explainers/:id/draw` (`startDraw`, **`explainers.ts:654`**) replaces a waiting job with one that goes now (if the allowance is still spent it pauses again), makes the failed scenes pending (**`explainers.ts:668-673`**) and leaves a job that is already running alone (**`explainers.ts:665`**).

**`done` does not mean every scene has a picture.** A scene that failed is not pending, so `drawNext` answers `done` and the explainer reaches `review` with it still `failed`, its reason in `draw_error`. The owner redraws it there by hand (`POST …/scenes/:position/draw`, `drawScene`, **`draw.ts:544`**: a synchronous draw with an optional note) or goes back to an earlier picture (`pickPicture`, **`draw.ts:581`**); pictures can be touched in `drawing`, `review`, `ready`, `scheduled` and a `failed` drawing, never while `rendering` (`picturesEditable`, **`scenes.ts:67`**). Three scenes failing **in a row** make the worker give up with `{ state: 'failed' }`; `applyDraw` then keeps the explainer `drawing` with the last reason, clears the job and the pause (**`apply.ts:328-333`**), and nothing retries by itself: the owner redraws, or presses Continue (`startDraw`).

### 13.11 — Approve the pictures (gate 2)

`POST /explainers/:id/approve-pictures` (**`src/routes/studio.ts:619`**) → `approvePictures` (**`src/services/explainers/explainers.ts:705`**): only from `review` (**`explainers.ts:710`**), then `queueRender` (**`explainers.ts:691`**), which builds the payload **first**. `renderPayload` (**`src/services/explainers/payloads.ts:145`**) calls `renderReadiness` (**`payloads.ts:117`**), the one list of what a render needs, in the order a person fixes it: voiced audio that is not stale (409 `EXPLAINER_AUDIO_STALE`, **`payloads.ts:121-123`**), a track in the library when the sound is music (409 `EXPLAINER_NO_TRACK`, **`payloads.ts:125-127`**), and a picture for every scene, `continues` counted (409 `EXPLAINER_PICTURES_MISSING` with the `positions`, **`payloads.ts:128-134`**). Only then is `explainer_render` queued (**`explainers.ts:694`**), a job nobody has claimed superseded (**`explainers.ts:695`**) and the explainer moved `review → rendering` (**`explainers.ts:697`**). The previous render, if there is one, stays on the row until the new one lands. The audit row `explainer.pictures_approved` is written by the route (**`studio.ts:621`**).

A render of a `ready` explainer (a label, a picture or the sound changed) is the same function from `ready` (`renderExplainer`, **`explainers.ts:717`**).

### 13.12 — Render

`explainerRenderJob` (aicourse-captions `scripts/studio/explainerRender.mjs`, `audioMix.mjs`, the compositions in `src/illustrated/`): Remotion renders `IllustratedVertical` (1080×1920) and `IllustratedHorizontal` (1920×1080) **muted**, and the `IllustratedCover` still; ffmpeg puts the voice and the chosen sound under each video. **Music** is the owner's track at −20 dB, faded in and out and ducked by the narration (sidechain compression); **sound effects only** is a soft whoosh at every cut and a pop after every label. Both are loudness-normalised to −14 LUFS, and both videos and the cover go up through signed uploads.

`applyRender` (**`src/services/explainers/apply.ts:338`**): the three URLs must be this app's upload URLs (**`apply.ts:342-346`**). `lockCurrent` (**`apply.ts:353`**), and a result that is no longer current has its three files **deleted**, since nothing will ever name them (**`apply.ts:354-359`**). The explainer must be `rendering` (**`apply.ts:362`**). `checkFiles` (**`apply.ts:364`**) wants two `video/mp4` and one `image/jpeg`, of this tenant, there in Storage. The URLs are rebuilt on our address (**`apply.ts:365-371`**), `rendering → ready` writes `render` and clears `job_id` (**`apply.ts:373`**), and the previous render's files go unless a post names them (**`apply.ts:375`**). A result whose `version` is not the explainer's `draft_version` is **still stored, and said**: `render_stale` in the view (**`explainers.ts:186`**) and a `warn` log (**`apply.ts:376-377`**), "the render is older than your edits". Schedule refuses it ([13.13](#1313--schedule)).

### 13.13 — Schedule

`POST /explainers/:id/schedule { when? }` (**`src/routes/studio.ts:629`**) → `scheduleExplainer` (**`src/services/explainers/schedule.ts:100`**). It is how an infographic is scheduled, through the same `insertVideoPost` (**`src/services/monteur/clips.ts:360`**) the Monteur's approve writes rows with, so the usual sweeps publish what it makes.

1. `when` is `next` (the default), `now` or a date and time; anything else is 400 `INVALID_SCHEDULE_TIME` (`parseWhen`, **`schedule.ts:72-78`**).
2. One transaction, under the tenant's **publishing lock** (`lockTenantPublishing`, **`schedule.ts:107`**: the one the Monteur's approve and the infographics take, so two schedules cannot take one slot) and the locked explainer row (**`schedule.ts:108`**).
3. **What may be scheduled** (`readyToPost`, **`schedule.ts:81-93`**): a `ready` explainer with a render (**`schedule.ts:82`**); not one rendered before the latest edits, since `render.version !== draft_version`, or another `sound_mode`, is 409 `EXPLAINER_RENDER_STALE` (**`schedule.ts:85-87`**); and when the sound is music its track must still be in the library, 409 `EXPLAINER_NO_TRACK` (**`schedule.ts:89-91`**), because the credit line cannot be written without it.
4. **The time** (**`schedule.ts:114-121`**): now, the time given, or the next free slot (`nextFreeSlots`, **`schedule.ts:118`**: the Monteur's `post_at` slots in the tenant's zone, thirty ahead; none free is 409 `NO_FREE_SLOT`).
5. **The platforms.** Instagram, Facebook, YouTube and TikTok all follow `studio_settings.infographic.platforms`, the one setting that already says where this owner's videos go (**`schedule.ts:103-106`**); a TikTok inbox draft is made only when `tiktok` is in the list (the owner's call, 2026-10-26), and a list with none of them answers 409 `EXPLAINER_NO_PLATFORMS`. One `group_id` ties the rows together (**`schedule.ts:123`**) and each platform has its own caption.
   - **Instagram and Facebook:** one row, `both` or the one that is on (`metaPlatformFor`, **`src/services/monteur/clips.ts:348`**), with the **vertical** video, the cover and `captions.meta` (**`schedule.ts:131-135`**).
   - **YouTube** (**`schedule.ts:136-144`**): a render of at most **180 seconds** (`YOUTUBE_SHORT_MAX_SECONDS`, **`schedule.ts:39`**) goes as the vertical video, a Short, with the cover. A **longer** one goes as the **horizontal** video, with no cover of ours (the cover is a vertical frame; YouTube picks its own), and its row carries **`shorts: false`** (**`schedule.ts:142`**), so no `#Shorts` is added to its title or description (`metadataFor`, **`src/services/youtubePublish.ts:104-105`**; `shortTitle` and `shortDescription` with `tagAsShort` false, **`src/services/youtube.ts:288`**, **`:311`**). Its options are `{ title, language }` and its caption is `captions.youtube`.
   - **TikTok**, when ticked: the vertical video as an **inbox draft** (`validateTikTokInboxOptions`, in `scheduleExplainer`), with `captions.tiktok`.

   A platform that is not connected is **not checked** here: its row fails in Posts, saying so, and does not keep the others off (**`schedule.ts:137`**).
6. **The credit line.** When the track the sound used requires credit (`credit_required`), its `credit` goes at the **end of every caption** (`withCredit`, **`schedule.ts:57`**, applied at **`schedule.ts:126-130`**). The credit goes in whole: when body and credit do not fit a platform's limit (2,200 characters; 5,000 for a YouTube description) the **body** is cut at a word and ends in an ellipsis, never the credit, and the outcome lists which captions were `trimmed`.
7. `ready → scheduled`, with `{ scheduled_time, group_id, row_ids }` (**`schedule.ts:151-152`**). The audit row `explainer.scheduled` names the platforms, the time and the group (**`studio.ts:631`**).

### 13.14 — Retry and delete

`POST /explainers/:id/retry` → `retryExplainer` (**`src/services/explainers/explainers.ts:731`**): only a `failed` explainer (**`explainers.ts:737`**), and it runs the failed step again from the state that step runs in (`RETRY_STATUS`, **`src/services/explainers/state.ts:35`**): `write` → `writing` (a fresh write, by whichever writer the settings name now), `voice` → `voicing`, `draw` → `drawing` (failed and half-drawn scenes made pending again, **`explainers.ts:751-754`**), `render` → `rendering`, and a failed `schedule` → `ready`, where Schedule is pressed again (scheduling is one request, not a job). A step can fail only from the state it runs in (`STEP_OF`, **`state.ts:40`**), which keeps a retry from jumping a gate the owner has not passed.

`DELETE /explainers/:id` → `deleteExplainer` (**`explainers.ts:790`**): the job nobody has claimed is failed (`supersede`), the row goes (its scenes with it, `ON DELETE CASCADE`), and every file it held (the scenes' pictures and their history, the audio, the two videos and the cover: `filesOf`, **`explainers.ts:775`**) is deleted **unless a `scheduled_posts` row names it** (`deleteUnreferencedUploads`, **`src/services/studio/jobs.ts:750`**): a file already handed to a platform is the post's now. A job that is already running finishes, and its result is dropped (`gone`).

### 13.15 — Retention

A file an explainer names is not swept by age. `KEPT_BY_EXPLAINERS_SQL` (**`src/services/retention.ts:428`**) is three guards ANDed into the media prune's candidate query (**`retention.ts:452`**):

- **A scene's pictures** (the chosen one and the three before it) for as long as the **scene exists** (**`retention.ts:431-434`**).
- **An explainer's voiceover, two videos and cover**: without limit while it is anything but `scheduled` (a `ready` one is waiting for Schedule, and no post names its files yet), and once `scheduled` until **30 days after its posting time** (`EXPLAINER_FILES_GRACE_DAYS`, **`retention.ts:408`**; **`retention.ts:435-444`**), the owner's window to download the MP4 for the networks the app does not post to. A time that cannot be read keeps the files.
- **The characters' reference pictures and the music tracks** while `studio_settings.explainer` names them (**`retention.ts:445-449`**).

After that they go like any posted file: the posts' own guard (`NAMED_BY_POST`, **`retention.ts:300`**) keeps them for as long as a post may still fetch them. The guards read the JSON as text, so an id anywhere in it keeps its file, which can only make the sweep delete fewer. A picture the owner drew and dropped, or a candidate no character was saved with, is named by nothing and goes by age. A database without v59 runs the prune without the three guards, which the migration made together (**`retention.ts:494-499`**).

The image allowance's own rows are swept too. `sweepAllowance` (**`src/services/explainers/pictures/allowance.ts:212`**) deletes `image_allowance` rows older than 90 days (**`allowance.ts:34`**), from `runRetentionSweep` once per run (`pruneAllowance`, **`retention.ts:697`**, **`retention.ts:744-750`**). That call never throws into the cron: a database without v59 has no table and reads as nothing (**`retention.ts:748`**).

### 13.16 — The daily cron's parts

`GET /api/cron/publish` (**`src/routes/api.ts:1022`**, [3.5](#35--daily-maintenance-only-on-the-daily-cron)) does two things for explainers, both fail-soft. `runRetentionSweep()` (**`api.ts:1059`**) ends with `sweepAllowance` ([13.15](#1315--retention)). `sweepWriting()` (**`api.ts:1162`**, **`src/services/explainers/writing.ts:314`**) looks at up to 25 explainers that are `writing`, or `failed` at `write`, oldest first, and runs `reconcileWriting` on each: the backstop for the lazy check, for a dashboard nobody opens. A script the Mac never claimed in ten minutes while it was off, or whose write failed with a sign-in error, is handed to Gemini here; the run starts under `waitUntil` and finishes after the response. It logs only when it started something (`cron.explainers_writing`), and a database behind v59 is not an error (**`api.ts:1165`**). **Nothing else of an explainer is scheduled:** the Mac's own polling moves its jobs, and the drain ([flow 5](#5-job-lifecycle)) knows nothing of them.

## Where each flow can silently do nothing

A quick index for the "it just isn't working" case. Every one of these is a normal return, not an
error, and several write **no row at all**.

**A `debug` line never prints.** The logger's default level is `info` (`DEFAULT_LEVEL`, **`src/utils/log.ts:36`**), and
production sets no `LOG_LEVEL`, so a row whose only evidence is marked *(debug)* below leaves no trace at all. Set
`LOG_LEVEL=debug` on a deployment to see them.

| Flow | Stops at | Log line | Row written? |
|---|---|---|---|
| 1 | bad signature — **`index.ts:365`** | `webhook.signature_rejected` (`app_keys_tried`, `instagram_app_configured`, `probe`) | no (403 precedes the DB) |
| 1 | unknown `field` — **`src/webhook/comments.ts:87`** | `comment.unhandled_field` *(debug)* | no |
| 1 | own comment — **`src/webhook/comments.ts:214`**, **`src/webhook/comments.ts:230`** | `comment.skipped_self_authored` / `_page_owner` *(debug)* | no |
| 1 | no creator for `entry.id` — **`comments.ts:205`** | `comment.no_creator` | no |
| 1 | a tenant with no Meta token (created by name) — `getCreatorByPageId` skips it | `comment.no_creator` | no |
| 1 | **no campaign matched** — **`comments.ts:237`** | `comment.no_campaign_match` | **no** |
| 1 | already handled — **`comments.ts:251`** | `comment.duplicate_ignored` | no (row exists, untouched) |
| 1 | 24h recipient cap — **`comments.ts:265`** | `dm.skipped_recipient_cap` | yes, `FAILED` |
| 1 | quota — **`comments.ts:280`** | `dm.quota_exhausted` | yes, `FAILED` |
| 2 | filtered at plan time — **`router.ts:88`** | *(none)* | no job at all |
| 2 | nothing answerable — **`src/webhook/messaging.ts:169`** | `dm.skipped_empty` *(debug)* | no |
| 2 | no creator — **`messaging.ts:257`** | `dm.no_creator` | no |
| 2 | already handled / live claim — **`messaging.ts:286`** | `dm.duplicate_ignored` | inbound row only |
| 2 | bot paused — **`messaging.ts:295`** | `dm.bot_paused` | inbound row, `handled_at` set |
| 2 | **the send quota refuses the reply on the job's last attempt** (the tenant's hourly DM quota or the app-wide Meta budget) — **`src/webhook/messaging.ts:622-629`**, and the sales turn's at **`src/webhook/messaging.ts:552-558`** | `dm.quota_exhausted` (`error`), once per attempt | inbound row, `handled_at` set; **nothing sent, no handoff line, no outbound row**. Earlier attempts release the claim and retry (~30 s, ~2 min) |
| 2 | the sender's profile lookup (Instagram only) is refused, throttled, or cannot run on a database without v40 — **`senderProfile.ts`** `refreshSenderProfile` | `dm.profile_failed` (`warn`); a throttled one is silent | no (the reply is unaffected; the attempt is recorded in `conversations.profile_checked_at`) |
| 2 | a **permanent** Meta refusal of the reply (a blocked recipient, a dead token) — the catch in **`messaging.ts`** (`isPermanentMetaError`) | `dm.pipeline_failed` | inbound row, `handled_at` set; **no outbound row, and nothing in `jobs`** (the job completes `done`): the inbox's "reply failed" chip cannot show it, only the logs can |
| 2 | an ad's standalone referral with no words (A3) — `handleMessagingEvent` | `ads.touch_recorded` (`recorded`: `entry` / `touch` / `duplicate` / `missing`) | no message row; `entry_source` or `ad_touches` on the conversation; the job ends `ad_referral_recorded` and **nothing is sent** |
| 2 | **Meta Business AI owns the Instagram thread** (error 100 / 2534037, A3) — `noteBusinessAiBlock` | `ads.alert_business_ai` (`error`), once per conversation | `conversations.no_reply_reason = 'business_ai_owns_thread'`; **not retried**, no outbound row; cleared by the next send that goes out |
| 2 | a send outside the window on an ad conversation (10 / 2018278, or 551, A3) | `ads.alert_window_error` (`error`) | that platform's `ads.extended_window` is turned OFF; not retried |
| 2 | **no `ai_agents` row** — **`ai.ts:383`** | `ai.unconfigured` (`warn`) | inbound row, `handled_at` set |
| 2 | agent switched off — **`ai.ts:383`** | `ai.disabled` (`debug`) | same |
| 7.8 | a `leadgen` change for a tenant with no lead_ads sign-off — `fetchAndStoreLead` | `ads.lead_locked` (`warn`) | **no** (nothing fetched) |
| 7.8 | the app-level Page webhook has no `leadgen` field, or the Page is not subscribed (no sign-off yet) | *(none: Meta sends nothing)* | no; `scripts/diagnose.mjs` notes the missing field |
| 7.8 | `GET /{leadgen_id}` refused (no `leads_retrieval`, Leads Access Manager) — `fetchAndStoreLead` | `ads.lead_read_refused` | no; the job ends `failed` and the catch-up will be refused too |
| 7.8 | a throttle on the lead read | `ads.throttled` | no, until the 6-hourly catch-up |
| 3 | row claimed by another run — **`api.ts:632`** | `cron.publish_already_claimed` | no change |
| 3 | **a due post of an inactive tenant** (`creators.is_active = false`) — `splitDueByTenantActivity`, **`src/routes/api.ts:570`**, in `publishDuePosts` **`src/routes/api.ts:948-953`** | `cron.publish_held_inactive` (`warn`, the count and tenant ids) on every sweep | no: the row stays `PENDING` and goes out on the first sweep after the tenant is switched back on |
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
| 5 | budget spent — **`runner.ts:202`**, **`:224`** | `job.drain_complete` (`budgetExhausted: true`); `job.released` when a batch had jobs left | jobs never claimed stay `pending`; the batch's unreached jobs go back to `pending` with their attempt given back, unless the reaper has already freed one and another drain claimed it (that claim is left alone). If the write fails: `job.release_failed`, and they wait for the 300 s reaper |
| 6 | 5 drafts already pending — **`tiktokPublish.ts:183-186`** | `cron.publish_held_tiktok_inbox` | yes, back to `PENDING` + `error_log` |
| 6 | bad webhook signature — **`routes/tiktok.ts:150`** | `tiktok.webhook_signature_rejected` | no (401 precedes the DB) |
| 6 | unknown `publish_id` / account — **`tiktokPublish.ts:379-380`** | `tiktok.webhook_applied` (`ignored:…`) | no |
| 6 | **creator never posts the draft** | *(none)* | row stays `IN_INBOX`; the sweep stops asking after 7 days |
| 6 | the profile scope is on but TikTok refuses the profile fields, or v44 is not applied — `completeConnection` | `tiktok.profile_info_failed` / `tiktok.profile_save_failed` (`warn`) | yes: the connection, its name and avatar; **no profile** |
| 7 | a think, an `explainer_write`, or an infographic job with `write`, for a tenant that is neither the owner nor on `studio.mac_brain_tenants` — **`think.ts:246`**, **`jobs.ts:311`** | `studio.mac_brain_refused` / `studio.mac_brain_job_refused` (`warn`) | no job; a queued one is `failed` with `NEEDS_API_BRAIN`'s message |
| 7 | a tenant's AI call the layer cannot answer (no provider key, a budget spent, the provider down) — `generate`, **`tenantAi.ts:50`** | `ai.call_refused` / `ai.call_failed` (`warn`), an `ai_usage` row with the outcome | an infographic: no row, no job (409 / 429 / 503 / 502); a Monteur call: the attempt fails with the layer's words (Editor: the reel goes on without edits); a Studio draft: `failed` with them. **Never the Mac, never Gemini** |
| 7 | the owner (or a listed tenant) with `monteur.brain: 'api'` stored — **`brain.ts:20`** | *(none)* | no: the call is the Mac's, as `claude_mac` is |
| 8 | a callback with no cookie, or one that does not equal `state` — **`meta.ts:114`** | `meta.oauth_state_mismatch` | no (before the DB) |
| 8 | a replayed, expired or foreign `state` — **`oauthState.ts:134`** | *(none: `reason=state_expired` in the redirect)* | no (the UPDATE matched nothing) |
| 8 | a tenant that is connected and did not ask for a reconnect — `mayConnect` | `meta.oauth_callback_failed` (`reason: already_connected`) | no, and Meta is never called |
| 8 | Connect with Facebook is off (`meta.login_enabled`) | *(none: `reason=disabled`)* | the state is spent, nothing else |
| 8 | the webhook could not be subscribed — `subscribePage` | `meta.subscribe_failed` / `_incomplete` / `_unread` (`warn`) | yes: connected, `meta_webhook_subscribed_at` NULL, `warn=` in the redirect |
| 8 | a pick nobody finishes | *(none)* | `meta_pick` row, payload cleared after 10 min by the next Meta state or the daily cron |
| 8 | **the test comment never turns green** (W4) — `readCommentCheck` finds no `comment.process` job for the tenant's ids since `meta_connected_at` | *(none: a normal `received: false`)* | no; the page stops asking after 10 minutes and offers "Check again". Means the webhook path is not delivering: for a Tester, the operator connects through Page access |
| 8 | the daily recheck cannot reach Meta, or Meta's answer is not an inspection — `classifyDebugToken` | `token.recheck_transient` (`warn`) | **no** (not even `token_last_checked_at`); the tenant is first in line tomorrow |
| 8 | a token that cannot be decrypted (a rotated key) — `recheckOneMetaToken` | `token.recheck_unreadable` (`warn`) | no |
| 8 | a connection that needs renewing or that Meta rejects — the recheck | `token.reconnect_due` (`warn` / `error`) | yes: the health columns; "reconnect due" on the card and on Overview |
| 8 | a deauthorize request with no valid signature, a stale one, or one for a person no tenant was connected by — **`routes/meta.ts`** `/deauthorize` | `meta.deauthorize_rejected` (`warn`) / `meta.deauthorize_handled` (`matched: 0`) | no (the rejection precedes the database; an unmatched id changes nothing and answers 200) |
| 8 | a TikTok or YouTube flow the wizard began, whose return address could not be saved (no v35 column) | `tiktok.return_to_unsaved` / `youtube.return_to_unsaved` (`warn`) | the state without `return_to`: it returns to Settings, and still connects |
| 8 | **Meta sends an event type to another website** (the Meta app's `instagram` or `page` subscription points elsewhere, is switched off or lacks `comments`/`messages`) — `describeSubscriptions` / `findProblems`, §8.10 | `meta.webhooks_checked` (`warn`, `problems`) and `meta.webhooks_alert` (`warn`, one outcome per channel); `webhook.signature_rejected` does **not** fire | **no `jobs` row**: the delivery never arrives. The stored `meta.webhooks.status` says `ok: false`, Today and the Inbox show the notice, the owner is told once a day |
| 8 | the hourly webhook check cannot run (no `META_APP_ID` / secret, no public address, Meta not answering) — `checkMetaWebhooks` | `meta.webhooks_unanswered` (`info` for a deployment with nothing to check, `warn` for a Meta that did not answer) | `meta.webhooks.status` keeps the last answer and sets `error`; **no notice** comes from a check that never answered |
| 8 | the webhook alert could not be sent (no channel switched on, every send refused) — `alertIfNew` | `meta.webhooks_alert` (`warn`), `meta.webhooks_alert_email_failed` / `_telegram_failed` | no `meta.webhooks.alerted` entry: the day is not spent, the next hourly check tries again |
| 8 | a repair step that Meta refused or that timed out — `applyStep` | `meta.webhooks_repaired` (`steps_failed`, `still_broken`) | the audit row `meta.webhooks_repair` (outcome per object); `ok: false` inside `steps` of a 200, and the card keeps Meta's own words beside the object |
| 9 | **no AI provider has a key** — `draftStep` / `generate` (`no_provider`) | `ai.call_refused`, `onboarding.draft_failed` (`error_kind: no_provider`) | yes: `failed`, `needsAiKey`, the prefill kept; **no draft, no retry** |
| 9 | one source unreadable (private Instagram, a site that refuses, no YouTube key) — `fetchDraftSources` | `onboarding.ig_source_failed`, `onboarding.yt_source_skipped`, `onboarding.draft_fetched` | yes: the draft is made from the rest, the failure is a line of `sources_status` |
| 9 | TikTok connected but its profile fields were never stored (the profile scope is off, or not reconnected since) — `readTikTok` | `onboarding.draft_fetched` (`tiktok: skipped`) | yes: `sources_status.tiktok` `skipped`, no TikTok source |
| 9 | **nothing at all readable** — `decideAfterFetch` | `onboarding.draft_step` (`outcome: fail`), `onboarding.draft_failed` | yes: `failed`, `no_source` (the wizard asks for the About text) |
| 9 | a second caller on a draft being worked on — `CLAIM_SQL` | `onboarding.draft_advance` (`outcome: busy`) | no change |
| 9 | **a draft nobody advances** (no wizard open, worker not running): it stays `queued` | *(none)* until the sweep runs: `onboarding.sweep` | row untouched; ended `expired` by whoever finds it after 30 minutes |
| 9 | a slow invocation whose lease ran out, or whose draft was superseded — owner-guarded writes | `onboarding.draft_lease_lost` | no (what it did is dropped) |
| 9 | the draft is ready and nobody applies it | *(none)* | the draft stays a draft: nothing is applied to the profile by the engine |
| 10 | a message from a group, or with no BSUID anywhere — **`whatsappPlan.ts:111`** | `wa.ignored` (`reason: group` / `no_user_id`) | **no job**, no row |
| 10 | a `field` the build does not handle (`calls`, `message_template_status_update`, …) — **`whatsappPlan.ts:180`** | `wa.unhandled_field` | no job |
| 10 | an entry with no changes, a `messages` change with nothing in it, value-level `errors[]` — **`whatsappPlan.ts:149`**, **:92**, **:104**, **:101** | `wa.empty_entry` / `wa.empty_change` / `wa.value_errors` (`warn`) | no job |
| 10 | a status with no id — **`whatsappPlan.ts:126`** | `wa.status_ignored` | no job |
| 10 | **no connection for the number** (never connected, revoked, a number that is not ours), or the tenant is switched off — **`whatsappInbound.ts:654`**, **`tenant.ts:217`** | `wa.no_creator` (`warn`), `wa.creator_inactive` | **no row**; Meta has its 200 and will not redeliver, so the message is gone. An `invalid` connection is NOT this: it stores |
| 10 | an edit, a deletion, `request_welcome` or a message with no id — **`whatsappInbound.ts:691`** | `wa.ignored` | no row |
| 10 | already handled — **`whatsappInbound.ts:353`**, **:410** | `wa.duplicate_ignored` | no change (the thread's `last_inbound_at` is deliberately not touched) |
| 10 | **every message, once concluded** — **`whatsappInbound.ts:418`** | `wa.inbound_stored` (`no_reply_reason`, `answered`) | yes, `handled_at` set + `no_reply_reason` (NULL for an answer); for anyone not on the test list the row holds **no text, phone, username, name or raw event** |
| 10 | a stranger's job ends (done, or failed for good) — **`whatsappInbound.ts:629`**, **`runner.ts`** | *(none: the payload is replaced in the ending statement)* | the job row stays with the audit minimum only (`change.redacted: true`); a retried failure keeps the whole payload until its last attempt |
| 10 | a settings read that fails on the last attempt — **`whatsappInbound.ts:665`** | `wa.settings_unreadable` (`error`) | yes, stored as for a stranger (metadata only) |
| 10 | two threads for one person after a BSUID change — **`whatsappInbound.ts:572`** | `wa.contact_rekey_conflict` (`warn`) | both threads kept, the system message on the new one; consents and the test-sender entry still follow |
| 10 | a status for a message we have no row for — **`whatsappStatus.ts:133`** | `wa.status_unknown_message` | no (nothing to update; the job completes, nothing is retried) |
| 10 | a status name Meta added later, or a status job with none — **`whatsappStatus.ts:156`**, **:151** | `wa.status_unrecognised` / `wa.status_empty` (`warn`) | no |
| 10 | a delivery that could not be counted (the message row has no tenant, or the job no number) — **`whatsappStatus.ts:113`** | `wa.usage_not_counted` (`warn`) | the status is applied; **the ledger misses it** |
| 10 | an account event Meta sent that this build cannot map, or one for a number nobody connected — **`whatsappAccount.ts:490`** | `wa.account_event_unhandled` (`warn`, with `reason`) / `wa.account_event_no_connection` (`warn`) | no (Meta got its 200 and will not resend; nothing is written) |
| 10 | an account event that only says something about partners or pricing — **`whatsappAccount.ts:268`** | `wa.account_event` (`informational: true`) | no |
| 10 | a repeat of an account change the owner was already told — **`whatsappAccount.ts:155`** | *(none: a duplicate is the point)* | no write, no second alert |
| 10 | an owner alert while alerts are off, or Telegram unreachable — **`whatsappNotify.ts:243`** | `wa.alert_not_sent` (`info`) / `wa.alert_failed` (`warn`) | the state is stored; a failed send releases the claim and the job retries |
| 10 | a quality event's follow-up read of the number fails — **`whatsappStatus.ts:180`** | `wa.account_health_read_failed` (`warn`) | the event is applied; the daily read tries again tomorrow |
| 10 | the free-reply alert check fails — **`whatsappAccount.ts:550`** | `wa.free_tier_check_failed` (`warn`) | the delivery is counted; the next delivery decides again |
| 10 | a preference change for a number nobody connected, or with no `phone_number_id` — **`whatsappStatus.ts:233`** | `wa.no_creator` (`warn`, `source: 'user_preferences'`) | no consent row: it names no tenant; Meta has its 200 and a retry would find the same nothing |
| 10 | Meta's "interested / not interested" feedback buttons, or a preference value this build does not know — **`consentPreferences.ts`** | `consent.user_preference` (`warn`, `recorded: 0`, `ignored: n`) | no (only `stop` / `resume` of `marketing_messages` is a consent row) |
| 10 | a stop phrase from a listed tester — **`whatsappInbound.ts:462`**, **`whatsappOptOut.ts:96`** | `wa.opted_out` (`newly`, `confirmation`), `consent.withdrawn_all` | yes: three `withdrawn` rows, the thread paused and `closed`, `opted_out_at`, follow-ups cancelled; the inbound row says `opted_out` and **the agent is never asked**. A stranger's «stop» is stored as metadata and not read |
| 10 | a stop while the agent is off, the connection is refused or a person has the thread — **`whatsappOptOut.ts`** | `wa.optout_confirmation_skipped` (`reason: 'agent_cannot_speak'`) | the opt-out is recorded; **no confirmation is sent, and a repeat gets none either** |
| 10 | the confirmation of a stop could not be sent — **`whatsappOptOut.ts`** | `wa.optout_confirmation_not_sent` (`warn` for a refusal, `error` for a thrown one; `effect: 'the opt-out stands'`) | the opt-out stands; **no outbound row**; nothing is retried |
| 10 | a stop that could not be written, last attempt — **`whatsappInbound.ts:453`** | `wa.optout_not_recorded` (`error`); `wa.optout_retrying` while attempts remain | **nothing recorded**, nothing sent to the contact; the row says `failure` |
| 10 | a stop the turn decided, whose consent history could not be written — **`whatsappAnswer.ts:209`** | `wa.optout_consent_unrecorded` (`error`) | the thread is opted out and the line went out; **the consent history misses this stop**; not retried |
| 10 | a tester's file that could not be saved (no media id, no token, too large, expired, an unsupported type, a refused connection) — **`whatsappMediaInput.ts:96`** | `wa.media_not_saved` (`reason`), `whatsapp.media_failed` / `whatsapp.media_skipped` | the message is stored with its media id in the raw event; **no private copy, and Meta drops the file after 7 days** |
| 10 | a voice note that could not be read — **`whatsappMediaInput.ts:193`** | `wa.voice_unreadable` (`reason`: `rate_limited`, `provider_unavailable`, `unsupported_media`, `empty`, `no_file`, …) | the one line asking for text goes out (row NULL); **a second unreadable voice note inside a day, with nothing typed between, gets none** (`wa.media_ack_skipped`, row `superseded`) |
| 10 | a file with no caption — **`whatsappMediaInput.ts:219`** | `wa.media_ack_sent` / `wa.media_ack_skipped` / `wa.media_ack_not_sent` | the kit's one line, once per burst; the agent is never asked. A sticker, a location and a contact card get **nothing** (`unsupported_type`) |
| 10 | a voice note or file for an agent that is off, or while a person has the thread — **`whatsappInbound.ts:469`** | `wa.inbound_stored` (`agent_off` / `bot_paused`) | the file is saved privately; **no transcription is paid for and no line is sent** |
| 10 | a ` #ref` that is not one of the tenant's own, or labels that cannot be read — **`whatsappInbound.ts:331`** | `wa.entry_link_unreadable` (`warn`) for the second | the thread is `organic`; the customer's words are unchanged |
| 10 | a `free_entry_point` status with no end, an end already past, or on a message with no row — **`whatsappStatus.ts:90`** | *(none)* / `wa.status_unknown_message` | `free_window_expires_at` is left as it was (never set from a referral, a link or an ad) |
| 10 | a daily health read of one number fails (a timeout, a database error) — **`whatsappHealth.ts:149`** | `wa.health_sweep_row_failed` (`warn`); a listing failure is `wa.health_sweep_failed` (`error`) | that number is left as it was; the rest are read |
| 10 | the meter's ledger cannot be read — **`routes/whatsapp.ts:76`** | `whatsapp.usage_unreadable` (`warn`) | no; the card answers `usage.unavailable: true` with zeros |
| 10 | **a message nobody answers** — `noReplyReasonFor`, **`whatsappInbound.ts:123`** | `wa.inbound_stored` (`no_reply_reason`, `answered: false`) | yes: the inbound row, `handled_at` set, `no_reply_reason` = `agent_off` / `not_test_sender` / `unsupported_type` (a sticker, a location, a card, a reaction) / `connection_invalid` / `bot_paused` / `opted_out` / `superseded` |
| 10 | the agent's reply could not be sent: a closed window, a billable reply nobody allowed, a refused connection — **`channels/send.ts:124`** | `wa.send_refused` (`warn`), `wa.answer_failed` (`error`) | the inbound row says `window_closed` / `billable_blocked` / `connection_invalid`; **no outbound row**; the thread is stamped "Needs you" and the owner is told; **Meta is not called** |
| 10 | the model cannot answer (no allowed provider, a 429, a timeout, a budget) — **`turn.ts:402`** | `dm.engine_failed` (`fallback: 'never'`), `ai.call_refused` | the hand-off line goes out as the one reply; inbound `provider_unavailable`; the bot is paused. **Never Gemini** |
| 10 | a send that may have landed (a timeout, a 5xx) — **`channels/send.ts`** `failedSend` | `wa.send_failed` (`may_have_landed: true`) | **never retried**; inbound `failure`; stamped; no outbound row, so a delivery that did happen is invisible in the thread |
| 10 | a reply sent and its record failed — **`whatsappAnswer.ts`** | `wa.answered_unrecorded` (`error`) | the customer was answered; **no outbound row** and no state move; concluded as answered, never retried |
| 10 | a follow-up for a WhatsApp conversation — **`followupJob.ts`** `scheduleFollowup` | `dm.followup_not_scheduled` (`reason: 'channel'`) | no job |
| 10 | a person's reply from the inbox on a closed window — **`routes/api.ts`** `replyOnWhatsApp` | `wa.send_refused` (`reason: 'window_closed'`) | no: `409 WHATSAPP_WINDOW_CLOSED`, nothing stored, bot not paused |
| 11 | ads are off for the tenant — **`routes/ads.ts:54`** | *(none)* | no: every `/api/ads` route answers 404 `ADS_DISABLED` |
| 11 | the pacer refused (our own 45-point budget, or Meta's block) — **`ads/graph.ts:167`** | `ads.paced` (`retry_at`) | no Meta call at all; 429 `RATE_LIMITED` |
| 11 | Meta throttled the ad account — **`ads/graph.ts:194`** | `ads.throttled` (`retry_at`) | `ads_pacer.blocked_until`; **never retried** |
| 11 | the guard checked an hour ago, or failed under 10 minutes ago — **`ads/guard.ts:86`** | *(none)* | no |
| 11 | a guard check failed (token, Meta, throttle) — **`ads/guard.ts:116`** | `ads.cap_check_failed` | `ads.cap_attempt` only; `guard_blind` after 2 h |
| 11 | an alert already sent today for the same kind and object — **`ads/notify.ts:168`** | `ads.alert_duplicate` | no (the row exists) |
| 11 | an alert kind the tenant switched off — `notifyAds` | `ads.alert_sent` (`telegram: 'off'`) | the `ads_alerts` row, channels `off` |
| 11 | an ad is `DISAPPROVED` / `WITH_ISSUES`, but the sync met it for the first time, or it already was in that state — `adStatusAlertFor`, `src/services/ads/adStatusAlerts.ts` | *(none)* | no alert and no `ads_alerts` row: the first import of an account is silent, and an ad made in Ads Manager and rejected before its first sync is never announced (it is in the Ads screen's needs-attention list, and the rule template **Ad rejected → tell me** catches it) |
| 11 | an `ad_rejected` / `ad_issues` alert cannot be handed to the alert channel (the tenant's settings unreadable) — `raiseAdStatusAlerts` | `ads.alert_failed` (`error`) | no `ads_alerts` row; **not retried**: the stored ad already holds the new state, so the next sync sees no change |
| 11 | a request names another tenant's ad object, or one from an account the tenant left — **`ads/actions.ts`** `ownObject` | `ads.not_own_object` (`warn`), audit `ads.not_own_object` | no: 403 `NOT_OWN_OBJECT` |
| 11 | a queued op whose target is another tenant's or another account's — **`ads/ops.ts`** `sendExec` | `ads.not_own_object` | the op `failed` with `NOT_OWN_OBJECT`; **Meta is not called**, no verify |
| 11 | a queued op on a Meta id the stored copy has not seen yet (made in Ads Manager before the next sync) — `assertOpTarget` | `ads.op_target_unmirrored` (`warn`) | sent: the token is the tenant's own, so Meta refuses anything outside its business |
| 11 | the overview cannot read alerts, spend or sign-offs (a table not migrated yet) — **`ads/tenantsOverview.ts`** | `admin.ads_alerts_unreadable` / `admin.ads_spend_unreadable` / `admin.ads_signoffs_unreadable` | the rest renders; cap use shows "unknown" |
| 11.6 | a rule ran less than 55 minutes ago, is off, or was never approved — `rulesStore.dueRules` | *(none)* | no run row |
| 11.6 | ads off, not configured, token dead, or no stored account snapshot — `rulesWiring` `account` | *(none)* | `ads_rule_runs` `blind` with the reason; `rule_blind` after 24 h |
| 11.6 | today's results stale and the refresh refused (pacer, throttle) or failed — `rules.ts` `freshness` | *(none)* | `blind` (`throttled` / `stale`); nothing judged on old numbers |
| 11.6 | every watched object below `min_data` | *(none)* | `skipped_no_data`; counts toward `rule_blind` |
| 11.6 | matched, but skipped: an op already queued, already paused, no daily budget of its own, at Meta's minimum, 4 budget changes used this hour, acted on in the last 24 h, or claimed by an earlier rule | *(none)* | the run row, the reason in `matched[].skipped` |
| 11.6 | a raise or resume matched | `ads.rule_acted` audit | an `open` `rule_raise` proposal: **nothing changes at Meta until the owner approves it** |
| 7.5 | the Mac worker has no `ads_think` handler (aicourse-captions not pulled, or the worker not restarted) | the worker's "doesn't know the job kind" | the job `failed`, the proposal `failed` with that error |
| 7.5 | the Mac is asleep or its worker stopped | none until the sweep | the proposal stays `drafting`; the daily cron fails it after 24 h |
| 7.5 | a review found nothing worth changing — `advanceProposal` | `ads.proposal_nothing_to_propose` | the `drafting` row is deleted |
| 7.5 | a tenant with ads on but < 3 days of results, or no AI for it — `runDailyReview` | `ads.daily_review` (`queued: 0`) | no |
| 13 | **explainers are off for the tenant** — **`routes/studio.ts:545`** | *(none: the answer is 404 `EXPLAINERS_DISABLED`)* | no: every `/api/studio/explainers` route answers it; the worker's `draw-next` is not behind the switch (**`routes/studio.ts:269`**) |
| 13 | **a result of a job that is no longer the explainer's** (a rewrite, a re-voice, a new drawing or a new render replaced it; the explainer was deleted or moved on) — **`explainers/apply.ts:77-89`** | `explainer.result_dropped` (`info`, with `reason`) | **no**: the job ends `done` with `{ dropped }`; a dropped render's three files are deleted (**`explainers/apply.ts:354-359`**) |
| 13 | the failure of such a job — **`explainers/apply.ts:421-430`** | `explainer.failure_ignored` (`info`) | no: a job that is no longer the explainer's cannot fail it |
| 13 | **a `draw-next` with the wrong `job_id`**, a job that is not a claimed `explainer_draw`, or an explainer that is not `drawing` — **`explainers/scenes.ts:158`** | `explainer.draw_next_refused` (`warn`) | no: **409 `EXPLAINER_BAD_STATE`**, nothing drawn and no unit reserved; the Mac's loop stops with the 409's words and reports its job failed |
| 13 | **drawing paused**: the provider says the day's free allocation is used up, or the owner's daily cap is reached — **`explainers/pictures/allowance.ts:137`**, **`explainers/pictures/draw.ts:378`**, **`:399-403`** | `explainer.allowance_exhausted` (`warn`, the provider's own refusal only) | the scene back to `pending`; the explainer stays `drawing` with `draw_paused_until` and a note; the next `explainer_draw` is queued with `not_before` at the next 00:05 UTC: **nothing to press** |
| 13 | **a busy Mac is never taken over** — **`explainers/writing.ts:222`** | *(none)* | no change: the write job stays `pending`; after 60 s the explainer's job line says the Mac is busy (`BUSY_MAC_NOTE`) |
| 13 | the owner turned `writer_fallback` off — **`explainers/writing.ts:241`** | *(none)* | no: the explainer waits for the Mac, or fails with its reason |
| 13 | **Gemini's research refused on a free key** (no Google Search grounding on Gemini 3's free tier) — **`explainers/writerGemini.ts:511-514`** | `explainer.gemini_request_refused` for each model, `explainer.gemini_run_failed` (`warn`) | yes: the job and the explainer `failed` at `write`, with `GROUNDING_HINT` in `error`; **no draft** |
| 13 | a Gemini run that died — **`explainers/writing.ts:267-275`** | `explainer.gemini_run_stalled` (`warn`) | yes, when the next look finds it 5 minutes stale: the job `failed` ("Press Retry"); never run again by itself |
| 13 | a script written with no web read (`research_rounds` 0) — **`explainers/apply.ts:132-134`** | `explainer.draft_written` (its `warnings` hold `research_limited`) | yes: a normal draft with the `research_limited` warning; approving it is allowed |
| 13 | a voice that runs into Gemini's free allowance — **`explainers/apply.ts:433-447`** | `explainer.voice_limit_requeued` (`info`) | the explainer stays `voicing` with a `VOICE_LIMIT:` note; `explainer_voice` is queued with `not_before`, up to three times, then `failed` |
| 13 | **a drawing that ends `done` with a scene that failed** — **`explainers/pictures/draw.ts:83`**, **`:502`** | `explainer.pictures_ready` | `review` is reached with a scene that has no picture; Approve pictures answers 409 `EXPLAINER_PICTURES_MISSING` with its position |
| 13 | three scenes fail in a row (the Mac's loop gives up) — **`explainers/apply.ts:328-333`** | `explainer.draw_failed` (`warn`) | the explainer stays `drawing` with the last reason and no job; nothing retries by itself |
| 13 | the daily look at the writing, on a database behind v59 — **`routes/api.ts:1165`** | *(none)* | no |

`RUNBOOK.md` works these backwards from the symptom.
