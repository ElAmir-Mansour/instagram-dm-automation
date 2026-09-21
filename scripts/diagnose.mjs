#!/usr/bin/env node
/**
 * Live diagnostics: "is this thing working right now?"
 *
 * Reads the deployed app and the production database and reports what is and is not healthy.
 * Everything it does is read-only — the database session is `default_transaction_read_only`
 * (see scripts/lib/live.mjs) and every HTTP call is either a GET or an intentionally
 * unauthorised probe. It never sends a DM, never publishes a post, never writes a row, and
 * never prints a token, password or connection string.
 *
 *   node scripts/diagnose.mjs                    full run against production
 *   node scripts/diagnose.mjs --env ../.env      explicit .env (worktrees have none)
 *   node scripts/diagnose.mjs --url https://…    a different deployment
 *   node scripts/diagnose.mjs --since 2026-09-21T11:00:00Z
 *                                                what counts as "since the deploy"
 *   node scripts/diagnose.mjs --probe-signature  also prove webhook HMAC end-to-end (see below)
 *   node scripts/diagnose.mjs --json             machine-readable, for a cron
 *
 * Exit codes — so this can gate a deploy or drive an alert:
 *   0  everything checked is healthy
 *   1  warnings only (degraded, or unproven and worth a look)
 *   2  at least one critical finding
 *   3  the diagnostics themselves could not run (no DATABASE_URL, read-only guard failed)
 *
 * WHY EACH CHECK EXISTS: this app's failure modes are specifically invisible. A comment that
 * matches no campaign writes no row at all, and a webhook signature rejection happens before
 * anything touches the database — so "silence" and "broken" look identical from the inside.
 * The questions below are the ones that distinguish them, in the order CLAUDE.md says they
 * have historically cost the most time.
 */
import axios from 'axios';
import { createHash, createHmac } from 'crypto';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    color, decryptSecret, describeDbTarget, fingerprint, fmtAge, fmtBytes, fmtTime,
    connectReadOnly, isEncrypted, loadEnv, parseArgs, safeQuery,
} from './lib/live.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
    console.log(`
AutoReply Pro live diagnostics — read-only. Reports what is and is not healthy.

  node scripts/diagnose.mjs [options]

  --env <path>          .env to read DATABASE_URL and the Meta app credentials from
                        (default: the nearest .env walking up from this checkout)
  --url <base>          deployment to check (default https://msg-response-auto.vercel.app)
  --since <iso>         what counts as "since the deploy" (default: the last applied migration)
  --probe-signature     also prove webhook HMAC end-to-end with a signed body that matches
                        nothing and short-circuits before the queue (writes nothing)
  --json                machine-readable output
  --help

Exit: 0 healthy · 1 warnings · 2 critical · 3 could not run.`);
    process.exit(0);
}

const envFile = loadEnv(typeof args.env === 'string' ? args.env : null);

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE_URL = (typeof args.url === 'string' ? args.url : 'https://msg-response-auto.vercel.app').replace(/\/$/, '');
const GRAPH = 'https://graph.facebook.com/v21.0';
const JSON_OUT = Boolean(args.json);

// ─── Thresholds ─────────────────────────────────────────────────────────────────────────
// Each is a judgement call, so each says what it is protecting against.

/** Meta's ~200 automated DMs/hour, minus the buffer src/utils/rateLimiter.ts applies. */
const DM_HOURLY_LIMIT = 180;
/** src/jobs/runner.ts CLAIM_VISIBILITY_SECONDS — past this a claim is reapable, so a job still `running` is stuck. */
const JOB_CLAIM_STALE_S = 300;
/** api.ts releases a scheduled-post claim after this long; past it the row is stranded. */
const POST_CLAIM_STALE_MIN = 15;
/** The cron runs once daily (Hobby-plan limit), so a due post can legitimately wait this long. */
const PUBLISH_LAG_TOLERANCE_H = 26;
/** Supabase free tier. `media_uploads` is BYTEA and grows with every video. */
const STORAGE_TIER_BYTES = 500 * 1024 * 1024;
/** A pending job older than this means no drain is happening — no webhooks, no cron, no external scheduler. */
const QUEUE_PENDING_WARN_MIN = 15;
const QUEUE_PENDING_CRIT_MIN = 90;
/** Substring matching makes short keywords dangerous: `تم` matches inside اهتمام, تمام, يتم. */
const MIN_SAFE_KEYWORD_LEN = 3;

/** The scopes the app's own paths need. Missing any one disables a feature silently. */
const REQUIRED_SCOPES = [
    'instagram_basic',
    'instagram_manage_comments',   // read comments, post public replies
    'instagram_manage_messages',   // private replies + DMs
    'instagram_content_publish',   // scheduled IG posts and reels
    'pages_messaging',             // Facebook DMs
    'pages_manage_engagement',     // comment replies / likes on FB
    'pages_manage_metadata',       // webhook subscription management
    'pages_manage_posts',          // scheduled FB posts
    'pages_read_engagement',
    'pages_read_user_content',
    'pages_show_list',
    'business_management',
];

// ─── Findings ───────────────────────────────────────────────────────────────────────────

const findings = [];
const add = (level, area, message, detail = null) => findings.push({ level, area, message, detail });
const crit = (...a) => add('crit', ...a);
const warn = (...a) => add('warn', ...a);
const ok = (...a) => add('ok', ...a);

/** Facts worth printing even when nothing is wrong — the context an operator reads second. */
const facts = [];
const fact = (area, line) => facts.push({ area, line });

const http = axios.create({ timeout: 20000, validateStatus: () => true });

// ════════════════════════════════════════════════════════════════════════════════════════
// 1. Deployment and security guards
// ════════════════════════════════════════════════════════════════════════════════════════
//
// The guards below are regression canaries for vulnerabilities that actually existed in this
// codebase: a cron endpoint that failed open when CRON_SECRET was unset, and a dashboard
// password whose default ("admin") is committed in a public repository's history. They are
// checked from outside, unauthenticated, exactly as an attacker would find them.

