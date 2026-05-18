# 📩 Instagram Comment-to-DM Automation

A **free, open-source** alternative to ManyChat ($29/mo), InstantDM, and other paid Instagram automation tools.

Automatically send Direct Messages to users who comment specific keywords on your Instagram posts — fully compliant with Meta's official API, deployed on free infrastructure.

<p align="center">
  <img src="docs/flow-diagram.png" alt="How it works" width="700">
</p>

## ✨ Features

- 🔑 **Keyword Triggers** — Define trigger words per campaign. When someone comments the keyword, they get a DM automatically.
- 📩 **Private DM Replies** — Uses Meta's official Private Reply API (not scraping, not browser automation).
- 💬 **Public Comment Replies** — Optionally reply publicly ("Check your DMs! 📩") to boost engagement.
- 🛡️ **Security** — HMAC SHA-256 signature verification on every webhook payload.
- 🚫 **Spam Prevention** — 24-hour duplicate check prevents re-DMing the same user on the same post.
- ⏱️ **Rate Limiting** — Built-in rate limiter respects Meta's 200 DMs/hour limit.
- 👥 **Multi-Account** — Support multiple Instagram accounts with separate campaigns.
- 📊 **Interaction Logging** — Every interaction is logged with status tracking (PENDING → SENT / FAILED).
- 💰 **Completely Free** — Runs on Vercel (free) + Supabase (free). Zero monthly cost.

## 🏗️ Architecture

```
Instagram Post
     │
     │  User comments a keyword (e.g. "LINK")
     ▼
Meta Webhooks ──POST──▶ Your Server (Vercel)
                              │
                              ├── Verify HMAC Signature
                              ├── Lookup Creator (DB)
                              ├── Match Keyword → Campaign
                              ├── Check 24h Duplicate
                              ├── Check Rate Limit
                              ├── Send Private DM
                              ├── Send Public Reply (optional)
                              └── Log Interaction (DB)
                              │
                              ▼
                        Supabase PostgreSQL
```

## 📋 Prerequisites

Before you start, make sure you have:

