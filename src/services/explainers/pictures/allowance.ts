/**
 * The image allowance: what the free image provider has been asked for each UTC day, the cap that keeps drawing under it, and the pause when the
 * provider says the free allocation is used up (illustrated explainers, data-model.md §3, research.md R5, spec FR-019).
 *
 * Platform-wide, one `image_allowance` row per provider and UTC day, because the provider account is the owner's and every tenant that draws spends
 * the same allocation. Cloudflare's is 10,000 neurons a day with no way to ask what is left, and a picture costs about 110, so the app counts
 * ESTIMATED units itself and keeps `daily_cap` pictures' worth of them (80 by default) under the allocation.
 *
 * THE PROTOCOL, which `draw.ts`, `candidates.ts` and the provider test all follow:
 *
 *   1. RESERVE before the call (`reserveAllowance`): one statement, INSERT … SELECT … ON CONFLICT … DO UPDATE … WHERE … RETURNING, that adds the
 *      units to the day and refuses, in the same statement, when they would pass the cap or when the provider already said the day is used up.
 *      Atomic, so a hundred callers at once cannot take more than the cap between them. A refusal is 429 `EXPLAINER_ALLOWANCE_PAUSED` with
 *      `retryAt`.
 *   2. CALL the provider, outside any transaction.
 *   3. SETTLE after it: a picture came back, nothing to do; an ordinary failure, REFUND the units (`refundAllowance`); the provider says the
 *      allocation is used up (code 4006 or HTTP 429), `markExhausted`, which keeps the units (the estimate was low, and the day is over anyway)
 *      and pauses drawing until the next 00:00 UTC plus five minutes, when Cloudflare has reset and the margin keeps the first call from racing it.
 *
 * The pause is DERIVED, not stored: `exhausted_at` is the only fact, and "paused until" is the next midnight plus five minutes after it. So an
 * exhaustion in the evening still pauses drawing in the first minutes of the next day, which the new day's own (empty) row would not say; the
 * reservation and the status both read yesterday's row for that.
 */
import { pool } from '../../../config/db.js';
import { queryRows } from '../../../db/query.js';
import { log } from '../../../utils/log.js';
import type { Exec } from '../../studio/common.js';
import { ExplainerError } from '../errors.js';
import { readImageProviderConfig } from './provider.js';

/** Cloudflare resets at 00:00 UTC; drawing resumes this long after, so the first call of the day does not race the reset. */
export const PAUSE_MARGIN_MS = 5 * 60_000;
/** `image_allowance` rows older than this are swept by the daily cron. */
export const SWEEP_AFTER_DAYS = 90;

/** What the dashboard shows (`GET /api/studio/explainers/allowance`). `cap` and `est_left` are in pictures, `used_units` in the provider's units. */
export interface AllowanceStatus {
    provider: string;
    /** The UTC day, `YYYY-MM-DD`. */
    day: string;
    used_units: number;
    pictures: number;
    cap: number;
    /** Pictures that can still be drawn today: 0 while paused. */
    est_left: number;
    /** ISO time drawing may resume, while it is paused (the cap is reached, or the provider said the allocation is used up); otherwise null. */
    paused_until: string | null;
}

/** What a reservation needs to know of the provider: its name (the table's key), its cap in pictures and what a picture costs. */
export interface AllowanceSpec {
    id: string;
    dailyCap: number;
    unitsPerPicture: number;
}

/** What `reserveAllowance` hands back: the day it reserved on, so a refund goes to that day even if midnight passed during the call. */
export interface Reservation {
    provider: string;
    day: string;
    count: number;
    unitsPerPicture: number;
}

export interface AllowanceRow {
    day: string;
    units: number;
    pictures: number;
    exhausted_at: Date | null;
}

/** The UTC calendar day of an instant, `YYYY-MM-DD`. */
export function utcDay(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `from`, plus five minutes: when drawing may resume after a pause that began at `from`. */
export function resumeAt(from: Date): Date {
    return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + 1) + PAUSE_MARGIN_MS);
}

