# Ads Manager: operator and client guide

Covers the Meta ads module (Marketing API) of AutoReply Pro, phases A1–A12 (all shipped 2026-10-22). The in-app version of the
connection steps and the money rule is the Help Center article `#/help/ads` (Arabic and English); this file is the
operator's copy and may be more technical. The design spec is kept outside this public repo.

---

## What the Ads Manager does

AutoReply Pro creates, watches and limits Meta ads for a tenant's own ad account. A1 is the safety layer under every ad
action. On top of it, the **Ads** screen has these tabs: Overview, Campaigns (A2), Create (A4 message ads, A5 every goal),
Results (A6), Proposals (A7, Claude drafts; nothing runs until you approve), Audiences (A8), Rules (A9), Leads (A10) and
Tests (A12). Managed clients (A11) use the same screens with their own token and ad account. Each has a section below.

- **Boost** a post from the Scheduler (`ad_boosts`, v52) and manage the campaigns in **Ads → Campaigns**: activate, pause,
  change a budget, duplicate, archive, delete. Everything is created **PAUSED**; nothing is spent until the owner confirms **Activate**.
- **One money rule** (see below) used by every screen and every action, so Boost, Settings and the Ads overview show the
  same "remaining this month" figure.
- **A spending guard** that pauses ACTIVE campaigns when the month's worst case would pass the monthly cap. It looks at
  the whole ad account, including campaigns made in Meta Ads Manager or other tools.
- **Alerts** to the tenant's own Telegram chat and/or email when the guard pauses spending, a payment fails, the account
  is disabled, or the token dies.
- **A daily account health check**: account status, funding status, spend cap, amount spent, token validity.
- **Per tenant, own token.** Each tenant pastes a system-user token from its own Meta business. Where the platform has set up
  Facebook Connect with the ads scopes, the card leads with **Connect ads with one click** and puts the pasted token under
  **Advanced: paste a system-user token**; a Connect token never carries `pages_manage_ads` (Facebook Login asks only for
  `ads_read`, `ads_management` and `business_management`), so the system-user token stays the reliable one for ads. Ads run on the Limited access tier (no App Review needed for assets the token's
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

| Kind | On the card as | Raised when |
|---|---|---|
| `cap_paused` | Campaigns paused because the cap was reached | the guard paused campaigns at the cap (also writes an audit row). **Cannot be switched off** |
| `payment` | Payment problems | the daily check finds a payment problem (unsettled account, failed funding) |
| `account_disabled` | The ad account was disabled | the daily check finds the account disabled or closed |
| `ad_rejected` | An ad was rejected | **Not raised yet.** The checkbox is on the card, but nothing in the app sends this alert today (`src/services/ads/notify.ts` defines it; no caller). The rule template **Ad rejected → tell me** (Rules tab) catches rejected ads instead |
| `ad_issues` | An ad has issues | **Not raised yet**, as above; the same rule template catches an ad Meta marks `WITH_ISSUES` |
| `token_dead` | The ads access stopped working | Meta answered `190` or `102`; the tenant's queue stops and `token.health` becomes `dead`. **Cannot be switched off** |
| `token_expiring` | The ads access is about to expire | a token with an end date (Connect) is within 14 days of it |
| `guard_blind` | Spending is not being watched | no successful guard check for 2 hours (dead token, throttling, Meta error). **Cannot be switched off** |
| `version_mismatch` | Meta changed the API version it answers on | the `facebook-api-version` response header differs from `ads.api_version` |
| `business_ai` | Meta Business AI took over a conversation | Meta refused a reply because its Business AI holds the Instagram thread (100 / 2534037; see "Ads and the DM assistant" below) |
| `window_error` | Meta refused a reply outside the window | a reply in the longer click-to-message window was refused, and that window was switched off for the platform |
| `proposal_ready` | Claude proposed changes to your running ads | the daily review (A7) produced proposals |
| `rule_acted` | A rule paused, lowered, proposed or told you something | one of your rules (A9) acted |
| `rule_blind` | A rule has not watched your ads for 24 hours | a rule could not run for a day |

Fourteen kinds are on the card (`SHOWN_ALERT_KINDS`, `src/services/ads/settings.ts`); a fifteenth, `lead_received`, belongs to
lead ads (A10). The three marked above cannot be switched off (`REQUIRED_ALERT_KINDS`).

Tenant side: **Settings → Connections → Meta ads (Boost) → Alert recipients** has the chat id, email, language, one toggle per kind and
**Send a test** (`POST /api/ads/settings/alerts` with `test: true`). To find a Telegram chat id: press Start on the
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

## Campaigns and queued changes

**What the screens read.** The Ads screen's reading tabs, **Overview**, **Campaigns** and **Results** (below), All read the app's **stored copy** of the ad
account (`ads_objects`, `ads_insights_daily`), never Meta live, so viewing costs none of Meta's 60 points per 5 minutes:

| What | Refreshed | From |
|---|---|---|
| Campaigns, ad sets, ads, statuses, review notes, budgets | every hour (drain) | `syncStructure`, `src/services/ads/sync.ts` |
| Today's results | every 4 hours, or **Refresh results** (once per 15 min) | `syncInsights(…, 'today')` |
| The last 28 days, with country and placement breakdowns | daily cron | `syncDailyAds` |
| Account status, payment method, token health | daily cron, and **Test connection** | `runAdsHealth`, `health.ts` |

The last 3 days of results are **provisional** (Meta revises them). Results are kept 37 months. Removing the token, choosing another ad
account or disconnecting Meta deletes the stored copy.

**Every change is queued.** Pause, resume, budget, end date, archive and delete each become one `ads_ops` row, sent in order per object
within Meta's limits: **4 budget changes per ad set per hour**, **30 s between edits of one object**, **10 spending-limit changes a
day**. A press tries to send at once; otherwise the change waits and the screen shows **expected at**. States: queued (`pending`),
sending (`running`), checking (`verify`: Meta did not answer, so the app reads back before anything is resent), done, failed.

- **Resume and budget raises** still need **confirm** and pass the money rule; the check happens before the change is queued, and a
  queued change counts as about to run for the next check.
- **Archive** is how a campaign ends (results stay). **Delete** is a separate, confirmed action and is refused while running. The
  Boost **Delete** button and v1's campaign delete now archive.
- **A create is never sent twice:** each create's name carries `AR·<op id>`; after a timeout the app searches for it, adopts it if
  found, and resends at most once after two misses 60 s apart.

**Where to look.** `GET /api/ads/ops?state=pending,running,verify` lists waiting changes; `GET /api/ads/ops/<id>` one. Logs:
`ads.ops_drain`, `ads.sync_sweep`, `cron.ads_daily_sync`, `ads.op_inline_failed`. Audit: `ads.op_enqueued`, `ads.op_applied`,
`ads.op_failed`. Flow, hop by hop: `FLOWS.md` §11.2. Help Center: `#/help/ads#campaigns`, `#queued-changes`, `#statuses`.

---

## Your first message ad

A message ad is an ad whose button opens a chat (Instagram Direct, Messenger, WhatsApp, or a mix) instead of a website.
The DM assistant or the WhatsApp agent answers there. It is built from an existing post (best: an Instagram reel) with the
Scheduler (Posts) screen's **Boost** button → goal **Send messages** (the "quick mode" of the ads builder,
`dashboard/js/pages/ads_builder.js`). Everything is created **PAUSED**; nothing is spent until **Activate** on the Ads screen.

