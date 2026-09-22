/**
 * The queue drain, run as an always-on Heroku worker dyno instead of a scheduler.
 *
 * Why this exists: the app's own drain logic (`drainWorker()` in src/jobs/drain.ts) already
 * does the real work — reap stale claims, then process due jobs — through
 * `GET /api/jobs/drain`, which is authenticated and already deployed on Vercel. This script
 * does not reimplement any of that. It is a loop that calls the endpoint on a fixed interval,
 * because nothing else reliably calls it: Vercel's Hobby-plan cron only runs once a day, and
 * the GitHub Actions workflow meant to fill that gap every 5-15 minutes has never actually
 * fired — CRON_SECRET was never added as a repository secret, so every scheduled run fails in
 * the first few seconds before it can call anything.
 *
 * A worker dyno does not sleep and is not killed after a response the way a Vercel function
 * is, so this can poll far more often than either of those — the interval below is a safety
 * margin, not a budget constraint.
 *
 * Secrets: only CRON_SECRET. This talks to the app over its public HTTP API exactly like the
 * GitHub Actions workflow was meant to — it does not touch the database directly and does not
 * need the Meta/Gemini credentials the app itself uses to process a job, so there is nothing
 * else to duplicate or keep in sync across two platforms.
 */

const BASE_URL = process.env.DRAIN_BASE_URL || 'https://msg-response-auto.vercel.app';
const CRON_SECRET = process.env.CRON_SECRET;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 60_000;
const REQUEST_TIMEOUT_MS = 20_000;

if (!CRON_SECRET) {
    console.error(JSON.stringify({ level: 'error', event: 'worker.missing_secret', message: 'CRON_SECRET is not set' }));
    process.exit(1);
}

function log(level, event, fields = {}) {
    console.log(JSON.stringify({ level, event, ts: new Date().toISOString(), ...fields }));
}

async function drainOnce() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/api/jobs/drain`, {
            headers: { Authorization: `Bearer ${CRON_SECRET}` },
            signal: controller.signal,
        });
        const body = await res.text();
        if (res.status !== 200) {
            log('error', 'worker.drain_bad_status', { status: res.status, body: body.slice(0, 500) });
            return;
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 500) }; }
        log('info', 'worker.drain_ok', parsed);
    } catch (err) {
        // A single failed poll must not kill the loop — the next tick tries again. Heroku
        // restarting the dyno on an uncaught exception would just be a slower version of the
        // same retry, with a cold-start cost this loop does not need to pay.
        log('error', 'worker.drain_failed', { message: err?.message || String(err) });
    } finally {
        clearTimeout(timeout);
    }
}

log('info', 'worker.started', { base_url: BASE_URL, poll_interval_ms: POLL_INTERVAL_MS });

async function loop() {
    for (;;) {
        await drainOnce();
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
}

loop();

// Heroku sends SIGTERM ~30s before a dyno restart (routine, at least daily). There is no
// in-flight state to save here — the next tick, on this dyno or the one after it, just
// resumes polling the same durable queue — so this only exists to exit quickly and log why,
// rather than being killed silently.
process.on('SIGTERM', () => {
    log('info', 'worker.sigterm');
    process.exit(0);
});
