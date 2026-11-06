/**
 * Cloudflare R2's free tier, kept (src/services/r2Usage.ts): the atomic reserve, the limits and their ceilings, the storage cap, the month's reset,
 * a database that fails, and the warnings. The database is `FakeDb`, whose reserve branch runs as one statement the way Postgres does; the clock is
 * pinned with `mock.timers` (a test that spells out an instant must pin it: CLAUDE.md).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import { emailHttp } from './notifyEmail.js';
import { setLogSink } from '../utils/log.js';
import {
    assertR2Room, buildR2Alert, checkLimitsInput, checkR2Warnings, clearR2BannerCache, formatBytes, monthKey, nextReset, parseLimits, R2_CEILINGS, R2_DEFAULT_LIMITS,
    R2CounterError, R2LimitError, R2UsageGuard, readCounters, readLimits, readR2Banner, readR2Summary, summarize, type R2Limits,
} from './r2Usage.js';
import { CREATOR, FakeDb } from './r2TestKit.js';

const NOV = new Date('2026-11-06T10:00:00Z');
let db: FakeDb;
let restoreDb: () => void;
let restoreSink: (() => void) | undefined;
let logged: Array<{ level: string; event: string }>;

before(() => {
    const previous = setLogSink((level, line) => {
        try { logged.push({ level, event: JSON.parse(line).event }); } catch { /* not ours */ }
    });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    logged = [];
    db = new FakeDb();
    restoreDb = db.install();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    mock.timers.enable({ apis: ['Date'], now: NOV });
    clearR2BannerCache();
});
afterEach(() => {
    mock.timers.reset();
    restoreDb();
});

const limits = (over: Partial<R2Limits> = {}): R2Limits => ({ ...R2_DEFAULT_LIMITS, ...over });
const guardWith = (l: R2Limits, readBatch = 50) => new R2UsageGuard({ limits: async () => l, readBatch });

describe('the ceilings and the limits', () => {
    it('keeps Cloudflare\'s free tier as the ceilings and a margin under it as the defaults', () => {
        assert.deepEqual({ ...R2_CEILINGS }, { storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 });
        assert.deepEqual({ ...R2_DEFAULT_LIMITS }, { storage_bytes: 9 * 1024 ** 3, class_a: 900_000, class_b: 9_000_000 });
        for (const k of ['storage_bytes', 'class_a', 'class_b'] as const) assert.ok(R2_DEFAULT_LIMITS[k] < R2_CEILINGS[k]);
    });

    it('reads a stored limit, never above its ceiling, and the default for anything unreadable', () => {
        assert.deepEqual(parseLimits(null), { ...R2_DEFAULT_LIMITS });
        assert.deepEqual(parseLimits('not json'), { ...R2_DEFAULT_LIMITS });
        assert.deepEqual(parseLimits(JSON.stringify({ storage_bytes: 5_000, class_a: 10, class_b: 20 })), { storage_bytes: 5_000, class_a: 10, class_b: 20 });
        // A value above a ceiling (edited in the database by hand) is read as the ceiling: the code's ceiling wins.
        assert.deepEqual(parseLimits(JSON.stringify({ storage_bytes: 99e12, class_a: 5_000_000, class_b: 99_000_000 })), { ...R2_CEILINGS });
        assert.deepEqual(parseLimits(JSON.stringify({ storage_bytes: -1, class_a: 'x', class_b: 1.5 })), { ...R2_DEFAULT_LIMITS });
    });

    it('refuses a save above a ceiling, and accepts any lower value', () => {
        const ok = checkLimitsInput({ storage_bytes: 1e9, class_a: 100, class_b: 1000 });
        assert.deepEqual(ok, { ok: true, value: { storage_bytes: 1e9, class_a: 100, class_b: 1000 } });
        const atCeiling = checkLimitsInput({ ...R2_CEILINGS });
        assert.equal(atCeiling.ok, true);
        for (const field of ['storage_bytes', 'class_a', 'class_b'] as const) {
            const over = checkLimitsInput({ ...R2_CEILINGS, [field]: R2_CEILINGS[field] + 1 });
            assert.equal(over.ok, false);
            assert.equal(over.ok === false && over.field, field);
            assert.match(over.ok === false ? over.error : '', /cannot be above Cloudflare's free tier/);
        }
        assert.equal(checkLimitsInput({ storage_bytes: 0, class_a: 1, class_b: 1 }).ok, false);
        assert.equal(checkLimitsInput({ storage_bytes: 1.5, class_a: 1, class_b: 1 }).ok, false);
        assert.equal(checkLimitsInput(null).ok, false);
    });

    it('readLimits takes the saved limits from the settings row', async () => {
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 7e9, class_a: 5, class_b: 6 }));
        assert.deepEqual(await readLimits(), { storage_bytes: 7e9, class_a: 5, class_b: 6 });
    });
});

