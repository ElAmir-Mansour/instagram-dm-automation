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
