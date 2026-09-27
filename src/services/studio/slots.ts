/**
 * Posting slots (STUDIO.md §4 `/slots`, §10.3): the tenant's local posting times, in its
 * timezone, that no PENDING Meta post already holds.
 *
 * The times are wall-clock times in `schedule.timezone` ("13:00" in Asia/Riyadh is 10:00Z), so
 * they are converted per day rather than once: a timezone with daylight saving moves its UTC
 * offset twice a year, and a slot computed from a fixed offset would drift by an hour.
 */
import { pool } from '../../config/db.js';
import type { ScheduleConfig } from '../../db/rows.js';
import type { Exec } from './common.js';

/**
 * A PENDING Meta post within this much of a slot holds it. Exact equality would call 13:00
 * free beside a post scheduled by hand at 13:10, and put two posts ten minutes apart.
 */
export const SLOT_HOLD_WINDOW_MS = 30 * 60 * 1000;
export const MAX_SLOT_COUNT = 30;
/** How far ahead to look. At one slot a day, 30 slots with every other one taken still fit. */
const HORIZON_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `timeZone`'s offset from UTC at `instant`, in ms (local minus UTC). */
export function zoneOffsetMs(instant: number, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(new Date(instant));
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    // The formatted parts have no milliseconds, so compare against the instant without them.
    return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time in `timeZone` names. The second pass re-reads the offset at
 * the first answer, which catches a daylight-saving change between the guess and the result.
 */
export function zonedTimeToUtc(
    year: number, month: number, day: number, hour: number, minute: number, timeZone: string
): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute);
    const first = guess - zoneOffsetMs(guess, timeZone);
    return guess - zoneOffsetMs(first, timeZone);
}

/** Every slot instant after `fromMs`, for `days` local days starting with today, ascending. */
export function candidateSlots(schedule: ScheduleConfig, fromMs: number, days: number): number[] {
    const times = [...schedule.slots].sort().map((slot) => slot.split(':').map(Number) as [number, number]);
    const today = new Date(fromMs + zoneOffsetMs(fromMs, schedule.timezone));
    const out: number[] = [];
    for (let k = 0; k < days; k++) {
        // Date.UTC normalises day overflow, so "the 32nd" becomes the 1st of next month.
        const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + k));
        for (const [hour, minute] of times) {
            const at = zonedTimeToUtc(
                day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute, schedule.timezone
            );
            if (at > fromMs) out.push(at);
        }
    }
    return out.sort((a, b) => a - b);
}

/** The first `count` candidates no taken time sits within the hold window of. Pure. */
export function freeSlots(candidates: readonly number[], taken: readonly number[], count: number): string[] {
    const out: string[] = [];
    for (const at of candidates) {
        if (out.length >= count) break;
        if (taken.some((t) => Math.abs(t - at) < SLOT_HOLD_WINDOW_MS)) continue;
        out.push(new Date(at).toISOString());
    }
    return out;
}

/** `?count=` clamped to 1..30; anything unreadable is 1. */
export function parseSlotCount(raw: unknown): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_SLOT_COUNT);
}

/** The platforms whose PENDING rows hold a slot, by default: the Meta ones. */
export const META_SLOT_HOLDERS: readonly string[] = ['instagram', 'facebook', 'both'];

export interface SlotOptions {
    /**
     * `both` is Instagram + Facebook. By default a TikTok row holds no slot: in the Studio it is the
     * sibling of a Meta post that already holds it. A caller whose posts go to TikTok alone (a
     * TikTok-only Monteur) passes `['tiktok']`, or every one of its posts gets the same slot.
     */
    holders?: readonly string[];
    /** A transaction's client, when the caller holds a lock the choice must be made under. */
    exec?: Exec;
}

export async function nextFreeSlots(
    creatorId: string, schedule: ScheduleConfig, count: number, now: number = Date.now(), opts: SlotOptions = {}
): Promise<string[]> {
    const until = now + (HORIZON_DAYS + 1) * DAY_MS;
    const exec = opts.exec ?? pool;
    const { rows } = await exec.query<{ scheduled_time: Date }>(
        `SELECT scheduled_time FROM scheduled_posts
          WHERE creator_id = $1
            AND status = 'PENDING'
            AND platform = ANY($4::text[])
            AND scheduled_time > $2 AND scheduled_time < $3`,
        [creatorId, new Date(now - SLOT_HOLD_WINDOW_MS), new Date(until), [...(opts.holders ?? META_SLOT_HOLDERS)]]
    );
    const taken = rows.map((r) => new Date(r.scheduled_time).getTime());
    return freeSlots(candidateSlots(schedule, now, HORIZON_DAYS), taken, count);
}
