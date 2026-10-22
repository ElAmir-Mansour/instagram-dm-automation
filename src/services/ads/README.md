# `src/services/ads/` — the Ads Manager's domain

The home of everything that talks to the Meta Marketing API for ads. The design and the phases live in the local spec folder
`002-meta-ads-manager` (`plan.md`; `docs/` is not public). v1's `metaAds.ts`, `adBoosts.ts`, `adsCap.ts` and `adsManager.ts` sit one
level up and are folded in here during phase A2.

## The rules every file here keeps

1. **Stored copy first.** Screens read Postgres, not Meta. A1 stores the account and token check (`ads.health.<tenant>`); A2 adds the
   stored copy of every campaign, ad set and ad (`ads_objects`, `ads_insights_daily`). A GET that must call Meta says so in its comment.
2. **Every write goes through `ads_ops`.** A1 records each activation, resume, budget raise and spending-limit change there (the money
   rule counts a running one as "about to run"); A2 turns it into the paced queue that sends them.
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
| `testDb.ts` | Tests only: a fake pool whose advisory lock really waits |

Tests sit beside each file. FLOWS.md §11 walks the money rule and the guard hop by hop; Help → Ads is the user-facing article.
