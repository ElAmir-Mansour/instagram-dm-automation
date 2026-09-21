# AutoReply Pro — architecture assessment and target design

**Status:** assessment of `chore/secrets-and-migrations` @ `1581c5e`, plus the changes landed
on `feat/architecture`.
**Audience:** whoever implements the next stage. Written to be actionable, not admired.

> This file lives at the repository root rather than in `docs/` because `docs/` is gitignored
> (`.gitignore:6`) and this needs to be reviewable in a pull request.

---

## 0. Summary

The codebase is in far better shape than its history suggests. The hardening and tenancy
passes did real work: the webhook is decomposed, tenant resolution is centralised, tokens are
encrypted, migrations have a ledger, and 137 tests exist where there were none. The remaining
problems are almost all **architectural rather than defective** — the code does what it says,
but the shape it is in cannot survive the next order of magnitude.

Three conclusions, in order of importance:

1. **The serverless fit is the central problem, and it is not the webhook's latency — it is
   durability.** The webhook answered Meta `200` and then kept working in the same invocation.
   On Vercel that work can be frozen at any point after the response, so it is lost *and* Meta
   has already been told it succeeded. Nothing anywhere recorded that it existed. This is
   addressed in this branch (§2, §7 Stage 0) by writing the work down before acknowledging.

2. **Gemini is the dominant marginal cost and ~80-90% of every request is the same static
   prefix resent verbatim.** Context caching is a roughly 4x cost reduction available for
   about a day of work, and it gets cheaper to adopt the sooner it happens (§4).

3. **Meta's app-level rate limit is a shared pool across all tenants, and it does not scale
   with tenant count in any way the product can control.** This is a business-model
   constraint, not an engineering one, and it should shape what gets sold before it shapes
   what gets built (§6).

Everything else — `BYTEA` media, `raw_payload` retention, connection pooling — is real but
bounded, well understood, and has a known fix.

---

## 1. Current state: what is actually well-factored

Being specific, because "it's fine" and "it looks fine" are different claims.

### Genuinely good seams

**`src/services/matching.ts`** is the model the rest of the codebase should follow. It is a
pure function over rows, the webhook passes a query result straight in, and
`matching.test.ts` exercises 14 cases including the ordering rules and the
Arabic-Indic-digit case that would silently break discount campaigns. The keyword-matching
logic can be changed with confidence. Nothing else in the repo has that property to the same
degree.

**`src/services/http.ts`** is a correct, small abstraction: one client, one timeout, one
retry policy, and — importantly — an explicit distinction between transient and permanent
Meta errors (`http.ts:15-24`). `isPermanentMetaError` encodes real operational knowledge
(190 = dead token, 200 = missing permission, 10903 = recipient blocked DMs) in one place.

**`src/config/crypto.ts`** is well-reasoned, and the reasoning is written down
(`crypto.ts:3-12`). The transparent-plaintext-read design (`decryptSecret` returns unprefixed
values unchanged, `crypto.ts:58-60`) is what made encryption deployable without a migration
window. That is a genuinely good call.

**`scripts/migrate.mjs`** fixed a real hole. The checksum-drift warning (`migrate.mjs:76-80`)
and the per-file transaction (`migrate.mjs:111-117`) are the two things the scripts it
replaced got wrong.

**`src/webhook/errors.ts`, `meta-payload.ts`** are small, pure, and tested. Good.

### Seams that are notional

**`src/services/tenant.ts` is two modules wearing one filename.** Lines 1-119 resolve "the
one active creator"; lines 121-331 resolve "the tenant this request is acting as". The file
says so itself (`tenant.ts:121-125`) and frames it as a transition. It has been a transition
for a while. `getActiveCreatorId` / `getActiveCreator` are the legacy half, and
`resolveTenant` still falls back to `getActiveCreatorId()` for legacy sessions
(`tenant.ts:285`). Until that fallback is gone, the "single canonical definition of which
tenant this is" has two answers.

Concretely: the module-level cache at `tenant.ts:41` (`cachedId`, 30s TTL) is per-warm-instance
state in a system whose whole premise is that instances are ephemeral and plural. It is
correct today only because there is one active creator.