async function checkDeployment() {
    const pages = ['/health', '/dashboard', '/privacy', '/data-deletion'];
    let health = null;
    for (const p of pages) {
        const res = await http.get(BASE_URL + p).catch((e) => ({ status: 0, statusText: e.message }));
        if (p === '/health') health = res;
        if (res.status === 200) {
            fact('deploy', `${p} → 200`);
        } else if (res.status === 503) {
            // The startup guard in src/index.ts: validateEnv() threw, so every route 503s.
            // The body names the missing variable, and that is the whole diagnosis.
            crit('deploy', `${p} → 503 Service misconfigured`, JSON.stringify(res.data).slice(0, 200));
        } else {
            crit('deploy', `${p} → ${res.status} ${res.statusText || ''}`.trim());
        }
    }

    if (health?.data?.database === 'connected') {
        ok('deploy', 'app is up and its database connection works');
        // Worth stating explicitly: a 200 from any route proves validateEnv() passed in
        // production, which is the only external evidence that INSTAGRAM_APP_SECRET,
        // CRON_SECRET and the rest are actually set there — a missing one would 503 everything.
        fact('deploy', 'all 7 required env vars are set in production (validateEnv passed — otherwise every route 503s)');
        const skew = Date.now() - Date.parse(health.data.serverTime);
        if (Math.abs(skew) > 120_000) warn('deploy', `clock skew vs deployment: ${fmtAge(Math.abs(skew))}`);
    } else if (health?.data?.database) {
        crit('deploy', `/health reports database: ${health.data.database}`);
    }

    // ── Guards ──
    const guards = [
        {
            name: 'webhook rejects a bad verify token',
            req: () => http.get(`${BASE_URL}/webhook`, {
                params: { 'hub.mode': 'subscribe', 'hub.verify_token': `diagnostic-wrong-${Date.now()}`, 'hub.challenge': 'probe' },
            }),
            expect: 403,
        },
        {
            name: 'webhook rejects an unsigned POST',
            // No x-hub-signature-256 header at all. Nothing downstream runs: verifyMetaSignature
            // is the first statement in the handler.
            req: () => http.post(`${BASE_URL}/webhook`, { object: 'instagram', entry: [] }),
            expect: 403,
        },
        {
            name: '/api/cron/publish requires the cron secret',
            req: () => http.get(`${BASE_URL}/api/cron/publish`),
            expect: 401,
            // A 500 here is the fail-open regression: requireCronSecret answers 500 when
            // CRON_SECRET is unset, which means the guard is only holding by accident of
            // configuration. A 200 would mean it published everything pending.
            onOther: (status) => status === 500
                ? crit('security', '/api/cron/publish → 500: CRON_SECRET is not configured in production')
                : crit('security', `/api/cron/publish → ${status}, expected 401 — the cron guard is not holding`),
        },
        {
            name: '/api/jobs/drain requires the cron secret',
            req: () => http.get(`${BASE_URL}/api/jobs/drain`),
            expect: 401,
        },
        {
            name: 'the published default password "admin" is rejected',
            req: () => http.post(`${BASE_URL}/api/auth/login`, { password: 'admin' }),
            expect: 401,
            onOther: (status) => status === 200
                ? crit('security', 'DASHBOARD_PASSWORD is still "admin" — that value is in the public repo history')
                : crit('security', `login with "admin" → ${status}, expected 401`),
        },
        {
            name: 'dashboard API requires a session',
            req: () => http.get(`${BASE_URL}/api/stats`),
            expect: 401,
        },
    ];

    let held = 0;
    for (const g of guards) {
        const res = await g.req().catch((e) => ({ status: 0, statusText: e.message }));
        if (res.status === g.expect) { held++; continue; }
        if (g.onOther) g.onOther(res.status);
        else crit('security', `${g.name}: got ${res.status}, expected ${g.expect}`);
    }
    if (held === guards.length) ok('security', `all ${held} security guards hold (403/401 as expected)`);

    const hdrs = health?.headers ?? {};
    const missing = ['content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security']
        .filter((h) => !hdrs[h]);
    if (missing.length) warn('security', `security headers missing: ${missing.join(', ')}`);
    else ok('security', 'security headers present (CSP, HSTS, X-Frame-Options, nosniff)');
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 2. Meta configuration — the highest-value check here
// ════════════════════════════════════════════════════════════════════════════════════════
//
// There is one callback URL per object type, app-wide. CLAUDE.md records an incident where
// the `instagram` object pointed at an unrelated project (api.elharef.shop), so Instagram
// comments never arrived while Facebook worked perfectly — and nothing in this app's logs or
// database could have shown that, because the deliveries were going somewhere else entirely.
// This is the only check that can see it.

const EXPECTED_SUBSCRIPTIONS = {
    instagram: ['comments', 'messages'],
    page: ['feed', 'messages'],
};

async function checkMetaConfig(dbState) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;
    if (!appId || !appSecret) {
        warn('meta', 'META_APP_ID / META_APP_SECRET not available locally — cannot inspect webhook subscriptions',
            'This is the check that catches a callback URL pointing at the wrong project. Run with --env pointing at a .env that has them.');
        return;
    }

    const appToken = `${appId}|${appSecret}`;
    const res = await http.get(`${GRAPH}/${appId}/subscriptions`, { params: { access_token: appToken } });
    if (res.status !== 200) {
        crit('meta', `cannot read webhook subscriptions (${res.status})`, JSON.stringify(res.data?.error ?? res.data).slice(0, 300));
        return;
    }

    const subs = res.data?.data ?? [];
    const expectedHost = new URL(BASE_URL).host;
    const seen = new Set();

    for (const sub of subs) {
        seen.add(sub.object);
        const fields = (sub.fields ?? []).map((f) => f.name);
        let host;
        try { host = new URL(sub.callback_url).host; } catch { host = null; }

        if (host !== expectedHost) {
            // Loud, per the brief: this is the failure that looks like "Instagram is broken".
            crit('meta', `object "${sub.object}" delivers to ${host ?? sub.callback_url} — NOT this deployment (${expectedHost})`,
                `Every ${sub.object} event is being POSTed somewhere else. Fix: Meta App Dashboard → Webhooks → ${sub.object} → Edit callback URL → ${BASE_URL}/webhook`);
        } else if (!sub.active) {
            crit('meta', `object "${sub.object}" is subscribed to the right URL but marked inactive`);
        } else {
            fact('meta', `${sub.object.padEnd(9)} → ${sub.callback_url} (active) [${fields.join(', ')}]`);
        }

        const want = EXPECTED_SUBSCRIPTIONS[sub.object] ?? [];
        const missingFields = want.filter((f) => !fields.includes(f));
        if (missingFields.length) {
            warn('meta', `object "${sub.object}" is not subscribed to: ${missingFields.join(', ')}`,
                'Events for an unsubscribed field are never sent, which is indistinguishable from no activity.');
        }
    }

    for (const obj of Object.keys(EXPECTED_SUBSCRIPTIONS)) {
        if (!seen.has(obj)) {
            crit('meta', `no webhook subscription for object "${obj}"`,
                obj === 'instagram'
                    ? 'Instagram comments and DMs will never arrive. The Instagram-Login app is a separate app — check that its ID is the one being inspected.'
                    : 'Facebook page events will never arrive.');
        }
    }
    if (!findings.some((f) => f.area === 'meta' && f.level === 'crit')) {
        ok('meta', `all ${subs.length} webhook subscriptions point at this deployment`);
    }

    // ── The verify-token handshake ──
    // Meta only re-checks this when a subscription changes, so existing subscriptions keep
    // delivering forever with a wrong or empty token — and then the next callback-URL edit
    // fails with an opaque "Callback verification failed: HTTP 403". Production once had
    // META_VERIFY_TOKEN="" for exactly this reason. Testing it now is the only way to know
    // before you need it.
    const candidates = [];
    if (process.env.META_VERIFY_TOKEN) candidates.push(['local env META_VERIFY_TOKEN', process.env.META_VERIFY_TOKEN]);
    for (const c of dbState.creators ?? []) {
        if (c.webhook_verify_token) candidates.push([`creators.webhook_verify_token (${c.name ?? c.id.slice(0, 8)})`, c.webhook_verify_token]);
    }

    if (!candidates.length) {
        warn('meta', 'no verify token available to test the handshake with',
            'Neither the local env nor any creator row has one. If production is in the same state, every subscription change will fail.');
        return;
    }

    const accepted = [];
    for (const [label, token] of candidates) {
        const challenge = `diag${Date.now().toString(36)}`;
        const r = await http.get(`${BASE_URL}/webhook`, {
            params: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': challenge },
        });
        if (r.status === 200 && String(r.data) === challenge) accepted.push(label);
    }

    if (accepted.length) {
        ok('meta', `verify-token handshake returns the challenge (accepted: ${accepted.join('; ')})`);
    } else {
        crit('meta', 'no known verify token is accepted by the live deployment',
            `Tried ${candidates.length} candidate(s): ${candidates.map(([l, t]) => `${l} [${fingerprint(t)}]`).join('; ')}. `
            + 'Existing subscriptions keep delivering, but any callback-URL or field change will fail with HTTP 403.');
    }
}

