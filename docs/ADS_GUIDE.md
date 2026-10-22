# Ads Manager: operator and client guide

Covers the Meta ads module (Marketing API) of AutoReply Pro as of phase A1 ("Safety foundation"). The in-app version of the
connection steps and the money rule is the Help Center article `#/help/ads` (Arabic and English); this file is the
operator's copy and may be more technical. The spec lives in `docs/specs/002-meta-ads-manager/` (local, not public).

---

## What the Ads Manager does

AutoReply Pro creates, watches and limits Meta ads for a tenant's own ad account. A1 is the safety layer under every ad
action; the screens that build ads come in later phases.

- **Boost** a post from the Scheduler (`ad_boosts`, v52) and manage the campaigns in the **Ads** screen: activate, pause,
  change a budget, delete. Everything is created **PAUSED**; nothing is spent until the owner confirms **Activate**.
- **One money rule** (see below) used by every screen and every action, so Boost, Settings and the Ads overview show the
  same "remaining this month" figure.
- **A spending guard** that pauses ACTIVE campaigns when the month's worst case would pass the monthly cap. It looks at
  the whole ad account, including campaigns made in Meta Ads Manager or other tools.
- **Alerts** to the tenant's own Telegram chat and/or email when the guard pauses spending, a payment fails, the account
  is disabled, or the token dies.
- **A daily account health check**: account status, funding status, spend cap, amount spent, token validity.
- **Per tenant, own token.** Each tenant pastes a system-user token from its own Meta business. Facebook Connect is an
  optional second source for the owner only. Ads run on the Limited access tier (no App Review needed for assets the token's
  business owns).
- **Feature switch:** ads are off for a tenant until the platform admin enables it (`POST /api/admin/ads/tenants/:id/enabled`;
  a tenant that is not the platform owner needs a ceiling first, `.../ceiling`). When off, every `/api/ads/*` route answers
  404 `ADS_DISABLED`.

Settings keys, all in `app_settings` (DB first, never env):

| Key | Holds |
|---|---|
| `ads.enabled.<tenant>` | the feature switch |
| `ads.settings.<tenant>` | JSON: `adAccountId` (digits, no `act_`), `maxDailyBudget`, `monthlyCap`, `tokenSource`, `tokenExpiresAt` |
| `ads.token.<tenant>` | the ads token, `enc:v1:` AES-256-GCM |
| `ads.alerts.<tenant>` | `{ telegramChatId, email, lang, kinds }` |
| `ads.api_version` | platform: the pinned Marketing API version (default `v26.0`, floor `v25.0`) |
| `ads.copy_admin` | platform: send a copy of every tenant alert to the platform admin (default on) |

---

## Connect your ad account (system-user token, step by step)

Same steps for the owner and for every client. The client does this in **their own** Meta business and pastes the token
into **their own** dashboard; nobody sends a token in chat or email.

**Before you start:** the ad account, the Facebook Page and the Instagram professional account must belong to (or be
shared with) the Meta business you use. The ad account needs a payment method (add it in Meta billing; the app cannot).

1. Meta **Business Settings** (business.facebook.com/settings) → **Users** → **System users**.
2. **Add** → a name (for example "AutoReply") → role **Admin** or **Employee** → **Create system user**.
3. Select the new system user → **Assign assets** and assign:
   - **Ad accounts** → the account, with **Manage campaigns** (full control also works);
   - **Pages** → the Page (full control or the task that allows creating ads);
   - **Instagram accounts** → the Instagram account.
4. **Generate new token** → choose the **app** (the platform admin tells you which; for the owner it is the app behind the
   webhook, ID in `docs/TOKEN_GUIDE.md`).
5. **Token expiration:** **Never**.
6. Tick the permissions: `ads_management`, `ads_read`, `business_management`, `pages_read_engagement`, `pages_manage_ads`.
7. **Generate token**, copy it. Meta shows it once.
8. In AutoReply: **Settings → Connections → Meta ads (Boost)** → paste into **System-user ads token** → enter the
   **ad account ID** → **Save** (the token is encrypted before it is stored and is never returned by the API again).