**`src/routes/api.ts` is 2,022 lines and is not a module, it is a namespace.** Auth, cron,
uploads, CSV export, stats, campaign CRUD, token management, the scheduler, the inbox, AI
settings and the webhook verify token all live in one file with one router. The mount-order
comments (`api.ts:648-741`) are load-bearing: `requireAuth`, then `requireLiveSession`, then
the admin router, then `resolveTenant`, with three route groups deliberately placed *above*
the auth boundary. That ordering is correct and carefully explained — and it is also the
reason this file cannot simply be split by feature without thinking hard. Any split must
preserve it explicitly rather than implicitly.

**`src/webhook/comments.ts` and `messaging.ts` are decomposed but not layered.** Each function
does payload normalisation, tenant resolution, database writes, rate-limit checks, Meta API
calls and status bookkeeping in one pass. They are readable and the comments are excellent,
but there is no seam between "decide what to do" and "do it", so the only way to test the
comment pipeline is against a live database and a live Meta account. That is why
`matching.ts` was extracted, and the same extraction has not happened for the rest.

**`src/utils/rateLimiter.ts` was imported-but-never-called and is now genuinely wired in**
(`comments.ts:161,170`, `messaging.ts:188`). Worth noting because `CLAUDE.md` still lists it
under known issues; that entry is stale.

**The tenant predicates in `tenant.ts:317-321` are stale in the opposite direction.** The
comment says the webhook writers "still INSERT without the column, so every row arriving right
now is NULL". They do not — `comments.ts` and `messaging.ts` both write `creator_id`
explicitly. The `OR creator_id IS NULL AND EXISTS(...)` fallback is now only serving
pre-backfill historical rows. It is harmless but it defeats the
`idx_interactions_creator` index for the tenant's main activity query. See §7 Stage 4.

### The `any` boundary

This is worth stating plainly because it explains a lot of the above. `tsconfig.json` sets
`strict`, `noUncheckedIndexedAccess` and (now) `noUnusedLocals`. Those buy very little on the
paths that matter, because **every path that matters starts at a value typed `any`**:

- `pool.query()` resolves to `QueryResult<any>`.
- Webhook bodies are `any` from `processWebhookBody(body: any)` down.

So `src/webhook/comments.ts` — a file that is almost entirely unchecked Meta JSON and
unchecked database rows — typechecks perfectly. This is not a hypothetical: writing row types
for `tenant.ts` in this branch immediately surfaced that the exported `Creator` interface
declared `is_active: boolean` while the webhook's own query never selects that column
(`tenant.ts:121`). Every webhook-path read of `creator.is_active` would have been `undefined`
with the compiler asserting otherwise. Fixed in `tenant.ts:17-39`.

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
  (`ai.ts:38` caps it at 30s), plus one or more Meta sends with retries and backoff
  (`http.ts:52-72`, up to 3 retries at 0.5/1/2s base with jitter). A batch of several DMs
  comfortably exceeds 20s.
- **Vercel freezes the invocation after the response.** Work after `res.send()` is not
  guaranteed to run. Vercel's Fluid Compute changes this somewhat, but "somewhat" is not a
  foundation.

Answering late meant redelivery storms. Answering early meant silent loss. Both were chosen at
different times; neither is correct, because **the problem is not where the 200 goes, it is
that the work only ever existed in memory.**

The failure is invisible by construction. A DM abandoned mid-Gemini leaves an inbound
`messages` row (written at `messaging.ts:143`, before the AI call) with no outbound partner.
There is no error, no retry, no alert. It looks exactly like a customer who was never
answered because the bot was off.

### 2.2 What this branch does

Write the intent down, *then* acknowledge:

```
verify signature → enqueue each event to `jobs` → res.sendStatus(200) → drain inline (budgeted)
```

- `planJobs` (`webhook/router.ts:46`) is a pure function from one webhook body to a list of
  jobs. It cannot throw on a malformed body — tested against seven malformed shapes — because
  it runs before Meta is acknowledged and an exception there is a 500, and a 500 is a
  redelivery storm.
- Enqueue is two fast `INSERT`s, well inside any timeout.
- `drainInline` (`jobs/drain.ts:38`) then does the common case immediately with an 8s budget,
  so **happy-path latency is unchanged**. Anything unfinished stays `pending`.
- If the enqueue fails for any reason, the webhook falls back to the exact pre-change inline
  path (`index.ts:225-241`). The queue is additive; it cannot make things worse.