### Before you start

| Need | Why |
|---|---|
| Ads connected, **Max daily budget** and **Monthly spend cap** set | the money rule refuses a create or an activate that does not fit (see "Limits and the money rule") |
| A published reel or post | the creative points at the existing post (`source_instagram_media_id`, or `object_story_id` for Facebook) |
| Instagram: an IG professional account connected to the Page | `INSTAGRAM_DIRECT` destination needs `instagram_user_id` |
| WhatsApp: a WhatsApp Business number linked to the Page | `promoted_object.whatsapp_phone_number`; without it the create is refused (`UNSUPPORTED`, field `destinations`) |
| Messenger: the Page | a **Facebook post is refused for Messenger** until live-checked (below): use the Instagram copy of the reel |
| The assistant for each destination is **on** | otherwise the people who click are not answered (see step 8) |

### Steps

1. **Scheduler → open the reel → Boost.** The quick-mode dialog opens with the post preselected. The caption is shown read-only: it
   *is* the ad text for a boosted post.
2. **Goal → Send messages**, then tick the **destinations** (one or more of Instagram, Messenger, WhatsApp). More than one
   destination makes one ad with several message buttons (`asset_feed_spec.optimization_type = DOF_MESSAGING_DESTINATION`).
3. **Countries** (default from settings, `SA` when empty), **daily budget** and **days** (1 to 30). The total (daily × days) is
   sent as a **lifetime budget** on the ad set with an end time, so Meta never spends more than the total. The money rule checks
   the total against the monthly cap, and `amount / days` against the max daily budget.
4. **Greeting and ice breakers: not on a boosted post.** Meta refuses them there (see the caveats below); the fields are hidden and
   the chat opens with Meta's greeting. For an ad from uploaded media (A5): greeting ≤ 300 characters, up to **4 ice breakers** (title ≤ 80,
   optional automatic answer ≤ 300). Example copy (فصحى, passes the policy check):

   | Field | Text |
   |---|---|
   | Caption (ad text) | تعلّم بناء وكلاء الذكاء الاصطناعي خطوة بخطوة بمشاريع عملية |
   | Greeting | مرحبًا! يسعدنا مساعدتك في اختيار الدورة المناسبة. ما الذي تودّ معرفته؟ |
   | Ice breaker 1 | ما محتوى الدورة؟ |
   | Ice breaker 2 | هل تناسب المبتدئين؟ — answer: نعم، تبدأ من الأساسيات وتبني مشروعاً كاملاً بالتدريج. |
   | Ice breaker 3 | كيف أسجّل؟ |

5. **Review** runs `POST /api/ads/drafts/validate` (about 7 Meta points): the **policy check** (on the caption as stored), the
   **money check**, **Meta's validation** (`validate_only` on the campaign and on the creative; nothing is created) and **the minimum
   daily budget** Meta accepts for the account. Meta is asked only when nothing else blocks.
   The policy check also runs while you type (`POST /api/ads/policy`, debounced, no Meta call).
   - **Block** findings highlight the phrase with the reason and a rewrite, and disable **Create** until the text changes.
   - **Warn** findings (certificate wording, "limited time" with no date, a "you…?" question) need the box
     "I have read the warnings" (`confirmPolicyWarnings: true`; without it the server answers `POLICY_WARNINGS`).
   - A caption that is blocked cannot be fixed here (it belongs to the post): choose another post.
6. **Create** (`POST /api/ads/drafts`) re-runs the policy check and the money check on the server, then queues four ops:
   campaign → ad set → creative → ad, each waiting for the previous one (`depends_on`). Every object is `PAUSED` and its
   name ends with the tag `AR·<op id>`, which is how an op that timed out is found again instead of being re-sent. The ad set and
   the ad get the ids of their parents from the earlier ops (`{op:<id>}` placeholders, filled when they run).
