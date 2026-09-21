/**
 * Tells a log line whether the request that produced it was this project's own diagnostic
 * probe rather than a real event.
 *
 * WHY THIS EXISTS: `scripts/diagnose.mjs` proves the security guards still hold by POSTing
 * an unsigned body to `/webhook` and hitting `/api/cron/publish` and `/api/jobs/drain`
 * unauthenticated. Each of those correctly produces `webhook.signature_rejected` or
 * `cron.unauthorized` — and those lines are **byte-identical** to the ones a real incident
 * produces.
 *
 * In an app whose documented worst failure mode is "a signature rejection is invisible",
 * owning a tool that manufactures indistinguishable rejections is a trap. It caught me:
 * reading production logs I found `webhook.signature_rejected` and was about to report a
 * live outage, when it was my own probe from ninety seconds earlier.
 *
 * ── The one thing this must never do ──
 * It must not influence any authorisation decision. A forged tag must buy an attacker
 * nothing at all. So `isDiagnosticProbe` is called only when building a log payload, after
 * the request has already been rejected, and its result is a label and nothing else.
 *
 * It is still authenticated, for a narrower reason: if the tag were a plain header, an
 * attacker could set it and have their probing appear in the logs as our own benign
 * self-test — turning a detection signal into cover. The tag is therefore an HMAC over a
 * timestamp using META_APP_SECRET (which the diagnostic already reads from .env), with a
 * short window so a captured tag cannot be replayed indefinitely.
 */
import crypto from 'crypto';
import type { Request } from 'express';

export const PROBE_HEADER = 'x-autoreply-probe';

/** How long a tag stays valid. Long enough for a slow round-trip, short enough to be useless later. */
const PROBE_TTL_MS = 5 * 60 * 1000;

/** Build the tag. Exported so the diagnostic and its tests derive it the same way. */
export function signProbeTag(timestamp: number, secret: string): string {
    return crypto.createHmac('sha256', secret).update(`probe:${timestamp}`).digest('hex');
}

/**
 * Is this request our own diagnostic probe? Used ONLY to label a log line.
 *
 * Returns false for anything malformed, unsigned, stale, future-dated, or signed with the
 * wrong secret — and never throws, because a logging helper that can throw would turn a
 * handled rejection into an unhandled 500.
 */
export function isDiagnosticProbe(req: Request): boolean {
    try {
        const secret = process.env.META_APP_SECRET;
        if (!secret) return false;

        const raw = req.headers[PROBE_HEADER];
        const header = Array.isArray(raw) ? raw[0] : raw;
        if (typeof header !== 'string') return false;

        const parts = header.split('.');
        if (parts.length !== 2) return false;

        const timestamp = Number(parts[0]);
        if (!Number.isFinite(timestamp)) return false;

        // Reject stale and future-dated tags alike: a replayed tag should expire, and a
        // clock-skew bug should not mint one that outlives the window.
        const age = Date.now() - timestamp;
        if (age > PROBE_TTL_MS || age < -PROBE_TTL_MS) return false;

        const expected = signProbeTag(timestamp, secret);
        const given = Buffer.from(parts[1]!, 'hex');
        const want = Buffer.from(expected, 'hex');
        // timingSafeEqual throws on a length mismatch, which Buffer.from silently produces
        // for malformed hex — hence the try/catch around the whole function.
        return given.length === want.length && crypto.timingSafeEqual(given, want);
    } catch {
        return false;
    }
}
