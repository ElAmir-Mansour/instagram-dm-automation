# `src/services/ads/` — the Ads Manager's domain

The home of everything that talks to the Meta Marketing API for ads. The design and the phases live in the local spec folder
`002-meta-ads-manager` (`plan.md`; `docs/` is not public). v1's `metaAds.ts` moved here in A2; v1's `adsCap.ts` became `money.ts`;
v1's `adsManager.ts` and its `/campaigns/:id` routes were removed after A12 (the Campaigns tab uses `/objects`, `adsObjects.ts`);
`adBoosts.ts` (Boost) stays one level up.

## The rules every file here keeps

1. **Stored copy first.** Screens read Postgres, not Meta. A1 stores the account and token check (`ads.health.<tenant>`); A2 adds the
   stored copy of every campaign, ad set and ad (`ads_objects`, `ads_insights_daily`, `ads_insights_breakdown`). A GET that must call Meta says so in its comment.
2. **Every write goes through `ads_ops`** (`ops.ts`): enqueued with an idempotency key, claimed one per object, sent outside any
   transaction through `sendExec`, Meta's per-object limits from the history, a create verified by its `AR·<op id>` tag before any
   resend. A pending or running op with `worst_case_delta` is "about to run" for the money rule.
3. **One pinned version.** `graph.ts` calls Meta on `ads.api_version` (default `v26.0`, never below `v25.0`), never on the publisher's
   `META_API_VERSION`, and logs `ads.version_mismatch` when Meta answers on another one.
4. **One money rule.** `money.ts`. Spent this month (the ad account's month) + what every active budget can still spend (today at 1.75×)
   + what is about to run + the candidate ≤ the monthly cap. Every screen, Boost, activation, resume, budget raise and the guard use it.
5. **No Meta call inside a database transaction.** Read Meta, then a short locked transaction (`checkAndStartSpend`), then call Meta.
6. **Throttles are never retried.** `withRetry({ ads: true })`; the pacer blocks the account until Meta's time.
7. **PAUSED first.** Every object is created PAUSED; spending starts only from a confirmed Activate (`confirm: true`).

## Files

| File | What |
|---|---|
| `graph.ts` | The client: pinned version, pacing, usage headers, error classes (`AdsGraphError`), `withAdsContext` |
| `metaUsage.ts` | Meta's usage headers parsed (shared with the Growth sync) |
| `pacer.ts` | `ads_pacer`: the 45-of-60-points budget, Meta's blocks |
| `money.ts` | THE money rule, the live month read, the lock, `aboutToRun`, `checkAndStartSpend`, `moneyFor` |
| `guard.ts` | The hourly cap guard: pause all at the cap, `cap_checked` only after success, `guard_blind` |
| `health.ts` | The daily token / account / funding / version check, Test connection, the Settings card's view |
| `notify.ts` | Alerts: typed union, once a day per kind and object, per-tenant recipients, admin copy |
| `adStatusAlerts.ts` | `ad_rejected` / `ad_issues`: the rule (an ad the stored copy already had moves into `DISAPPROVED` / `WITH_ISSUES`), raised by the structure sync after its transactions; best effort, never throws |
| `settings.ts` | The `ads.*` settings families, ceilings, alert recipients, the setup steps |
| `spendCap.ts` | Meta's account spending limit: set, read back, 10 a day |
| `ops.ts` | The paced write queue: enqueue, claim, execute, verify, reap, `drainAdsOps`, `runOpInline` |
| `actions.ts` | The owner's actions as ops (status, budget, archive, delete) and Boost's waited writes (`writeNow`); `ownObject` resolves every `:id` |
| `sync.ts` | The structure sync (hourly), today's results (4 h), the 28 days and breakdowns (daily); `requestTodaySync` |
| `mirror.ts` | The stored copy: upserts, deletion marking, the reads and `ObjectView`, `forgetStoredCopy` |
| `overview.ts` | `GET /overview` from the stored copy: health, money, needs attention, queued changes |
| `policy.ts` | The policy check (A4): versioned bilingual rules, normalised matching, findings with spans in the original text, a rewrite per rule |
| `spec.ts` | `CampaignSpec` → Graph params (A4), pure: messages (single and several destinations, greeting, ice breakers), engagement, reach, traffic; Boost's preset `boostToSpec`; the LIVE-CHECK flags |
| `drafts.ts` | The builder's server steps (A4): `validateDraft` (Meta `validate_only`, money, minimum, bots) and `createDraft` (stored copy + chain of create ops, PAUSED) |
| `rulesEval.ts` | Rules, pure (A9): validation, the templates, metrics over today / 3d / 7d, min data, the plan (protective ops vs proposals), blindness |
| `rules.ts` | The rules pass for one tenant: order, fresh numbers or `blind`, act, propose, alert, record a run |
| `rulesWiring.ts` | The pass wired to the stored copy, the queue, A7's proposals and the alerts; `evaluateDueRules` (the drain's share) |
| `rulesStore.ts` | `ads_rules` and `ads_rule_runs`: save = approve, due rules, run rows, the cooldown read |
| `metaAds.ts` | v1's Graph helpers (moved here in A2) |
| `results.ts` | `GET /api/ads/results` (A6): the Results tab and the ad rows, from the stored insights only, never Meta |
| `attribution.ts` | Ads → DM attribution (A3): which ad a conversation came from, what the bot may be told, the reply window, the two ad-only send refusals |
| `switches.ts` | A3's two per-tenant switches, both off by default: `ads.bot_context.<t>` and `ads.extended_window.<t>` |
| `adUploads.ts` | Signed direct uploads (A5): the builder's pictures and videos go from the browser straight to Supabase Storage (Vercel's 4.5 MB cap) |
| `adMedia.ts` | Uploaded ad media from our Storage to Meta and into a creative (A5) |
| `creatives.ts` | Creatives for the builder (A5): the 9:16 placement version, `adimages` / `advideos`, video status, previews |
| `targetingSearch.ts` | What the builder asks Meta before creating anything (A5): targeting search and the reach estimate |
| `lifecycle.ts` | Duplicate (A5): the `POST /{id}/copies` parameters; a copy is always created PAUSED |
| `graphPort.ts` | The narrow Graph interface the A5 builder code is written against, so it can be tested with a stub |
| `audiences.ts` | Custom Audiences (A8): engagement, video and lookalike audiences, and customer lists |
| `hashing.ts` | Customer lists (A8): parse, normalise, hash and batch, so a raw email or phone exists in one place only |
| `legalSignoff.ts` | The legal sign-off that unlocks customer lists and lead ads (A8/A10, `ads_legal_signoffs`) |
| `leads.ts` | Lead ads (A10): instant forms, the leads they collect, and what the law asks of them; locked per tenant until a sign-off |
| `studies.ts`, `studiesStore.ts`, `studiesPorts.ts` | Split tests (A12): the logic, its `ads_studies` table, and its wiring to the other modules |
| `ownership.ts` | Tenant isolation: every id from a request or a queued op is re-checked against the stored copy (`ownObject`) |
| `tenantsOverview.ts` | The platform admin's view of every tenant's ads (`GET /api/admin/ads/tenants`), Postgres only |
| `proposals/` | AI proposals (A7): Claude drafts a campaign or a change; checks, states, the daily review, `ports.ts` |
| `testDb.ts`, `testing/` | Tests only: fake pools (the advisory lock really waits; the queue's markers; objects and settings) |

Tests sit beside each file. FLOWS.md §11 walks the money rule and the guard (§11.1), the sync and the queue (§11.2), creating an ad (§11.3) and the rules (§11.6) hop by hop; Help → Ads is the user-facing article.