7. **Activate** from the Ads screen. The money rule runs again at that moment (the month may have moved since).
8. **Bot check before activating.** Review warns per destination: assistant **off** → nobody answers; WhatsApp agent in **test** →
   only the listed test senders get an answer; DM sales in **test** (`sales_test`) → everyone is answered but only testers are sold
   to; **not connected** → no answer. The DM assistant answers ad conversations like any other DM
   (they carry the ad's id in `conversations.entry_source`), and the Ads screen counts those conversations per ad.
   Do **not** activate while the warning stands unless you want unanswered chats.

### Ads and the DM assistant (A3)

How a click-to-message ad reaches the DM assistant, and the two switches under **Conversations from ads** (Settings → Connections →
Meta ads; both off by default, `src/services/ads/switches.ts`):

- **Where the ad id arrives.** Instagram sends it on the first message; Messenger on the greeting or ice-breaker tap of a NEW
  thread, and on an EXISTING thread only as a separate `referral` event, which needs the Page field `messaging_referrals`. A Page
  connected before A3 gets that field on its next Facebook reconnect. The first ad a person came from is kept
  (`conversations.entry_source`); later taps go to `ad_touches` (the newest 10).
- **Give the assistant the ad's context** (`ads.bot_context.<tenant>`): the assistant is told which ad the person came from, the
  offer it is about and the question they tapped. Off, the prompt is exactly as without ads.
- **Reply window for ad conversations** → **Use the longer window on Instagram / Messenger** (`ads.extended_window.<tenant>`): replies are allowed for 7 days less an hour from the
  ad click on those threads. Turn it on only after a real day-2 reply has been accepted; a refusal (10/2018278 or 551) turns it
  off for that platform by itself and raises `window_error`.
- **Meta Business AI** (error 100 / 2534037): Meta's own AI holds the Instagram thread and every reply from the assistant is
  refused. Nothing is retried; the conversation is marked `business_ai_owns_thread` and one `business_ai` alert goes out. The fix
  is in Meta Business Suite → Business AI → "Take control of conversations with your Business AI".

The Help Center has the same in Help → Ads (message-ads-inbox, bot-and-ads, reply-window, business-ai).

### Checklist before you press Activate

- [ ] Review showed no block; every warning was read, and you agree with each.
- [ ] The total and the "remaining this month" figure are what you meant (the total is a **lifetime** budget).
- [ ] Meta's minimum budget for the account is below your daily figure (else `BELOW_META_MINIMUM`).
- [ ] The assistant for every chosen destination is **on** (not off, not test).
- [ ] In Meta Ads Manager (search `AR·`): campaign, ad set, ad and creative exist, all paused, and the preview shows the right
      post and the right button (Send message / Message / WhatsApp).
- [ ] The page your offer links to (for the owner: the Udemy course description) has no income claims: Meta reviews it too.

### The policy check, in one page

`src/services/ads/policy.ts` (versioned, deterministic, Arabic normalised, no model). Why: repeated rejections can restrict the
ad account and the Page the bot runs on. **Block:** income figures («اكسب 500$ يومياً»), passive income and get-rich wording
(«دخل سلبي», «ثراء سريع»), minimal effort («بدون مجهود», «وأنت نائم»), quitting a job («اترك وظيفتك»), guaranteed results
(«مضمون 100%»), job promises («احصل على وظيفة»), and "you + personal attribute" («هل أنت عاطل عن العمل؟», «ديونك؟»).
**Warn:** «هل أنت مبرمج؟» (borderline), «شهادة معتمدة» (may make Meta treat it as the EMPLOYMENT special ad category, which narrows
targeting), «لفترة محدودة» without a date. The rule of thumb: **sell the skill, not the money.** Passing the check does not
promise approval; Meta reviews each ad (typically within 24 hours) and can re-review it later. After a rejection: fix the
cause first, then ask for **one** review in Meta's Account Quality; repeated appeals slow the answer.

### Live-check caveats (not yet proven against Meta; do not promise these to a client)

- **No greeting on a boosted post (live-checked 2026-10-22).** `validate_only` on the owner's account answered "(#100) Invalid keys
  "page_welcome_message" were found in param "call_to_action[value]"", and Meta documents no other place for a greeting on a creative
  built from a post. So `POST_GREETING_PLACEMENT = 'omit'` (`spec.ts`) and quick mode hides the greeting and ice breakers
  (`GREETING_ON_POST: false`): the chat opens with Meta's greeting, and the Instagram ice breakers from Settings still show on a new chat.
  Ads from uploaded media (A5) carry the greeting under `link_data` / `video_data`.
- **A Facebook post for a Messenger ad is refused** (`UNSUPPORTED`, field `ads.<i>.creative`) while
  `FB_POST_MESSENGER_OK = false`. Meta's pages disagree (`object_story_id` "not supported" for Messenger creatives on one page,
  supported on another). Flip the constant only after a `validate_only` call that succeeds, and record the result in
  research.md R11.
- **Creative opt-outs.** Meta accepts only 7 keys in `creative_features_spec` on EVERY creative (live-checked 2026-10-22 on a post
  creative in A4, and on an uploaded video and a 9:16 placement creative in A5: "`music` must be one of {IG_VIDEO_NATIVE_SUBTITLE,
  IMAGE_ANIMATION, PRODUCT_BROWSING, PRODUCT_METADATA_AUTOMATION, PROFILE_CARD, STANDARD_ENHANCEMENTS_CATALOG,
  TEXT_OVERLAY_TRANSLATION}"; `adapt_to_placement` is refused too). `CREATIVE_OPT_OUTS` is the four of those that could change what is
  shown, all OPT_OUT. The rewriting and generative features cannot be named through the API; the app never opts in to them.
- **Real delivery** (review, conversations labelled with the ad, cost per conversation next day) is checked only with the
  owner's OK, one day at the minimum budget (quickstart §A4 step 4).

### Build any campaign

The **Create** tab of the Ads screen (`#/ads_create`, `dashboard/js/pages/ads_create.js`) is the full builder. Boost on the Scheduler
is its quick mode; both end in the same `CampaignSpec` and the same server functions (`drafts.ts`). Everything is created **PAUSED**.

### The eight steps

