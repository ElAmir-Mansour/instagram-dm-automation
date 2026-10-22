# `src/services/ads/` — the Ads Manager's domain

The home of everything that talks to the Meta Marketing API for ads. The design and the phases live in the local spec folder
`002-meta-ads-manager` (`plan.md`; `docs/` is not public). v1's `metaAds.ts` and `adsManager.ts` moved here in A2 (`metaAds.ts`,
`manager.ts`; the old paths re-export for one phase); `adsCap.ts` re-exports `money.ts`; `adBoosts.ts` (Boost) stays one level up.

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
| `settings.ts` | The `ads.*` settings families, ceilings, alert recipients, the setup steps |
| `spendCap.ts` | Meta's account spending limit: set, read back, 10 a day |
| `ops.ts` | The paced write queue: enqueue, claim, execute, verify, reap, `drainAdsOps`, `runOpInline` |
| `actions.ts` | The owner's actions as ops (status, budget, archive, delete) and v1's adapters (`writeNow`); `ownObject` resolves every `:id` |
| `sync.ts` | The structure sync (hourly), today's results (4 h), the 28 days and breakdowns (daily); `requestTodaySync` |
| `mirror.ts` | The stored copy: upserts, deletion marking, the reads and `ObjectView`, `forgetStoredCopy` |
| `overview.ts` | `GET /overview` from the stored copy: health, money, needs attention, queued changes |
| `metaAds.ts`, `manager.ts` | v1's Graph helpers and campaign controls (moved here in A2) |
| `testDb.ts`, `testing/` | Tests only: fake pools (the advisory lock really waits; the queue's markers; objects and settings) |

Tests sit beside each file. FLOWS.md §11 walks the money rule and the guard (§11.1) and the sync and the queue (§11.2) hop by hop; Help → Ads is the user-facing article.