The worst case moves from *silently lost forever* to *still pending*. That is the whole point.

### 2.3 What is still missing, and it is one thing

**There is no scheduled drainer.** `GET /api/jobs/drain` exists and is the correct shape, but
`vercel.json` can only schedule one cron a day on the Hobby plan. So today a stranded job
waits for the next webhook delivery (usually seconds, on an active account) or for the daily
cron (worst case 24h).

That is bounded and vastly better than the previous unbounded loss, but it is not finished.
The fix requires no code: point any external scheduler at
`GET /api/jobs/drain` with `Authorization: Bearer $CRON_SECRET` every minute. QStash's free
tier, a GitHub Actions schedule, or cron-job.org all do this. **This is the highest-value
single action available and it costs nothing.**

### 2.4 The cron and `scheduled_time`

The once-daily cron makes `scheduled_time` effectively day-granular despite the UI offering
minutes. This is currently a genuine product lie.

The queue solves it without a plan upgrade, because `jobs.run_after` *is* a scheduler. Once a
per-minute external drain exists, a scheduled post becomes a `publish.post` job with
`run_after = scheduled_time` and the granularity becomes the drain interval. The publish
logic in `api.ts:288-454` is already correctly written for this — it has an atomic claim, a
stale-claim reaper and an attempt cap — so moving it is a handler extraction, not a rewrite.
Deliberately **not** done in this branch (§9).

---

## 3. Data layer

### 3.1 `media_uploads` is `BYTEA` and should not be

~40MB today, growing with every reel, against a 500MB Supabase free tier. A 1080×1920 H.264
reel is 15-30MB; a few dozen fills the tier. Worse, the bytes cross the Postgres connection
on **every fetch** — and `GET /api/uploads/:id` is fetched by Meta during ingestion, which is
a cold, unauthenticated, potentially repeated read of tens of megabytes through a connection
pool sized at 10.

`src/services/storage.ts` in this branch introduces the `MediaStore` seam so the swap is a
one-line change to `getMediaStore()`. The migration itself is §7 Stage 3.

One constraint any implementation must respect: **Meta cURLs the URL itself**, with no session
and no credentials. A signed, short-lived URL is fine; a private bucket is not.

### 3.2 `messages.raw_payload` has no retention policy

Every inbound DM writes the entire Meta event as JSONB, forever. Two problems:

- **Cost.** It is several times the size of the columns beside it, in the same 500MB tier.
- **Privacy, and a compliance gap.** It is a permanent record of what individual people wrote,
  with their Meta user ids, long after they stopped interacting. The app publishes a
  `/data-deletion` page (`index.ts:106`) promising deletion, as Meta's Platform Terms require.
  A deletion that clears `messages.text` and leaves `raw_payload` holding the same text has
  deleted nothing. **This is the mechanism by which that published promise is currently
  untrue** — the most serious non-security issue in this assessment.

`src/services/retention.ts` implements the sweep. It clears only `raw_payload`; `text`,
`direction` and `created_at` are what the inbox and `ai.ts`'s history window read and are
never touched. It is **opt-in** (`RAW_PAYLOAD_RETENTION_DAYS` unset = no-op) because nulling a
column is irreversible on a live account. **Recommended value: 90.** Set it.

### 3.3 Connection pooling

`src/config/db.ts:4-11` — `max: 10`, `idleTimeoutMillis: 30000`.

The number that matters is not 10, it is **10 × concurrent warm instances**. Under a viral
reel, Vercel fans out to dozens of instances, each opening up to 10 connections. Supabase's
free tier direct-connection limit is around 60; the pooler's is higher but finite. The
realistic failure is connection exhaustion during exactly the traffic spike the product exists
to handle, surfacing as `connectionTimeoutMillis` expiries — which the `pool.on('error')`
handler (`db.ts:19`) will log but cannot fix.

Three things, in order:

1. **Confirm `DATABASE_URL` points at Supabase's pooler (port 6543, transaction mode), not
   the direct port 5432.** If it is the direct port, this is the single highest-priority fix
   in this section. Cheap to check, and the symptom if it is wrong is indistinguishable from
   general slowness.