| Step | What you choose | Rules the builder keeps |
|---|---|---|
| 1. Goal | Messages, Visits to a link, Engagement, Reach, and Leads (offered, but locked for a workspace until the platform admin records its legal sign-off, A10) | Only what the goal allows is offered later |
| 2. Destination | Messages: Instagram / Messenger / WhatsApp. Link: one of your offers (tracked) or another https address | A free address is warned: its clicks are not counted |
| 3. Creative | A published post, or an image / video from your computer, with an optional 9:16 version (link ads) | Engagement and Reach use a post; a Facebook post is refused for message and link ads; a video needs a cover |
| 4. Text | Main text (the feed shows 125 characters, then "more"), headline, button; a message ad's greeting and quick questions | The policy check runs 400 ms after you stop typing |
| 5. Audience | Countries, cities with a 17–80 km radius, age, gender, languages, interests, Advantage audience, special category | Advantage audience: minimum age 18–25, no maximum (Meta fixes 65). A special category: everyone 18–65, no gender, no interests, radius ≥ 25 km; political is refused |
| 6. Placements | Automatic (recommended) or chosen | Instagram Explore, Facebook video feeds and Messenger Stories are never offered (Meta removed them) |
| 7. Budget and schedule | On the ad set or the campaign; total (needs an end) or daily; start and end; days and hours | A schedule needs a total budget; the money rule and Meta's minimum are shown beside the amount |
| 8. Review | Meta's `validate_only`, the money, the reach estimate, a preview per placement | Create sends exactly what was reviewed; any change asks for a new review |

### Uploads (why a 50 MB video works on Vercel)

1. The browser asks `POST /api/ads/uploads/sign` (owner) for a signed Supabase Storage URL, and PUTs the file there itself, with a
   progress bar. The app never receives the bytes, so Vercel's 4.5 MB body limit does not apply. Limits: JPG/PNG ≤ 30 MB, MP4/MOV ≤
   50 MB (Supabase's free per-file limit).
2. `POST /api/ads/creatives/from-media` hands it to Meta: an image's bytes to `adimages` (→ a hash); a video by its public address
   `<public base>/api/uploads/<id>` to `advideos` with `file_url` — Meta pulls the file. What Meta answered is kept in
   `ads.media.<tenant>`. A video waits for its cover (frame 0 is black).
3. At Review and Create the server checks a video is `ready` at Meta (1 point while it processes); "still processing" is a problem
   in Review, never a half-made ad.

The dashboard's CSP allows `connect-src https://*.supabase.co` (the PUT) and `frame-src https://www.facebook.com` (Meta's
previews), in `vercel.json` and `routes/api.ts` `securityHeaders`. If the Storage project ever moves to a custom domain, add it there.

### The 9:16 version

For an uploaded creative on a link ad, a second file becomes the Stories version through placement customisation
(`asset_feed_spec`, `optimization_type: PLACEMENT`, two `asset_customization_rules`). Meta does not allow it on an existing post.
**Reels positions are a live check**: `REELS_CUSTOMISATION_LIVE_CHECKED = false` in `src/services/ads/creatives.ts`, so only Stories
gets the 9:16 version until a `validate_only` with `reels` succeeds (then flip it and record the result in research.md R11).

### Previews

Review asks `generatepreviews` for two placements (1 point each). Meta's answer is an iframe; the dashboard takes only its address,
and only on `www.facebook.com`. When Meta will not preview for the token (a system-user token may not), the dashboard draws an
**approximate preview**: the picture cropped to the frame (Feed 4:5, Stories/Reels 9:16), the Page's initial (never a photo of a
person), the text cut at 125 characters, the headline and button, a message ad's greeting and quick questions.

### Duplicate, archive, delete

On the Campaigns tab: **Duplicate** (`POST /objects/:id/duplicate`) queues a `/copies` call: the copy is PAUSED, every name gets
` · copy AR·<key>`, and it re-enters Meta's review and learning. **Archive** keeps the history; **Delete** is a separate confirmed
action and never on a running object.

### Not yet proven live (2026-10-22)

- The system user has no Page / Instagram asset, so creative creates (and previews) are refused by Meta until it is assigned in
  Business Settings → System users → Assign assets. Review then shows Meta's refusal and nothing is created.
- `REELS_CUSTOMISATION_LIVE_CHECKED`, the `generatepreviews` answer for a system-user token, and `advideos` `file_url` from our
  domain are checked on the first live run (quickstart §A5).

## Troubleshooting a create

