/**
 * The timing instrument (`timing.ts`) and the pool that feeds it (`countStatements`, src/config/db.ts).
 *
 * What is pinned, because each is a way the measurement would lie: a timeline is ONE line however deep it nests; its steps add up to
 * its total; a statement is counted where it was issued and nowhere else; the counted promise is the caller's own, so a failed
 * statement still fails; and nothing at all is counted or wrapped outside a tally, which is every dashboard request.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it, mock } from 'node:test';
import { countStatements } from '../config/db.js';
import { REDACT_KEY, setLogSink } from './log.js';
import { countStatement, isTallying, lap, noteTiming, queryTally, withQueryTally, withTimeline } from './timing.js';

const lines: Record<string, any>[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { lines.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

/** The clock moved by hand: `Date` only, so the promises still settle. */
function clock(start = 1_000_000) {
    mock.timers.enable({ apis: ['Date'], now: start });
    return { tick: (ms: number) => mock.timers.tick(ms), reset: () => mock.timers.reset() };
}

const timingLines = (event: string) => lines.filter((l) => l.event === event);

describe('a timeline', () => {
    it('is one line, with each step\'s time and statements, in the order they ran, adding up to its total', async () => {
        lines.length = 0;
        const t = clock();
        try {
            await withTimeline('test.timing', async () => {
                t.tick(70);
                await countStatement(Promise.resolve());
                lap('state');
                t.tick(5);
                lap('prefilter');
                t.tick(400);
                await Promise.all([countStatement(Promise.resolve()), countStatement(Promise.resolve())]);
                lap('context');
                noteTiming({ outcome: 'sent', engine: 'providers' });
                t.tick(30);
            });
        } finally {
            t.reset();
        }

        const [line] = timingLines('test.timing');
        assert.equal(timingLines('test.timing').length, 1);
        assert.deepEqual(Object.keys(line!.steps_ms), ['state', 'prefilter', 'context', 'rest']);
        assert.deepEqual(line!.steps_ms, { state: 70, prefilter: 5, context: 400, rest: 30 });
        assert.deepEqual(line!.steps_db, { state: 1, context: 2 });
        assert.equal(line!.total_ms, 505);
        assert.equal(line!.db_statements, 3);
        assert.equal(line!.outcome, 'sent');
        assert.equal(line!.engine, 'providers');
    });

    it('nested in another, adds its steps to the outer line instead of logging a second one', async () => {
        lines.length = 0;
        await withTimeline('test.outer', async () => {
            lap('creator');
            await withTimeline('test.inner', async () => {
                lap('state');
                noteTiming({ outcome: 'superseded' });
            });
            lap('settle');
        });
        assert.equal(timingLines('test.inner').length, 0);
        const [outer] = timingLines('test.outer');
        assert.deepEqual(Object.keys(outer!.steps_ms).filter((k) => k !== 'rest'), ['creator', 'state', 'settle']);
        assert.equal(outer!.outcome, 'superseded');
    });

    it('a step that runs twice adds up, as a second model call does', async () => {
        lines.length = 0;
        const t = clock();
        try {
            await withTimeline('test.twice', async () => {
                t.tick(600);
                lap('model');
                t.tick(10);
                lap('guard');
                t.tick(700);
                lap('model');
            });
        } finally {
            t.reset();
        }
        assert.deepEqual(timingLines('test.twice')[0]!.steps_ms, { model: 1300, guard: 10 });
    });

    it('is logged when the work throws, and the error is the work\'s own', async () => {
        lines.length = 0;
        await assert.rejects(withTimeline('test.thrown', async () => {
            lap('claim');
            throw new Error('the send failed');
        }), /the send failed/);
        assert.deepEqual(Object.keys(timingLines('test.thrown')[0]!.steps_ms).filter((k) => k !== 'rest'), ['claim']);
    });

    it('outside one, a lap and a note do nothing', () => {
        lines.length = 0;
        lap('state');
        noteTiming({ outcome: 'sent' });
        assert.equal(lines.length, 0);
    });

    it('opens a statement tally of its own when there is none, and uses the one in scope when there is', async () => {
        lines.length = 0;
        assert.equal(isTallying(), false);
        await withTimeline('test.own', async () => {
            assert.equal(isTallying(), true);
            await countStatement(Promise.resolve());
        });
        assert.equal(timingLines('test.own')[0]!.db_statements, 1);

        await withQueryTally(async () => {
            await countStatement(Promise.resolve());
            await withTimeline('test.shared', async () => { await countStatement(Promise.resolve()); });
            await countStatement(Promise.resolve());
            // The timeline reports its own statements; the tally has all three.
            assert.equal(timingLines('test.shared')[0]!.db_statements, 1);
            assert.equal(queryTally().db_statements, 3);
        });
    });
});

