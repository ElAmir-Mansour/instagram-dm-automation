/**
 * The image allowance (T040): what the free provider has been asked for each UTC day, the cap that keeps drawing under it, and the pause when the
 * provider says it is used up. The pool answers by SQL through a small emulation of the `image_allowance` table that implements what each
 * statement is MEANT to do (the real statements are run against a real Postgres in the verification of this PR: 100 reservations at once against
 * a cap of 80 let exactly 80 through). What these tests pin is the protocol around them (reserve before, refund on an ordinary failure, keep the
 * units and pause on exhaustion), the dates, the numbers the dashboard shows, and the text of the one statement the cap lives in.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../../config/db.js';
import { installFakeDb, type FakeDb } from '../../monteur/testDb.js';
import { ExplainerError } from '../errors.js';
import { installAllowanceTable, installSettings, SAVED_PROVIDER, type AllowanceTableRow } from './testSupport.js';
import {
    allowanceStatus, computeStatus, markExhausted, refundAllowance, reserveAllowance, resumeAt, sweepAllowance, utcDay, type AllowanceRow,
} from './allowance.js';

const SPEC = { id: 'cloudflare', dailyCap: 80, unitsPerPicture: 110 };
const at = (iso: string): Date => new Date(iso);
const NOON = at('2026-10-25T12:00:00.000Z');

describe('utcDay', () => {
    it('is the UTC calendar day, whatever the zone of the machine: 23:59:59.999Z is still that day, 00:00:00Z is the next', () => {
        assert.equal(utcDay(at('2026-10-25T23:59:59.999Z')), '2026-10-25');
        assert.equal(utcDay(at('2026-10-26T00:00:00.000Z')), '2026-10-26');
        assert.equal(utcDay(at('2026-01-01T00:00:00.000Z')), '2026-01-01');
    });
});

describe('resumeAt', () => {
    it('is the next 00:00 UTC plus five minutes: Cloudflare resets at midnight, and the margin keeps the first call from racing it', () => {
        assert.equal(resumeAt(at('2026-10-25T13:00:00.000Z')).toISOString(), '2026-10-26T00:05:00.000Z');
        assert.equal(resumeAt(at('2026-10-25T23:59:59.999Z')).toISOString(), '2026-10-26T00:05:00.000Z');
    });

    it('is the day after, not the same day, when it is asked at exactly midnight', () => {
        assert.equal(resumeAt(at('2026-10-25T00:00:00.000Z')).toISOString(), '2026-10-26T00:05:00.000Z');
    });

    it('crosses the end of a month and of a year', () => {
        assert.equal(resumeAt(at('2026-10-31T20:00:00.000Z')).toISOString(), '2026-11-01T00:05:00.000Z');
        assert.equal(resumeAt(at('2026-12-31T20:00:00.000Z')).toISOString(), '2027-01-01T00:05:00.000Z');
        assert.equal(resumeAt(at('2028-02-28T10:00:00.000Z')).toISOString(), '2028-02-29T00:05:00.000Z');
    });
});

describe('computeStatus', () => {
    const config = { provider: 'cloudflare', daily_cap: 80, units_per_picture: 110 };
    const row = (over: Partial<AllowanceRow> = {}): AllowanceRow => ({ day: '2026-10-25', units: 0, pictures: 0, exhausted_at: null, ...over });

    it('is a day with nothing drawn: the whole cap left, and not paused', () => {
        assert.deepEqual(computeStatus(config, [], NOON), { provider: 'cloudflare', day: '2026-10-25', used_units: 0, pictures: 0, cap: 80, est_left: 80, paused_until: null });
    });

    it('counts the pictures left from the units used: the cap is pictures, the allowance is units', () => {
        const status = computeStatus(config, [row({ units: 440, pictures: 4 })], NOON);
        assert.equal(status.used_units, 440);
        assert.equal(status.pictures, 4);
        assert.equal(status.cap, 80);
        assert.equal(status.est_left, 76);
        assert.equal(status.paused_until, null);
    });

    it('rounds the pictures left down: a picture that would not fit is not left', () => {
        assert.equal(computeStatus(config, [row({ units: 8_700 })], NOON).est_left, 0, '100 units are left, a picture costs 110');
        assert.equal(computeStatus(config, [row({ units: 8_690 })], NOON).est_left, 1);
    });

    it('is paused until tomorrow 00:05 UTC when the cap is reached, with nothing left', () => {
        const status = computeStatus(config, [row({ units: 8_800, pictures: 80 })], NOON);
        assert.equal(status.est_left, 0);
        assert.equal(status.paused_until, '2026-10-26T00:05:00.000Z');
    });

    it('is paused until tomorrow 00:05 UTC when the provider said the allowance is used up, even with the cap far off', () => {
        const status = computeStatus(config, [row({ units: 3_000, pictures: 27, exhausted_at: at('2026-10-25T11:40:00.000Z') })], NOON);
        assert.equal(status.est_left, 0);
        assert.equal(status.paused_until, '2026-10-26T00:05:00.000Z');
        assert.equal(status.used_units, 3_000);
    });

    it('stays paused after midnight, until 00:05, when the exhaustion was yesterday', () => {
        const yesterday = row({ day: '2026-10-24', units: 5_000, exhausted_at: at('2026-10-24T22:00:00.000Z') });
        const justAfterMidnight = computeStatus(config, [yesterday], at('2026-10-25T00:03:00.000Z'));
        assert.equal(justAfterMidnight.paused_until, '2026-10-25T00:05:00.000Z');
        assert.equal(justAfterMidnight.est_left, 0);
        assert.equal(justAfterMidnight.used_units, 0, 'the new day starts at zero');
        const afterMargin = computeStatus(config, [yesterday], at('2026-10-25T00:06:00.000Z'));
        assert.equal(afterMargin.paused_until, null);
        assert.equal(afterMargin.est_left, 80);
    });

    it('does not read an exhaustion from two days ago as a pause', () => {
        const old = row({ day: '2026-10-23', exhausted_at: at('2026-10-23T22:00:00.000Z') });
        assert.equal(computeStatus(config, [old], NOON).paused_until, null);
    });

    it('is paused for the day when the cap is 0 (drawing switched off), and does not divide by a unit cost it was not given', () => {
        const status = computeStatus({ ...config, daily_cap: 0 }, [], NOON);
        assert.equal(status.est_left, 0);
        assert.equal(status.cap, 0);
        assert.equal(status.paused_until, '2026-10-26T00:05:00.000Z');
    });

    it('takes a fractional unit cost without losing a picture to rounding: 80 pictures at 109.9 are 80 pictures', () => {
        assert.equal(computeStatus({ ...config, units_per_picture: 109.9 }, [], NOON).est_left, 80);
        assert.equal(computeStatus({ ...config, units_per_picture: 109.9 }, [row({ units: 109.9 * 79 })], NOON).est_left, 1);
    });
});

describe('the allowance in the database', () => {
    let db: FakeDb;
    let table: AllowanceTableRow[];
    let settings: Map<string, string>;

    const find = (provider: string, day: string) => table.find((r) => r.provider === provider && r.day === day);

    beforeEach(() => {
        db = installFakeDb();
        settings = installSettings(db);
        table = installAllowanceTable(db);
    });
    afterEach(() => db.restore());

    const pausedWith = (retryAt: string, text: RegExp) => (err: unknown) => {
        assert.ok(err instanceof ExplainerError, String(err));
        assert.equal(err.code, 'EXPLAINER_ALLOWANCE_PAUSED');
        assert.equal(err.status, 429);
        assert.deepEqual(err.params, { retryAt });
        assert.match(err.message, text);
        return true;
    };

    describe('reserveAllowance', () => {
        it('reserves one picture of the day: one statement, the provider, the UTC day, the unit cost, the count and the cap as its parameters', async () => {
            const reservation = await reserveAllowance(SPEC, 1, pool, NOON);
            assert.deepEqual(reservation, { provider: 'cloudflare', day: '2026-10-25', count: 1, unitsPerPicture: 110 });
            const [reserve] = db.ran(/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\)/);
            assert.deepEqual(reserve!.params, ['cloudflare', '2026-10-25', 110, 1, 80]);
            assert.deepEqual(find('cloudflare', '2026-10-25'), { provider: 'cloudflare', day: '2026-10-25', units: 110, pictures: 1, exhausted_at: null });
        });

        it('defaults to one picture and to the clock', async () => {
            const reservation = await reserveAllowance(SPEC);
            assert.equal(reservation.count, 1);
            assert.equal(reservation.day, utcDay(new Date()));
        });

        it('lets exactly the cap through in a day, and refuses the next with 429 EXPLAINER_ALLOWANCE_PAUSED until tomorrow 00:05 UTC', async () => {
            for (let i = 0; i < 80; i++) await reserveAllowance(SPEC, 1, pool, NOON);
            assert.equal(find('cloudflare', '2026-10-25')!.units, 8_800);
            await assert.rejects(reserveAllowance(SPEC, 1, pool, NOON), pausedWith('2026-10-26T00:05:00.000Z', /limit of 80 pictures/));
            assert.equal(find('cloudflare', '2026-10-25')!.units, 8_800, 'a refused reservation reserves nothing');
        });

        it('starts a new UTC day from zero: yesterday’s pictures do not count against today', async () => {
            for (let i = 0; i < 80; i++) await reserveAllowance(SPEC, 1, pool, at('2026-10-25T23:00:00.000Z'));
            await assert.rejects(reserveAllowance(SPEC, 1, pool, at('2026-10-25T23:59:00.000Z')));
            const next = await reserveAllowance(SPEC, 1, pool, at('2026-10-26T00:00:01.000Z'));
            assert.equal(next.day, '2026-10-26');
            assert.equal(find('cloudflare', '2026-10-26')!.pictures, 1);
        });

        it('reserves a batch together (four candidates are four pictures) and refuses the whole batch when it does not fit, reserving none of it', async () => {
            const batch = await reserveAllowance(SPEC, 4, pool, NOON);
            assert.equal(batch.count, 4);
            assert.deepEqual(find('cloudflare', '2026-10-25'), { provider: 'cloudflare', day: '2026-10-25', units: 440, pictures: 4, exhausted_at: null });
            for (let i = 0; i < 74; i++) await reserveAllowance(SPEC, 1, pool, NOON); // 78 used
            await assert.rejects(reserveAllowance(SPEC, 4, pool, NOON), pausedWith('2026-10-26T00:05:00.000Z', /limit of 80 pictures/));
            assert.equal(find('cloudflare', '2026-10-25')!.pictures, 78);
            assert.equal((await reserveAllowance(SPEC, 2, pool, NOON)).count, 2, 'two do fit');
        });

        it('refuses everything when the cap is 0, and a batch larger than the whole cap on a day with nothing used', async () => {
            await assert.rejects(reserveAllowance({ ...SPEC, dailyCap: 0 }, 1, pool, NOON), pausedWith('2026-10-26T00:05:00.000Z', /limit of 0 pictures/));
            await assert.rejects(reserveAllowance({ ...SPEC, dailyCap: 3 }, 4, pool, NOON), /limit of 3 pictures/);
            assert.equal(table.length, 0);
        });

        it('refuses while the provider said the allowance is used up, until tomorrow 00:05 UTC, and does not even ask the reservation statement', async () => {
            await markExhausted('cloudflare', pool, at('2026-10-25T11:40:00.000Z'));
            db.statements.length = 0;
            await assert.rejects(reserveAllowance(SPEC, 1, pool, NOON), pausedWith('2026-10-26T00:05:00.000Z', /used up/));
            assert.equal(db.ran(/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\) SELECT/).length, 0);
        });

        it('keeps refusing after midnight until 00:05 when the exhaustion was in the evening, then reserves on the new day', async () => {
            await markExhausted('cloudflare', pool, at('2026-10-25T22:00:00.000Z'));
            await assert.rejects(reserveAllowance(SPEC, 1, pool, at('2026-10-26T00:03:00.000Z')), pausedWith('2026-10-26T00:05:00.000Z', /used up/));
            const reservation = await reserveAllowance(SPEC, 1, pool, at('2026-10-26T00:05:01.000Z'));
            assert.equal(reservation.day, '2026-10-26');
        });

        it('runs on the executor it is given, so a reservation inside a transaction is rolled back with it', async () => {
            const seen: string[] = [];
            const exec = { query: (sql: string, params?: unknown[]) => { seen.push(sql.replace(/\s+/g, ' ').trim().slice(0, 40)); return pool.query(sql, params); } };
            await reserveAllowance(SPEC, 1, exec as never, NOON);
            assert.equal(seen.length, 2, 'the pause check, then the reservation');
            assert.match(seen[0]!, /^SELECT exhausted_at/);
            assert.match(seen[1]!, /^INSERT INTO image_allowance/);
        });

        it('reserves with ONE statement that holds the cap and the exhausted flag: INSERT … SELECT … ON CONFLICT DO UPDATE … WHERE … RETURNING', async () => {
            await reserveAllowance(SPEC, 1, pool, NOON);
            const sql = db.ran(/^INSERT INTO image_allowance AS a \(provider, day, units, pictures\)/)[0]!.sql;
            assert.match(sql, /ON CONFLICT \(provider, day\) DO UPDATE SET units = a\.units \+ EXCLUDED\.units, pictures = a\.pictures \+ EXCLUDED\.pictures/);
            assert.match(sql, /DO UPDATE SET .* WHERE a\.exhausted_at IS NULL AND a\.units \+ EXCLUDED\.units <= \$5::numeric \* \$3::numeric RETURNING/, 'the cap, in the statement that adds to the day');
            assert.match(sql, /SELECT \$1::text, \$2::date, \$3::numeric \* \$4::numeric, \$4::numeric WHERE \$4::numeric <= \$5::numeric ON CONFLICT/, 'the first picture of a day is held to the cap too');
            assert.match(sql, /RETURNING a\.units::float8 AS units, a\.pictures AS pictures$/);
        });
    });

    describe('refundAllowance', () => {
        it('gives the units of a failed call back: the day it was reserved on, the count and the unit cost as parameters', async () => {
            const reservation = await reserveAllowance(SPEC, 1, pool, NOON);
            await refundAllowance(reservation);
            assert.deepEqual(find('cloudflare', '2026-10-25'), { provider: 'cloudflare', day: '2026-10-25', units: 0, pictures: 0, exhausted_at: null });
            assert.deepEqual(db.ran(/^UPDATE image_allowance/)[0]!.params, ['cloudflare', '2026-10-25', 1, 110]);
        });

        it('gives back some of a batch: four candidates drawn, one failed, one picture refunded', async () => {
            const reservation = await reserveAllowance(SPEC, 4, pool, NOON);
            await refundAllowance(reservation, 1);
            assert.equal(find('cloudflare', '2026-10-25')!.units, 330);
            assert.equal(find('cloudflare', '2026-10-25')!.pictures, 3);
        });

        it('refunds to the day of the reservation, not to the day it is now: a draw can straddle midnight', async () => {
            const reservation = await reserveAllowance(SPEC, 1, pool, at('2026-10-25T23:59:59.000Z'));
            await refundAllowance(reservation);
            assert.equal(find('cloudflare', '2026-10-25')!.units, 0);
            assert.equal(find('cloudflare', '2026-10-26'), undefined);
        });

        it('never takes a day below zero, and does nothing for a count of zero', async () => {
            const reservation = await reserveAllowance(SPEC, 1, pool, NOON);
            await refundAllowance(reservation, 5);
            assert.deepEqual([find('cloudflare', '2026-10-25')!.units, find('cloudflare', '2026-10-25')!.pictures], [0, 0]);
            db.statements.length = 0;
            await refundAllowance(reservation, 0);
            assert.equal(db.statements.length, 0);
        });

        it('uses the executor it is given', async () => {
            const reservation = await reserveAllowance(SPEC, 1, pool, NOON);
            let used = 0;
            await refundAllowance(reservation, 1, { query: (sql: string, params?: unknown[]) => { used++; return pool.query(sql, params); } } as never);
            assert.equal(used, 1);
        });
    });

    describe('markExhausted', () => {
        it('records when the provider said the allocation is used up, and says when drawing may resume: the next 00:00 UTC plus five minutes', async () => {
            const until = await markExhausted('cloudflare', pool, at('2026-10-25T11:40:00.000Z'));
            assert.equal(until.toISOString(), '2026-10-26T00:05:00.000Z');
            assert.equal(find('cloudflare', '2026-10-25')!.exhausted_at!.toISOString(), '2026-10-25T11:40:00.000Z');
            assert.deepEqual(db.ran(/exhausted_at\)/)[0]!.params.slice(0, 2), ['cloudflare', '2026-10-25']);
        });

        it('keeps the units that were reserved: the failed call is counted, the estimate was low', async () => {
            await reserveAllowance(SPEC, 1, pool, NOON);
            await markExhausted('cloudflare', pool, NOON);
            assert.equal(find('cloudflare', '2026-10-25')!.units, 110);
            assert.equal(find('cloudflare', '2026-10-25')!.pictures, 1);
        });

        it('works on a day with no row yet, and on one that already says it is used up', async () => {
            await markExhausted('cloudflare', pool, at('2026-10-25T08:00:00.000Z'));
            await markExhausted('cloudflare', pool, at('2026-10-25T09:00:00.000Z'));
            assert.equal(table.length, 1);
            assert.equal(table[0]!.exhausted_at!.toISOString(), '2026-10-25T09:00:00.000Z');
        });
    });

    describe('allowanceStatus', () => {
        const savedProvider = SAVED_PROVIDER;

        it('is null when no image provider is configured: nothing to count', async () => {
            assert.equal(await allowanceStatus(NOON), null);
            assert.equal(db.ran(/FROM image_allowance/).length, 0);
        });

        it('is what the dashboard shows: provider, UTC day, units and pictures used, the cap, the pictures left and when a pause ends', async () => {
            settings.set('explainers.image_provider', savedProvider);
            await reserveAllowance(SPEC, 4, pool, NOON);
            assert.deepEqual(await allowanceStatus(NOON), { provider: 'cloudflare', day: '2026-10-25', used_units: 440, pictures: 4, cap: 80, est_left: 76, paused_until: null });
        });

        it('shows the pause once the provider said the allowance is used up, as an ISO time', async () => {
            settings.set('explainers.image_provider', savedProvider);
            await markExhausted('cloudflare', pool, at('2026-10-25T11:40:00.000Z'));
            const status = await allowanceStatus(NOON);
            assert.equal(status!.paused_until, '2026-10-26T00:05:00.000Z');
            assert.equal(status!.est_left, 0);
        });

        it('uses the cap and unit cost that are saved, and asks for today and yesterday only', async () => {
            settings.set('explainers.image_provider', JSON.stringify({ ...JSON.parse(savedProvider), daily_cap: 10, units_per_picture: 200 }));
            const status = await allowanceStatus(NOON);
            assert.equal(status!.cap, 10);
            assert.equal(status!.est_left, 10);
            assert.deepEqual(db.ran(/^SELECT day::text/)[0]!.params, ['cloudflare', '2026-10-25']);
        });
    });

    describe('sweepAllowance', () => {
        it('deletes the rows older than 90 days, on the executor it is given, and says how many', async () => {
            let sql = '';
            const exec = { query: async (text: string) => { sql = text.replace(/\s+/g, ' ').trim(); return { rows: [], rowCount: 7 }; } };
            assert.equal(await sweepAllowance(exec as never), 7);
            assert.equal(sql, "DELETE FROM image_allowance WHERE day < (NOW() AT TIME ZONE 'UTC')::date - 90");
        });

        it('says 0 when the driver reports no count', async () => {
            assert.equal(await sweepAllowance({ query: async () => ({ rows: [], rowCount: null }) } as never), 0);
        });
    });
});