9. Press **Test connection**. The server (`POST /api/ads/settings/test`, 1 to 2 Meta calls) lists the scopes the token has and the
   ones it lacks, and the assigned ad accounts, Pages and Instagram accounts. Fix whatever is missing in Meta, then test again.
10. Set the **Max daily budget** and the **Monthly spend cap** (the checklist shows four steps: token, account, payment, limits).

**Finding the ad account ID:** in Ads Manager, the number after `act=` in the page address; or Business Settings →
Accounts → **Ad accounts**. Enter it with or without the `act_` prefix.

**Checking it from a terminal** (read-only, makes no change): `node scripts/ads-probe.mjs` prints the access tier, the
version Meta served, minimum budgets, account status and funding (type only), the token's scopes and expiry, the assigned
assets and the boost eligibility of the last 5 reels. See "Troubleshooting" for flags.

---

## Limits and the money rule

One rule, one module (`adsMoney`), every screen and action. In plain words:

> this month's spend in the ad account (all campaigns, including ones made in Meta Ads Manager)
> + the most every running budget can still spend this month
> + what is about to be switched on
> must be at or below the monthly cap.

- **Daily budgets** count at up to **1.75 times** the budget for the current day only (Meta may spend up to 75% over a daily
  budget on one day; shown to users as "average per day, may reach +75% on a day") and at 1.0 for the remaining days.
