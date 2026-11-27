/**
 * What an EXTERNAL monitor may know about the deployment: the unauthenticated `GET /health`, the drain's heartbeat and the optional dead-man ping.
 *
 * Alerts that fire from inside the app cannot say the app is dead: a Vercel outage, a paused database or a stopped Heroku worker tells nobody. So three
 * pieces sit outside it (RUNBOOK "Monitoring"):
 *
 *   `/health`     answers 200 while the database answers and the queue is moving, and **503 when the queue is stuck**: the oldest due job has waited
 *                 more than 10 minutes AND no drain has run for 5. A free uptime monitor on the URL therefore also catches a dead worker.
 *   heartbeat     `recordDrainHeartbeat`, called by `GET /api/jobs/drain`: one row of `app_settings` (`ops.drain_heartbeat`) whose `updated_at` is the
 *                 time of the last run. DB-backed because serverless instances share no memory; written at most once a minute, the throttle being in
 *                 the UPDATE itself (so two instances cannot both write) with an instance-local shortcut that saves the round trip.
 *   dead-man ping `pingDeadMan`: when the platform admin saved a ping URL (Settings → Platform → Monitoring) the drain GETs it at most once every 5
 *                 minutes after a good run. It is handed to `waitUntil`, never awaited, and never throws, so a slow or dead ping service cannot fail or
 *                 slow a drain. No URL means no request.
 *
 * GET /health LEAKS NOTHING: no ids, no tenant names, no counts of anything a business owns. Ages in seconds, booleans, and the database's answer.
 * The webhook booleans mean "an event was written to the queue in the last 24 hours for an account connected here"; a quiet account is normal, so a
 * monitor must NOT alert on them (they are for a human reading the JSON), and they never move the status.
 *
 * Cost: the Vercel Hobby plan has 4 hours of CPU a month. `/health` is two statements (one over a partial index, one over the last 24 hours of
 * `jobs`), the heartbeat one write a minute, the ping one setting read per drain and one write per 5 minutes.
 */
import axios from 'axios';
import { queryCount, queryOne } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { waitUntil } from '../utils/waitUntil.js';
import { APP_SETTING_KEYS, getSetting, last4, setSetting } from './appSettings.js';

/** The queue is stuck when the oldest due job is older than this AND the drain is stale. */
export const QUEUE_STUCK_AFTER_S = 600;
/** No drain run for this long is "stale": the worker calls every 120 s, so this is two and a half missed calls. */
export const DRAIN_STALE_AFTER_S = 300;
/** The heartbeat is written at most this often. */
export const HEARTBEAT_EVERY_S = 60;
/** The dead-man ping goes out at most this often. */
export const PING_EVERY_S = 300;
/** A platform is "fresh" when an event for it was queued within this window. */
export const WEBHOOK_FRESH_WINDOW_S = 24 * 3600;
/** A ping that takes longer than this is abandoned. */
export const PING_TIMEOUT_MS = 5_000;

export interface HealthSnapshot {
    /** Seconds the oldest DUE pending job has waited, or null when none is due. */
    oldestPendingS: number | null;
    /** Seconds since the last recorded drain run, or null when none was ever recorded. */
    drainLastS: number | null;
    /** Booleans per platform, or null when they could not be read. */
    webhooks: { instagram: boolean; facebook: boolean; whatsapp: boolean } | null;
}

export interface HealthBody {
    ok: boolean;
    db: boolean;
    queue_oldest_pending_s: number | null;
    drain_last_s: number | null;
    webhook_fresh: { instagram: boolean; facebook: boolean; whatsapp: boolean } | null;
    /** Kept for scripts/diagnose.mjs and older monitors. */
    status: 'ok' | 'error';
    database: 'connected' | 'disconnected';
    serverTime: string;
}

/** The 503 rule, pure: a stuck queue is an old due job and a drain nobody has seen lately (never seen counts as stale). */
export function isQueueStuck(oldestPendingS: number | null, drainLastS: number | null): boolean {
    if (oldestPendingS === null || oldestPendingS <= QUEUE_STUCK_AFTER_S) return false;
    return drainLastS === null || drainLastS > DRAIN_STALE_AFTER_S;
}