2. **Lower `max` to 2-3.** Counter-intuitive but correct for serverless: each instance handles
   a small number of concurrent requests, so a large per-instance pool buys nothing and
   multiplies the global count. With transaction-mode pooling, 1-2 is often right.
3. Only then consider Supabase Supavisor / an external pooler.

The queue helps here too: fewer long-lived handlers holding connections while awaiting Gemini.

### 3.4 Smaller data-layer notes

- **No single artifact describes the live schema.** `schema.sql` plus twelve migrations plus
  whatever was applied by hand. The migration ledger fixes *forward* drift but does not
  reconstruct the present. Dumping the live schema to `schema/current.sql` in CI would.
- `interactions` has no index on `(creator_id, timestamp DESC)`, which is the dashboard's main
  query shape. `idx_interactions_creator` exists but is single-column.
- `jobs` (v13) will accumulate `done` rows. The indexes are partial to keep the hot path fast,
  but a `DELETE FROM jobs WHERE status='done' AND updated_at < NOW() - INTERVAL '7 days'`
  belongs in the same sweep as `pruneRawPayloads`. **Not yet implemented** — noted in §9.

---

## 4. Cost model

Gemini is the dominant marginal cost. The structure of that cost is unusually lopsided and
therefore unusually easy to fix.

### 4.1 Where the tokens go

Every call to `generateAiResponse` (`ai.ts:169`) sends:

| Component | Resent every call? | Rough size |
|---|---|---|
| System prompt | **yes** | 200-500 tokens |
| Knowledge base (`ai_agents.knowledge_base`) | **yes** | 1,000-5,000+ tokens, grows |
| Fixed Arabic instructions (`ai.ts:245`) | **yes** | ~150 tokens |
| Response schema (`RESPONSE_SCHEMA`) | **yes** | ~400 tokens |
| Conversation history (`HISTORY_WINDOW = 8`) | partially | 200-800 tokens |
| Current user message | no | 10-50 tokens |

Arabic tokenises at roughly **2-2.5× more tokens per character than English** — Arabic script
is poorly covered by BPE vocabularies trained predominantly on English, so words fragment into
many subword pieces. Both the knowledge base and the system prompt here are Arabic
(`ai.ts:205`, `ai.ts:245`), so the multiplier applies to the largest, most-repeated component.

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

`ai.ts:27-35` already identifies this. It should be the next non-structural piece of work.

### 4.3 Measure first — now possible

This branch adds an `ai.usage` log event (`ai.ts`, in the success path) recording
`prompt_tokens`, `output_tokens`, `cached_tokens` and `history_turns` per call. Before
optimising, run a week and check the real prompt/output ratio. The estimates above are
estimates.

### 4.4 Cheaper adjacent wins

- **`HISTORY_WINDOW` was trimmed 15 → 8.** Correct direction. With caching in place the
  history is the *only* uncached part, so it becomes the thing to tune, not the prefix.
- **`gemini-2.5-flash-lite`** is already in `SUPPORTED_MODELS` (`ai.ts:16`) and is several
  times cheaper. For keyword-triggered FAQ answering against a fixed knowledge base, it is
  very likely sufficient. A/B it — this is a settings change, not code.
- **Do not send the response schema when it is not needed.** Most replies are
  `message_type: "text"`; the carousel and quick-reply branches of `RESPONSE_SCHEMA`
  (`ai.ts:68-119`) are ~400 tokens sent on every call to support a minority of responses. A
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

### 5.2 What this branch does

`src/utils/log.ts`: `log(level, event, fields)` emitting one JSON object per line. No
dependency — `JSON.stringify` and `AsyncLocalStorage`, both stdlib. Key properties:

- **`event` is a dotted machine-stable name**, not a sentence. Sentences get reworded and the
  alert that depended on the old wording stops firing silently.
- **Request correlation via `AsyncLocalStorage`** (`index.ts:58-62`), preferring Vercel's own
  `x-vercel-id` so platform and application logs join for free. The correlation id is
  carried across the queue boundary in `jobs.request_id` and re-established by the runner
  (`runner.ts:74-83`), so a search for one delivery returns the work it caused, not just its
  acknowledgement.
- **Key-name redaction** for anything matching `token|secret|password|api_key|authorization|
  signature|cookie`, applied recursively. This matters: an axios error's `config.headers`
  carries the Gemini API key, and `describeError` is called on axios errors throughout.