| What you see | Meaning |
|---|---|
| `POLICY_BLOCKED` (422, with `findings`) | the server's policy check blocked a text; edit it, or choose another post if it is the caption |
| `POLICY_WARNINGS` (409, with `findings`) | a warning was not confirmed; read it, tick the box, create again |
| `OVER_MONTHLY_CAP`, `OVER_DAILY_MAX` | the money rule (`GET /money`); Review shows what is left |
| `BELOW_META_MINIMUM` | the daily figure is below Meta's minimum for this account |
| `UNSUPPORTED` + field | not allowed yet: Facebook post for Messenger, WhatsApp without a linked number, a lead goal (A10), several destinations with a special ad category |
| Review: "Meta said no" | Meta's `validate_only` refused the campaign or the creative; its message names the field. Fix and Review again |
| `RATE_LIMITED` (`retryAt`) | the pacer is waiting; nothing was lost |
| Ads Manager shows a campaign but no ad | an op later in the chain failed or is waiting; the failed op shows Meta's reason, the ops after it fail `DEPENDENCY_FAILED`. Nothing spends |
| Creative fails: the Page or IG account is not assigned | the system user has no Page / IG asset (A1's probe, 2026-10-22): assign them in Business Settings → System users → Assign assets |

---

## Reading your results

**Where.** Ads → **Results** (`#/ads_results`). Pick a period (7, 28 or 90 days) and what to show: the whole ad account, one campaign
or one ad. Like the other tabs it reads the stored copy only (`GET /api/ads/results`), so it opens at once and costs no Meta points.

| On screen | What it is |
|---|---|
| **Spend** | What Meta spent each day, in the ad account's currency, **excluding tax** (Meta's invoices are the accounting record) |
| **Results** | What each ad was bought for (its ad set's optimisation goal): conversations, link clicks, leads or follows. A campaign with mixed goals adds each ad's own |
| **Cost per result / conversation / tracked click** | Spend ÷ the count; "—" when the count is 0 |
| **Tracked clicks** | The app's own count, not Meta's: **direct** = people's clicks on the ad's `/r/` link (`tracked_links.ads_object_id`); **via chat** = clicks on links the assistant sent in conversations the ad started (`entry_source.ad_id`). Link previews and bots are left out |
| **Handed to a person** | Conversations the ad started that were handed over (`handoff_at`) |
| **Compare by** | Ad, country (`EG`, `SA`…) or placement (`instagram:reels`…), from the stored breakdown rows. The countries add up to the total. Tracked clicks have no country, so they appear by ad only |

- **Days** are the ad account's days (its time zone), the same as Ads Manager; the app's own clicks are cut on the same midnights.
- **Provisional days.** Meta revises results for up to 28 days; the daily job re-reads the trailing 28. The last 3 days are shaded on
  every chart and marked "provisional"; compare settled days with Ads Manager.
- **Currencies** are never added together: one totals strip per currency, charts in the account's currency only.
- **No sales-based figure.** Sales happen on another website (for the owner, Udemy), which neither Meta nor the app can see, so there is no "return" figure of
  any kind (a lint test, `src/dashboard/no-roas.test.ts`, keeps it out of every string). The closest signals are tracked clicks on the
  offer link and conversations handed to a person.
- **Refresh.** The owner's **Refresh results** queues a today-refresh (at most once per 15 minutes, `POST /api/ads/sync`); the screen
  says when it is expected or when to try again. **Last updated** is always shown.
- **Elsewhere.** Growth shows a **Paid (ads)** card (daily spend, results, conversations, follows from ads; `overview.paid`), and the
  Results screen lists running or spending ads under the DM campaigns, each labelled **Ad**.

**Checking it against Meta.** Pick 7 settled days (older than 3 days) for the whole account: the spend total must equal Ads Manager's
for the same dates in the account's time zone, and the Egypt + Saudi comparison must add up to it. Flow, hop by hop: `FLOWS.md` §12.6.
Help Center: `#/help/ads#results`, `#provisional-numbers`, `#cost-per-conversation`.

---

## Audiences

**Where.** Ads → **Audiences** (`#/ads_audiences`). Saved groups of people that Meta builds; the builder's audience step includes or
excludes them (the picker under interests).

**Before the first one.** The ad account's owner accepts Meta's **Custom Audience Terms** once, in Meta. The API cannot accept them:
when the stored account read says they are not accepted, the tab shows a banner and a button to Meta's terms page, and creates are
refused with `TERMS_NOT_ACCEPTED`. A create that Meta refuses with `200/1870090` shows the same message on its card.

| Kind | Built from | Window |
|---|---|---|
| Instagram engagers | the connected Instagram account: engaged, any interaction, profile visit, or messaged | up to 730 days |
| Facebook Page engagers | the connected Page: engaged, visited, clicked a button, saved, or messaged | up to 730 days |
| People who messaged | Instagram, the Page, or both | up to 730 days |
| Video viewers | 1–50 published reels/videos: 3 s, ThruPlay, 25/50/75/95% | up to 365 days |
| Lookalike | a ready (or "too small" but ≥ 100 people) non-lookalike audience, one country, 1–20% | — |
| Customer list | emails / phones the owner uploads — **locked** until a legal sign-off (below) | — |

- **Statuses.** *Being created* until Meta has built it (the page re-reads every 10 s); *Ready* with Meta's size range; *Too small*
  under about 1,000 people (cannot be targeted, can seed a lookalike from 100); *Flagged by Meta* (`operation_status 471`: Meta
  judged it implies sensitive data; unusable, review only in Meta's UI; delete it and recreate with a neutral name).
- **Names are neutral.** The server refuses names implying health, financial status, religion, orientation, politics, or a DM-bot
  segment (`reason: sensitive_name`). The bot's conversation labels never become an audience or a seed.
- **Sizes** come from the hourly structure sync (`act_<id>/customaudiences`, only for tenants that have an audience).

**Customer lists and the legal lock.** Uploading contacts is personal-data processing under Egypt's PDPL 151/2020 (compliance
deadline 2026-11-01) and Saudi PDPL. So a tenant's customer lists stay **locked** until the platform admin records a sign-off:
Tenants → the tenant → **Ads: legal sign-off** → scope *Customer-list audiences*, countries (e.g. `EG, SA`), and a note saying who gave
the opinion and where it is filed. Revoking locks it again from the tenant's next request; rows are never deleted. Locked, the tab
shows what is needed and a Help link, and the API answers `403 LOCKED_LEGAL` before reading any text.

Unlocked, the owner pastes a list or picks a `.csv`/`.txt` (≤ 3 MB), chooses the country of numbers without a country code (only
covered countries), ticks the consent box and presses **Scramble and upload**. In the request the server normalises and SHA-256-hashes
every value, leaves out opted-out people (WhatsApp STOP / withdrawn marketing consent, and recorded do-not-target requests), rows
outside the covered countries, invalid rows and duplicates, and queues the hashes in batches of ≤ 10,000. The list text is never
stored; the hashes are cleared from the queue when each batch ends; the audience keeps only how many rows were sent.

**Do-not-target requests.** When someone asks not to be shown your ads, record their `+country` phone or email at the bottom of the
tab. Only its hash is kept; it is removed from every customer list already at Meta and left out of later uploads.

Flow, hop by hop: `FLOWS.md` §7.6. Help Center: `#/help/ads#audiences`, `#lookalikes`, `#customer-lists`.

## Lead ads

**Where.** Ads → **Leads** (`#/ads_leads`) for the forms and the leads; Ads → **Create**, goal **Leads**, for the ad.

**Locked until a legal sign-off.** A lead form collects personal data (names, phones, emails) under Egypt's PDPL 151/2020 (compliance
deadline 2026-11-01: a controller licence, a separate e-marketing licence, consent for transfers abroad) and Saudi PDPL (consent,
unsubscribe, records). So lead ads stay **locked per tenant** until the platform admin records a sign-off: Tenants → the tenant →
**Ads: legal sign-off** → scope *Lead ads*, the countries the opinion covers, and a note. While locked:
- `POST /api/ads/lead-forms` and a `goal: 'leads'` draft answer `403 LOCKED_LEGAL`; the Create tab shows the goal locked;
- the Page is NOT subscribed to `leadgen`, so Meta sends no lead; a stray `ads.lead` job for a locked tenant fetches nothing.