/** The status and body for a snapshot, or for a database that did not answer (`null`). Pure. */
export function composeHealth(snapshot: HealthSnapshot | null, now: Date = new Date()): { status: number; body: HealthBody } {
    const serverTime = now.toISOString();
    if (!snapshot) {
        return {
            status: 503,
            body: {
                ok: false, db: false, queue_oldest_pending_s: null, drain_last_s: null, webhook_fresh: null,
                status: 'error', database: 'disconnected', serverTime,
            },
        };
    }
    const stuck = isQueueStuck(snapshot.oldestPendingS, snapshot.drainLastS);
    return {
        status: stuck ? 503 : 200,
        body: {
            ok: !stuck, db: true,
            queue_oldest_pending_s: snapshot.oldestPendingS,
            drain_last_s: snapshot.drainLastS,
            webhook_fresh: snapshot.webhooks,
            status: stuck ? 'error' : 'ok', database: 'connected', serverTime,
        },
    };
}

const toSeconds = (v: unknown): number | null => {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : null;
};

/** Reads the snapshot. Throws when the database does not answer; the webhook booleans alone fail soft (null). */
export async function readHealthSnapshot(): Promise<HealthSnapshot> {
    const [main, webhooks] = await Promise.all([
        queryOne<{ oldest_pending_s: string | number | null; drain_last_s: string | number | null }>(
            `SELECT
                 (SELECT EXTRACT(EPOCH FROM (NOW() - MIN(run_after))) FROM jobs
                   WHERE status = 'pending' AND run_after <= NOW()) AS oldest_pending_s,
                 (SELECT EXTRACT(EPOCH FROM (NOW() - updated_at)) FROM app_settings WHERE key = $1) AS drain_last_s`,
            [APP_SETTING_KEYS.opsDrainHeartbeat]
        ),
        queryOne<{ instagram: boolean; facebook: boolean; whatsapp: boolean }>(
            `WITH recent AS (
                 SELECT DISTINCT tenant_key FROM jobs
                  WHERE created_at > NOW() - make_interval(secs => $1)
                    AND kind IN ('comment.process', 'dm.process', 'wa.event')
                    AND tenant_key IS NOT NULL
             )
             SELECT
                 EXISTS (SELECT 1 FROM recent r JOIN creators c ON c.instagram_page_id = r.tenant_key) AS instagram,
                 EXISTS (SELECT 1 FROM recent r JOIN creators c ON c.facebook_page_id = r.tenant_key) AS facebook,
                 EXISTS (SELECT 1 FROM recent r JOIN platform_connections p
                           ON p.platform = 'whatsapp' AND p.status <> 'revoked'
                          AND (p.external_account_id = r.tenant_key OR p.profile->>'waba_id' = r.tenant_key)) AS whatsapp`,
            [WEBHOOK_FRESH_WINDOW_S]
        ).catch((err) => {
            log('warn', 'health.webhook_freshness_unread', describeError(err));
            return null;
        }),
    ]);
    return {
        oldestPendingS: toSeconds(main?.oldest_pending_s),
        drainLastS: toSeconds(main?.drain_last_s),
        webhooks: webhooks ? { instagram: !!webhooks.instagram, facebook: !!webhooks.facebook, whatsapp: !!webhooks.whatsapp } : null,
    };
}

/** What `GET /health` answers. Never throws. */
export async function healthResponse(now: Date = new Date()): Promise<{ status: number; body: HealthBody }> {
    try {
        return composeHealth(await readHealthSnapshot(), now);
    } catch (err) {
        log('warn', 'health.db_unreachable', describeError(err));
        return composeHealth(null, now);
    }
}

// ─── Heartbeat ──────────────────────────────────────────────────────────────────────────────

let lastBeatAt = 0;

/** Test seam: forget the instance-local throttle. */
export function resetHeartbeatThrottle(): void {
    lastBeatAt = 0;
}

/**
 * Record that the drain ran. At most one write a minute: this instance skips the query inside the minute, and the statement itself only
 * updates a row older than a minute, so concurrent instances cannot both write. Returns whether a row was written. Never throws.
 */