- **It cannot throw.** It runs inside `catch` blocks. Circular references (an axios error
  holds request→response→config→request), `BigInt`, and `Error`'s non-enumerable fields are
  all handled; a failing sink is swallowed.
- **`describeError`** lifts `meta_code` / `meta_subcode` out of axios errors. This is the
  field that distinguishes a dead token (190) from a missing permission (200) from a
  recipient who blocked DMs (10903) — three different operator actions that the previous
  `err.message` logging rendered as one indistinguishable string.

142 of 150 `console.*` calls are converted. Of the eight left, five are in `src/config/env.ts`
and are a deliberate exception documented in that file — they run before anything is serving,
there is no request to correlate, and the audience is a person reading a terminal. The other
three are in `src/db_check2.ts`, an unreferenced ad-hoc debug script that nothing imports and
no route reaches; it should simply be deleted (§9).

One privacy fix landed alongside: `api.ts` logged the full text of every manual inbox reply.
It now logs the length.

### 5.3 What should alert

Structured events make this expressible. In rough priority:

| Event | Condition | Why it matters |
|---|---|---|
| `webhook.signature_rejected` | any occurrence | Half of all traffic silently 403ing is the documented worst-case failure. `secrets_tried` and `instagram_secret_set` are on the line. |
| `dm.quota_exhausted` | any occurrence | Real customers are being dropped. |
| `job.failed` | any occurrence | A job that spent its attempts. Nothing else will retry it. |
| `token.status_failed` / `meta_code: 190` | any occurrence | Dead Meta token — the whole product stops, and nothing else notices. |
| `webhook.enqueue_failed_falling_back` | any occurrence | Durability is off; the app is back to pre-queue behaviour. |
| `comment.no_campaign_match` | rate change | Not an error, but a sudden spike means a campaign was deactivated or a keyword broke. |
| `job.drain_complete` | `budgetExhausted: true` sustained | The drain cannot keep up; the external scheduler is missing or too infrequent. |
| `ai.usage` | `total_tokens` trend | Cost regression, e.g. someone pasted a 50KB knowledge base. |

None of this needs a vendor. Vercel log drains into any HTTP endpoint, and these are JSON
lines.

### 5.4 The observability gap that remains

**There is no health signal for "the pipeline is working".** Every alert above is
failure-triggered, and the defining characteristic of this system's worst failures is silence.
A comment matching no campaign writes no row; a webhook that stops arriving writes nothing at
all. `GET /health` checks the database and nothing else.

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

`rateLimiter.ts` is per-creator (`DEFAULT_HOURLY_LIMIT = 180`, `rateLimiter.ts:19`). That is
the right shape for protecting Meta from any one tenant, and the wrong shape for protecting
tenants from each other, because N tenants × 180/hr has no relationship to the app-wide pool.

What is needed, in order:

1. **A global bucket in addition to the per-creator one.** `checkSendQuota` already takes a
   `bucket` parameter (`rateLimiter.ts:35`) and `rate_limit_counters` is keyed on
   `(creator_id, bucket, window_start)`. A sentinel creator id for the app-wide bucket is a
   handful of lines. **This is the cheap, obvious first step and it is not done.**
2. **Fair queueing in the drain.** `claim` is currently `ORDER BY run_after` — strict FIFO, so
   a tenant with 10,000 queued events starves everyone behind them. Round-robin by
   `creator_id` fixes it. The `jobs` table has the column; the change is to one query.
3. **Per-tenant quotas as a product feature**, with the app-wide pool as the real budget being
   allocated.

### 6.2 The blocker is Meta, not code

Serving other people's accounts requires **Advanced Access**, which requires **Business
Verification plus per-permission App Review** for roughly six permissions including
`instagram_content_publish` and `pages_messaging`. Months of process with genuine rejection
risk.

The architectural implication is real and worth stating: **do not build for scale that Meta
will not permit.** The tenancy foundation that exists (users, memberships, encrypted
per-tenant tokens, RLS enabled) is the right amount. The next increment — fair queueing,
global rate budgeting, per-tenant observability — should be sequenced *after* Advanced Access
is granted, not before.

### 6.3 Remaining tenancy debt

