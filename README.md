# ⚡ AutoReply Pro — Instagram DM Automation

A self-hosted Instagram Comment-to-DM automation platform with a premium glassmorphic dashboard. When users comment a trigger keyword on your posts, the bot automatically sends them a DM and optionally replies publicly.

## 🚀 Features

- **Comment → DM Automation** — Keyword-triggered DMs sent via the official Meta Graph API
- **Campaign Management** — Create, edit, and delete campaigns from the dashboard
- **Analytics Dashboard** — Real-time charts, stats, and activity logs
- **Token Management** — Validate and update Meta tokens directly from the UI
- **Webhook Processing** — Receives and processes Instagram webhook events
- **Production-Ready** — Deployed on Vercel with PostgreSQL (Supabase)

## 📸 Dashboard

The dashboard is available at `/dashboard` and includes:
- **Overview** — Hero stats, activity charts, status donut, recent activity
- **Campaigns** — CRUD management with glassmorphic cards
- **Analytics** — 30-day stacked bar chart + performance breakdown
- **Activity Log** — Paginated, searchable interaction history
- **Settings** — Token validation, expiry display, account info

## 🛠️ Setup

### Prerequisites
- Node.js 18+
- A PostgreSQL database (Supabase recommended)
- A Meta Developer App with Instagram Graph API configured
- A Vercel account for deployment

### 1. Clone & Install
```bash
git clone https://github.com/ElAmir-Mansour/instagram-dm-automation.git
cd instagram-dm-automation
npm install
```

### 2. Environment Variables
```bash
cp .env.example .env
```

Edit `.env` with your values:
```env
PORT=3000
DATABASE_URL=postgresql://...
META_VERIFY_TOKEN=your_webhook_verify_token
META_APP_SECRET=your_app_secret
DASHBOARD_PASSWORD=your_dashboard_login_password
```

### 3. Database Setup
Run the schema in your Supabase SQL editor:
```sql
-- See schema.sql for full schema
```

### 4. Meta Access Token (IMPORTANT!)

You need a **permanent Page Access Token** that never expires. Follow these steps:

#### Option A: Use the Exchange Script (Recommended)
1. Go to [Graph API Explorer](https://developers.facebook.com/tools/explorer/)
2. Select your app → Set token type to **User Token** (NOT Page Token!)
3. Add all required permissions → Generate Access Token
4. Run:
```bash
node scripts/exchange-token.mjs YOUR_SHORT_LIVED_USER_TOKEN
```
5. The script outputs a permanent Page Token. Save it to your database.

#### Option B: Manual Exchange
See the detailed guide in the [Token Management Guide](docs/TOKEN_GUIDE.md).

#### Token Types Cheat Sheet
| Type | Lifespan | Source |
|------|----------|--------|
| Short-lived (User or Page) | ~1 hour | Graph API Explorer |
| Long-lived Page | 60 days | Exchange short-lived Page Token |
| **Permanent Page** | ♾️ Never | Exchange User Token → `/me/accounts` |

> ⚠️ **Common mistake:** Generating a Page Token directly from the Explorer and exchanging it only gives 60 days. You MUST start with a **User Token** to get a permanent one.

### 5. Run Locally
```bash
npm run start:dev
```

Visit:
- Dashboard: http://localhost:3000/dashboard
- Health: http://localhost:3000/health

### 6. Deploy to Vercel
```bash
vercel --prod
```

Add all environment variables in Vercel Dashboard → Settings → Environment Variables.

## 📡 Webhook Configuration

In the [Meta Developer Console](https://developers.facebook.com/apps/):
1. Go to your app → Webhooks
2. Set callback URL: `https://your-domain.vercel.app/webhook`
3. Set verify token: same as `META_VERIFY_TOKEN` in your `.env`
4. Subscribe to: `feed` (for comment events)

## 🔧 API Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/auth/login` | No | Login (returns HMAC token) |
| `GET` | `/api/stats` | Yes | Dashboard overview stats |
| `GET` | `/api/stats/daily?days=30` | Yes | Daily breakdown |
| `GET/POST/PUT/DELETE` | `/api/campaigns` | Yes | Campaign CRUD |
| `GET` | `/api/interactions` | Yes | Paginated activity log |
| `GET/POST` | `/api/settings/token` | Yes | Token status & update |

## ⚠️ Known Gotchas

1. **Vercel is stateless** — Never use in-memory stores for auth/sessions. We use HMAC-signed tokens.
2. **Async must complete before response** — Vercel kills the function after `res.send()`. Do all work first.
3. **Token type matters** — Use PAGE tokens for API calls, not USER tokens.
4. **24-hour messaging window** — Meta only allows messaging within 24 hours of user interaction.

## 📄 License

MIT
