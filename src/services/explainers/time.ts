/**
 * Instants the lifecycle waits for: when an allowance resets. Pure: the caller passes the clock.
 */

/** The wall-clock parts of an instant in a time zone. */
function zoned(ms: number, timeZone: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-CA', {
            timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
        }).formatToParts(new Date(ms)).map((part) => [part.type, part.value])
    );
    return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute), s: Number(parts.second) };
}

/** How far the zone's wall clock is from UTC at an instant, in ms (negative west of Greenwich). */
function offsetMs(ms: number, timeZone: string): number {
    const p = zoned(ms, timeZone);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * The next 00:00 in `timeZone` after `now`, as an instant: daylight saving time included, because the offset is read at the instant it is applied to (twice, so
 * a day that changes the offset still lands on midnight).
 */
export function nextMidnightIn(timeZone: string, now: number): Date {
    const p = zoned(now, timeZone);
    const wall = Date.UTC(p.y, p.m - 1, p.d + 1, 0, 0, 0);
    let instant = wall - offsetMs(wall, timeZone);
    instant = wall - offsetMs(instant, timeZone);
    return new Date(instant);
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