describe('the reserve', () => {
    it('counts Class A one at a time and Class B in batches, in the month\'s row', async () => {
        const guard = guardWith(limits(), 50);
        await guard.reserve('A');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 0 });
        await guard.reserve('B');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 50 }, 'a batch of 50 reads is reserved, and counted, at once');
        const statements = db.statements.length;
        for (let i = 0; i < 49; i++) await guard.reserve('B');
        assert.equal(db.statements.length, statements, 'the other 49 reads are served from the batch: no database round trip');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 50 });
        await guard.reserve('B');
        assert.deepEqual(db.counters('2026-11'), { a: 1, b: 100 }, 'the 51st read reserves the next batch');
    });

    it('refuses at the limit, sends nothing further, and says which limit and when it resets', async () => {
        db.setCounters('2026-11', 3, 0);
        const guard = guardWith(limits({ class_a: 4 }));
        await guard.reserve('A');
        assert.deepEqual(db.counters('2026-11'), { a: 4, b: 0 });
        await assert.rejects(guard.reserve('A'), (err: unknown) => {
            assert.ok(err instanceof R2LimitError);
            assert.equal(err.kind, 'class_a');
            assert.equal(err.code, 'R2_LIMIT');
            assert.equal(err.limit, 4);
            assert.match(err.message, /free write allowance for this month is used up/);
            assert.match(err.message, /resets on 2026-12-01/);
            return true;
        });
        assert.deepEqual(db.counters('2026-11'), { a: 4, b: 0 }, 'a refusal changes nothing');
        assert.ok(logged.some((l) => l.event === 'media.r2_limit_reached'));
    });

    it('takes what a request needs when there is no room for a whole batch', async () => {
        db.setCounters('2026-11', 0, 8);
        const guard = guardWith(limits({ class_b: 10 }), 50);
        await guard.reserve('B');
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 9 }, 'a batch of 50 does not fit, one read does');
        await guard.reserve('B');
        await guard.reserve('B').then(() => assert.fail('the tenth was the last'), (e) => assert.ok(e instanceof R2LimitError && e.kind === 'class_b'));
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 10 });
    });

    it('never refuses a read because the Class A limit was lowered below what is used', async () => {
        db.setCounters('2026-11', 500, 0);
        await guardWith(limits({ class_a: 10 })).reserve('B');
        assert.equal(db.counters('2026-11').b, 50);
    });

    it('concurrent reserves never overshoot, however they interleave and however many instances there are', async () => {
        const limit = 137;
        // Several instances (each its own guard and batch) hammer the same month at once, with the database answering in a shuffled order.
        const instances = [1, 2, 3, 4, 5].map((i) => new R2UsageGuard({ limits: async () => limits({ class_b: limit }), readBatch: i * 7 }));
        const original = db.query.bind(db);
        db.query = async (sql, params) => {
            await new Promise((r) => setImmediate(r));
            for (let i = 0; i < Math.floor(Math.random() * 3); i++) await Promise.resolve();
            return original(sql, params);
        };
        let granted = 0;
        let refused = 0;
        await Promise.all(Array.from({ length: 400 }, (_, i) => instances[i % instances.length]!.reserve('B').then(() => { granted++; }, (e) => {
            assert.ok(e instanceof R2LimitError);
            refused++;
        })));
        const used = db.counters('2026-11').b;
        assert.ok(used <= limit, `the counter (${used}) never passed the limit (${limit})`);
        assert.ok(granted <= used, 'every granted read was counted first');
        assert.ok(refused > 0 && granted > 0);
        assert.equal(granted + refused, 400);
    });

    it('fails closed: a database error refuses the request, as a counter error, and nothing is counted', async () => {
        db.failOn = /^INSERT INTO app_settings \(key, value, is_secret, updated_at\) SELECT/;
        const guard = guardWith(limits());
        await assert.rejects(guard.reserve('B'), (err: unknown) => err instanceof R2CounterError && /could not be updated/.test(err.message));
        await assert.rejects(guard.reserve('A'), R2CounterError);
        db.failOn = null;
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 0 });
        // Limits that cannot be read are refused the same way.
        const blind = new R2UsageGuard({ limits: async () => { throw new Error('settings unreadable'); } });
        await assert.rejects(blind.reserve('B'), R2CounterError);
        assert.ok(logged.some((l) => l.event === 'media.r2_counter_failed'));
    });

    it('starts again on the 1st (UTC): a new month is a new row, and a leftover batch of the old month is dropped', async () => {
        mock.timers.reset();
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-30T23:59:59Z') });
        const guard = guardWith(limits({ class_b: 100 }), 50);
        await guard.reserve('B');
        await guard.reserve('B');
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 50 }, 'a batch is held locally');
        db.setCounters('2026-11', 0, 100);
        await assert.rejects(guardWith(limits({ class_b: 100 })).reserve('B'), R2LimitError, 'November is used up');

        mock.timers.reset();
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-12-01T00:00:01Z') });
        assert.equal(monthKey(), '2026-12');
        await guard.reserve('B');
        assert.deepEqual(db.counters('2026-12'), { a: 0, b: 50 }, 'December counts from zero, with a fresh batch (November\'s leftover was not carried)');
        assert.deepEqual(db.counters('2026-11'), { a: 0, b: 100 }, 'November\'s row is left as it was');
        await guardWith(limits({ class_b: 100 })).reserve('B');
    });

    it('names the month in UTC and the reset at its end', () => {
        assert.equal(monthKey(new Date('2026-12-31T23:59:59Z')), '2026-12');
        assert.equal(nextReset(new Date('2026-12-31T23:59:59Z')), '2027-01-01T00:00:00.000Z');
        assert.equal(nextReset(new Date('2026-11-06T10:00:00Z')), '2026-12-01T00:00:00.000Z');
    });

    it('reads the counters of a month that has none as zero', async () => {
        assert.deepEqual(await readCounters('2026-11'), { a: 0, b: 0 });
    });
});

