# 🔑 Meta Access Token — Critical Operations Guide

## ⚠️ CRITICAL: Read This Before Debugging Token Issues

The #1 recurring issue in this project is **expired tokens**. This document contains everything needed to diagnose and fix token problems.

---

## Token Types (Know the Difference!)

| Type | Lifespan | How to Get |
|------|----------|-----------|
| **Short-lived User Token** | ~1-2 hours | Graph API Explorer → User Token |
| **Short-lived Page Token** | ~1-2 hours | Graph API Explorer → Page Token |
| **Long-lived User Token** | 60 days | Exchange short-lived user token via `/oauth/access_token` |
| **Long-lived Page Token** | 60 days | Exchange short-lived page token via `/oauth/access_token` |
| **Permanent Page Token** | ♾️ NEVER | Get from `/me/accounts` using a long-lived **User** token |

> **KEY RULE:** A Page Token derived from a long-lived User Token via `/me/accounts` will NEVER expire. A Page Token exchanged directly only gets 60 days.

---

## How to Get a PERMANENT Token (Never Expires)

### Step 1: Generate a SHORT-LIVED **USER** token
1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select app: `AutoResponseBot` (App ID: `847772258381375`)
3. **IMPORTANT:** Set token type to **User Token** (NOT Page Token)
4. Add permissions:
   - `pages_show_list`
   - `pages_manage_metadata`
   - `pages_read_engagement`
   - `business_management`
   - `instagram_basic`
   - `instagram_manage_comments`
   - `instagram_manage_messages`
5. Click **Generate Access Token** → Copy it

### Step 2: Run the exchange script
```bash
cd /Users/elamir/Documents/Msg_Response_Auto
node scripts/exchange-token.mjs YOUR_USER_TOKEN
```

### Step 3: Verify
- Go to [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/)
- Paste the output token
- Confirm **Expires: Never**

### Step 4: Update in production
- Go to Dashboard → Settings → Paste the new token
- Or update directly in Supabase: `UPDATE creators SET page_access_token = 'TOKEN' WHERE is_active = true`

---

## How the Exchange Works Internally

```
Short-lived User Token (1 hour)
        │
        ▼  GET /oauth/access_token?grant_type=fb_exchange_token
        │  &client_id=847772258381375
        │  &client_secret={APP_SECRET}
        │  &fb_exchange_token={SHORT_TOKEN}
        │
Long-lived User Token (60 days)
        │
        ▼  GET /me/accounts?access_token={LONG_USER_TOKEN}
        │
Permanent Page Token (NEVER expires) ← This is what we want!
```

### ❌ WRONG PATH (gives 60-day token):
```
Short-lived PAGE Token → exchange → Long-lived PAGE Token (60 days only)
```

### ✅ CORRECT PATH (gives permanent token):
```
Short-lived USER Token → exchange → Long-lived USER Token → /me/accounts → PERMANENT Page Token
```

---

## Token Invalidation Scenarios

A "permanent" token can still be invalidated by:
1. User changes their Facebook password
2. User removes the app from their Facebook settings
3. User loses admin role on the Facebook Page
4. App secret is reset in Meta Developer Console
5. Meta detects suspicious activity and forces re-auth

**When any of these happen:** The webhook will start returning error code `190` and the bot will stop working. Follow the steps above to generate a new token.

---

## Database Schema for Tokens

```sql
-- Table: creators
-- The page_access_token column stores the Meta Page Access Token
SELECT column_name FROM information_schema.columns WHERE table_name = 'creators';
-- Result: id, instagram_page_id, page_access_token, is_active, created_at
```

- `instagram_page_id`: The Instagram Business Account ID (e.g., `17841459652725922`)
- `page_access_token`: The Meta Page Access Token used for all API calls
- `is_active`: Whether this creator is currently active

---

## Error Code Reference

| Error Code | Meaning | Fix |
|-----------|---------|-----|
| `190` | Token expired or invalidated | Generate new permanent token (steps above) |
| `10` | Permission denied | Re-grant permissions in Graph API Explorer |
| `100` | Invalid parameter | Check API endpoint and field names |
| `368` | Temporarily blocked | Rate limit hit — wait 1 hour |
| `4` | Application request limit | Too many API calls — wait |