/**
 * The one statement the cap lives in. A picture count that does not fit the cap at all is refused before a row exists (the SELECT's WHERE: an
 * `ON CONFLICT … WHERE` is only looked at when a row is already there), a day with a row is refused when the provider said it is used up or when
 * the new total would pass `cap × units`, and either refusal returns no row. Every parameter has one type throughout: Postgres refuses a
 * parameter used with two different casts.
 *
 *   $1 provider · $2 UTC day · $3 units a picture · $4 pictures to reserve · $5 the cap, in pictures
 */
const RESERVE_SQL = `INSERT INTO image_allowance AS a (provider, day, units, pictures)
     SELECT $1::text, $2::date, $3::numeric * $4::numeric, $4::numeric
      WHERE $4::numeric <= $5::numeric
     ON CONFLICT (provider, day) DO UPDATE
        SET units = a.units + EXCLUDED.units, pictures = a.pictures + EXCLUDED.pictures
      WHERE a.exhausted_at IS NULL AND a.units + EXCLUDED.units <= $5::numeric * $3::numeric
     RETURNING a.units::float8 AS units, a.pictures AS pictures`;

/**
 * The newest exhaustion of today or yesterday: yesterday's can still be pausing drawing in the first minutes of today. Bounded above by today as
 * well, so that `now` decides what is asked and a row of a day that has not come cannot answer for this one.
 */
const LAST_EXHAUSTION_SQL = `SELECT exhausted_at FROM image_allowance
      WHERE provider = $1 AND exhausted_at IS NOT NULL AND day BETWEEN $2::date - 1 AND $2::date
      ORDER BY exhausted_at DESC LIMIT 1`;

const REFUND_SQL = `UPDATE image_allowance
        SET units = GREATEST(units - $4::numeric * $3::numeric, 0), pictures = GREATEST(pictures - $3::numeric, 0)::int
      WHERE provider = $1 AND day = $2::date`;

const EXHAUSTED_SQL = `INSERT INTO image_allowance AS a (provider, day, units, pictures, exhausted_at)
     VALUES ($1, $2::date, 0, 0, $3::timestamptz)
     ON CONFLICT (provider, day) DO UPDATE SET exhausted_at = EXCLUDED.exhausted_at
     RETURNING a.exhausted_at`;

const STATUS_SQL = `SELECT day::text AS day, units::float8 AS units, pictures, exhausted_at FROM image_allowance
      WHERE provider = $1 AND day BETWEEN $2::date - 1 AND $2::date
      ORDER BY day DESC`;

/**
 * The refusal of a reservation, and of a draw the provider ended with "used up": 429 `EXPLAINER_ALLOWANCE_PAUSED`, with `retryAt` in its params.
 * `why` says whether the provider's allocation is spent or the owner's daily cap is reached; the words differ, the answer is the same.
 */
export function pausedError(until: Date, why: 'exhausted' | 'cap', spec: Pick<AllowanceSpec, 'dailyCap'>): ExplainerError {
    const when = `${until.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    const message = why === 'exhausted'
        ? `Drawing is paused: the image provider's free allowance for today is used up. It resumes at ${when}.`
        : `Drawing is paused: today's limit of ${spec.dailyCap} pictures is reached. It resumes at ${when}.`;
    return new ExplainerError('EXPLAINER_ALLOWANCE_PAUSED', message, { retryAt: until.toISOString() });
}

/**
 * Reserve `count` pictures' worth of units on today's row, BEFORE the provider is called. Throws 429 `EXPLAINER_ALLOWANCE_PAUSED` (with `retryAt`)
 * when the provider said today's allocation is used up, or when the units would pass the daily cap: the whole reservation or none of it, so
 * four candidates are never half reserved. `exec` is the transaction's client when the reservation belongs to one (a refusal then rolls the
 * rest of the transaction back with it); `now` is for tests.
 */