describe('the storage cap', () => {
    const r2Row = (id: string, bytes: number) => db.addMedia({ id, storage_path: `r2:${CREATOR}/${id}.mp4`, size_bytes: String(bytes) });
    const ID1 = '00000000-0000-4000-8000-000000000001';
    const ID2 = '00000000-0000-4000-8000-000000000002';

    it('lets a file in while R2 bytes plus the file fit, and refuses with R2_LIMIT when they do not', async () => {
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 1000, class_a: 10, class_b: 10 }));
        r2Row(ID1, 600);
        await assertR2Room(400);
        await assert.rejects(assertR2Room(401), (err: unknown) => {
            assert.ok(err instanceof R2LimitError);
            assert.equal(err.kind, 'storage');
            assert.match(err.message, /free storage is full/);
            assert.match(err.message, /Switch new uploads to Supabase or free up space/);
            return true;
        });
    });

    it('counts a signed-but-unconfirmed upload: its row already carries the declared size', async () => {
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 1000, class_a: 10, class_b: 10 }));
        r2Row(ID1, 500);
        r2Row(ID2, 450); // signed, never confirmed
        await assert.rejects(assertR2Room(100), R2LimitError);
    });

    it('does not count Supabase files, which are not in R2', async () => {
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 1000, class_a: 10, class_b: 10 }));
        db.addMedia({ id: ID1, storage_path: `${CREATOR}/${ID1}.mp4`, size_bytes: '999999' });
        await assertR2Room(1000);
    });

    it('refuses when the sum cannot be read: a write that cannot be measured is not made', async () => {
        db.failOn = /SUM\(size_bytes\)/;
        await assert.rejects(assertR2Room(1), R2CounterError);
    });

    it('formats bytes the way the messages use them', () => {
        assert.equal(formatBytes(9 * 1024 ** 3), '9.7 GB');
        assert.equal(formatBytes(10_000_000_000), '10 GB');
        assert.equal(formatBytes(150e6), '150 MB');
    });
});

describe('the summary and the banner', () => {
    it('is ok under 80%, warn from 80%, full at the limit', () => {
        const l = { storage_bytes: 1000, class_a: 100, class_b: 1000 };
        assert.equal(summarize({ storage_bytes: 100, class_a: 10, class_b: 10 }, l, NOV).level, 'ok');
        assert.equal(summarize({ storage_bytes: 100, class_a: 79, class_b: 10 }, l, NOV).level, 'ok');
        assert.equal(summarize({ storage_bytes: 100, class_a: 80, class_b: 10 }, l, NOV).level, 'warn');
        assert.equal(summarize({ storage_bytes: 100, class_a: 80, class_b: 1000 }, l, NOV).level, 'full');
        const s = summarize({ storage_bytes: 500, class_a: 25, class_b: 1000 }, l, NOV);
        assert.deepEqual(s.items.map((i) => [i.kind, i.pct]), [['storage', 50], ['class_a', 25], ['class_b', 100]]);
        assert.equal(s.resetsAt, '2026-12-01T00:00:00.000Z');
        assert.equal(s.month, '2026-11');
    });

    it('reads this month\'s numbers from the rows', async () => {
        db.setCounters('2026-11', 12, 345);
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 5000, class_a: 100, class_b: 1000 }));
        db.addMedia({ id: '00000000-0000-4000-8000-000000000001', storage_path: 'r2:x', size_bytes: '1000' });
        const s = await readR2Summary(NOV);
        assert.deepEqual(s.items.map((i) => i.used), [1000, 12, 345]);
    });

    it('shows no banner while R2 is not set up, or under 80%, and one at 80% and at 100%', async () => {
        db.setCounters('2026-11', 0, 8_000_000);
        assert.equal(await readR2Banner(NOV), null, 'not configured');
        db.configureR2();
        clearR2BannerCache();
        assert.deepEqual(await readR2Banner(NOV), { level: 'warn', resetsAt: '2026-12-01T00:00:00.000Z', items: [{ kind: 'class_b', pct: 88 }] }, '8M of 9M reads is 88%');
        db.setCounters('2026-11', 0, 1000);
        assert.deepEqual(await readR2Banner(NOV), { level: 'warn', resetsAt: '2026-12-01T00:00:00.000Z', items: [{ kind: 'class_b', pct: 88 }] }, 'kept for a minute');
        clearR2BannerCache();
        assert.equal(await readR2Banner(NOV), null, 'under 80%');
        db.setCounters('2026-11', 0, 9_000_000);
        clearR2BannerCache();
        assert.equal((await readR2Banner(NOV))?.level, 'full');
    });
});