- `resolveTenant` falls back to `getActiveCreatorId()` for legacy sessions (`tenant.ts:285`).
  Until legacy shared-password sessions are removed, "which tenant" has two answers.
- The `cachedId` module cache (`tenant.ts:41`) is per-instance state; correct only while
  there is one active creator.
- RLS is enabled deny-by-default (v11) but the app connects as the table **owner**, which RLS
  does not apply to. It is a blast shield against a leaked anon key, not tenant isolation.
  Real isolation needs a non-owner role, `FORCE ROW LEVEL SECURITY`, and policies keyed on a
  verified session claim. The v11 migration says this clearly and honestly.

---

## 7. Target architecture and staged migration

Each stage is independently shippable and independently valuable. Stages 1-2 are the ones
that change the system's character.

### Stage 0 — landed on this branch

- Structured logging with request correlation (`src/utils/log.ts`), threaded through the
  webhook, job, cron and API paths.
- Durable job seam: `jobs` table (v13), `JobQueue` interface, `PostgresJobQueue`, budgeted
  drain runner, `GET /api/jobs/drain`.
- Webhook enqueues before acknowledging, with automatic fallback to the inline path.
- `MediaStore` seam.
- Row types (`src/db/rows.ts`) and typed query helpers (`src/db/query.ts`), applied across
  the whole webhook path, `tenant.ts`, `ai.ts` and `rateLimiter.ts`.
- Opt-in `raw_payload` retention.

**Unblocks:** everything below. Nothing here changes observable behaviour.

### Stage 1 — turn on what already exists *(hours, no code)*

1. Apply migration v13: `npm run migrate`.
2. Set `RAW_PAYLOAD_RETENTION_DAYS=90`.
3. Verify `DATABASE_URL` uses Supabase's pooler port (6543), and lower `db.ts` `max` to 2-3.
4. Point an external scheduler at `GET /api/jobs/drain` every minute with the `CRON_SECRET`
   bearer token.

**Unblocks:** genuine durability (not just opportunism); bounded job latency; the data-layer
and privacy fixes. Step 4 is the highest value-per-effort action available anywhere in this
document.

### Stage 2 — move scheduled publishing onto the queue *(1-2 days)*

Extract `api.ts:288-454` into a `publish.post` job handler. A scheduled post becomes a job with
`run_after = scheduled_time`.

**Unblocks:** minute-accurate scheduling, which the UI has always claimed; retries with
backoff for free; removal of the bespoke claim/reap/attempt-cap machinery, which the job
runner now duplicates.

### Stage 3 — media to object storage *(1-2 days)*

Write `BlobMediaStore` against `MediaStore`. Backfill existing rows, keeping
`/api/uploads/:id` as a permanent redirect so URLs already handed to Meta keep working. Then
drop the `BYTEA` column.

**Unblocks:** the 500MB tier stops being a countdown; uploads above 3.2MB (direct-to-blob
upload removes the base64/4.5MB body ceiling entirely); connection pool relief.

### Stage 4 — tenancy hardening *(2-3 days, gate on Advanced Access)*

Global rate bucket; round-robin claim by `creator_id`; remove the legacy-session tenant
fallback and the `cachedId` cache; drop the `creator_id IS NULL` halves of the tenant
predicates once a backfill is confirmed complete.

### Stage 5 — split `api.ts` *(2-3 days)*

By feature (`routes/campaigns.ts`, `routes/inbox.ts`, `routes/scheduler.ts`, …), with the
middleware ordering hoisted into one explicit composition root rather than implied by
statement order. **Deliberately last**: it is the largest diff and the smallest behavioural
win, and doing it before Stages 1-4 would conflict with all of them.

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

### ADR-2 — Postgres as the queue, not QStash/SQS/Redis

**Chosen:** a `jobs` table with `FOR UPDATE SKIP LOCKED`, behind a `JobQueue` interface.

**Rationale:** the database is already here, already pooled, already backed up. At this volume
the extra round-trip is irrelevant next to the 2-8s Gemini call it wraps. The deciding factor
is operability: a stuck job can be inspected with the SQL editor the operator already has open
at 2am, which is not true of a hosted queue's dead-letter console.

**Rejected — QStash.** The right answer at 10-100× this volume, and it cannot be provisioned
from here. `JobQueue`'s five methods map 1:1 onto publish/receive/ack/nack/visibility-timeout
precisely so this is a new file, not a refactor.