export async function reserveAllowance(spec: AllowanceSpec, count = 1, exec: Exec = pool, now: Date = new Date()): Promise<Reservation> {
    const day = utcDay(now);

    // The pause the provider asked for, which can reach into today from yesterday's row. The statement below only sees today's.
    const { rows: last } = await exec.query<{ exhausted_at: Date }>(LAST_EXHAUSTION_SQL, [spec.id, day]);
    if (last[0]) {
        const until = resumeAt(new Date(last[0].exhausted_at));
        if (until.getTime() > now.getTime()) throw pausedError(until, 'exhausted', spec);
    }

    const { rows } = await exec.query<{ units: number; pictures: number }>(RESERVE_SQL, [spec.id, day, spec.unitsPerPicture, count, spec.dailyCap]);
    if (!rows[0]) throw pausedError(resumeAt(now), 'cap', spec);
    return { provider: spec.id, day, count, unitsPerPicture: spec.unitsPerPicture };
}

/**
 * Give `count` pictures' units back (all of the reservation by default) after a call that failed for an ordinary reason: nothing was drawn, so
 * nothing was used. To the day the units were reserved on; never below zero.
 */
export async function refundAllowance(reservation: Reservation, count: number = reservation.count, exec: Exec = pool): Promise<void> {
    if (count <= 0) return;
    await exec.query(REFUND_SQL, [reservation.provider, reservation.day, count, reservation.unitsPerPicture]);
}

/**
 * The provider said the free allocation is used up: record when, so drawing pauses (the reservation refuses, the status says until when) and
 * answer when it may resume. The units already reserved stay counted.
 */
export async function markExhausted(providerId: string, exec: Exec = pool, now: Date = new Date()): Promise<Date> {
    await exec.query(EXHAUSTED_SQL, [providerId, utcDay(now), now.toISOString()]);
    const until = resumeAt(now);
    log('warn', 'explainer.allowance_exhausted', { provider: providerId, resumes_at: until.toISOString() });
    return until;
}

/**
 * The status from the configured cap and the rows of today and yesterday. Pure. Paused until the next 00:05 UTC when the provider said it is used
 * up (the newest exhaustion, if its pause has not ended: yesterday's counts in the first minutes of today), or when the cap is reached.
 */
export function computeStatus(
    config: { provider: string; daily_cap: number; units_per_picture: number }, rows: readonly AllowanceRow[], now: Date
): AllowanceStatus {
    const day = utcDay(now);
    const today = rows.find((row) => row.day === day);
    const used = today?.units ?? 0;
    const fits = Math.floor((config.daily_cap * config.units_per_picture - used) / config.units_per_picture + 1e-9);

    let pausedUntil: Date | null = null;
    for (const row of rows) {
        if (!row.exhausted_at) continue;
        const until = resumeAt(new Date(row.exhausted_at));
        if (until.getTime() > now.getTime() && (!pausedUntil || until.getTime() > pausedUntil.getTime())) pausedUntil = until;
    }
    if (!pausedUntil && fits <= 0) pausedUntil = resumeAt(now);

    return {
        provider: config.provider,
        day,
        used_units: used,
        pictures: today?.pictures ?? 0,
        cap: config.daily_cap,
        est_left: pausedUntil ? 0 : Math.max(0, fits),
        paused_until: pausedUntil ? pausedUntil.toISOString() : null,
    };
}

/** Today's allowance, or null when no image provider is configured (there is nothing to count). */
export async function allowanceStatus(now: Date = new Date()): Promise<AllowanceStatus | null> {
    const config = await readImageProviderConfig();
    if (!config) return null;
    const rows = await queryRows<AllowanceRow>(STATUS_SQL, [config.provider, utcDay(now)]);
    return computeStatus(config, rows, now);
}

/** The daily cron's sweep: rows older than 90 days. Returns how many it deleted. `exec` is the cron's own, so the sweep joins its transaction or pool. */
export async function sweepAllowance(exec: Exec): Promise<number> {
    const { rowCount } = await exec.query(`DELETE FROM image_allowance WHERE day < (NOW() AT TIME ZONE 'UTC')::date - ${SWEEP_AFTER_DAYS}`);
    return rowCount ?? 0;
}