describe('the owner\'s warning', () => {
    let emails: Array<{ subject: string; text: string; to: string }>;
    let original: typeof emailHttp.post;
    beforeEach(() => {
        emails = [];
        original = emailHttp.post;
        (emailHttp as unknown as { post: unknown }).post = async (_path: string, body: any) => { emails.push({ subject: body.subject, text: body.text, to: body.to[0] }); return { status: 200, data: {} }; };
        db.configureR2();
        db.set('notify.email_enabled', 'true');
        db.set('notify.email_api_key', 're_0123456789abcdefghijKLMN', true);
        db.set('notify.email_to', 'owner@example.com');
        db.set('storage.r2_limits', JSON.stringify({ storage_bytes: 1e9, class_a: 100, class_b: 1000 }));
    });
    afterEach(() => { (emailHttp as unknown as { post: unknown }).post = original; });

    it('says nothing under 80%', async () => {
        db.setCounters('2026-11', 79, 100);
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: [] });
        assert.equal(emails.length, 0);
    });

    it('emails the owner once a day per limit at 80%, naming the limit in both languages', async () => {
        db.setCounters('2026-11', 85, 100);
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: ['class_a'] });
        assert.equal(emails.length, 1);
        assert.equal(emails[0]!.to, 'owner@example.com');
        assert.match(emails[0]!.subject, /above 80%/);
        assert.match(emails[0]!.text, /write operations \(Class A\): 85 of 100 \(85%\)/);
        assert.match(emails[0]!.text, /عمليات الكتابة/);
        assert.match(emails[0]!.text, /Cloudflare's own dashboard is the final word/);

        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: [] }, 'the same limit, the same day: not again');
        assert.equal(emails.length, 1);

        db.setCounters('2026-11', 85, 900);
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: ['class_b'] }, 'another limit is its own warning');
        assert.equal(emails.length, 2);

        mock.timers.reset();
        mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-07T01:00:00Z') });
        assert.deepEqual(await checkR2Warnings({ now: new Date('2026-11-07T01:00:00Z') }).then((r) => r.alerted.sort()), ['class_a', 'class_b'], 'and again the next day');
    });

    it('says it is used up at 100%', async () => {
        db.setCounters('2026-11', 100, 0);
        await checkR2Warnings({ now: NOV });
        assert.match(emails[0]!.subject, /free tier reached/);
    });

    it('does not mark a day told when nothing could be sent, so the next drain tries again', async () => {
        db.set('notify.email_enabled', 'false');
        db.setCounters('2026-11', 90, 0);
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: [] });
        assert.equal(db.settings.has('storage.r2_alerted'), false);
        db.set('notify.email_enabled', 'true');
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: ['class_a'] });
    });

    it('costs nothing while R2 is not set up, and never throws', async () => {
        db.settings.delete('storage.r2_account_id');
        db.setCounters('2026-11', 99, 0);
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: [] });
        db.configureR2();
        db.failOn = /storage\.r2_usage|SELECT value FROM app_settings/;
        assert.deepEqual(await checkR2Warnings({ now: NOV }), { alerted: [] });
    });

    it('builds a message that names every limit that is high, with the reset date', () => {
        const s = summarize({ storage_bytes: 9e8, class_a: 90, class_b: 10 }, { storage_bytes: 1e9, class_a: 100, class_b: 1000 }, NOV);
        const msg = buildR2Alert(s.items.filter((i) => i.pct >= 80), s.resetsAt, 'https://x.example/dashboard');
        assert.match(msg.text, /storage: 900 MB of 1 GB \(90%\)/);
        assert.match(msg.text, /2026-12-01/);
    });
});
