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
 *
 * Two loops, independent of each other: the drain above, and (P24) the profile-draft sweep,
 * `POST /api/onboarding/drafts/sweep`, which advances the drafts nobody is working on. See
 * `sweepLoop` below for why it is not part of the drain's.
 */

const BASE_URL = process.env.DRAIN_BASE_URL || 'https://msg-response-auto.vercel.app';
const CRON_SECRET = process.env.CRON_SECRET;
// 2 minutes, not 1 (2026-11-08): every call costs Vercel Active CPU, and the Hobby plan includes 4 h a month. A webhook already
// drains its own jobs inline, so this only sets how late a scheduled post can go out.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 120_000;
// Just under Vercel's 300 s function limit. The drain now ends with the Monteur's pick sweep
// (MONTEUR.md §6), two Gemini calls for one video, so a drain can take minutes: aborting at 20 s
// logged every such run as a failure while the work finished anyway. The polls stay sequential,
// so a long drain only delays the next one.
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS) || 290_000;
// The profile-draft backstop (docs/onboarding/03 §4): its own loop, below. A draft takes minutes (two model calls of up to 150 s), so
// it must never share a request with the drain, whose queue would then wait on a model. The wait is between the END of one sweep and
// the start of the next, so a long sweep only delays the next one.
// 15 minutes, not 1 (2026-11-08): a draft is first moved on by whoever asks, so this backstop rarely finds work, and each
// call costs Vercel Active CPU.
const DRAFT_SWEEP_INTERVAL_MS = Number(process.env.DRAFT_SWEEP_INTERVAL_MS) || 900_000;

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

/**
 * One call to the draft sweep: `POST /api/onboarding/drafts/sweep`, the same bearer secret as the drain. It advances the profile drafts
 * that nobody is working on (a function that was lost mid-draft, a retry whose wait is over, a draft nobody opened). Most calls find
 * nothing, so only a call that did something, and every failure, is logged.
 */
async function sweepOnce() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}/api/onboarding/drafts/sweep`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${CRON_SECRET}` },
            signal: controller.signal,
        });
        const body = await res.text();
        if (res.status !== 200) {
            log('error', 'worker.sweep_bad_status', { status: res.status, body: body.slice(0, 500) });
            return;
        }
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 500) }; }
        if (parsed && parsed.considered > 0) log('info', 'worker.sweep_ok', parsed);
    } catch (err) {
        // Same as the drain: a failed poll must not end the loop.
        log('error', 'worker.sweep_failed', { message: err?.message || String(err) });
    } finally {
        clearTimeout(timeout);
    }
}

log('info', 'worker.sweep_started', { draft_sweep_interval_ms: DRAFT_SWEEP_INTERVAL_MS });

// Its own loop, independent of the drain's: neither waits for the other, and a hung sweep cannot hold the queue.
async function sweepLoop() {
    for (;;) {
        await sweepOnce();
        await new Promise((resolve) => setTimeout(resolve, DRAFT_SWEEP_INTERVAL_MS));
    }
}

sweepLoop();

// Heroku sends SIGTERM ~30s before a dyno restart (routine, at least daily). There is no
// in-flight state to save here — the next tick, on this dyno or the one after it, just
// resumes polling the same durable queue — so this only exists to exit quickly and log why,
// rather than being killed silently.
process.on('SIGTERM', () => {
    log('info', 'worker.sigterm');
    process.exit(0);
});