- **Lifetime budgets** (a boost's ad set): a lifetime budget is checked against the daily max as `amount / days`.
- **The month** is the **ad account's time zone** (`timezone_name`), not the tenant's or UTC.
- **Figures exclude tax.** Meta's invoices are the accounting record; every spend figure on screen carries that note.
- `GET /api/ads/money?candidate=<daily|lifetime>:<amount>:<days>` returns `{ fits, remaining, worstCase, spentThisMonth, ... }`
  (cached about 60 s per tenant). `remaining` is the cap minus the worst case without the candidate.
- Refusals use the codes `OVER_MONTHLY_CAP`, `OVER_DAILY_MAX`, `OVER_CEILING` (the platform ceiling), `BELOW_META_MINIMUM`.
- **Max daily budget** applies to every ad set. **Platform ceiling** (set by the platform admin per managed
  tenant, `POST /api/admin/ads/tenants/:id/ceiling`) caps both limits; a tenant cannot save a limit above it.
- **Account spending limit** is Meta's own `spend_cap` on the ad account: a second net. It can be set or cleared from Settings
  (`POST /api/ads/spend-cap`, `confirm: true`), is read back after every write, and Meta allows at most 10 changes a day
  (`17/1885172` → `EDIT_LIMIT`). Units are verified on the live account (see the probe).
- Saving a monthly cap at or below this month's spend succeeds, answers `warnings: ['will_pause_all']` and runs the guard
  at once: every active campaign is paused.

---

## Alerts

Sent by `adsNotify` to the tenant's recipients (`ads.alerts.<tenant>`: Telegram chat id and/or email, language), with a copy
to the platform admin's channel while `ads.copy_admin` is on. The deployment's Telegram bot and email key (`notify.*`) are
reused; only the recipient is per tenant. Rows are deduplicated on `(tenant, kind, object_key, day)` in `ads_alerts`, so one
alert per kind and object per day. `ads_alerts` rows are kept one year.

| Kind | Raised when |
|---|---|
| `cap_paused` | the guard paused campaigns at the cap (also writes an audit row). **Cannot be switched off** |
| `payment` | a payment problem found by the daily check (unsettled account, failed funding) |
| `account_disabled` | the daily check finds the account disabled or closed |
| `token_dead` | Meta answered `190` or `102`; the tenant's queue stops and `token.health` becomes `dead`. **Cannot be switched off** |
| `token_expiring` | a token with an end date (Connect) is within 14 days of it |
| `guard_blind` | no successful guard check for 2 hours (dead token, throttling, Meta error). **Cannot be switched off** |
| `version_mismatch` | the `facebook-api-version` response header differs from `ads.api_version` |

Tenant side: **Settings → Meta ads (Boost) → Alert recipients** has the chat id, email, language, one toggle per kind and
**Send test message** (`POST /api/ads/settings/alerts` with `test: true`). To find a Telegram chat id: press Start on the
alerts account, then message `@userinfobot`, which replies with the Id.

An alert holds the kind of problem, the ad account and amounts (spend, cap). Never customer data or card data. This is what
`public/privacy.html` promises; change both together.

---

## Account health

The daily pass (the 00:00 UTC cron) reads for every enabled tenant: `account_status`, `disable_reason`, `funding_source_details`
(type and presence only are kept), `is_prepay_account`, `spend_cap`, `amount_spent`, `balance`, and checks the token
(`debug_token` for Connect tokens, a cheap `GET /me?fields=id` otherwise). The result is stored on the settings view
(`account.syncedAt` shows when).

`account_status` values:

| Status | Meaning | What to do |
|---|---|---|
| 1 | Active | nothing |
| 2 | Disabled (see `disable_reason`) | appeal in Meta Account Quality; nothing can run until reactivated |
| 3 | Unsettled (payment due) | pay in Meta billing |
| 7 | Pending risk review | wait for Meta's answer |
| 8 | Pending settlement | a payment is being processed; usually clears within hours |
| 9 | In grace period | a payment is late but the account still runs; pay before the grace ends |
| 100 | Pending closure | contact Meta support if it is a mistake |
| 101 | Closed | permanent; use another account |
| 201 / 202 | any active / any closed | query values, not states of one account |

No payment method blocks Activate (the app cannot add one). A prepay account spends from its balance and stops when it runs out.

---

## Troubleshooting

- **No Connect button:** Connect is optional and off unless the platform enables it. Paste a system-user token.
- **Token dead (`190`/`102`, `token_dead` alert):** generate a new token (steps above), paste, **Test connection**. Until then
  the guard cannot pause anything. Rotation details in `docs/TOKEN_GUIDE.md` ("Ads token").
- **Payment failed:** fix in Meta billing; the next daily check clears it.
- **Rate-limited (`RATE_LIMITED`, `retryAt`):** Meta allows about 60 points per 5 minutes on the Limited tier (read = 1, write = 3).
  Throttle codes (`17/2446079`, `613/*` except `613/1487632`, `80000`, `80003`, `80004`, `80014`, `4/1504022`, `4/1504039`) are
  never retried: the pacer records `blocked_until` and waits. Look for `ads.throttled` in the logs.
- **"Spending is not being watched" banner / `guard_blind`:** the hourly guard (`enforceMonthlyCaps`, run inside
  `/api/jobs/drain`) has had no successful check for 2 hours. Causes: dead token, throttling, Meta outage. It writes
  `ads.cap_checked` only after a successful check. `GET /api/ads/overview` → `guard: { lastCheckedAt, blind }`.
- **`EDIT_LIMIT`:** 4 budget changes per hour per ad set (`613/1487632`) or 10 spend-cap changes per day (`17/1885172`); `retryAt` says when.
- **`10/1341012`:** the system user lacks the Page assignment: assign the Page in step 3.
- **Probe:** `node scripts/ads-probe.mjs [--tenant <uuid>] [--env <path>] [--json]`. Read-only: DB through `connectReadOnly`, only GET
  calls to Meta, token in the `Authorization` header, nothing secret printed (funding display strings are cut to the last 4
  digits). Exit 0 all sections answered, 1 a section was refused, 3 could not run. Money fields print in Meta's minor units on purpose.