| Requirement | Details |
|-------------|---------|
| **Instagram Account** | Must be a **Business** or **Creator** account (not Personal) |
| **Facebook Page** | Your IG account must be linked to a Facebook Page |
| **Meta Developer Account** | Free at [developers.facebook.com](https://developers.facebook.com/) |
| **Supabase Account** | Free at [supabase.com](https://supabase.com/) |
| **Node.js** | v18 or later |
| **Vercel Account** *(for deployment)* | Free at [vercel.com](https://vercel.com/) |

## 🚀 Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/ElAmir-Mansour/instagram-dm-automation.git
cd instagram-dm-automation
npm install
```

### 2. Set Up Supabase Database

1. Create a free project at [supabase.com](https://supabase.com/).
2. Go to **SQL Editor** and run the contents of [`schema.sql`](./schema.sql):

```sql
-- Creates 3 tables: creators, campaigns, interactions
-- Plus indexes for fast webhook lookups
```

<details>
<summary>📄 View full schema</summary>

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS creators (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    instagram_page_id VARCHAR(255) UNIQUE NOT NULL,
    page_access_token TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    creator_id UUID REFERENCES creators(id) ON DELETE CASCADE,
    post_id VARCHAR(255),
    trigger_keyword VARCHAR(255) NOT NULL,
    dm_template TEXT NOT NULL,
    public_reply_template TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS interactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    campaign_id UUID REFERENCES campaigns(id) ON DELETE CASCADE,
    comment_id VARCHAR(255) UNIQUE NOT NULL,
    sender_username VARCHAR(255) NOT NULL,
    post_id VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'PENDING',
    error_log TEXT,
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_campaigns_trigger ON campaigns(trigger_keyword);
CREATE INDEX IF NOT EXISTS idx_interactions_spam_check ON interactions(sender_username, post_id, timestamp);
```

</details>

### 3. Set Up Meta Developer App

1. Go to [Meta for Developers](https://developers.facebook.com/) → **Create App** → Choose **Business** type.
2. Add the **Instagram Graph API** product.
3. Link your Instagram Professional account.
4. Generate a **Page Access Token**:
   - Go to **Tools → Graph API Explorer**
   - Select your App and the Facebook Page linked to your IG account
   - Add these permissions:
     - `instagram_manage_messages`
     - `instagram_manage_comments`
     - `pages_manage_metadata`
     - `pages_read_engagement`
   - Click **Generate Access Token**
   - ⚠️ Use the [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) to extend it to a **Long-Lived Token** (lasts 60 days)

5. **Insert your data into the `creators` table:**

```sql
INSERT INTO creators (instagram_page_id, page_access_token)
VALUES ('YOUR_FACEBOOK_PAGE_ID', 'YOUR_LONG_LIVED_PAGE_ACCESS_TOKEN');
```

> **💡 How to find your Page ID:** Go to Graph API Explorer and query `me?fields=id,name` with your Page Access Token.

### 4. Create a Campaign

Here's a real-world example — when someone comments **"تم"** on your post, they get a welcoming DM:

```sql
INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template)
VALUES (
    'CREATOR_UUID_FROM_STEP_ABOVE',
    'تم',                                                          -- Trigger keyword
    'أهلاً وسهلاً! 👋 شكراً لتعليقك. تابعنا عشان يوصلك كل جديد! 🔥

🔗 شوف المشروع هنا:
https://github.com/ElAmir-Mansour/instagram-dm-automation',         -- DM message
    'تم الإرسال في الخاص! 📩'                                       -- Public reply (optional, can be NULL)
);
```

Now whenever someone comments a message containing **"تم"** on any of your posts, they'll automatically receive:
1. A **DM** welcoming them with a follow request and the project link
2. A **public reply** saying "تم الإرسال في الخاص! 📩"

> **💡 Tip:** You can create multiple campaigns with different keywords. For example, add another campaign with keyword `"link"` that sends an English welcome message.

### 5. Configure Environment Variables

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
PORT=3000
DATABASE_URL=postgresql://postgres:YOUR_PASSWORD@db.YOUR_PROJECT.supabase.co:5432/postgres
META_VERIFY_TOKEN=any_random_string_you_choose
META_APP_SECRET=your_facebook_app_secret
```

| Variable | Where to find it |
|----------|-----------------|
| `DATABASE_URL` | Supabase Dashboard → Settings → Database → Connection String (URI) |
| `META_VERIFY_TOKEN` | Any random string — you'll use the same value when setting up webhooks |
| `META_APP_SECRET` | Meta Developer Console → App Settings → Basic → App Secret |

### 6. Run Locally

```bash
npm run start:dev
```

You should see:
```
🚀 Server running on port 3000
   Health:   http://localhost:3000/health
   Webhook:  http://localhost:3000/webhook
   Privacy:  http://localhost:3000/privacy
```

### 7. Connect Meta Webhooks

#### For Local Testing (using ngrok):

```bash
# Install ngrok: https://ngrok.com/
ngrok http 3000
```

This gives you a public URL like `https://abc123.ngrok-free.app`.

#### Configure in Meta Dashboard:

1. Go to your Meta App Dashboard → **Webhooks**
2. Select **Instagram** from the dropdown
3. Click **Edit Subscription**
4. Enter:
   - **Callback URL:** `https://abc123.ngrok-free.app/webhook` (or your Vercel URL for production)
   - **Verify Token:** The same value as your `META_VERIFY_TOKEN` env variable
5. Click **Verify and Save**
6. Subscribe to the **`comments`** field ✅

### 8. Test It!

1. Go to your Instagram post
2. Comment with your trigger keyword (e.g., "I want the link")
3. Check your server logs — you should see the webhook arrive
4. The commenter should receive a DM within seconds ⚡

## 🚢 Deploy to Production (Vercel)

```bash
# Install Vercel CLI
npm i -g vercel

# Deploy
vercel

# Follow the prompts, then add your environment variables:
vercel env add DATABASE_URL
vercel env add META_VERIFY_TOKEN
vercel env add META_APP_SECRET
```

After deploying, update your **Meta Webhook URL** to your Vercel production URL (e.g., `https://your-project.vercel.app/webhook`).

> **💡 Vercel Free Tier** gives you 1M function invocations/month — more than enough for most creators.

## 📁 Project Structure

```
├── src/
│   ├── index.ts              # Express app — webhook routes & request pipeline
│   ├── config/
│   │   ├── db.ts             # PostgreSQL connection pool (Supabase)
│   │   └── env.ts            # Environment variable validation
│   ├── services/
│   │   └── instagram.ts      # Instagram Graph API — send DMs & replies
│   └── utils/
│       ├── signature.ts      # HMAC SHA-256 webhook signature verification
│       └── rateLimiter.ts    # Rate limiter (respects Meta's 200 DMs/hr)
├── public/
│   ├── privacy.html          # Privacy Policy page (required by Meta)
│   └── data-deletion.html    # Data Deletion page (required by Meta)
├── schema.sql                # Database schema (run in Supabase SQL Editor)
├── vercel.json               # Vercel deployment configuration
├── .env.example              # Environment variable template
└── package.json
```

## ⚙️ API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check — returns server & database status |
| `GET` | `/webhook` | Meta webhook verification handshake |
| `POST` | `/webhook` | Receives Instagram comment events from Meta |
| `GET` | `/privacy` | Privacy Policy page |
| `GET` | `/data-deletion` | Data Deletion Instructions page |

## 📏 Meta API Limits

| Rule | Limit |
|------|-------|
| Private replies per hour | 750 per IG account |
| Automated DMs per hour | ~200 per IG account |
| Messages per comment | 1 (one private reply per comment) |
| Comment age for reply | Must be within 7 days |
| Conversation window | 24 hours after user's last message |
| Per-user cap | 1 automated DM per user per 24 hours |

## 💰 Cost Breakdown

| Service | Free Tier | Monthly Cost |
|---------|-----------|:------------:|
| Vercel (Hosting) | 1M invocations/month | **$0** |
| Supabase (Database) | 500 MB storage | **$0** |
| Meta Graph API | No per-message cost | **$0** |
| **Total** | | **$0/month** |

## 🔒 Meta App Review

To move from Development Mode (testing only) to Live Mode (public), you need to pass Meta App Review:

1. **Complete [Business Verification](https://business.facebook.com/settings/security)** in Meta Business Manager
2. **Submit a screencast** (1080p, under 5 min) showing:
   - User login / Instagram account connection
   - A real comment triggering a real DM
   - Which permission enables each action
3. **Required permissions:**
   - `instagram_manage_comments`
   - `instagram_manage_messages`
   - `pages_manage_metadata`
   - `pages_read_engagement`
4. **Required pages** (already included in this project ✅):
   - Privacy Policy at `/privacy`
   - Data Deletion at `/data-deletion`

## 🛠️ Database Management

### View Recent Interactions
```sql
SELECT i.sender_username, i.status, i.timestamp, c.trigger_keyword
FROM interactions i
JOIN campaigns c ON i.campaign_id = c.id
ORDER BY i.timestamp DESC
LIMIT 20;
```

### Check Failed Messages
```sql
SELECT sender_username, comment_id, error_log, timestamp
FROM interactions
WHERE status = 'FAILED'
ORDER BY timestamp DESC;
```

### Add a New Campaign
```sql
INSERT INTO campaigns (creator_id, trigger_keyword, dm_template, public_reply_template)
VALUES (
    'your-creator-uuid',
    'info',
    'Thanks for your interest! Here is all the info: https://example.com/info',
    'Sent you a DM with more details! 📩'
);
```

### Deactivate a Creator
```sql
UPDATE creators SET is_active = false WHERE instagram_page_id = 'YOUR_PAGE_ID';
```

## 🤔 FAQ

<details>
<summary><b>Can I trigger on multiple keywords?</b></summary>

Yes! Create multiple campaigns for the same creator, each with a different `trigger_keyword`. Each keyword can have its own DM template.

</details>

<details>
<summary><b>Can I target specific posts only?</b></summary>

Yes. Set the `post_id` field in the campaigns table to a specific Instagram post ID. If `post_id` is `NULL`, the campaign triggers on ALL posts.

</details>

<details>
<summary><b>What happens if my Vercel app goes down?</b></summary>

Meta will retry webhook deliveries for a period of time. Your app will process them when it's back online. Already-sent interactions won't be re-sent thanks to the duplicate prevention logic.

</details>

<details>
<summary><b>Will this get my Instagram account banned?</b></summary>

No — this uses Meta's **official Graph API**. It's the exact same API that ManyChat and other Meta-approved partners use. As long as you respect rate limits and don't spam, you're fully compliant.

</details>

<details>
<summary><b>How do I renew my Page Access Token?</b></summary>

Long-lived tokens expire after 60 days. To renew:
1. Go to Graph API Explorer
2. Generate a new token
3. Extend it using the Access Token Debugger
4. Update the `page_access_token` in your `creators` table

</details>

<details>
<summary><b>Does this work with Reels?</b></summary>

Yes! Instagram treats Reel comments the same as post comments in the Webhooks API. Your trigger keywords will work on Reels automatically.

</details>

## 🗺️ Roadmap

- [ ] Rich message templates (buttons, quick replies, carousels)
- [ ] Story reply & mention triggers
- [ ] Multi-keyword campaigns with match modes (exact, contains, regex)
- [ ] Template variables (`{{username}}`, `{{keyword}}`)
- [ ] Admin dashboard (web UI for managing campaigns)
- [ ] Analytics & conversion tracking
- [ ] Automatic token refresh notifications
- [ ] Multi-step conversation flows

## 📄 License

MIT License — feel free to use this for personal or commercial projects.

## ⭐ Star This Repo

If this saved you $29/month on ManyChat, consider giving it a ⭐ — it helps others discover the project!