Recording the sign-off re-subscribes the Page with `leadgen` at once; revoking re-subscribes without it (and the 6-hourly catch-up
re-checks both). Leads already stored stay readable and keep their retention date after a revocation.

**Operator setup (once per app / per tenant).**
1. Meta app → Webhooks → **Page** → subscribe the field **`leadgen`** (the app-level subscription; without it no Page sends leads).
2. The tenant's Facebook connection needs `leads_retrieval` and `pages_manage_ads` (plus `pages_manage_metadata`, already held).
   Without App Review these work only for people with a role on the app.
3. If the Page uses **Leads Access Manager**, give the connecting person (or the app) access, or `GET /{leadgen_id}` is refused.
4. Record the sign-off (above). Check with Meta's **Lead Ads Testing Tool**: a test lead appears in the Leads tab within minutes.

**Make a form.** **New form** → name; language Arabic (`AR_AR`, default) or English; full name, email, phone, city; up to 5 questions of
your own; the optional consent question ("May we contact you by message or WhatsApp?", key `contact_consent`); the thank-you screen
(title, sentence, button, https link). Every form carries `privacy_policy.url = <site>/privacy`. Meta's restricted question types are
refused (an allow-list), and so is a question of your own whose label names a restricted category (health, religion, orientation,
criminal record, union, politics, ethnicity, money/account numbers, passwords, government ids) — `RESTRICTED_QUESTION` with the field.
The form is created with ONE `POST /{page_id}/leadgen_forms` using the tenant's **Page token** (not the ads token, not the queue);
a dialog's idempotency key makes a double submit one form; a create Meta never answered stays *Waiting for Meta* until the catch-up
finds it on the Page by name. Forms made in Ads Manager are picked up by the catch-up (*Made in Meta*).

**Make the ad.** Create → goal **Leads** → the form (active ones only) → an uploaded image or video (a post cannot carry the form) →
the button (**Sign up**, Learn more, Apply now, Subscribe, Get quote). Countries are limited to the sign-off's. Mapping: campaign
`OUTCOME_LEADS`; ad set `destination_type: ON_AD`, `optimization_goal: LEAD_GENERATION`, `promoted_object.page_id`; creative CTA
`{ type, value: { lead_gen_form_id } }` with `link: https://fb.me/`. Everything PAUSED. Claude proposals never produce a lead ad.

**How leads arrive.** The `leadgen` webhook → an `ads.lead` job (ids only) → `GET /{leadgen_id}` with the Page token → `ads_leads`.
A throttle is not retried. Every 6 hours per tenant the catch-up lists the Page's forms and reads `/{form_id}/leads` with
`filtering=[time_created GREATER_THAN <newest seen − 10 min>]` (up to 10 pages of 100), so a missed notification is recovered within
24 h.

**Storage, retention, erasure.** Answers are AES-256-GCM (`answers_enc`, key `TOKEN_ENCRYPTION_KEY`); emails and phones are also kept
as HMAC keys (`person_keys`) for erasure. Retention is Settings → Ads → `leadRetentionDays` (default 90, 1–365); the drain's sweep
nulls the answers and keys and keeps a count-only row, and a lowered period applies to existing leads. Erasure (Operations → data
erasure) with an email or phone deletes that person's lead rows entirely. Leads are never sent to an AI. Nothing contacts a lead
automatically; the consent answer is shown. The CSV export (owner only) is audited (`ads.leads_exported`, count and filters only).

**Troubleshooting.**
- *No leads arrive, Testing Tool lead missing:* the app-level `leadgen` field (step 1); the sign-off recorded (the Page's
  `subscribed_apps` must list `leadgen`: `scripts/diagnose.mjs` shows the fields); `leads_retrieval` granted; Leads Access Manager.
- *A lead appears hours later:* the notification was missed and the 6-hourly catch-up found it — expected.
- *Form "Refused":* Meta's sentence is on the card (often a missing permission or a question Meta rejects).

Flow, hop by hop: `FLOWS.md` §7.8. Help Center: `#/help/ads#lead-ads`, `#leads-and-privacy`.

---

## Let Claude draft

The **Proposals** tab (`#/ads_proposals`, `dashboard/js/pages/ads_proposals.js`) is where Claude drafts campaigns and changes
for you. **Nothing is created, changed or spent until you press Approve**, and a new campaign is then created **PAUSED**.

### Ask for a campaign

1. Press **Suggest a campaign** (on Proposals or on the Overview) and write one sentence: what to advertise, where, for how
   long ("messages for the new workshop, Egypt and Saudi Arabia, a one-week test"). Or press **Suggest a campaign** on a
   published post in **Posts**: Claude builds the campaign on that post.
2. A **Drafting** card appears. For your own account Claude writes it **on your Mac** (a Studio `ads_think` job, Claude Code
   on your plan, never an API key), so it can take a few minutes, and it needs the Mac awake with the Studio worker running.
   You can leave the page; the card updates by itself. A draft the Mac never answers fails after 24 hours.
3. The card shows the goal, budget, countries and ages, the ad text, **why** (the rationale), what Claude **assumed**, the
   expected range (only from your own results; none when you have no history), and what it adds to this month's **worst case**.

### What is checked before you see it

| Check | What happens |
|---|---|
| Schema | an answer that does not fit is asked again once with the errors, then fails |
| Policy (A4) | a blocked phrase ("guaranteed", income figures, …) is asked again once with the findings, then fails; warnings are shown on the card |
| Money (A1) | over your max daily budget or what is left of the monthly cap → the budget is **reduced** to fit, with a note; below Meta's minimum → fails |
| Evidence (daily review) | a number that is not in your account's own results drops the item |
| Builder rules (A4/A5) | the same `validateSpec` as the builder, asked again once |

