/**
 * Instants the lifecycle waits for: when an allowance resets. Pure: the caller passes the clock. The zone arithmetic is the posting slots' (slots.ts), which
 * already reads a zone's offset at the instant it is applied to, so a day that changes the offset still lands on midnight.
 */
import { zonedTimeToUtc, zoneOffsetMs } from '../studio/slots.js';

/** The next 00:00 in `timeZone` after `now`, as an instant: daylight saving time included. */
export function nextMidnightIn(timeZone: string, now: number): Date {
    // The zone's calendar day at `now`, read from the zone's own wall clock.
    const local = new Date(now + zoneOffsetMs(now, timeZone));
    return new Date(zonedTimeToUtc(local.getUTCFullYear(), local.getUTCMonth() + 1, local.getUTCDate() + 1, 0, 0, timeZone));
}

/**
 * When Gemini's daily request quotas reset: "midnight Pacific time" (ai.google.dev/gemini-api/docs/rate-limits), which is 07:00 or 08:00 UTC. The voice step
 * is retried a few minutes after it, never at 00:05 UTC: that is the middle of Gemini's night, and the retry would fail on the same quota.
 */
export function nextGeminiQuotaReset(now: number): Date {
    return nextMidnightIn('America/Los_Angeles', now);
}

/** The next 00:00 UTC: when the image provider's allowance is counted from again (`image_allowance.day` is a UTC day). */
export function nextUtcMidnight(now: number): Date {
    const d = new Date(now);
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}