/**
 * Optional: prove HMAC signature verification positively, from outside, with zero writes.
 *
 * Off by default because it is the only thing in this script that POSTs. It is safe, and the
 * reason is structural rather than a matter of care: src/index.ts checks the signature first,
 * then rejects any `object` that is not "instagram" or "page" with a 200 — *before* the
 * enqueue. So a correctly signed body carrying object "autoreply-diagnostic-probe" reaches
 * exactly one line of code, writes no row, enqueues no job, matches no campaign and sends
 * nothing to anyone. A 200 proves the app accepted the signature; a 403 proves
 * META_APP_SECRET here differs from production's.
 *
 * Note what it does NOT prove: INSTAGRAM_APP_SECRET. Instagram-signed events use the other
 * app's secret, and that value is not in the local .env.
 */
async function probeSignature() {
    const secret = process.env.META_APP_SECRET;
    if (!secret) { warn('meta', 'signature probe skipped — META_APP_SECRET not available locally'); return; }

    // The `object` value is deliberately not "instagram" or "page": src/index.ts answers 200
    // and returns at that check, before `enqueueWebhookBody`. Nothing is stored, nothing is
    // matched, nothing is sent.
    const body = JSON.stringify({ object: 'autoreply-diagnostic-probe', entry: [] });
    const hmac = createHmac('sha256', secret).update(body).digest('hex');

    const res = await http.post(`${BASE_URL}/webhook`, body, {
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${hmac}` },
    });
    if (res.status === 200) {
        ok('meta', 'webhook HMAC accepted — META_APP_SECRET matches production (probe wrote nothing: unrecognised object short-circuits before the queue)');
    } else if (res.status === 403) {
        crit('meta', 'webhook rejected a correctly signed probe — the local META_APP_SECRET differs from production\'s',
            `local fingerprint ${fingerprint(secret)}. If production's is wrong, every Facebook-signed delivery is 403ing before it touches the database.`);
    } else {
        warn('meta', `signature probe returned ${res.status} (expected 200)`, JSON.stringify(res.data).slice(0, 200));
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 3. Token health
// ════════════════════════════════════════════════════════════════════════════════════════

async function checkTokens(dbState) {
    const appId = process.env.META_APP_ID;
    const appSecret = process.env.META_APP_SECRET;

    for (const c of dbState.creators ?? []) {
        const who = c.name || c.id.slice(0, 8);

        if (!c.page_access_token) { crit('token', `[${who}] no page access token stored`); continue; }

        // Report the at-rest state, then decrypt in memory to use. The token itself is never
        // printed, logged or written anywhere — only its fingerprint.
        if (isEncrypted(c.page_access_token)) {
            fact('token', `[${who}] stored encrypted (enc:v1)`);
        } else {
            warn('token', `[${who}] page_access_token is stored as PLAINTEXT, not enc:v1`,
                'src/config/crypto.ts encrypts on write only, so a token saved before that shipped is still plaintext in a database whose '
                + 'connection string was committed to a public repo. Re-save the token from Settings to encrypt it.');
        }

        let token;
        try { token = decryptSecret(c.page_access_token); }
        catch (err) { crit('token', `[${who}] cannot decrypt stored token: ${err.message}`); continue; }

        if (!appId || !appSecret) {
            warn('token', `[${who}] cannot verify token health — META_APP_ID/META_APP_SECRET not available locally`);
            continue;
        }

        const res = await http.get(`${GRAPH}/debug_token`, {
            params: { input_token: token, access_token: `${appId}|${appSecret}` },
        });
        const d = res.data?.data;
        if (res.status !== 200 || !d) {
            crit('token', `[${who}] /debug_token failed (${res.status})`, JSON.stringify(res.data?.error ?? res.data).slice(0, 300));
            continue;
        }

        if (!d.is_valid) {
            crit('token', `[${who}] token is INVALID — every Meta call fails`, d.error ? JSON.stringify(d.error).slice(0, 200) : null);
        }
        if (d.type !== 'PAGE') {
            crit('token', `[${who}] token type is ${d.type}, must be PAGE`,
                'A USER token cannot post private replies or publish. Exchange it: scripts/exchange-token.mjs.');
        }

        // expires_at 0 means a never-expiring page token, which is what this app needs.
        if (d.expires_at && d.expires_at > 0) {
            const daysLeft = (d.expires_at * 1000 - Date.now()) / 86_400_000;
            if (daysLeft < 7) crit('token', `[${who}] token expires in ${Math.round(daysLeft)}d`);
            else warn('token', `[${who}] token expires in ${Math.round(daysLeft)}d (a never-expiring PAGE token is expected)`);
        }

        // Separate from expiry and easy to miss: data access lapses after 90 days of the user
        // not re-authorising, and when it does, reads start failing while the token stays "valid".
        if (d.data_access_expires_at) {
            const daysLeft = (d.data_access_expires_at * 1000 - Date.now()) / 86_400_000;
            if (daysLeft < 0) crit('token', `[${who}] data access EXPIRED ${Math.abs(Math.round(daysLeft))}d ago`);
            else if (daysLeft < 14) warn('token', `[${who}] data access expires in ${Math.round(daysLeft)}d — re-authorise the app`);
            else fact('token', `[${who}] data access expires in ${Math.round(daysLeft)}d (${fmtTime(d.data_access_expires_at * 1000)})`);
        }

        const scopes = d.scopes ?? [];
        const missing = REQUIRED_SCOPES.filter((s) => !scopes.includes(s));
        if (missing.length) {
            crit('token', `[${who}] missing ${missing.length} required scope(s): ${missing.join(', ')}`,
                'Each missing scope disables a path silently — instagram_manage_messages is DMs, instagram_content_publish is scheduling, '
                + 'pages_manage_engagement is public replies.');
        } else {
            ok('token', `[${who}] token is ${d.type}, valid, ${d.expires_at ? 'expiring' : 'never expires'}, all ${REQUIRED_SCOPES.length} required scopes present`);
        }
        fact('token', `[${who}] app "${d.application}" (${d.app_id}), profile ${d.profile_id}, ${scopes.length} scopes, fingerprint ${fingerprint(token)}`);

        if (c.token_status && c.token_status !== 'valid') {
            warn('token', `[${who}] creators.token_status = "${c.token_status}"`, c.token_error ? String(c.token_error).slice(0, 200) : null);
        }
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 4. Event flow — age is the signal
// ════════════════════════════════════════════════════════════════════════════════════════
//
// A tenant silent for days when it normally is not is the thing nobody notices, so the age of
// the last event is compared against that tenant's own history rather than a fixed number.
// The important caveat, which the output states: a comment matching no campaign writes no
// row, so silence here is not proof of a delivery failure. Only `jobs` can tell those apart
// — every delivery becomes a job row now, matched or not.

async function checkEventFlow(db, dbState) {
    const now = Date.now();
    const deployProxy = typeof args.since === 'string'
        ? new Date(args.since)
        : (dbState.lastMigrationAt ? new Date(dbState.lastMigrationAt) : null);

    for (const c of dbState.creators ?? []) {
        const who = c.name || c.id.slice(0, 8);

        const { rows } = await safeQuery(db, `
            SELECT
              (SELECT max(timestamp)  FROM interactions WHERE creator_id = $1) AS last_interaction,
              (SELECT count(*) FROM interactions WHERE creator_id = $1 AND timestamp > now() - interval '24 hours') AS i_24h,
              (SELECT count(*) FROM interactions WHERE creator_id = $1 AND timestamp > now() - interval '7 days')  AS i_7d,
              (SELECT max(m.created_at) FROM messages m WHERE m.creator_id = $1 AND m.direction = 'inbound')  AS last_inbound,
              (SELECT max(m.created_at) FROM messages m WHERE m.creator_id = $1 AND m.direction = 'outbound') AS last_outbound,
              (SELECT count(*) FROM messages WHERE creator_id = $1 AND direction = 'inbound' AND created_at > now() - interval '7 days') AS dm_7d,
              (SELECT count(*) FROM campaigns WHERE creator_id = $1 AND is_active) AS campaigns_active,
              (SELECT count(*) FROM conversations WHERE creator_id = $1 AND is_bot_active) AS bot_threads,
              (SELECT coalesce(bool_or(is_active), false) FROM ai_agents WHERE creator_id = $1) AS ai_on
        `, [c.id]);
        const r = rows[0] ?? {};

        // The tenant's own rhythm: the median gap between comment interactions over the last
        // 90 days. A fixed "24h is bad" threshold is wrong for an account that gets a comment
        // a week and wrong for one that gets thirty a day.
        const base = await safeQuery(db, `
            WITH g AS (
              SELECT timestamp, lag(timestamp) OVER (ORDER BY timestamp) AS prev
                FROM interactions WHERE creator_id = $1 AND timestamp > now() - interval '90 days')
            SELECT count(*) AS n,
                   (percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (timestamp - prev)))) AS median_gap_s
              FROM g WHERE prev IS NOT NULL
        `, [c.id]);
        const medianGapS = Number(base.rows[0]?.median_gap_s ?? 0);
        const sampleN = Number(base.rows[0]?.n ?? 0);

        const lastI = r.last_interaction ? new Date(r.last_interaction).getTime() : null;
        const ageI = lastI ? now - lastI : null;

        fact('flow', `[${who}] comments: last ${fmtAge(ageI)} ago (${fmtTime(lastI)}), ${r.i_24h} in 24h, ${r.i_7d} in 7d, `
            + `${r.campaigns_active} active campaigns`
            + (sampleN > 5 ? `, typical gap ${fmtAge(medianGapS * 1000)}` : ''));

        if (!lastI) {
            warn('flow', `[${who}] no comment interaction has EVER been recorded`);
        } else {
            // 4x the tenant's own median gap, floored at 6h so a chatty account does not alert
            // over lunch, and only when there is enough history for the median to mean anything.
            const expected = sampleN > 5 ? Math.max(6 * 3600e3, medianGapS * 1000 * 4) : 48 * 3600e3;
            if (ageI > 7 * 86400e3) {
                crit('flow', `[${who}] no comment interaction for ${fmtAge(ageI)}`,
                    'Either nothing matched a campaign for a week, or deliveries are not arriving. Check the queue section — a delivery that '
                    + 'matches nothing still writes a `jobs` row, so zero jobs is the distinguishing evidence.');
            } else if (ageI > expected) {
                warn('flow', `[${who}] no comment interaction for ${fmtAge(ageI)} — this tenant's typical gap is ${fmtAge(medianGapS * 1000)}`);
            } else {
                ok('flow', `[${who}] comment path active — last interaction ${fmtAge(ageI)} ago`);
            }
        }

        const lastDm = r.last_inbound ? new Date(r.last_inbound).getTime() : null;
        const ageDm = lastDm ? now - lastDm : null;
        fact('flow', `[${who}] DMs: last inbound ${fmtAge(ageDm)} ago (${fmtTime(lastDm)}), last outbound ${fmtAge(r.last_outbound ? now - new Date(r.last_outbound).getTime() : null)} ago, `
            + `${r.dm_7d} inbound in 7d, AI agent ${r.ai_on ? 'on' : 'OFF'}, ${r.bot_threads} threads with the bot enabled`);

        if (!lastDm) {
            warn('flow', `[${who}] no inbound DM has ever been recorded — the DM path is entirely unproven`);
        } else if (ageDm > 30 * 86400e3) {
            warn('flow', `[${who}] no inbound DM for ${fmtAge(ageDm)} — the DM path is unexercised, not necessarily broken`,
                'Nothing here can distinguish "nobody messaged" from "messages are not arriving". A DM sent from another account is the only proof; see VERIFYING.md.');
        } else {
            ok('flow', `[${who}] DM path active — last inbound ${fmtAge(ageDm)} ago`);
        }

        if (!r.ai_on) warn('flow', `[${who}] the AI agent row is inactive — inbound DMs will not be answered`);
        if (Number(r.campaigns_active) === 0) crit('flow', `[${who}] no active campaigns — every comment matches nothing and writes no row`);
    }

    // ── Since the deploy ──
    // The question the operator actually has after a large refactor.
    if (deployProxy && !Number.isNaN(deployProxy.getTime())) {
        const { rows } = await safeQuery(db, `
            SELECT (SELECT count(*) FROM interactions WHERE timestamp  > $1) AS interactions,
                   (SELECT count(*) FROM messages     WHERE created_at > $1) AS messages,
                   (SELECT count(*) FROM jobs         WHERE created_at > $1) AS jobs
        `, [deployProxy.toISOString()]);
        const s = rows[0] ?? {};
        const total = Number(s.interactions) + Number(s.messages) + Number(s.jobs);
        const label = typeof args.since === 'string' ? '--since' : 'last migration';
        fact('flow', `since ${fmtTime(deployProxy)} (${label}): ${s.jobs} jobs, ${s.interactions} interactions, ${s.messages} messages`);
        if (total === 0) {
            warn('flow', `NOTHING has been processed since ${fmtTime(deployProxy)} (${fmtAge(now - deployProxy.getTime())} ago) — the current code has never handled a real event`,
                'Not by itself a failure: it is also what a quiet account looks like. But it means the refactored pipeline is unverified in production. '
                + 'Run scripts/watch.mjs and post one comment (VERIFYING.md) — that is the only way to close this.');
        } else {
            ok('flow', `${total} events processed since ${fmtTime(deployProxy)} — the current deployment has handled real traffic`);
        }
    }

    // Campaign hygiene: substring matching plus a two-character keyword is a live hazard.
    const kw = await safeQuery(db, 'SELECT id, trigger_keyword, creator_id FROM campaigns WHERE is_active');
    const risky = [];
    for (const row of kw.rows) {
        for (const k of String(row.trigger_keyword).split(',').map((s) => s.trim()).filter(Boolean)) {
            if (k.length < MIN_SAFE_KEYWORD_LEN) risky.push(`"${k}" (campaign ${row.id.slice(0, 8)})`);
        }
    }
    if (risky.length) {
        warn('flow', `${risky.length} active keyword(s) shorter than ${MIN_SAFE_KEYWORD_LEN} characters: ${risky.join(', ')}`,
            'Matching is substring-based (normalizedCommentText.includes(keyword)), so a short keyword fires on unrelated comments — تم matches inside اهتمام, تمام, يتم.');
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 5. The job queue
// ════════════════════════════════════════════════════════════════════════════════════════

async function checkQueue(db) {
    const byStatus = await safeQuery(db, `
        SELECT status, count(*) AS n, min(created_at) AS oldest, max(created_at) AS newest
          FROM jobs GROUP BY status ORDER BY status`);
    if (byStatus.error) { crit('queue', `cannot read the jobs table: ${byStatus.error}`, 'Migration v13 may not be applied.'); return; }

    if (!byStatus.rows.length) {
        warn('queue', 'the jobs table is EMPTY — no webhook delivery has ever been enqueued',
            'Every delivery writes a job row before the 200 is sent (unless WEBHOOK_QUEUE=off), so an empty table means no delivery has reached '
            + 'the handler since migration v13 was applied. That is the one thing "a comment matched nothing" cannot explain.');
        return;
    }

    fact('queue', byStatus.rows.map((r) => `${r.status}=${r.n}`).join('  '));

    const pend = await safeQuery(db, `
        SELECT count(*) AS n, min(run_after) AS oldest_due
          FROM jobs WHERE status = 'pending' AND run_after <= now()`);
    const pendingN = Number(pend.rows[0]?.n ?? 0);
    if (pendingN > 0) {
        const ageMin = (Date.now() - new Date(pend.rows[0].oldest_due).getTime()) / 60000;
        const msg = `${pendingN} job(s) pending, oldest due ${fmtAge(ageMin * 60000)} ago`;
        if (ageMin > QUEUE_PENDING_CRIT_MIN) {
            crit('queue', msg, 'Nothing is draining. The inline drain only runs when a webhook arrives, and the Vercel cron is once daily — '
                + 'point an external scheduler at GET /api/jobs/drain with the CRON_SECRET bearer.');
        } else if (ageMin > QUEUE_PENDING_WARN_MIN) {
            warn('queue', msg);
        } else {
            ok('queue', msg + ' (within the expected drain window)');
        }
    }

    const stuck = await safeQuery(db, `
        SELECT id, kind, attempts, max_attempts, claimed_at, left(coalesce(last_error, ''), 160) AS err
          FROM jobs WHERE status = 'running' AND claimed_at < now() - interval '${JOB_CLAIM_STALE_S} seconds'
          ORDER BY claimed_at LIMIT 10`);
    for (const j of stuck.rows) {
        crit('queue', `job ${j.id.slice(0, 8)} (${j.kind}) has been "running" since ${fmtTime(j.claimed_at)} — claim is stale`,
            `attempt ${j.attempts}/${j.max_attempts}. A claim is reapable after ${JOB_CLAIM_STALE_S}s, so the invocation holding it died mid-flight.`
            + (j.err ? ` Last error: ${j.err}` : ''));
    }

    const dead = await safeQuery(db, `
        SELECT id, kind, attempts, max_attempts, updated_at, left(coalesce(last_error, ''), 200) AS err
          FROM jobs WHERE status = 'failed' AND attempts >= max_attempts
          ORDER BY updated_at DESC LIMIT 10`);
    for (const j of dead.rows) {
        crit('queue', `job ${j.id.slice(0, 8)} (${j.kind}) exhausted its retries at ${fmtTime(j.updated_at)}`, j.err || 'no error recorded');
    }

    const recentFail = await safeQuery(db, `
        SELECT count(*) AS n FROM jobs WHERE status = 'failed' AND updated_at > now() - interval '24 hours'`);
    if (Number(recentFail.rows[0]?.n ?? 0) > 0) warn('queue', `${recentFail.rows[0].n} job(s) failed in the last 24h`);

    if (!stuck.rows.length && !dead.rows.length && pendingN === 0) ok('queue', 'queue is drained — nothing pending, stuck or dead-lettered');
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 6. Publishing
// ════════════════════════════════════════════════════════════════════════════════════════

async function checkPublishing(db) {
    const byStatus = await safeQuery(db, 'SELECT status, count(*) AS n FROM scheduled_posts GROUP BY status ORDER BY status');
    if (byStatus.error) { crit('publish', `cannot read scheduled_posts: ${byStatus.error}`); return; }
    fact('publish', byStatus.rows.map((r) => `${r.status}=${r.n}`).join('  ') || 'no scheduled posts');

    const stranded = await safeQuery(db, `
        SELECT id, claimed_at, attempts, platform, post_type
          FROM scheduled_posts
         WHERE status = 'PUBLISHING' AND claimed_at < now() - interval '${POST_CLAIM_STALE_MIN} minutes'`);
    for (const p of stranded.rows) {
        crit('publish', `post ${p.id.slice(0, 8)} stranded in PUBLISHING since ${fmtTime(p.claimed_at)} (attempt ${p.attempts})`,
            `Past the ${POST_CLAIM_STALE_MIN}-minute reaper window. The next /api/cron/publish releases it if attempts < 5, and marks it FAILED otherwise.`);
    }

    const overdue = await safeQuery(db, `
        SELECT id, scheduled_time, platform, post_type, attempts,
               extract(epoch FROM (now() - scheduled_time)) / 3600 AS overdue_h
          FROM scheduled_posts
         WHERE status = 'PENDING' AND scheduled_time < now()
         ORDER BY scheduled_time LIMIT 10`);
    for (const p of overdue.rows) {
        const h = Number(p.overdue_h);
        const line = `post ${p.id.slice(0, 8)} (${p.platform}/${p.post_type}) was due ${h.toFixed(1)}h ago and is still PENDING`;
        if (h > PUBLISH_LAG_TOLERANCE_H) {
            crit('publish', line, `Past the ${PUBLISH_LAG_TOLERANCE_H}h the once-daily cron can explain — the cron is not running, or it is erroring before this row.`);
        } else {
            warn('publish', line, 'Expected: the Vercel cron runs once daily at 00:00 UTC (Hobby-plan limit), so scheduled_time is effectively day-granular.');
        }
    }

    const failed = await safeQuery(db, `
        SELECT id, scheduled_time, attempts, left(coalesce(error_log, '(no error_log)'), 220) AS err
          FROM scheduled_posts WHERE status = 'FAILED' ORDER BY scheduled_time DESC LIMIT 5`);
    for (const p of failed.rows) {
        warn('publish', `post ${p.id.slice(0, 8)} FAILED (due ${fmtTime(p.scheduled_time)}, ${p.attempts} attempts)`, p.err);
    }

    // `reel` silently falls through to a text-only feed post with no media, per CLAUDE.md.
    const badType = await safeQuery(db, `
        SELECT count(*) AS n FROM scheduled_posts
         WHERE status IN ('PENDING', 'PUBLISHING') AND post_type = 'reel' AND platform IN ('facebook', 'both')`);
    if (Number(badType.rows[0]?.n ?? 0) > 0) {
        crit('publish', `${badType.rows[0].n} unpublished cross-post(s) use post_type='reel'`,
            "publishFacebookPost does not handle 'reel' and falls through to a text-only feed post with no media. Use post_type='video'.");
    }

    const noCover = await safeQuery(db, `
        SELECT count(*) AS n FROM scheduled_posts
         WHERE status = 'PENDING' AND post_type IN ('video', 'reel') AND (cover_url IS NULL OR cover_url = '')`);
    if (Number(noCover.rows[0]?.n ?? 0) > 0) {
        warn('publish', `${noCover.rows[0].n} pending video post(s) have no cover_url`,
            'Instagram defaults a reel thumbnail to frame 0, so anything fading up from black gets a black tile in the profile grid.');
    }

    if (!stranded.rows.length && !overdue.rows.length && !failed.rows.length) {
        ok('publish', 'no stranded, overdue or failed scheduled posts');
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 7. Rate limits
// ════════════════════════════════════════════════════════════════════════════════════════

async function checkRateLimits(db) {
    const cur = await safeQuery(db, `
        SELECT r.creator_id, coalesce(c.name, left(r.creator_id::text, 8)) AS who, r.bucket, r.count, r.window_start
          FROM rate_limit_counters r
          LEFT JOIN creators c ON c.id = r.creator_id
         WHERE r.window_start = date_trunc('hour', now())
         ORDER BY r.count DESC`);
    if (cur.error) { crit('limits', `cannot read rate_limit_counters: ${cur.error}`); return; }

    if (!cur.rows.length) {
        fact('limits', `no sends counted in the current hour (ceiling ${DM_HOURLY_LIMIT}/hr per tenant)`);
    }
    for (const r of cur.rows) {
        const pct = (Number(r.count) / DM_HOURLY_LIMIT) * 100;
        const line = `[${r.who}] ${r.bucket}: ${r.count}/${DM_HOURLY_LIMIT} this hour (${pct.toFixed(0)}%)`;
        if (Number(r.count) >= DM_HOURLY_LIMIT) {
            crit('limits', line + ' — QUOTA EXHAUSTED, sends are being dropped',
                'checkSendQuota increments then compares, so anything over the limit returns allowed:false and the interaction is marked FAILED.');
        } else if (pct >= 75) warn('limits', line);
        else fact('limits', line);
    }

    const recentDrops = await safeQuery(db, `
        SELECT count(*) AS n FROM interactions
         WHERE status = 'FAILED' AND error_log ILIKE '%rate limit%' AND timestamp > now() - interval '24 hours'`);
    if (Number(recentDrops.rows[0]?.n ?? 0) > 0) {
        crit('limits', `${recentDrops.rows[0].n} interaction(s) in the last 24h were dropped by the hourly quota`);
    }

    const caps = await safeQuery(db, `
        SELECT count(*) AS n FROM dm_send_log WHERE sent_at > now() - interval '24 hours'`);
    fact('limits', `${caps.rows[0]?.n ?? 0} recipient(s) in the 24h per-recipient DM cap window`);
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 8. Schema drift
// ════════════════════════════════════════════════════════════════════════════════════════
//
// The code now ships expecting migrations that may not be applied. A missing one does not
// announce itself: the webhook takes the delivery, the INSERT fails on an unknown column, and
// the failure looks like every other kind of silence. Ordering and checksums mirror
// scripts/migrate.mjs exactly, so this and the runner agree on what "pending" means.

async function checkSchema(db, dbState) {
    const ledger = await safeQuery(db, 'SELECT filename, checksum, applied_at FROM schema_migrations');
    if (ledger.error) {
        crit('schema', 'there is no schema_migrations ledger in this database',
            'Nothing records which migrations ran. Run `npm run migrate:status`, then `scripts/migrate.mjs --baseline` if the schema is already current.');
        return;
    }
    const applied = new Map(ledger.rows.map((r) => [r.filename, r.checksum]));
    dbState.lastMigrationAt = ledger.rows.reduce((max, r) => (!max || r.applied_at > max ? r.applied_at : max), null);

    const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
    const versionOf = (f) => { const m = f.match(/_v(\d+)/); return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER; };

    let files;
    try {
        files = ['../schema.sql', ...readdirSync(path.join(REPO_ROOT, 'src/config'))
            .filter((f) => f.endsWith('.sql'))
            .sort((a, b) => versionOf(a) - versionOf(b) || a.localeCompare(b))];
    } catch (err) {
        warn('schema', `cannot read migration files from ${REPO_ROOT}: ${err.message}`);
        return;
    }

    const pending = [];
    const changed = [];
    for (const rel of files) {
        const full = rel.startsWith('../') ? path.join(REPO_ROOT, rel.slice(3)) : path.join(REPO_ROOT, 'src/config', rel);
        const name = path.basename(full);
        let sql;
        try { sql = readFileSync(full, 'utf8'); } catch { continue; }
        if (!applied.has(name)) { pending.push(name); continue; }
        if (applied.get(name) !== sha(sql)) changed.push(name);
    }

    if (pending.length) {
        crit('schema', `${pending.length} migration(s) in this checkout are NOT applied to the live database: ${pending.join(', ')}`,
            'The deployed code expects them. Apply with `node scripts/migrate.mjs` (or the Supabase SQL editor) before trusting anything else in this report.');
    }
    for (const name of changed) {
        warn('schema', `${name} has been edited since it was applied — the ledger no longer describes the database`,
            'migrate.mjs will not re-run it. Add a new migration instead of editing an applied one.');
    }
    if (!pending.length && !changed.length) {
        ok('schema', `all ${applied.size} migrations applied and unmodified (latest ${fmtTime(dbState.lastMigrationAt)})`);
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 9. Storage
// ════════════════════════════════════════════════════════════════════════════════════════

async function checkStorage(db) {
    const r = await safeQuery(db, `
        SELECT (SELECT count(*) FROM media_uploads) AS files,
               pg_total_relation_size('media_uploads') AS media_bytes,
               pg_database_size(current_database())   AS db_bytes`);
    if (r.error) { warn('storage', `cannot measure storage: ${r.error}`); return; }

    const mediaBytes = Number(r.rows[0].media_bytes);
    const dbBytes = Number(r.rows[0].db_bytes);
    const pct = (dbBytes / STORAGE_TIER_BYTES) * 100;
    fact('storage', `media_uploads: ${r.rows[0].files} files, ${fmtBytes(mediaBytes)} · database total ${fmtBytes(dbBytes)} of ${fmtBytes(STORAGE_TIER_BYTES)} (${pct.toFixed(0)}%)`);

    if (pct >= 85) {
        crit('storage', `database is at ${pct.toFixed(0)}% of the ${fmtBytes(STORAGE_TIER_BYTES)} tier`,
            'media_uploads is BYTEA in Postgres and grows with every video. Move it to S3/R2/Supabase Storage, or prune published rows.');
    } else if (pct >= 60) {
        warn('storage', `database is at ${pct.toFixed(0)}% of the ${fmtBytes(STORAGE_TIER_BYTES)} tier — ${fmtBytes(mediaBytes)} of it is media_uploads BYTEA`);
    } else {
        ok('storage', `storage at ${pct.toFixed(0)}% of the ${fmtBytes(STORAGE_TIER_BYTES)} tier`);
    }

    // The raw Meta event kept with every DM: message bodies and Meta user ids, retained
    // forever unless RAW_PAYLOAD_RETENTION_DAYS is set.
    const raw = await safeQuery(db, `
        SELECT count(*) AS n, min(created_at) AS oldest FROM messages WHERE raw_payload IS NOT NULL`);
    if (Number(raw.rows[0]?.n ?? 0) > 0 && !process.env.RAW_PAYLOAD_RETENTION_DAYS) {
        warn('storage', `${raw.rows[0].n} message(s) still carry raw_payload, oldest ${fmtTime(raw.rows[0].oldest)}, and RAW_PAYLOAD_RETENTION_DAYS is unset locally`,
            'Unset means keep forever — verbatim message bodies and Meta user ids for people who never interacted again. 90 is the recommended value.');
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// 10. Local configuration
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Only ever presence and a fingerprint. The fingerprint is what makes "does my .env match
// production" answerable without either value being visible.

function checkLocalConfig() {
    const required = ['DATABASE_URL', 'META_VERIFY_TOKEN', 'META_APP_SECRET', 'INSTAGRAM_APP_SECRET',
        'GEMINI_API_KEY', 'DASHBOARD_PASSWORD', 'CRON_SECRET'];
    const missing = required.filter((k) => !process.env[k]);

    fact('config', `env source: ${envFile ?? 'process environment only'}`);
    fact('config', `META_APP_ID: ${process.env.META_APP_ID ?? 'unset'} · secrets: ${
        ['META_APP_SECRET', 'INSTAGRAM_APP_SECRET', 'META_VERIFY_TOKEN', 'CRON_SECRET', 'TOKEN_ENCRYPTION_KEY']
            .map((k) => `${k}=${fingerprint(process.env[k])}`).join(' ')}`);

    if (missing.length) {
        // Local absence is not a production fault — production's own state is proven by the
        // 503-vs-200 check in checkDeployment. Say so, rather than raising a false alarm.
        warn('config', `not set in this environment: ${missing.join(', ')}`,
            'Only affects what these diagnostics can verify locally. Production has all of them, or every route would be 503ing. '
            + (missing.includes('INSTAGRAM_APP_SECRET') ? 'Without INSTAGRAM_APP_SECRET, --probe-signature cannot test the Instagram app\'s signing secret.' : ''));
    }
    if (!process.env.TOKEN_ENCRYPTION_KEY) {
        warn('config', 'TOKEN_ENCRYPTION_KEY is not set here — an encrypted token could not be read to check its health');
    }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// Render
// ════════════════════════════════════════════════════════════════════════════════════════

function render() {
    const crits = findings.filter((f) => f.level === 'crit');
    const warns = findings.filter((f) => f.level === 'warn');
    const oks = findings.filter((f) => f.level === 'ok');

    if (JSON_OUT) {
        console.log(JSON.stringify({
            checked_at: new Date().toISOString(),
            target: BASE_URL,
            database: describeDbTarget(process.env.DATABASE_URL ?? ''),
            verdict: crits.length ? 'critical' : warns.length ? 'degraded' : 'healthy',
            critical: crits, warnings: warns, healthy: oks, facts,
        }, null, 2));
        return crits.length ? 2 : warns.length ? 1 : 0;
    }

    // The first five lines are the whole answer. Everything below them is why.
    const verdict = crits.length
        ? color.red(`BROKEN — ${crits.length} critical, ${warns.length} warning(s)`)
        : warns.length
            ? color.yellow(`DEGRADED — ${warns.length} warning(s), nothing critical`)
            : color.green('HEALTHY — everything checked is working');

    console.log(color.bold('\nAutoReply Pro — live diagnostics'));
    console.log(`${color.dim('checked')} ${new Date().toISOString()}  ${color.dim('target')} ${BASE_URL}`);
    console.log(`${color.dim('database')} ${describeDbTarget(process.env.DATABASE_URL ?? '')} ${color.dim('(read-only session)')}`);
    console.log(`${color.dim('verdict')} ${verdict}`);
    console.log('');

    if (crits.length) {
        console.log(color.red('CRITICAL'));
        for (const f of crits) {
            console.log(`  ${color.red('✖')} ${color.bold(f.area.padEnd(8))} ${f.message}`);
            if (f.detail) console.log(`    ${color.dim('→ ' + f.detail)}`);
        }
        console.log('');
    }
    if (warns.length) {
        console.log(color.yellow('WARNINGS'));
        for (const f of warns) {
            console.log(`  ${color.yellow('!')} ${color.bold(f.area.padEnd(8))} ${f.message}`);
            if (f.detail) console.log(`    ${color.dim('→ ' + f.detail)}`);
        }
        console.log('');
    }
    if (oks.length) {
        console.log(color.green('HEALTHY'));
        for (const f of oks) console.log(`  ${color.green('✔')} ${color.bold(f.area.padEnd(8))} ${f.message}`);
        console.log('');
    }

    console.log(color.cyan('DETAIL'));
    let lastArea = null;
    for (const f of facts) {
        if (f.area !== lastArea) { console.log(`  ${color.bold(f.area)}`); lastArea = f.area; }
        console.log(`    ${color.dim(f.line)}`);
    }
    console.log('');

    if (crits.length || warns.length) {
        console.log(color.dim('Next: `node scripts/watch.mjs` then post one comment — see VERIFYING.md.\n'));
    }
    return crits.length ? 2 : warns.length ? 1 : 0;
}

// ════════════════════════════════════════════════════════════════════════════════════════

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set.');
        console.error('  Pass --env <path-to-.env>, or run from a checkout that has one (this script walks up to find it).');
        process.exit(3);
    }

    const db = await connectReadOnly();
    const dbState = { creators: [], lastMigrationAt: null };

    try {
        const creators = await safeQuery(db, `
            SELECT id, name, instagram_page_id, facebook_page_id, is_active, page_access_token,
                   webhook_verify_token, token_status, token_error, created_at
              FROM creators ORDER BY created_at`);
        if (creators.error) {
            crit('deploy', `cannot read the creators table: ${creators.error}`);
        } else {
            dbState.creators = creators.rows.filter((c) => c.is_active);
            const inactive = creators.rows.length - dbState.creators.length;
            fact('config', `${creators.rows.length} creator row(s), ${dbState.creators.length} active${inactive ? `, ${inactive} inactive (not checked)` : ''}`);
            if (!dbState.creators.length) {
                crit('deploy', 'no active creator — the webhook can resolve no tenant, so every delivery is dropped');
            }
        }

        checkLocalConfig();
        // Schema first: a pending migration invalidates most of what follows, and it sets
        // `lastMigrationAt`, which the event-flow check uses as the deploy marker.
        await checkSchema(db, dbState);
        await checkDeployment();
        await checkMetaConfig(dbState);
        if (args['probe-signature']) await probeSignature();
        await checkTokens(dbState);
        await checkEventFlow(db, dbState);
        await checkQueue(db);
        await checkPublishing(db);
        await checkRateLimits(db);
        await checkStorage(db);
    } finally {
        await db.end().catch(() => {});
    }

    process.exit(render());
}

main().catch((err) => {
    console.error(`Diagnostics failed to run: ${err.message}`);
    if (process.env.LOG_STACKS) console.error(err.stack);
    process.exit(3);
});