### Approve, edit, reject

- **Approve** asks once, then re-runs the policy check and the money rule (nothing is adjusted at this point: if it no longer
  fits, it is refused with the reason) and Meta's `validate_only`. Then the ops are queued: the campaign, ad set, creative and
  ad, all PAUSED, each op tagged with the proposal. Switch it on in **Campaigns** when you are ready.
- **Edit in builder** opens **Create** (`ads_create.js`) filled with the draft; whatever you create there is your own campaign,
  and the proposal stays until you reject it or it expires.
- **Reject** creates nothing.
- A proposal you do not decide **expires after 7 days**.

### The daily review

Once a day (the daily cron) Claude reviews your running ads with at least 3 days of results and proposes **at most 3**
changes: pause, lower or raise a budget, move budget between ad sets, or a new ad from a post. Each change shows the numbers it
is based on. You get the **proposal_ready** alert (Settings → Ads alerts → "Claude proposed changes"); it can be switched off.

### What the AI sees

Aggregates only (FR-049, `src/services/ads/proposals/input.ts` `buildInput`): campaign and ad set names, budgets, statuses,
targeting summary and 7-day totals; your offers' name, price and a short summary (emails and phone numbers removed); your
limits and Meta's minimum; the policy rules; your own request; a post's caption and public counts. **Never** customers'
messages, names, phone numbers, emails, lead answers or contact lists. Other businesses on the platform use the AI provider
set for them in Operations → AI providers (purposes `ads_draft`, `ads_review`); without one they see `AI_NOT_CONFIGURED`.

### When it goes wrong

| Symptom | Cause and fix |
|---|---|
| Drafting for a long time | the Mac is asleep or the Studio worker is stopped: wake it; the card picks up the answer. After 24 h it fails: ask again |
| Failed: "doesn't know the job kind ads_think" | the Mac worker is older than the handler: pull aicourse-captions and restart the worker (launchd) |
| `AI_NOT_CONFIGURED` (another business) | no AI provider is set up for it: Operations → AI providers |
| Approve: `OVER_MONTHLY_CAP` | spending moved since the draft; ask for a new one, or edit it in the builder |
| Approve: `POLICY_BLOCKED` | the text breaks a rule; edit it in the builder |
| Approve: `NOT_WIRED` | a deployment without the A1–A5 parts; not expected in production |

## Rules

The **Rules** tab (`#/ads_rules`, `dashboard/js/pages/ads_rules.js`) holds your standing conditions. They are checked about once an
hour (the drain, `src/services/ads/rules.ts`), on the stored copy, after today's results are read again if they are older than 2 hours.

