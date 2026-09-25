# TikTok — setup and operations guide

The TikTok counterpart of [`TOKEN_GUIDE.md`](TOKEN_GUIDE.md). Everything needed to set TikTok up,
keep it connected, get posts out, get the app through TikTok's review, and read what went wrong.

Claims about the app are cited to `file:line` so you can check them. Claims about TikTok's
developer portal and the TikTok app come from the live rollout of 2026-09-23/24 and say so —
TikTok changes its portal, so treat those as "what it looked like then".

- Something is broken right now: [`RUNBOOK.md`](../RUNBOOK.md) §10, symptom-first.
- Proving it works end to end: [`VERIFYING.md`](../VERIFYING.md), "Verifying TikTok".
- Every hop a TikTok post takes: [`FLOWS.md`](../FLOWS.md) §6, and §3.6 for photo posts.

---

## The state of things (2026-09-24)

| | |
|---|---|
| App on developers.tiktok.com | **AutoReply Pro** |
| Client key in use | a **Sandbox** key. The production app is pending review |
| Who can connect | only the sandbox's target users. The creator's own account is one |
| Products | Login Kit, Content Posting API, Webhooks |
| Scopes | `user.info.basic`, `video.upload`, `video.publish` |
| What works | **Direct Post** (`video.publish`) — forced to **Only me** until TikTok audits the app |
| What does not | **Inbox drafts** (`video.upload`). TikTok reported six drafts delivered; none was ever found (§12) |
| Settings → TikTok app | "Direct Post is switched on…" ticked (Direct Post cannot happen otherwise); "TikTok has approved this app…" unticked (the audit has not passed) |

**The one rule to remember: until TikTok audits the app, the TikTok account must be private at
the moment a post goes out, and every post goes out as "Only me".** §6.3 is the workflow that
worked.

---

## 1. What TikTok allows, and what it doesn't

| | Inbox drafts | Direct Post, **before** the audit | Direct Post, **after** the audit |
|---|---|---|---|
| Scope | `video.upload` | `video.publish` | `video.publish` |
| Where the post lands | the creator's TikTok inbox, as a draft they finish and post in the TikTok app | straight onto the profile | straight onto the profile |
| Who can see it | whatever the creator picks in TikTok's editor | **Only me** (`SELF_ONLY`). Enforced by TikTok and by the app (`src/services/tiktokPublish.ts:94-96`, `:290-292`) | whatever the composer's "Who can see this video" says, from the options TikTok offers that account |
| The account must be | anything | **private at posting time**, or TikTok refuses with `unaudited_client_can_only_post_to_private_accounts` | public or private |
| Privacy, interactions, disclosure | chosen in TikTok's editor | chosen in our composer (TikTok's guidelines move them there) | chosen in our composer |
| Branded content ("Paid partnership") | in TikTok's editor | **not possible** — branded content can't be Only me (`tiktokPublish.ts:98-100`) | yes |
| Caption | sent as the undocumented `post_info.title`; retried without it if TikTok refuses (§10) | sent | sent |
| Pending limit | 5 unposted drafts per 24 h (§9) | none of ours | none of ours |
| Status here | `IN_INBOX` until the creator posts it, then `PUBLISHED` | `PUBLISHED` | `PUBLISHED` |
| Reliability, observed | **unreliable** — delivered, never seen | works | not yet reachable |

**Photo posts** (`image` = one photo, `carousel` = 2–35) exist in all three columns. They are
the same lifecycle with no upload step: TikTok pulls every image from this app's own URL, and
**only from a URL prefix verified in the portal** (§2.5). JPEG or WebP, uploaded here — never a
link to another site (`src/services/postMedia.ts:20-24`, `:77-97`). They carry a title (at most
90 UTF-16 units) and a description (at most 4000), and TikTok allows their init 6 calls a
minute per token (`src/services/tiktok.ts:537-540`, `:584`).

**What TikTok does not allow at all, for this app:**

- **Anything with comments or DMs.** No scope this app holds reads comments, replies to them or
  sends a message, so there is no TikTok equivalent of the Instagram comment → DM pipeline (§12).
- **A publish time.** No TikTok API takes one. The app holds the post and publishes it when the
  drain next runs, so a post is on time to within the drain interval — minutes to hours, see
  RUNBOOK §4.1 and §5.1.
- **Public posts before the audit**, and branded content before the audit.
- **A chosen cover.** TikTok picks a video's; a photo post's cover is its first image
  (`photo_cover_index: 0`, `src/services/tiktok.ts:606`). TikTok rows never get a `cover_url`
  (`src/routes/api.ts:2280-2281`).
- **Editing after it has gone.** Once a row is `PUBLISHING`, `PROCESSING` or `IN_INBOX` the app
  refuses edits (`src/routes/api.ts:2395-2398`); change the post in TikTok.

---

## 2. Developer-portal setup, step by step