**Rejected — in-memory queue with no table.** Solves nothing: the problem is durability across
invocation death.

**Consequence:** `jobs` rows accumulate and need their own retention. Claim contention is
handled by `SKIP LOCKED` but is not free at very high concurrency.

### ADR-3 — A `MediaStore` interface now, `BYTEA` behind it

**Chosen:** introduce the seam, keep the implementation.

**Rationale:** the reason media has not moved is that it *reads* as a big change when in fact
the storage decision is reachable from two call sites. Making that true in the type system
converts a scary migration into a scheduled one. Provisioning a bucket is not possible from
here anyway.

**Rejected — move to Vercel Blob now.** Requires provisioning; explicitly out of scope.

**Rejected — leave it alone until the move happens.** The seam is 113 lines and makes the move
a day's work instead of a week's. Cheap insurance.

### ADR-4 — Hand-written row types, not a generated schema or an ORM

**Chosen:** `src/db/rows.ts`, maintained by hand against the migrations.

**Rationale:** the `any` boundary is the single biggest reason `strict` buys nothing here.
Row types close it at the call sites that matter for a few hours' work and zero runtime risk.

**Rejected — a query builder or ORM (Kysely, Drizzle, Prisma).** The SQL in this codebase is
good and several statements depend on Postgres specifics a builder would obscure or forbid:
the `ON CONFLICT ... WHERE ... DO NOTHING` idempotency claims, `FOR UPDATE SKIP LOCKED`, the
atomic publish claim. The problem was never the SQL — it was that the results were untyped.
Adding an ORM would also add the first heavyweight dependency to a project with four.

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

---

## 9. Deliberately not done

Recorded so it is a decision rather than an omission.

- **Splitting `api.ts`.** Largest diff, smallest behavioural win, and it would conflict with
  every other stage. Stage 5.
- **Moving scheduled publishing onto the queue.** The seam exists and this is the obvious next
  handler, but it touches the code path that posts to a real Instagram account. It wants its
  own change with its own review. Stage 2.
- **Gemini context caching.** The largest cost win available, but it changes what is sent to
  the model on every DM. It should follow a week of `ai.usage` data rather than precede it.
- **Returning 503 on enqueue failure.** ADR-1.
- **`jobs` row retention.** `done` rows accumulate. The sweep belongs next to
  `pruneRawPayloads` and is a handful of lines; left out only to keep this branch's retention
  story to one opt-in switch rather than two.
- **Global (app-wide) rate bucket.** ~20 lines given the existing `bucket` parameter, and the
  fix for the cross-tenant 429 problem. Left out because it changes send behaviour for the
  live account and belongs with Stage 4's fair-queueing work, where it can be tested together.
- **A pipeline liveness metric.** §5.4. Needs a traffic baseline to set non-noisy thresholds.
- **Deleting `src/db_check2.ts`.** 15 lines of ad-hoc debug script that nothing imports and no
  route reaches, sitting in `src/` where it is compiled and deployed. Harmless, and deleting
  unrelated files is not what this branch is for — but it should go.
- **Removing the legacy `getActiveCreator*` half of `tenant.ts`.** Blocked on removing legacy
  shared-password sessions.
- **Dashboard changes of any kind.** Out of scope for this branch by instruction.

---

## 10. Corrections to the existing project documentation

`CLAUDE.md` is unusually good and mostly current. Four entries are now stale:

1. **"`src/utils/rateLimiter.ts` is imported but never called."** No longer true — it is wired
   into both the comment and DM paths.
2. **"`/api/cron/publish` fails open."** No longer true — it fails closed, and the guard is now
   shared with `/api/jobs/drain`.
3. **"~60 emoji `console.log` calls."** It was 150. Now 5, all deliberate.
4. **"Keyword matching is substring-based at `src/index.ts:438`."** Correct behaviour, wrong
   location — it moved to `src/services/matching.ts` and is now tested.

And one correction to a comment in the source: `tenant.ts:306-315` states that the webhook
writers do not set `creator_id`. They do (`comments.ts`, `messaging.ts`). The
`creator_id IS NULL` fallback in the tenant predicates now serves only pre-backfill rows and
can be removed once a backfill is confirmed — see §7 Stage 4.