- **Saving a rule is approving it.** From the next check, its protective actions run on their own: **pause**, **lower the daily budget**
  by a percentage (5–90%, never below Meta's minimum), **tell me** (an alert).
- **Raising a budget (5–100%) or resuming never runs on its own.** Each time the rule matches, it makes one proposal in **Proposals**;
  approving it re-runs the money rule (monthly cap, daily max) exactly like a change you make by hand.
- **Conditions** (up to 5, all must hold): spend, results, cost per result, cost per conversation, CTR, CPM, frequency (today only, on
  campaigns or ads: reach does not add up across days), spending pace (campaigns and ad sets), rejected ad (tell me only). Windows: today,
  last 3 days, last 7 days, each including today, in the ad account's time zone. **Only after** a minimum of impressions and/or spend.
  Money spent with no result counts as too expensive, so set a minimum.
- **Limits it keeps:** one action per item per check (pause rules first), Meta's 4 budget changes per ad set per hour, a 24-hour pause
  before the same rule changes the same item again, an item with a change already waiting is left alone.
- **Templates:** cost per conversation too high → pause (you set the amount; 3 days, after 500 impressions); spending too fast → tell me
  (ad sets, pace above 1.5); frequency over 3 → lower 20% (campaigns, today, after 1,000 impressions); ad rejected → tell me.
- **History:** every check is a row (`ads_rule_runs`, 90 days): watched / acted / proposed / not enough data / could not check (with
  the reason). **24 hours without a real check → a "rule is not watching" alert** (`rule_blind`). Each action → one `rule_acted` alert per
  item per day.

### When it goes wrong

| Symptom | Cause and fix |
|---|---|
| "Not watching" badge | no real check for 24 h: open History. Not enough data → wait or lower "Only after"; token refused → paste a new ads token (Settings → Meta ads); Meta limiting requests → usually clears next hour |
| Lower budget "skipped: no daily budget of its own" | the budget is on the ad sets (or is a lifetime budget): point the rule at ad sets, or at a campaign with a daily campaign budget |
| "Meta's 4 budget changes this hour are used" | tried again next hour |
| A raise rule matched, nothing changed | by design: approve the proposal in Proposals |

## Testing two versions

The **Tests** tab (`#/ads_tests`, `dashboard/js/pages/ads_tests.js`) runs Meta's own split test: two to seven versions of an ad,
or two to five audiences, at the same time. Meta splits the audience so nobody sees two versions, and at the end names the
better one with its confidence. **Creating a test spends nothing; only Start spends, and it asks first.**

### Before you start

- Build the versions in **Create**, and leave them **paused**:
  - **Two versions of the ad:** two or more ads in **one** ad set (they share its audience). Change one thing only (the image,
    the text or the headline), or you will not know which change made the difference.
  - **Two audiences:** two or more ad sets in one campaign, each with **its own daily budget** (a campaign budget cannot be
    split per arm). The test sets their daily budgets equal.
- A **Meta business portfolio** is needed (studies belong to the business, not the ad account). If none is saved, the form asks
  you to pick one and saves it in the ads settings (`ads.settings.businessId`).

### Steps

1. **Tests → New test.** Choose what you compare, tick the paused versions, enter the **daily budget for the whole test**, the
   start date (tomorrow at the earliest, in the ad account's time zone) and the end date (1–30 days later).
2. The form shows the equal split (two arms 50/50, three 34/33/33) and the **worst case** (daily budget × days). It counts
   against your monthly cap: a test that would go over it is refused with the reason.
3. **Create the test.** The arms stay paused. The test is made at Meta through the queue (`Being created at Meta…`, usually
   under a minute), then reads **Ready**.
4. **Start** asks once, naming the daily budget, the days, the worst case and that the ad account's payment method is charged.
   It runs the money rule again, then switches on the arms, then their ad set, then the campaign last, each with the usual
   payment check and limits. A refusal stops there with the reason, and nothing spends.
5. **Stop** pauses the arms at any time; the result so far stays.

### Reading the result

- While it runs, the result is read every 6 hours; the last read is about half a day after the end (Meta settles its numbers).
- The winner is marked with Meta's **confidence**. Low confidence means the difference is not proven: run it longer, or with a
  bigger budget. "**No clear winner**" is a real answer (Meta could not separate them), not a fault.
- With a winner, a **proposal to pause the other versions** appears in **Proposals** (kind "test winner", from a split test). It
  only happens when you approve it, and approving re-checks it first. It expires after 7 days like any proposal.

### When it goes wrong

| Symptom | Cause and fix |
|---|---|
| `BUSINESS_REQUIRED` | no business portfolio saved, and the token sees none or several: pick one in the form; if the list is empty, add the system user to the business in Business Settings |
| "Every version must be paused" | an arm is running: pause it in **Campaigns**, then create the test |
| "…in the same ad set" | a creative test's ads come from different ad sets: build them in one ad set |
| "…its own daily budget" | an audience test's ad set uses the campaign's budget or a lifetime budget: rebuild it with a daily budget |
| Failed after create | Meta refused the study (its words are on the card): often an ad already in another running test, or a start date in the past |
| `OVER_MONTHLY_CAP` / `OVER_DAILY_MAX` | the test does not fit your limits: lower the daily budget or shorten it |
| Ready, never started, dates passed | it is marked stopped ("never started"); make a new one |

### Live-check caveats (not yet proven against Meta)

- `creative_test_config.daily_budget` is sent as the WHOLE test's daily budget in minor units; the money rule counts daily × days.
  Confirm on the first live test that Meta spends that much in total, not that much per arm.
- The shape of an objective's `results` is read tolerantly (an object, JSON text, or a list); confirm the confidence scale.

## For managed clients

Until Meta verifies the owner's business, every managed client uses its own system-user token, its own Meta business,
its own ad account and its own payment method. Meta bills the client directly; the platform never pays Meta for a client.

**Admin (once per client)**
1. The platform admin's **Client ads** page (`#/admin_ads`) → the tenant's row → set the ceiling (max daily budget, monthly cap) → switch Ads on.
   Without a ceiling the switch is refused (`CEILING_REQUIRED`).
2. Send the client to Help → Ads → For managed clients (`#/help/ads#for-clients`).
3. Check the row once the client says it is done: token health `ok`, account status `active`, payment method yes.

**Client (about 20 minutes)**
1. Business Settings → Users → System users → Add (Employee).
2. Assign assets with full control: the ad account, the Page, the Instagram account and the AutoReply app.
3. Generate token: expiry Never, with `ads_management`, `ads_read`, `business_management`, `pages_read_engagement`,
   `pages_show_list`, `pages_manage_ads`. Assign the assets first; a token carries what was assigned when it was made.
4. Settings → Meta ads: paste the token, test the connection, pick the ad account, check the payment method, set the
   max daily budget and the monthly cap.

**Limits and the ceiling.** The client's limits must be at or below the ceiling; a save above it is refused with
`OVER_CEILING` and shows the allowed value. To allow more, raise the ceiling on the **Client ads** page.

**Who sees what.** The admin sees health, open alerts and cap use as a percentage. Amounts spent, the daily max and the
monthly cap are visible only if the client turns on "Share spend" (`ads.share_spend.<t>`, owner only, audited).

**Isolation.** Every read and every write re-checks `creator_id` and `ad_account_id`
(`src/services/ads/ownership.ts`). Another tenant's object id gives `NOT_OWN_OBJECT`, which is logged and audited.

## Troubleshooting

- **No Connect button:** Connect is optional and off unless the platform enables it. Paste a system-user token.
- **Token dead (`190`/`102`, `token_dead` alert):** generate a new token (steps above), paste, **Test connection**. Until then
  the guard cannot pause anything. Rotation details in `docs/TOKEN_GUIDE.md` ("Ads token").
- **Payment failed:** fix in Meta billing; the next daily check clears it.
- **Rate-limited (`RATE_LIMITED`, `retryAt`):** Meta allows about 60 points per 5 minutes on the Limited tier (read = 1, write = 3).
  Throttle codes (`17/2446079`, `613/*` except `613/1487632`, `80000`, `80003`, `80004`, `80014`, `4/1504022`, `4/1504039`) are
  never retried: the pacer records `blocked_until` and waits. Look for `ads.throttled` in the logs.
- **"Spending is not being watched" banner / `guard_blind`:** the guard (`runGuard`, `src/services/ads/guard.ts`, run inside
  every `/api/jobs/drain`) has had no successful check for 2 hours. Causes: dead token, throttling, Meta outage. It writes
  `ads.cap_checked` only after a successful check. `GET /api/ads/overview` → `guard: { lastCheckedAt, blind }`.
- **`EDIT_LIMIT`:** 4 budget changes per hour per ad set (`613/1487632`) or 10 spend-cap changes per day (`17/1885172`); `retryAt` says when.
- **`10/1341012`:** the system user lacks the Page assignment: assign the Page in step 3.
- **Probe:** `node scripts/ads-probe.mjs [--tenant <uuid>] [--env <path>] [--json]`. Read-only: DB through `connectReadOnly`, only GET
  calls to Meta, token in the `Authorization` header, nothing secret printed (funding display strings are cut to the last 4
  digits). Exit 0 all sections answered, 1 a section was refused, 3 could not run. Money fields print in Meta's minor units on purpose.