At [developers.tiktok.com](https://developers.tiktok.com) → **Manage apps** → **AutoReply Pro**.

### 2.1 Sandbox first, production after review

The app has a **production** side, which TikTok reviews, and a **sandbox**, which works at once
for the accounts you list. Each has its **own client key and client secret**. The key saved in
Settings today is the sandbox one.

1. In the sandbox, add the creator's TikTok account as a **target user**. Only target users can
   authorise a sandbox app.
2. Configure the same products, scopes and URLs on both sides (§2.2–§2.5), so that switching to
   production later is a key swap and nothing else (§8.3).

Posts made through the sandbox are real posts on the real account — the 2026-09-24 rollout ran
entirely on the sandbox key.

### 2.2 Products

| Product | Configure | Used for |
|---|---|---|
| **Login Kit** | Redirect URI `https://msg-response-auto.vercel.app/api/tiktok/callback` | Connect TikTok (§4) |
| **Content Posting API** | switch **Direct Post** on; verify the URL prefix (§2.5) | posting videos and photos, and reading their status |
| **Webhooks** | Callback URL `https://msg-response-auto.vercel.app/api/tiktok/webhook` | status events, and `authorization.removed` when someone removes the app |

### 2.3 Scopes

Add all three in the portal. The app decides which to *request* at Connect time from the two
switches in §5 (`tiktokScopes`, `src/services/tiktok.ts:53-56`):

| Scope | What it is for | Requested when |
|---|---|---|
| `user.info.basic` | the account's name and avatar on the Settings card | always |
| `video.upload` | inbox drafts | Direct Post switch off; or on and **not** audited, so each post can choose |
| `video.publish` | Direct Post | Direct Post switch on |

> **Asking for a scope the portal has not granted fails the whole authorisation**, not just that
> scope. So the Direct Post switch in Settings must never be ticked before the portal has Direct
> Post switched on and `video.publish` added. After the audit, the app stops asking for
> `video.upload` — inbox drafts have no purpose once posts can go out public.

### 2.4 The URLs to register

Settings → **TikTok** → **TikTok app (platform admin)** → "Register these in the TikTok developer
portal" lists every one with a copy button (`src/routes/tiktok.ts:340-346`). They are built from
the **Public site address** field, so save that first (§3). Copy them; do not type them.

| Portal field | Value | Served by |
|---|---|---|
| Website URL | `https://msg-response-auto.vercel.app/` | the landing page, `src/index.ts:98` |
| Terms of Service URL | `https://msg-response-auto.vercel.app/terms` | `src/index.ts:109` |
| Privacy Policy URL | `https://msg-response-auto.vercel.app/privacy` | `src/index.ts:103` |
| Redirect URI (Login Kit) | `https://msg-response-auto.vercel.app/api/tiktok/callback` | `src/routes/tiktok.ts:92` |
| Webhook callback URL | `https://msg-response-auto.vercel.app/api/tiktok/webhook` | `src/routes/tiktok.ts:153` |
| Scopes to request | what Connect will ask for, today `user.info.basic,video.upload,video.publish` | `src/services/tiktok.ts:53` |

> **TikTok compares the redirect URI byte for byte.** A trailing slash, `http://`, or a preview
> deployment's host is a different URI, and Connect fails. That is why it is built from the saved
> Public site address and never from the request's Host header (`src/services/appSettings.ts:30-37`).

Check they answer — all read-only:

```bash
B=https://msg-response-auto.vercel.app
for p in / /terms /privacy; do printf '%-9s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$B$p")"; done
curl -s -o /dev/null -w 'callback %{http_code}\n' "$B/api/tiktok/callback"
curl -s -o /dev/null -w 'webhook  %{http_code}\n' -X POST -H 'Content-Type: application/json' -d '{}' "$B/api/tiktok/webhook"
```

Healthy: `200` for the three pages; `302` for the callback (no code, so it bounces back to
Settings); `401` for the webhook (unsigned, so refused before anything is written —
`src/routes/tiktok.ts:157-165`). The last one writes a harmless `tiktok.webhook_signature_rejected`
log line.

### 2.5 URL properties: verifying the prefix through the dashboard

**Photo posts need this; videos do not.** A video is pushed to TikTok (`FILE_UPLOAD`), but a
photo can only be *pulled* (`PULL_FROM_URL`), and TikTok pulls only from a verified prefix
(`src/services/tiktok.ts:16-22`). Without it every photo post fails with
`url_ownership_unverified`.

1. Portal → **URL properties** → add a property → **URL prefix** →
   `https://msg-response-auto.vercel.app/` (with the trailing slash).
2. TikTok offers a file named `tiktok<token>.txt`. Download it and open it in a text editor. It is
   one line, `tiktok-developers-site-verification=…`.
3. Dashboard → Settings → TikTok → **TikTok app (platform admin)**:
   - **Verification file name**: the file's name, exactly (`tiktokAbC123.txt`);
   - **Verification file contents**: the line inside it;
   - **Save TikTok app**.

   Both are required together; the name must match `tiktok[A-Za-z0-9_-]{4,100}.txt` and the
   contents fit in 500 characters (`src/routes/tiktok.ts:358`, `:395-404`).
4. Confirm the app serves it, before asking TikTok to look:

   ```bash
   curl -fsS https://msg-response-auto.vercel.app/tiktokAbC123.txt
   ```

   Healthy: the same line as the file. A `404` means the saved name differs from the URL.
5. Portal → **Verify**.

**TikTok handed out three different files over time** — one for the Terms/Privacy URLs, one for
the prefix, then one more for domains when Direct Post was switched on. **The app keeps serving
all of them.** Saving a new file moves the previous one into a history (the last ten), and the
root route answers any of them (`src/services/appSettings.ts:196-206`, `src/index.ts:117-131`).
The Settings form shows only the newest. To see every file being served:

```sql
SELECT key, left(value, 300) AS value, updated_at
  FROM app_settings
 WHERE key IN ('tiktok.verification_filename', 'tiktok.verification_content',
               'tiktok.verification_history');
```

Past ten files the oldest drops out of the history and its URL starts to 404. If a property in
the portal ever shows as unverified again, save its file again.

> **The Public site address must be the verified prefix's origin.** Photo URLs are rebuilt at
> publish time as `<Public site address>/api/uploads/<uuid>.jpg` (`.webp` for WebP), never taken
> from the row (`src/services/tiktokPublish.ts:396-400`), because a row saved from a preview
> deployment would carry a host TikTok refuses. With no address saved and no `PUBLIC_BASE_URL`,
> a photo post fails outright — there is no request to fall back to inside a cron
> (`:397-399`).

---

## 3. Paste the key and secret into Settings

One set of credentials for the whole deployment, so this is **platform admin only**: the block is
not drawn for anyone else, and its API answers them 404 (`src/routes/tiktok.ts:188-194`). The
shared `DASHBOARD_PASSWORD` login is a platform admin.

1. Portal → the app (the sandbox today; production once approved) → **Credentials**. Copy the
   **Client key** and **Client secret**.
2. Dashboard → **Settings** → **TikTok** → **TikTok app (platform admin)**. It is open by default
   until the app is configured.
3. Fill in:

   | Field | What to paste | Notes |
   |---|---|---|
   | **Client key** | the client key | Shown whole once saved — it is not a secret; TikTok puts it in every authorise URL, and seeing it is how a typo gets found (`src/routes/tiktok.ts:324-326`). Must match `[A-Za-z0-9_-]{6,100}` (`:369`) |
   | **Client secret** | the client secret | Never shown again. The field is always blank; **blank means "keep what is saved"**. Once saved it reads "Saved (abc•••yz) — leave blank to keep it". Stored encrypted, like the Meta token (`src/services/appSettings.ts:53`, `:82-89`) |
   | **Public site address** | `https://msg-response-auto.vercel.app` | No path, no trailing slash — it is normalised to an origin, and must be `https://` (`src/services/appSettings.ts:130-140`). Every TikTok URL is built from it (§2.4, §2.5) |

4. **Save TikTok app**. Healthy: the toast "TikTok app settings saved.", and the section now offers
   **Connect TikTok** to the workspace owner.

Saving the secret, and later connecting, both encrypt, so both need `TOKEN_ENCRYPTION_KEY` in the
environment — the same requirement as saving a Meta token (RUNBOOK §3.2).

**The database wins over the environment.** `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` and
`PUBLIC_BASE_URL` are only fallbacks, and none is needed at boot (`src/services/appSettings.ts:110-123`,
`:147-154`). A value from the environment is labelled "Set in the environment — saving here
overrides it". With either half of the credentials missing, TikTok is simply "not set up": the
section says "TikTok isn't set up yet…" and Connect answers 409.

**The client secret is also the webhook key.** TikTok signs every webhook with the client secret
of the app that sends it (`src/services/tiktok.ts:766-789`). Save a secret from the wrong app —
sandbox versus production — and Connect fails *and* every webhook is refused (RUNBOOK §10.6).

To read what is saved without opening the dashboard (read-only):

```sql
SELECT key, is_secret,
       CASE WHEN is_secret THEN '(encrypted)' ELSE left(value, 80) END AS value,
       updated_at
  FROM app_settings
 WHERE key LIKE 'tiktok.%' OR key = 'app.public_base_url'
 ORDER BY key;
```

---

## 4. Connect and Reconnect

Connecting is per workspace, and only the workspace **owner** can do it ("Only the account owner
can connect or disconnect TikTok.", `src/routes/tiktok.ts:186`). One TikTok account per
workspace, and one workspace per TikTok account.

### 4.1 Connect

1. Settings → **TikTok** → **Connect TikTok**. The dashboard asks the server for TikTok's
   authorise URL, which also sets a single-use cookie valid for 10 minutes, then goes there
   (`src/routes/tiktok.ts:261-285`). **Start and finish in the same browser** — the cookie is how
   the callback knows the round trip is yours.
2. Log in to the TikTok account this workspace should post to (with the sandbox key: a target
   user). TikTok's consent screen names **AutoReply Pro** and the scopes. Allow.
3. You land back on Settings with **"TikTok connected."** Healthy card:
   - the account's display name and a **Connected** pill;
   - **Posting mode:** — see the table below;
   - "A TikTok connection lasts one year — reconnect before *date*";
   - "Drafts waiting in your TikTok inbox (last 24 hours): *n* of 5";
   - **Permissions**: one chip per scope TikTok actually granted. **Read them.** This is the only
     place that shows what the connection can do.

| Posting mode shown | Means |
|---|---|
| Inbox drafts | the Direct Post switch is off, or this connection lacks `video.publish` |
| Direct post or drafts — you choose per post (until TikTok approves the app) | switch on, not audited, and the connection holds both `video.publish` and `video.upload` — **today's normal** |
| Direct post (private until TikTok approves the app) | switch on, not audited, connection holds `video.publish` only |
| Direct post | switch on and audited |

(`tiktokModeLabel`, `dashboard/js/pages/settings.js:431-435`; the server decides the mode with
`postModeFor`, `src/routes/tiktok.ts:225-227`.)

Two warnings the card can add: "Reconnect TikTok to allow direct posting." (the switch is on but
this connection predates it) and "Video upload permission wasn't granted — reconnect and allow
video upload." (neither posting scope was granted).

### 4.2 When Connect comes back with an error

The callback redirects to Settings with a reason, and the page turns it into a toast
(`src/routes/tiktok.ts:92-151`):

| Toast | Cause | Fix |
|---|---|---|
| "TikTok connection was cancelled." | Cancel was pressed on TikTok's consent screen | Connect again and allow |
| "The connection link expired or was started in another browser. Try again from this browser." | the cookie did not come back: another browser or profile, cookies blocked, or the login finished somewhere else | start and finish in one browser |
| "The connection link expired. Try again." | more than 10 minutes, or the link was used twice | Connect again |
| "That TikTok account is connected to another workspace. Disconnect it there first." | the same TikTok account is on another workspace (`src/services/tiktokConnections.ts:199-201`) | disconnect it there |
| "TikTok didn't accept the connection. Check the client key and secret, then try again." | the code exchange failed: a wrong secret, a sandbox key with a production secret, a redirect URI that differs from the portal's, or no `TOKEN_ENCRYPTION_KEY` | §3; the Vercel log line `tiktok.oauth_callback_failed` carries TikTok's own reason |
| "Set the public site address in the TikTok app settings first." | no Public site address anywhere | §3 |
| "Couldn't connect TikTok. Try again." | TikTok answered with an error other than a cancel — most often a scope the portal has not granted (§2.3) | read the log line `tiktok.oauth_denied`; untick the Direct Post switch or fix the portal |

TikTok may also show its own error page and never come back, for the same scope reason.

### 4.3 Reconnect

**Reconnect** runs the same flow and replaces the workspace's connection in place: new tokens, new
scopes, status back to active, the last error cleared (`completeConnection`,
`src/services/tiktokConnections.ts:142-204`). Scheduled posts are untouched. Reconnect when:

- the pill says **Needs reconnecting** (the card shows "Last problem: …" — §8.2);
- you have just ticked the Direct Post switch (§5);
- "reconnect before *date*" is near — the refresh token dies a year after the first authorisation,
  and the card adds a days-left warning inside 30 days (§8);
- the client key changed, e.g. sandbox to production (§8.3).

Afterwards, check **Permissions** again and that "reconnect before" moved.

### 4.4 Disconnect

**Disconnect TikTok** → confirm. The app revokes its token with TikTok (best-effort) and deletes the
stored connection — account id, name, avatar and both tokens (`disconnect`,
`src/services/tiktokConnections.ts:376-393`). Removing the app from the TikTok side ("Manage app
permissions" in TikTok) does the same through the `authorization.removed` webhook
(`src/services/tiktokPublish.ts:656-660`).

> **The confirm dialog says scheduled TikTok posts "won't be sent until you reconnect". The code is
> stricter:** posts not yet due stay `PENDING`, but any post that comes due while disconnected is
> claimed and **FAILS** with "TikTok is not connected for this account — connect it in Settings."
> (`src/services/tiktokConnections.ts:36-41`, `:306`). After reconnecting, retry those with
> **Publish now**.

---

## 5. The two switches: Direct Post and Audited

Both live in Settings → TikTok → **TikTok app (platform admin)** → **Direct Post**, and both are
facts about TikTok's portal that the app cannot check for itself — you tell it:

| Checkbox (exact label) | App setting | Tick it when |
|---|---|---|
| "Direct Post is switched on for this app in the TikTok developer portal" | `tiktok.direct_post_enabled` | the portal has Direct Post on **and** `video.publish` added |
| "TikTok has approved this app for Direct Post (audit passed)" | `tiktok.audited` | TikTok has told you the audit passed |

Both default to off and are saved with **Save TikTok app**, which always sends both — an unticked
box is a real "no" (`dashboard/js/pages/settings.js:609-612`, `src/routes/tiktok.ts:406-413`).

| Direct Post | Audited | Connect asks for | A new TikTok post goes out as | Privacy allowed |
|---|---|---|---|---|
| off | (ignored) | `user.info.basic`, `video.upload` | an inbox draft | chosen in TikTok's editor |
| **on** | **off** — today | all three | the composer asks, per post: "Post directly to my profile" or "Send to my TikTok drafts (inbox)" | **Only me** |
| on | on | `user.info.basic`, `video.publish` | direct, always | any level TikTok offers the account |

(`tiktokScopes`, `src/services/tiktok.ts:53-56`; the per-post choice, `src/routes/api.ts:2245-2251`.)
Audited on its own does nothing: with Direct Post off, posts are inbox drafts.

### 5.1 Switching Direct Post on

1. Portal first: Content Posting API → Direct Post on, `video.publish` added, and any domain
   verification TikTok asks for (§2.5). Otherwise the next Connect fails for everyone (§2.3).
2. Tick "Direct Post is switched on…" → **Save TikTok app**. "Scopes to request" now ends in
   `video.publish`.
3. **Every connected workspace must Reconnect once.** Until it does, its card says "Reconnect
   TikTok to allow direct posting." and its posts keep going out as inbox drafts — the mode needs
   the scope on the connection, not just the switch (`src/routes/tiktok.ts:225-227`).
4. The mode is fixed on each post when it is scheduled (`src/routes/api.ts:2240-2251`), so posts
   scheduled before the switch stay inbox drafts. Edit them and choose "Post directly to my
   profile", or reschedule them.

### 5.2 Switching Audited on

1. Only once TikTok has approved the production app, and after its key and secret are in Settings
   (§8.3).
2. Tick "TikTok has approved this app for Direct Post (audit passed)" → **Save TikTok app**.
3. What changes: the composer offers every privacy level TikTok lists for the account; branded
   content becomes available; the drafts choice disappears; the account no longer has to be
   private; and the Studio can post a TikTok carousel "at the same time" as Instagram instead of
   queueing it (§6.5).
4. Make the TikTok account public again.

> **Ticking Audited does not make posts public by itself.**
> - A composer post's "Who can see this video" has **no default** — TikTok's guidelines forbid one
>   — so choose **Everyone** on each post (`dashboard/js/pages/posts.js:986-1005`).
> - **Posts scheduled before the tick keep "Only me".** The privacy is stored on the row when it is
>   scheduled (`scheduled_posts.platform_options`), and the publish-time check only narrows it,
>   never widens it (`src/services/tiktokPublish.ts:287-297`). Edit each one and choose Everyone.
> - Studio carousels scheduled *after* the tick do go out public automatically
>   (`studioTikTokOptions`, `src/services/studio/schedule.ts:39-50`).

No reconnect is needed after the audit: the existing connection already holds `video.publish`. A
later reconnect asks only for `user.info.basic` and `video.publish`, which ends inbox drafts — as
intended.

**Do not tick Audited early.** The app would then offer Everyone, which TikTok does not allow an
unaudited app, so the post would not go out as chosen. **Unticking it again** leaves posts already scheduled wider than Only
me to fail at publish with "Until TikTok approves this app, direct posts can only be private (Only
me) — edit the post." (`src/services/tiktokPublish.ts:290-292`).

---

## 6. Posting

### 6.1 Videos, from the composer

**Posts Scheduler** → new post:

1. **Platform**: TikTok, for a TikTok-only post. Or Instagram/Facebook/both with **Also send to
   TikTok**, which adds a second, linked row with the same caption, video and time — read §10
   before using it with a caption that asks for a comment keyword.
2. **Type**: Video. MP4 (H.264) is the safe choice; the app accepts MP4, MOV or WebM
   (`src/services/tiktokPublish.ts:42`, `:507-509`). The dashboard upload tops out around 3.3 MB
   (Vercel's 4.5 MB request cap on base64); a bigger render goes straight into `media_uploads`,
   and the TikTok publisher reads the bytes from there rather than over HTTP (`:207-213`).
3. **Caption** — §10.
4. **TikTok post settings.** Built live from TikTok's `creator_info` for the connected account, as
   TikTok's guidelines require (`src/routes/tiktok.ts:234-259`):

   | Control (exact label) | Behaviour |
   |---|---|
   | "How should this reach TikTok?" → "Post directly to my profile" / "Send to my TikTok drafts (inbox)" | only until the audit, and only when the connection holds both scopes. The direct option's hint: "Private (Only me) until TikTok approves the app. Your account must be set to private at posting time." |
   | "Posts to" | the TikTok account's nickname |
   | "Who can see this video" | starts on "Choose who can see this" — **no default**. Until the audit only **Only me** is accepted |
   | "Interactions": "Allow comments", "Allow Duet", "Allow Stitch" | **all off by default**; greyed out with "Turned off in this account's TikTok privacy settings." where the creator has switched one off |
   | "Commercial content" → "Disclose commercial content" → "Your brand" / "Branded content" | labels the post "Promotional content" / "Paid partnership". Branded content is unavailable until the audit |
   | "This video was made with AI (AI-generated content label)" | off by default |
   | "I agree to post this video to my TikTok account" | required |
   | "By posting, you agree to TikTok's Music Usage Confirmation." | the declaration; it adds "Branded Content Policy" when branded content is on |

   The composer also states the account's longest allowed video and refuses a longer one.
5. **Schedule** it, or tick **Publish immediately instead of scheduling**. A saved post's card has
   **Publish now** for the same thing later.

At publish time the server reads `creator_info` again and re-checks everything — the privacy
level is still offered, the video fits the account's maximum (read from the MP4 header), Only me
while unaudited — and forces off any interaction the creator has since switched off, before
anything is uploaded (`startDirectPost`, `src/services/tiktokPublish.ts:304-330`). The init is
**never retried**: a 5xx may already have posted it, and a retry would post it twice
(`src/services/tiktok.ts:501-504`).

In inbox mode none of the panel appears; TikTok's editor asks for all of it when the creator opens
the draft.

### 6.2 Photos and carousels

- **Type**: Image (one photo) or Carousel (2–35 for TikTok; Instagram's own limit is 10). JPEG or
  WebP, **uploaded here** — TikTok refuses a link to another site, and PNG
  (`src/services/postMedia.ts:20-24`, `:77-97`).
- With **Also send to TikTok**, the TikTok row may carry its own 9:16 slides; otherwise it shares
  the Meta row's, checked against TikTok's rules — a PNG carousel that is fine on Facebook is
  refused for its TikTok sibling (FLOWS.md §3.6).
- **TikTok title** — filled from the caption's first line; edit it freely, at most 90 UTF-16 units.
  The description is the whole caption, cut to 4000 (§10).
- The settings panel is the video's minus Duet, Stitch and the AI label, plus **Music** →
  **Auto-add music**, the one choice that starts on (TikTok's own default).
- Needs the verified URL prefix and the Public site address (§2.5), or it fails with
  `url_ownership_unverified`.
- **Six photo inits a minute per token.** Space photo posts out — the Studio uses 40 seconds
  (`src/services/studio/schedule.ts:29`). A drain that finds many photo posts already due
  publishes them back to back, so a backlog can still run into the limit; the ones refused fail
  with `rate_limit_exceeded` and are retried with **Publish now** (§11).
- An inbox photo draft needs TikTok app 31.8 or newer on the phone (`app_version_check_failed`).

### 6.3 The private-account workflow, until the audit

This is what worked on 2026-09-24, for videos and for 14 photo carousels sent 40 seconds apart.
Until TikTok audits the app, a direct post is refused unless the account is private **at the
moment it goes out**, and it lands as Only me.

1. **Make the account private.** TikTok app → Profile → menu → Settings and privacy → Privacy →
   **Private account** on. If the switch is missing or greyed out, the account is most likely a
   Business account (§12).
2. **Schedule the posts as Only me** — the composer with "Post directly to my profile" and "Only
   me" (§6.1), or the Studio batch (§6.5).
3. **Let every one of them go out before touching the account again.** Watch Posts Scheduler until
   each reads **Published**, or ask the database (read-only):

   ```sql
   SELECT id, status, post_type, scheduled_time, left(error_log, 100) AS err
     FROM scheduled_posts
    WHERE platform = 'tiktok'
      AND platform_options->>'mode' = 'direct'
      AND status IN ('PENDING', 'PUBLISHING', 'PROCESSING')
    ORDER BY scheduled_time;
   ```

   **Empty means nothing is still going out.** Posts go out when the drain runs, not at the minute
   they were scheduled (RUNBOOK §4.1), so this can take a while. A row with a future
   `scheduled_time` will go out later — and fail if the account is public by then.
4. **Make the account public again**: Privacy → Private account off.
5. **Make each post public**: open the post → **⋯** → **Privacy settings** → **Everyone**. One post
   at a time.
6. From the Studio, tick **Made public on TikTok** on each draft as you go. It is a reminder only
   and changes nothing on TikTok.

A post that failed in between with "Until TikTok approves this app, direct posts only work when
your TikTok account is set to private…" (`unaudited_client_can_only_post_to_private_accounts`):
make the account private again, press **Publish now** on it, wait for **Published**, then repeat
steps 4 and 5.

### 6.4 What the post card says

| Status | The card shows | Meaning |
|---|---|---|
| `PENDING` | Pending | waiting for its time — or **held**, with "Waiting for TikTok: *n* drafts from the last 24 hours are still in your TikTok inbox…" (inbox mode only, §9) |
| `PUBLISHING` | Publishing | claimed and being sent |
| `PROCESSING` | TikTok is processing | TikTok has it and is still working on it |
| `IN_INBOX` | In your TikTok inbox | inbox mode: a draft waiting for the creator, with **Copy caption** and **Open TikTok** |
| `PUBLISHED` | Published | TikTok said `PUBLISH_COMPLETE` |
| `FAILED` | Failed, and why | the reason is `error_log` (§11); retry with **Publish now**, or edit and save |

Only public, moderated posts get a TikTok post id, stored as `TT:<id>` in `published_post_id`
(`src/services/tiktokPublish.ts:254-263`). **An Only me post never gets one**, so `PUBLISHED` with
no link is normal and the card says "Posted on TikTok."

Three things move a row after the upload — the 12-second poll inside the publish call, TikTok's
webhook, and a sweep on every drain and the daily cron — all through one idempotent transition,
so they may overlap (FLOWS.md §6.5).

### 6.5 From the Studio: "Queue for TikTok" and the batch

The Studio makes Instagram carousels and a 9:16 TikTok version of each (STUDIO.md §4).

1. When scheduling a ready draft, the TikTok choice is **Queue for TikTok** (until the audit),
   **Post to TikTok at the same time** (only once Audited is ticked) or **Don't post to TikTok**.
2. Make the account private (§6.3 step 1).
3. **Post queued TikTok carousels** at the top of the Studio → **Post to TikTok**. This creates one
   TikTok carousel row per queued draft, **due now, 40 seconds apart**, with: Direct Post, Only me
   while unaudited (Everyone once audited), the draft's TikTok title, Auto-add music on, comments
   allowed, and the **Your brand** disclosure on — every Studio carousel is labelled "Promotional
   content". The click is the consent (`studioTikTokOptions` and `runTikTokBatch`,
   `src/services/studio/schedule.ts:39-50`, `:220-273`).
4. It refuses with "Direct Post is not available: switch it on in Settings → TikTok app, then
   reconnect TikTok." unless the connection holds `video.publish` and the Direct Post switch is on
   (`src/services/studio/schedule.ts:56-64`).
5. The rows go out on the next drains. Keep the account private until the SQL in §6.3 step 3 comes
   back empty, then do steps 4–6.

---

## 7. App review

Submitted 2026-09-23 and pending as of 2026-09-24. This section is for a resubmission, and for the
production app's audit.

### 7.1 How to present the app

TikTok's guidelines reject **tools that only post to your own accounts**. AutoReply Pro is not one:
it is a managed multi-tenant scheduler — workspaces, users with memberships and roles, a tenant
switcher, a platform-admin surface — and each workspace connects its **own** TikTok account, one
account per workspace (§4). Present it as that: a scheduling tool for creators and small teams.

**Describe only what exists.** There is no self-serve signup — the operator creates workspaces
(RUNBOOK §8) — so do not claim one. Reviewers test what the description promises.

A description that is true of the code:

> AutoReply Pro is a web app for creators and small teams to plan and schedule their social posts.
> Each workspace connects its own Instagram, Facebook and TikTok accounts. The creator writes a
> post once, chooses the platforms and a time, and the app publishes it then. For TikTok, the
> creator connects their account with Login Kit and composes the post in our scheduler — choosing
> who can see it, which interactions to allow and whether it is commercial content, and confirming
> consent — and at the scheduled time the app publishes it with the Content Posting API. The app
> does not read comments, messages or any other user's data on TikTok.

### 7.2 What to write, product by product and scope by scope

Paste these, adjusted to the form's length limits.

**Login Kit**

> The creator connects their own TikTok account to their workspace from Settings → Connect TikTok.
> Redirect URI: https://msg-response-auto.vercel.app/api/tiktok/callback. The OAuth state is
> single-use, expires after 10 minutes and is bound to the browser that started the flow. Access
> and refresh tokens are encrypted at rest (AES-256-GCM). The creator can disconnect at any time,
> which revokes the token with TikTok and deletes the stored connection.

**Content Posting API**

> We publish the videos and photo posts a creator schedules in our composer to their own TikTok
> account, at the time they chose. Before every direct post we call creator_info/query — when the
> creator composes it, and again at publish time — and build the composer from it: the creator's nickname; the privacy levels TikTok offers them, with none
> pre-selected; comment, Duet and Stitch settings, all off by default and disabled where the
> creator has turned them off; the maximum video duration; the commercial content disclosure; and
> an explicit consent checkbox with TikTok's Music Usage Confirmation and Branded Content Policy
> declarations. Videos are sent with FILE_UPLOAD. Photos are sent with PULL_FROM_URL from our
> verified URL prefix, https://msg-response-auto.vercel.app/. We read each post's status to show
> the creator whether it was published.

**Webhooks**

> Our callback, https://msg-response-auto.vercel.app/api/tiktok/webhook, receives post.publish.*
> events to update the post's status in the creator's dashboard, and authorization.removed, on
> which we delete the stored connection and its tokens. Every delivery is verified with the
> Tiktok-Signature header.

**`user.info.basic`**

> To show the creator which TikTok account is connected: its display name and avatar on the
> Settings page. We store the open_id to match webhook events to the right workspace.

**`video.publish`**

> To publish the creator's scheduled videos and photo posts directly to their profile, with the
> privacy, interaction and disclosure settings they chose in our composer.

**`video.upload`**

> For creators who prefer to finish a post in TikTok: at the scheduled time the video or photos are
> sent to their TikTok inbox as a draft, which they edit and post in the TikTok app.

Every sentence above is backed by code: `src/routes/tiktok.ts` (callback, state cookie, webhook),
`src/services/tiktokConnections.ts` (encryption, disconnect), `src/services/tiktokPublish.ts`
(creator_info re-checks, defaults), `dashboard/js/pages/posts.js:986-1005` (every choice starts off).

### 7.3 The demo video, shot by shot

TikTok's requirements, from the rollout: **recorded in the sandbox**, and showing the web app's
domain, Connect TikTok, the Direct Post composer — privacy with no default, interaction toggles
off by default, the commercial-content disclosure, the consent declaration — and the post
appearing on TikTok.

**Prepare:** the sandbox key in Settings; the creator's account a target user; **Disconnect
TikTok** first, so the recording shows a fresh Connect; the account set to private (the post will
be Only me — say so on screen); a short MP4 (5–15 s, H.264); a screen recorder that captures the
browser's address bar; the phone, with TikTok open on the profile.

| # | Show | Hold on |
|---|---|---|
| 1 | `https://msg-response-auto.vercel.app/` in the browser | the address bar — this is "the domain" |
| 2 | Log in to `/dashboard` | the workspace name — and the tenant switcher, if the demo login belongs to more than one workspace |
| 3 | Settings → TikTok → **Connect TikTok** | the section before connecting |
| 4 | TikTok's authorisation page | the app name "AutoReply Pro" and the scopes; log in and authorise |
| 5 | Back on Settings | "TikTok connected.", the **Connected** pill, the account name, the three **Permissions** chips |
| 6 | Posts Scheduler → new post → Platform **TikTok**, Type **Video**, upload, write a caption | the upload finishing |
| 7 | "TikTok post settings" | "Posts to" and the nickname; "Who can see this video" reading **Choose who can see this** — no default. Open it to show the options TikTok offers, then choose **Only me** |
| 8 | "Interactions" | **Allow comments, Allow Duet, Allow Stitch all unticked**. Tick one and untick it, to show they are real choices |
| 9 | "Commercial content" | switch on **Disclose commercial content**: "You need to indicate if your content promotes yourself, a third party, or both." Choose **Your brand** → "Promotional content". Show that **Branded content** cannot be combined with Only me |
| 10 | The declaration and consent | "By posting, you agree to TikTok's Music Usage Confirmation."; press publish *without* ticking consent to show it is refused; then tick **I agree to post this video to my TikTok account** |
| 11 | **Publish now** | the card going from "TikTok is processing" to **Published** |
| 12 | The phone, or TikTok on the web | the post on the profile, with the same caption. On screen: "Only me because the app is not audited yet" |
| 13 | *(optional)* the same for a photo carousel | the **TikTok title** field and **Auto-add music** |
| 14 | *(optional)* **Disconnect TikTok** → confirm | the dialog saying access is revoked and the connection deleted |

One continuous take per part reads as more credible than a montage. Check the form's size and
length limits before recording.

### 7.4 Pre-submission checklist

- [ ] **Terms and Privacy name a real contact email and the operator.** All three public pages still
  say `[not yet supplied]` (`public/terms.html:1187-1188`, `public/privacy.html:1253-1254`,
  `public/data-deletion.html:1057-1058`). Reviewers look for these.
- [ ] **Terms and Privacy describe the scopes you are asking for.** Today they promise exactly two
  scopes, `user.info.basic` and `video.upload`, "and no others", uploads to the inbox only, and
  that nothing is posted publicly on the owner's behalf (`public/privacy.html:1073-1096`,
  `public/terms.html:994-996`, `:1027-1030`). The submission asks for `video.publish` and shows
  Direct Post and photo posts, so the pages must say so first — otherwise the reviewer finds the
  contradiction.
- [ ] Every URL registered exactly as Settings lists it; the three pages answer `200` (§2.4).
- [ ] The URL prefix is verified, and every verification file still answers `200` (§2.5).
- [ ] The production app has the same products, scopes, redirect URI and webhook URL as the sandbox.
- [ ] The Settings card shows **Connected** and all three **Permissions** for the sandbox account.
- [ ] One end-to-end Only me post has been proven (VERIFYING.md, "Verifying TikTok").
- [ ] The demo video covers every row of §7.3 up to 12.
- [ ] Each product and scope has its text (§7.2), and the app description matches what the
  dashboard really does (§7.1).
- [ ] If the form asks for reviewer access to the dashboard, create a dedicated demo user on a demo
  workspace (Users screen, a password of 12+ characters). **Never hand over `DASHBOARD_PASSWORD`**:
  it mints a `platform_admin` session.

After approval: swap in the production key and secret and reconnect (§8.3), then tick Audited (§5.2).

---

## 8. Tokens and reconnecting

### 8.1 Lifetimes

| Token | Lives | Stored | Renewed |
|---|---|---|---|
| Access token | **24 hours** | `platform_connections.access_token`, `enc:v1` | on use, when less than 10 minutes are left (`getAccessToken`, `src/services/tiktokConnections.ts:302-323`), and every day by the cron for every active connection (`refreshAllConnections`, `:330-354`, called at `src/routes/api.ts:890`) |
| Refresh token | **365 days from the first authorisation** — refreshing does not extend it | `refresh_token`, `enc:v1` | replaced on every refresh, because TikTok may rotate it; only one refresh runs at a time, and a claim older than 2 minutes is taken over (`src/services/tiktokConnections.ts:247-292`) |
| OAuth state | 10 minutes, single use | `oauth_states` | per Connect (`:33`, `:49-75`) |

**Reconnect once a year.** The card's "A TikTok connection lasts one year — reconnect before
*date*" is the refresh token's expiry, and it adds a days-left warning inside 30 days. Diarise the
date, as with Meta's data-access date (RUNBOOK §3). After reconnecting, read the new date: it comes
from TikTok's own answer (`refresh_expires_in`, `src/services/tiktok.ts:201-213`), so it is the truth.

The daily cron's refresh is a **health check** the Meta side never had: a revoked account is
found at 00:00 UTC, not by the next scheduled post.

### 8.2 What makes a connection "Needs reconnecting"

- **A refresh refused** with `access_token_invalid`, `invalid_grant`, `scope_not_authorized` or
  `scope_permission_missed` (`src/services/tiktok.ts:95-100`) → the row becomes `invalid` with
  TikTok's reason in `last_error` — unless another invocation had just rotated the token, in which
  case nothing is dead (`src/services/tiktokConnections.ts:273-286`).
- **Any publish call** failing with one of those codes does the same (`noteTikTokFailure`,
  `:360-367`, called at `src/services/tiktokPublish.ts:565`).
- **Transient failures never do** — a 5xx, a timeout or a rate limit releases the claim for the
  next caller (`src/services/tiktokConnections.ts:288-290`).

While it is invalid: the card shows **Needs reconnecting** and "Last problem: …"; every TikTok post
that comes due **fails** with that reason (`:307-309`); and scheduling a new TikTok post is refused
with "TikTok is not connected — connect it in Settings first." (`src/routes/api.ts:2236-2239`).

**The only fix is Reconnect** (§4.3); a dead refresh token cannot be revived. Then retry what failed
in the meantime with **Publish now**.

The app checks a post's scope *before* calling TikTok, because TikTok's `scope_not_authorized`
would mark the whole connection invalid and so block the other mode as well
(`src/services/tiktokPublish.ts:495-502`).

### 8.3 Switching from the sandbox key to the production key

When the production app is approved:

1. Confirm the production app has everything in §2: products, scopes, redirect URI, webhook URL,
   URL properties.
2. Settings → TikTok app: paste the **production** Client key and Client secret → **Save TikTok
   app**. From that moment webhooks are verified with the production secret.
3. **Every workspace: Reconnect.** The stored tokens were issued to the sandbox app, so expect the
   next refresh under the production key to be refused and the card to say Needs reconnecting
   (§8.2). Reconnecting straight away saves a failed post. The account may come back with a
   different `open_id`, which is fine: the reconnect replaces the workspace's row in place.
4. Tick **Audited** only if the approval covers the Direct Post audit (§5.2).

### 8.4 Reading the connection from the database

```sql
SELECT c.name AS workspace, p.display_name, p.status, p.scopes,
       p.access_expires_at, p.refresh_expires_at, p.last_refreshed_at,
       p.refresh_claimed_at, left(p.last_error, 160) AS last_error
  FROM platform_connections p
  JOIN creators c ON c.id = p.creator_id
 WHERE p.platform = 'tiktok';
```

Healthy: `status = active`; `last_refreshed_at` within the last day (the daily cron);
`access_expires_at` in the future or refreshed on the next use; `refresh_expires_at` months away;
`refresh_claimed_at` NULL.

---

## 9. Limits

| Limit | Value | Whose | What happens when you hit it |
|---|---|---|---|
| Unposted inbox drafts | **5 per 24 hours** | TikTok. Counted here conservatively: this workspace's inbox rows `PUBLISHING`, `PROCESSING` or `IN_INBOX` claimed in the last 24 h (`src/services/tiktokPublish.ts:173`, `:190-201`) | the post is **held**, not failed: back to `PENDING` with "Waiting for TikTok: *n* drafts…", and it goes out on a later sweep; **Publish now** answers 409. Direct posts do not count |
| Photo post init | **6 calls a minute** per token | TikTok (`src/services/tiktok.ts:582-585`) | `rate_limit_exceeded` → the post **fails**; the init is never retried automatically (§11) |
| Status checks | 30 a minute per token | TikTok | the sweep asks about at most 10 rows per drain and 25 per daily cron (`src/services/tiktokPublish.ts:577-582`, `src/routes/api.ts:894`) |
| Posts per day per account | TikTok's own cap | TikTok | `spam_risk_too_many_posts` → retry tomorrow |
| Active users of the app | TikTok's daily cap for this app | TikTok | `reached_active_user_cap` → retry later |
| Before the audit | Only me, on a private account | TikTok | §6.3 |
| Video file | MP4, MOV or WebM here; TikTok asks for MP4 (H.264). TikTok takes up to 4 GB, sent whole up to 64 MB and in 32 MB chunks above — but the function holds the whole file in memory, it is read from `media_uploads` (Postgres, on a 500 MB tier), and a video at an outside URL is capped at 256 MB | both (`src/services/tiktokPublish.ts:42`, `:50`; `src/services/tiktok.ts:304-349`) | refused before upload with "TikTok accepts MP4, MOV or WebM video — …" |
| Video length | the account's own maximum (`max_video_post_duration_sec`) | TikTok; checked here before upload for Direct Post (`src/services/tiktokPublish.ts:314-317`) | "This video is *n*s; your TikTok account allows up to *m*s." |
| Frame rate, resolution | 23–60 fps; 360–4096 px on each side | TikTok, after processing (`src/services/tiktok.ts:708-722`) | FAILED with TikTok's reason (§11.2) |
| Photos per post | 1 (`image`) or 2–35 (`carousel`) | both (`src/services/postMedia.ts:20-21`) | refused at scheduling |
| Photo format | JPEG or WebP, uploaded here | TikTok (`src/services/postMedia.ts:24`, `:77-97`) | refused at scheduling, and again at publish |
| Photo title | **90** UTF-16 units | TikTok (`src/services/tiktok.ts:537`) | refused at scheduling if typed; cut to fit if taken from the caption |
| Photo description | **4000** UTF-16 units | TikTok (`:538`) | cut to fit |
| Video caption | **2200** UTF-16 units | TikTok (`:357`) | cut to fit |
| Dashboard upload | about 3.3 MB of file | Vercel's 4.5 MB request cap | write bigger files straight to `media_uploads` (CLAUDE.md, "Workflows") |
| Accounts | one TikTok account per workspace, and one workspace per TikTok account | here (`uq_platform_connections_creator`, `uq_platform_connections_account`, `src/config/migration_v18_tiktok.sql`) | "That TikTok account is connected to another workspace…" |
| Refresh token | 365 days from the first authorisation | TikTok | reconnect yearly (§8) |
| A clickable link in the bio | a **Business** account, or **1,000+ followers** | TikTok | the "link in bio" call to action points at plain text (§10) |

A UTF-16 unit is what JavaScript's `String.length` counts: one per Arabic or Latin letter, **two
per emoji**. Truncation never splits an emoji in half (`truncateUtf16`, `src/services/tiktok.ts:546-551`).

**The 40-second stagger only works if the drain runs often.** Rows are due 40 s apart, but they
go out when a drain runs, and one drain publishes everything already due back to back
(`publishDuePosts`, `src/routes/api.ts:785-831`). With the Heroku worker on (it polls every 60 s)
that is one or two posts a minute; after an hours-long gap in the GitHub schedule it can be the
whole batch at once, and a seventh photo post inside one minute fails with `rate_limit_exceeded`.
Press **Publish now** on those a minute later. Which drainers are running: RUNBOOK §5.1.

---

## 10. Captions and calls to action

### 10.1 What TikTok receives

| Post | The caption goes as | Cut at | Notes |
|---|---|---|---|
| Video, Direct Post | `post_info.title` (documented) | 2200 UTF-16 units | `src/services/tiktokPublish.ts:319-320`, `src/services/tiktok.ts:514` |
| Video, inbox draft | `post_info.title` — **undocumented** for inbox uploads | 2200 | if TikTok answers `invalid_params`/`invalid_param`, the init is repeated once **without** it, and the draft arrives with no caption (`src/services/tiktok.ts:362-412`). The log line `tiktok.upload_started` says `caption_sent: true` or `false`; the card's **Copy caption** button is the fallback |
| Photo, either mode | **title**: the TikTok title field, or else the caption's first line with text on it; **description**: the whole caption | 90 / 4000 | `photoTitle`, `src/services/tiktok.ts:557-562`; `src/services/tiktokPublish.ts:444-447` |

Count in UTF-16 units: one per letter, two per emoji (§9).

### 10.2 The call to action: link in bio, never a comment keyword

- **Nothing on TikTok answers a comment.** No scope this app holds can read comments or send a
  message (§12). A caption that says "comment X and we'll send you the link" promises something
  nothing will deliver.
- **TikTok captions point to the link in the bio: «رابطه في البايو».**
- The Studio enforces it: a TikTok caption must contain «البايو» (STUDIO.md §6), and every one
  carries the Studio's **TikTok caption line** setting — "Every TikTok caption carries this line.
  TikTok can't send DMs, so point people to your bio." The seeded line is in
  `scripts/seed-studio-settings.mjs:67`.
- **The bio link is clickable only on a Business account or with 1,000+ followers.** Before that,
  the call to action works only as text people read and search for.

### 10.3 "Also send to TikTok" copies the Meta caption word for word

The TikTok sibling gets the same caption as the Instagram/Facebook row
(`src/routes/api.ts:2163-2166`, `:2279`). An Instagram caption built around a comment keyword goes
to TikTok with that keyword in it. So either:

- schedule the TikTok post on its own (Platform: TikTok) with a link-in-bio caption; or
- edit the TikTok row's caption before it goes out — allowed while it is `PENDING` or `FAILED`,
  refused once it is `PUBLISHING`, `PROCESSING` or `IN_INBOX` (`src/routes/api.ts:2395-2398`).

The Studio does not have this problem: it writes separate Instagram and TikTok captions.

---

## 11. Error codes

Every TikTok failure lands in `scheduled_posts.error_log`, shown on the post's card. It starts
with the step that failed, then the plain-language sentence:

| Prefix | Step |
|---|---|
| `TikTok post init:` | a Direct Post video's init |
| `TikTok upload init:` | an inbox video's init |
| `TikTok photo post:` | a photo post's init, either mode |
| `TikTok upload (chunk i of n):` | pushing the video bytes |
| `TikTok creator info:` | reading the account's posting options before a Direct Post |
| `TikTok token refresh:` / `TikTok token exchange:` | a refresh / Connect |
| `TikTok status:` | asking TikTok how a post is doing |

A code not in these tables comes through as TikTok's own message, or the bare code
(`toTikTokError`, `src/services/tiktok.ts:140-164`).

### 11.1 API refusals — every code the app translates

`CODE_MESSAGES`, `src/services/tiktok.ts:107-131`. The four marked **re-auth** also mark the
connection `invalid` (`:95-100`, §8.2).

| Code | What `error_log` says | Meaning | Fix |
|---|---|---|---|
| `access_token_invalid` **re-auth** | The TikTok connection has expired or was revoked — reconnect TikTok in Settings. | TikTok no longer accepts the access token | **Reconnect** (§4.3), then **Publish now** on the posts that failed |
| `invalid_grant` **re-auth** | TikTok refused the saved login — reconnect TikTok in Settings. | the refresh token expired (a year after the first authorisation), was revoked, or belongs to another app — sandbox versus production (§8.3) | **Reconnect** |
| `scope_not_authorized` **re-auth** | TikTok did not grant the upload permission — reconnect TikTok and allow video upload. | the token lacks the scope this call needs. The sentence says "upload" even when the missing scope is `video.publish` | check the portal has the scope (§2.3), **Reconnect**, allow everything on the consent screen, then read **Permissions** |
| `scope_permission_missed` **re-auth** | *(same sentence)* | as above | as above |
| `rate_limit_exceeded` | TikTok rate limit reached — it will be retried. | too many calls a minute; for photo inits the ceiling is 6 | **The code is narrower than the sentence:** status checks are retried, but a rate-limited **init** is not — the post is FAILED and stays so. Wait a minute, then **Publish now** |
| `spam_risk_too_many_pending_share` | TikTok allows only 5 unposted inbox drafts per 24 hours. Post or delete the drafts waiting in your TikTok inbox, then retry. | TikTok's own count, which can run ahead of the app's — the app counts only rows still `PUBLISHING`, `PROCESSING` or `IN_INBOX`, not a share TikTok created for an upload that then failed on our side | post or delete the drafts in the TikTok app — if you can find them (§12) — or edit the post to post directly |
| `spam_risk_too_many_posts` | TikTok's daily posting limit for this account has been reached. Retry tomorrow. | TikTok's cap per account per day | **Publish now** tomorrow |
| `spam_risk_user_banned_from_posting` | TikTok has blocked this account from posting. | the account is restricted | nothing here; check the account's notifications in the TikTok app |
| `reached_active_user_cap` | This TikTok app has reached its daily active-user cap. Retry later. | the app's cap on distinct users a day | retry later |
| `unaudited_client_can_only_post_to_private_accounts` | Until TikTok approves this app, direct posts only work when your TikTok account is set to private. Switch the account to private (TikTok → Settings → Privacy), then retry. | the account was public at posting time | §6.3: private → **Publish now** → public |
| `privacy_level_option_mismatch` | That privacy choice is not available for this TikTok account any more — edit the post and choose again. | the post's privacy is no longer among the account's options. The app's own pre-check usually says the same sentence first (`src/services/tiktokPublish.ts:293-295`) | edit the post and choose again |
| `file_format_check_failed` | TikTok rejected the file format — upload an MP4 (H.264). | not a format TikTok takes | re-encode (below), upload, reschedule |
| `invalid_file_upload` | TikTok rejected the uploaded file. | the bytes did not match what the init declared, or the file is damaged | upload the file again and reschedule |
| `url_ownership_unverified` | TikTok can only fetch photos from a verified URL prefix. In the TikTok developer portal, open "URL properties", verify https://msg-response-auto.vercel.app/, then retry. | the prefix is not verified, or the Public site address differs from it | §2.5, then **Publish now** |
| `invalid_param` | TikTok refused the post's settings as invalid. (TikTok: *TikTok's own message*) | TikTok's message names the field — the one thing needed to fix it, so it is kept (`src/services/tiktok.ts:137`, `:150`) | read the field TikTok named, edit, retry. An inbox video has already been retried once without its caption |
| `invalid_params` | *(same)* | as above | as above |
| `app_version_check_failed` | Sending photos to TikTok drafts needs TikTok app version 31.8 or newer. Update the TikTok app, then retry. | an inbox photo draft, an old TikTok app | update the TikTok app on the phone, then **Publish now** |

To re-encode a video into what TikTok and Meta both take (1080×1920 for a reel, H.264, AAC,
faststart):

```bash
ffmpeg -i in.mov -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -ar 48000 -movflags +faststart out.mp4
```

### 11.2 TikTok's verdict after processing — `fail_reason`

When TikTok accepts the upload and then refuses the post, its status says `FAILED` with a
`fail_reason`, and `error_log` holds the sentence below, with no prefix (`FAIL_REASONS`,
`src/services/tiktok.ts:708-727`). It can arrive through any of the three writers — the inline poll,
the webhook or the sweep.

| `fail_reason` | What `error_log` says | Fix |
|---|---|---|
| `file_format_check_failed` | TikTok rejected the file format — use an MP4 (H.264). | re-encode (§11.1) |
| `duration_check_failed` | The video is longer (or shorter) than TikTok allows for this account. | trim it; the composer shows the account's longest allowed video |
| `frame_rate_check_failed` | TikTok needs a frame rate between 23 and 60 fps. | re-encode with `-r 30` |
| `picture_size_check_failed` | TikTok needs a resolution between 360 and 4096 pixels on each side. | re-export, e.g. 1080×1920 |
| `internal` | TikTok had an internal error — retry the post. | **Publish now** |
| `video_pull_failed` | TikTok could not fetch the video. | rare: videos are pushed, not pulled. Upload again and retry |
| `photo_pull_failed` | TikTok could not fetch the photos — check they are still uploaded and that the URL prefix is verified in TikTok's portal. | RUNBOOK §10.3 |
| `publish_cancelled` | The TikTok upload was cancelled. | retry |
| `auth_removed` | The TikTok connection was removed — reconnect TikTok in Settings. | **Reconnect** |
| `spam_risk_too_many_posts` | TikTok's daily posting limit for this account has been reached. | retry tomorrow |
| `spam_risk_user_banned_from_posting` | TikTok has blocked this account from posting. | the TikTok app |
| `spam_risk_text` | TikTok flagged the text of this post. | edit the caption, retry |
| `spam_risk` | TikTok flagged this post as spam risk. | change the post, retry later |
| anything else | TikTok reported: *reason* | search TikTok's docs for the reason |
| none | TikTok reported a failure without a reason. | retry once; if it repeats, change the media |

A later success overwrites such a FAILED — the transition allows it (`applyStatus`,
`src/services/tiktokPublish.ts:246-263`).

### 11.3 Sentences the app writes itself

Not TikTok codes: the app's own checks, most of them made *before* calling TikTok so the reason is
readable.

| What `error_log` says | Where | Fix |
|---|---|---|
| Waiting for TikTok: *n* drafts from the last 24 hours are still in your TikTok inbox (TikTok allows 5). Post them in the TikTok app and this goes out on the next run. — **status stays `PENDING`** | `src/services/tiktokPublish.ts:176-181`, `:555-563` | held, not failed: it retries by itself. Post the drafts, or edit the post to post directly |
| TikTok is not connected for this account — connect it in Settings. | `src/services/tiktokConnections.ts:36-41` | **Connect TikTok**, then **Publish now** |
| *the connection's last problem* (when it is `invalid`) | `src/services/tiktokConnections.ts:307-309` | **Reconnect** |
| The TikTok token is being refreshed by another request — retry in a moment. | `src/services/tiktokConnections.ts:322` | **Publish now** again |
| TikTok app credentials are not configured. | `src/services/tiktokConnections.ts:258-262` | §3 |
| This post is set to post directly, but TikTok has not granted direct posting — reconnect TikTok in Settings. | `src/services/tiktokPublish.ts:497-499` | §5.1, then **Reconnect** |
| This post is set to go to your TikTok drafts, but TikTok has not granted uploading — reconnect TikTok in Settings, or edit the post to post directly. | `src/services/tiktokPublish.ts:500-502` | as it says |
| This TikTok post has no privacy choice — edit it and choose who can see it. | `src/services/tiktokPublish.ts:289` | edit the post |
| Until TikTok approves this app, direct posts can only be private (Only me) — edit the post. | `src/services/tiktokPublish.ts:290-292` | edit, choose **Only me** (or tick Audited, if it has really passed) |
| That privacy choice is not available for this TikTok account any more — edit the post and choose again. | `src/services/tiktokPublish.ts:293-295` | edit the post |
| This video is *n*s; your TikTok account allows up to *m*s. | `src/services/tiktokPublish.ts:314-317` | a shorter video |
| TikTok accepts MP4, MOV or WebM video — this file is … | `src/services/tiktokPublish.ts:507-509` | re-encode (§11.1) |
| TikTok needs a video to upload. / The uploaded video no longer exists — upload it again. | `src/services/tiktokPublish.ts:483`, `:211` | upload again, edit the post |
| TikTok needs a photo to post… / A TikTok carousel takes 2 to 35 photos… / TikTok photos must be JPEG or WebP… / TikTok can only take photos uploaded here… | `src/services/tiktokPublish.ts:385-394`, `src/services/postMedia.ts:77-97` | fix the slides, edit the post |
| TikTok fetches photos from this app's public address, and none is set — add it in Settings → TikTok app. | `src/services/tiktokPublish.ts:396-399` | §3 |
| TikTok did not confirm this upload within 24 hours. Check your TikTok inbox; if it is not there, retry. | `src/services/tiktokPublish.ts:617-620` | RUNBOOK §10.7 |
| TikTok upload has no publish id — schedule it again. | `src/services/tiktokPublish.ts:612-615` | reschedule |
| Abandoned after 5 publish attempts — each claim went stale without completing. … | `src/routes/api.ts:858-865` | RUNBOOK §4.2 |

---

## 12. FAQ

**Why can't I see my drafts?**

Nobody knows yet, and that is the honest answer. On 2026-09-23/24 TikTok reported six uploads as
delivered to the inbox (`SEND_TO_USER_INBOX`, so the cards read "In your TikTok inbox"), and the
creator never found them: no inbox notification on the phone, and nothing among the drafts in
TikTok Studio on the web. So `IN_INBOX` proves only what TikTok *says* about the upload, not that
a draft is visible to anyone. It also costs you: every such draft counts against the five a day,
so a sixth inbox post is held until the oldest one leaves the 24-hour window; the rows stay `IN_INBOX`, the sweep stops asking about
them after 7 days (`src/services/tiktokPublish.ts:594-598`), and nothing in this app can list or
delete a TikTok draft. **Use Direct Post** (§5.1, §6.3). If you do try inbox mode again, first
check the card's display name is the account open on the phone, and that the TikTok app is
up to date — 31.8 or newer for photo drafts. (CLAUDE.md's setup notes expected sandbox inbox
uploads to reach the inbox; the rollout found otherwise.)

**Why is my post "Only me"?**

Because TikTok has not audited the app yet, and until it does every direct post is forced to Only
me — the app refuses anything else (`src/services/tiktokPublish.ts:94-96`). Make it public by
hand: open the post → ⋯ → Privacy settings → Everyone (§6.3). After the audit, tick Audited and
choose Everyone on each post (§5.2).

**Can TikTok auto-DM the people who comment, like Instagram?**

No. None of this app's scopes reads comments or sends messages, and TikTok offers nothing that
would for this app. When researched on 2026-09-23: TikTok's own Comment-to-Message feature was
only available in some countries (Vietnam, Indonesia and Thailand — not Saudi Arabia); its
Business Messaging API could answer a conversation but not start one; and reading or replying to
comments exists only in TikTok's API for Business, which needs a company email domain and a
company-owned website — the same legal-entity blocker as Meta's Advanced Access. Check TikTok's
current documentation before relying on that list. So on TikTok the call to action is the link
in the bio (§10.2).

**Business account or personal?**

**Personal, until the audit.** Direct Post needs the account private at posting time, and TikTok
does not offer "Private account" on a Business account — if the switch is missing under Settings
and privacy → Privacy, the account is a Business one. The catch: a clickable bio link needs a
Business account **or** 1,000+ followers. After the audit the account no longer has to be private,
so switching to Business is safe then.

**Why does a published post have no TikTok link in the dashboard?**

TikTok gives a post id only to public, moderated posts, and an Only me post never gets one — so
`PUBLISHED` with no id is normal. Note one gap in the code: a row that is already `PUBLISHED` does
not take an id that arrives later, because the transition only fills it on the way *into*
`PUBLISHED` (`src/services/tiktokPublish.ts:254-263`). A post you make public by hand afterwards
therefore never gets its link here.

**Why did it go out late?**

No TikTok API takes a publish time, so the app publishes a post when the drain next runs after
its scheduled time — minutes with the Heroku worker on, up to hours on the GitHub schedule alone
(RUNBOOK §4.1, §5.1). **Publish now** skips the wait.

**Is it safe to press Publish now twice?**

Yes. The click claims the row atomically, so a second click while it is sending gets "Cannot
publish now — this post is already PUBLISHING." (`src/routes/api.ts:2551-2579`). And a retry of a
row that already reached TikTok asks TikTok about it first, instead of posting it again
(`src/services/tiktokPublish.ts:430-441`, `:515-528`).

**If I delete a TikTok post from Posts Scheduler, is it deleted on TikTok?**

No. Deleting the row deletes this app's record only (`src/routes/api.ts:2492-2516`). Delete the
post in TikTok.

**Can two workspaces use the same TikTok account?**

No. One TikTok account belongs to one workspace — webhooks name the account, not the workspace —
so the second Connect says "That TikTok account is connected to another workspace. Disconnect it
there first." (`src/services/tiktokConnections.ts:199-201`).

**Does the app read my TikTok comments, followers or analytics?**

No. It stores the account's `open_id`, display name and avatar, its tokens (encrypted), and what
TikTok reports about each post the app sent (`public/privacy.html`, "When the account owner
connects TikTok").

---

## Where things live

**Settings** (`app_settings`, edited in Settings → TikTok app; `src/services/appSettings.ts:17-49`):

| Key | Holds | Env fallback |
|---|---|---|
| `tiktok.client_key` | the client key | `TIKTOK_CLIENT_KEY` |
| `tiktok.client_secret` | the client secret, `enc:v1` | `TIKTOK_CLIENT_SECRET` |
| `app.public_base_url` | the Public site address | `PUBLIC_BASE_URL` |
| `tiktok.verification_filename`, `tiktok.verification_content` | the newest verification file | — |
| `tiktok.verification_history` | the ten before it, still served | — |
| `tiktok.direct_post_enabled` | `'true'` when the Direct Post box is ticked | — |
| `tiktok.audited` | `'true'` when the Audited box is ticked | — |

**Tables:** `platform_connections` (one TikTok row per workspace, tokens `enc:v1`), `oauth_states`
(Connect's single-use nonces), and on `scheduled_posts`: `platform = 'tiktok'`,
`platform_options` (mode, privacy, toggles, consent time, photo title), `external_publish_id`
(TikTok's `publish_id`, written before any bytes go up), `status_checked_at`, `group_id` (links a
TikTok row to its Meta sibling), `media_urls` (photo slides). Schema: `src/config/migration_v18_tiktok.sql`,
`migration_v19_tiktok_direct_post.sql`, `migration_v20_carousel.sql`.

**Routes:**

| Route | Who | Does |
|---|---|---|
| `GET /api/tiktok/callback` | TikTok's redirect | finishes Connect |
| `POST /api/tiktok/webhook` | TikTok | status events, `authorization.removed` |
| `GET /api/tiktok/connection` | any member | the Settings card |
| `GET /api/tiktok/creator-info` | any member | the composer's panel, live from TikTok |
| `POST /api/tiktok/connect`, `/disconnect` | workspace owner | Connect, Disconnect |
| `GET`/`POST /api/tiktok/app-settings` | platform admin | the TikTok app block |
| `GET /tiktok<token>.txt` | TikTok's verifier | a saved verification file |
| `GET /terms`, `/privacy`, `/` | anyone | the pages TikTok requires |

**Code:** `src/services/tiktok.ts` (every API call and rule), `src/services/tiktokConnections.ts`
(tokens, OAuth state), `src/services/tiktokPublish.ts` (the post lifecycle), `src/routes/tiktok.ts`
(the routes), `src/services/studio/schedule.ts` (the Studio's queue and batch). The hop-by-hop walk
is FLOWS.md §6.