export async function recordDrainHeartbeat(nowMs: number = Date.now()): Promise<boolean> {
    if (nowMs - lastBeatAt < HEARTBEAT_EVERY_S * 1000) return false;
    lastBeatAt = nowMs;
    try {
        const written = await queryCount(
            `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
             VALUES ($1, $2, false, NOW(), NULL)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
               WHERE app_settings.updated_at < NOW() - make_interval(secs => $3)`,
            [APP_SETTING_KEYS.opsDrainHeartbeat, new Date(nowMs).toISOString(), HEARTBEAT_EVERY_S]
        );
        return written > 0;
    } catch (err) {
        lastBeatAt = 0; // a failed write is retried by the next drain, not in a minute
        log('warn', 'health.heartbeat_failed', describeError(err));
        return false;
    }
}

// ─── Dead-man ping ──────────────────────────────────────────────────────────────────────────

export type PingOutcome = 'skipped_no_url' | 'throttled' | 'pinged' | 'failed';

/** The one HTTP call, a seam for tests. A non-2xx answer throws. */
export type PingSend = (url: string) => Promise<void>;

const defaultSend: PingSend = async (url) => {
    await axios.get(url, { timeout: PING_TIMEOUT_MS, maxRedirects: 2, validateStatus: (s) => s >= 200 && s < 300 });
};

/** A ping URL must be https (a plain http one would put the check's id on the wire) and not point at this machine. */
export function isValidPingUrl(value: string): boolean {
    if (value.length > 300) return false;
    try {
        const u = new URL(value);
        if (u.protocol !== 'https:' || u.username || u.password) return false;
        const host = u.hostname.toLowerCase();
        return !(host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || /^[\d.]+$/.test(host) || host.includes(':'));
    } catch {
        return false;
    }
}

/**
 * GET the saved ping URL, at most once every 5 minutes across all instances. Returns what happened and NEVER throws: no URL, a failed read, a
 * refused claim, a timeout or a non-2xx answer are all outcomes, logged without the URL (it is a secret).
 */
export async function pingDeadMan(send: PingSend = defaultSend): Promise<PingOutcome> {
    try {
        const url = await getSetting(APP_SETTING_KEYS.monitoringPingUrl);
        if (!url) return 'skipped_no_url';
        // The claim comes first, so a slow ping never lets a second instance send another.
        const claimed = await queryCount(
            `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
             VALUES ($1, 'ping', false, NOW(), NULL)
             ON CONFLICT (key) DO UPDATE SET updated_at = NOW()
               WHERE app_settings.updated_at < NOW() - make_interval(secs => $2)`,
            [APP_SETTING_KEYS.opsPingLast, PING_EVERY_S]
        );
        if (claimed === 0) return 'throttled';
        try {
            await send(url);
            return 'pinged';
        } catch (err) {
            // Never describeError the axios error: its config carries the URL.
            const status = (err as { response?: { status?: number } })?.response?.status ?? null;
            log('warn', 'health.ping_failed', { http_status: status, timed_out: (err as { code?: string })?.code === 'ECONNABORTED' });
            return 'failed';
        }
    } catch (err) {
        log('warn', 'health.ping_error', { message: (err as Error)?.message?.slice(0, 120) });
        return 'failed';
    }
}

/** Start the ping under `waitUntil` and return at once: the drain never waits for it. */
export function startDeadManPing(): void {
    waitUntil(pingDeadMan());
}

// ─── The setting ────────────────────────────────────────────────────────────────────────────

export interface MonitoringSettings {
    /** The URL itself is never in an answer: whether one is saved, and its last four characters. */
    pingUrl: { set: boolean; last4: string | null };
    /** How often, so the card can say it. */
    pingEverySeconds: number;
}

export async function describeMonitoringSettings(): Promise<MonitoringSettings> {
    const url = await getSetting(APP_SETTING_KEYS.monitoringPingUrl);
    return { pingUrl: { set: !!url, last4: url ? last4(url) : null }, pingEverySeconds: PING_EVERY_S };
}

/** Save (or, with an empty string, remove) the ping URL. Returns false when the value is not an acceptable URL; nothing is written then. */
export async function saveMonitoringPingUrl(value: string, updatedBy: string | null): Promise<boolean> {
    const trimmed = value.trim();
    if (trimmed !== '' && !isValidPingUrl(trimmed)) return false;
    await setSetting(APP_SETTING_KEYS.monitoringPingUrl, trimmed === '' ? null : trimmed, updatedBy);
    return true;
}