describe('the statement tally', () => {
    it('hands back the very promise it was given, so a failed statement still fails where it was awaited', async () => {
        await withQueryTally(async () => {
            const failing = Promise.reject(new Error('relation "jobs" does not exist'));
            assert.equal(countStatement(failing), failing);
            await assert.rejects(failing, /does not exist/);
            assert.equal(queryTally().db_statements, 1);
        });
    });

    it('counts nothing outside a tally, and has no fields to give', () => {
        const p = Promise.resolve();
        assert.equal(countStatement(p), p);
        assert.deepEqual(queryTally(), {});
    });

    it('counts a statement where it was issued: work in another tally is never counted here', async () => {
        let other = -1;
        await withQueryTally(async () => {
            await Promise.all([
                withQueryTally(async () => {
                    await countStatement(Promise.resolve());
                    await countStatement(Promise.resolve());
                    other = queryTally().db_statements ?? -1;
                }),
                countStatement(Promise.resolve()),
            ]);
            assert.equal(queryTally().db_statements, 1);
        });
        assert.equal(other, 2);
    });
});

describe('the pool', () => {
    /** A pool with no database behind it: `query` answers, `connect` hands out a client whose statements are recorded. */
    function fakePool() {
        const sent: string[] = [];
        const client = {
            query: async (sql: string) => { sent.push(sql); return { rows: [], rowCount: 0 }; },
            release: () => { sent.push('<release>'); },
            marker: 'the client',
        };
        const pool = {
            query: async (sql: string) => { sent.push(sql); return { rows: [], rowCount: 0 }; },
            connect: (cb?: (err: unknown, c: unknown) => void) => {
                if (cb) { cb(undefined, client); return undefined; }
                return Promise.resolve(client);
            },
        };
        countStatements(pool);
        return { pool, client, sent };
    }

    it('counts every statement sent inside a tally, a transaction\'s included, and each once', async () => {
        const { pool, sent } = fakePool();
        await withQueryTally(async () => {
            await pool.query('SELECT 1');
            const tx = await (pool.connect() as Promise<any>);
            await tx.query('BEGIN');
            await tx.query('SELECT pg_advisory_xact_lock(1)');
            await tx.query('COMMIT');
            tx.release();
            assert.equal(tx.marker, 'the client', 'everything else is the client\'s own');
            assert.equal(queryTally().db_statements, 4);
        });
        assert.deepEqual(sent, ['SELECT 1', 'BEGIN', 'SELECT pg_advisory_xact_lock(1)', 'COMMIT', '<release>']);
    });

    it('outside a tally, hands out the client itself, and the callback form always: nothing is wrapped', async () => {
        const { pool, client } = fakePool();
        assert.equal(await (pool.connect() as Promise<any>), client);
        await withQueryTally(async () => {
            let given: unknown;
            pool.connect((_err: unknown, c: unknown) => { given = c; });
            assert.equal(given, client, 'the form pool.query uses is passed straight through');
        });
    });
});

describe('timing names', () => {
    /** Every `lap('…')` step and every key a `noteTiming({ … })` literal writes, in src/. */
    function names(): string[] {
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = path.join(dir, name);
                if (statSync(full).isDirectory()) walk(full);
                else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push(full);
            }
        };
        walk('src');
        const found: string[] = [];
        for (const file of files) {
            const src = readFileSync(file, 'utf8');
            for (const m of src.matchAll(/\blap\('([^']+)'\)/g)) found.push(m[1]!);
            for (const m of src.matchAll(/\bnoteTiming\(\{([^}]*)\}/g)) {
                for (const k of m[1]!.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*[:,]?/g)) found.push(k[1]!);
            }
        }
        return found;
    }

    it('are never named so the logger blanks them (REDACT_KEY): the line would print [redacted] where the number should be', () => {
        const found = names();
        // The scan must be reading the real calls: a broken pattern would find none and pass.
        assert.ok(found.includes('model') && found.includes('sender_wait') && found.includes('event_age_ms'), `found: ${found.join(', ')}`);
        assert.deepEqual(found.filter((n) => REDACT_KEY.test(n)), []);
    });
});