---

## App Credentials (DO NOT EXPOSE)

- **App ID:** `847772258381375`
- **App Name:** `AutoResponseBot`
- **App Secret:** Stored in `.env` as `META_APP_SECRET` — NEVER commit to git
- **Page ID (Facebook):** `100560442828593` (ElAmir Mansour)
- **Instagram Account ID:** `17841459652725922`

---

## Exchange Script Location

```
/Users/elamir/Documents/Msg_Response_Auto/scripts/exchange-token.mjs
```

Usage: `node scripts/exchange-token.mjs <SHORT_LIVED_USER_TOKEN>`


---

## Ads token (Marketing API)

The Meta ads module (Boost, the Ads screen, the spending guard) does **not** use the Page token above. Each tenant has its own
ads token, stored apart from `creators.page_access_token`. Step-by-step creation for owners and clients: `docs/ADS_GUIDE.md`
("Connect your ad account") and the Help Center article `#/help/ads`.

### Two kinds of ads token

| | System-user token (the default) | Connect token (optional, owner) |
|---|---|---|
| Made in | Meta Business Settings → Users → System users → Generate new token | Facebook Login (Settings → Connect), when the ads scopes are on (`meta.ads_scopes_enabled`) |
| Lifespan | **Never** expires (choose "Never" at generation) | ~60 days, a long-lived USER token |
| `ads.settings.<tenant>.tokenSource` | `pasted` | `connect` |
| Expiry known from | nothing to track | `debug_token` → `tokenExpiresAt` |
| Alert | `token_dead` when it stops working | `token_expiring` **14 days** before the end, then `token_dead` |
| Removed when | the owner removes it on the card | Meta is disconnected or the app is removed in Facebook |

> **KEY RULE:** the cap guard dies with its token. A Connect token that lapses silently means nobody is pausing campaigns at the
> cap. That is why the system-user token is the default and Connect is only a second source.

### Scopes

`ads_management`, `ads_read`, `business_management`, `pages_read_engagement`, `pages_manage_ads`. The ad account, the Page and the
Instagram account must be **assigned** to the system user (ad account with "Manage campaigns"), or Meta answers with a permission
error even though the scopes are ticked (`10/1341012` = the Page is not assigned). The dashboard's **Test connection** lists missing
scopes and the assigned assets; `node scripts/ads-probe.mjs` prints the same from a terminal (`debug_token` needs `META_APP_ID` and
`META_APP_SECRET` in the environment).

### Where it is stored

`app_settings`, key `ads.token.<tenant id>`, value `enc:v1:…` (AES-256-GCM via `src/config/crypto.ts`, same key as the Page token).
The API never returns it, only whether it is set and its last four characters. The account id and limits sit in the JSON row
`ads.settings.<tenant id>`.

### How a dead token is detected

- **Every Meta call** the ads module makes: error code `190` or `102` marks the tenant's `token.health = 'dead'`, stops that
  tenant's queue and raises the `token_dead` alert (once a day). It cannot be switched off.
- **The daily health check** (00:00 UTC cron) checks every enabled tenant: `debug_token` for a Connect token (validity and expiry),
  a cheap `GET /me?fields=id` for a pasted one. This finds a revoked token even when nobody has touched ads that day.
- **The hourly guard** (`/api/jobs/drain`) cannot read spend with a dead token, so after 2 hours without a successful check the
  `guard_blind` alert fires and the Ads overview shows "spending is not being watched".

A system user's token also dies when the system user is deleted, when its asset assignments are removed, or when the app's secret
is reset.

### Rotating it

1. Meta Business Settings → System users → select the user → **Generate new token** (same app, **Never**, the five scopes). The old
   token keeps working until you revoke it, so install the new one first.
2. AutoReply → Settings → Connections → **Meta ads (Boost)** → paste into **System-user ads token** → **Save** → **Test connection**.
3. Only then revoke the old token in Meta (system user → Revoke tokens), if you want it gone.
4. Never paste a token in chat, email or an issue. `scripts/ads-probe.mjs` never prints it.
