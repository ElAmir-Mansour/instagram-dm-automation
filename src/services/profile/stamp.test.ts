/**
 * `profileVersionFor` (P7): the number a generated row is stamped with.
 *
 * Pinned here:
 *   - the stored profile's version, and null for a tenant with none, for one whose database has no v33 yet,
 *     and for a read that failed: it never throws into a generation path;
 *   - a failed read is logged once as `profile.version_stamp_failed`, with the tenant and nothing else;
 *   - it shares the request's (or job's) profile cache with the settings readers: one query for however many
 *     rows a request stamps, a failed read is not kept, a new scope reads again, a transaction client always reads;
 *   - it does not repair or write anything: the statements it sends are one SELECT.
 *
 * Where each of the six sites stamps is pinned in that site's own test file (drafts, sweep, analyst, infographics).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { drainJobs } from '../../jobs/runner.js';
import type { Job, JobHandlerRegistry, JobQueue } from '../../jobs/types.js';
import { setLogSink } from '../../utils/log.js';
import { getStudioSettings } from '../studio/settings.js';
import { withProfileCache } from './cache.js';
import { defaultProfile } from './defaults.js';
import { profileVersionFor } from './stamp.js';
import { resetProfileTableWarning, resetProfileWarnings } from './store.js';
import { emptyState, installProfileDb, OTHER, OWNER, type ProfileDb, type State } from './testDb.js';
import { throughJsonb } from './testSupport.js';

let state: State;
let db: ProfileDb;
let events: { level: string; event: string; fields: Record<string, unknown> }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    events = [];
    const previous = setLogSink((level, line) => { const fields = JSON.parse(line); events.push({ level, event: fields.event, fields }); });
    restoreSink = () => setLogSink(previous);
    resetProfileWarnings();
    resetProfileTableWarning();
    state = emptyState();
    db = installProfileDb(state);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

/** A stored profile as the database holds it. */
function store(creatorId: string, version: number): void {
    state.profiles.set(creatorId, { profile: throughJsonb(defaultProfile()), version, activated_at: null, updated_by: null });
}

const reads = (): number => db.ran(/FROM creator_profiles/).length;
const stampFailures = () => events.filter((e) => e.event === 'profile.version_stamp_failed');

describe('profileVersionFor — the answer', () => {
    it('is the stored profile’s version, whichever it is now', async () => {
        store(OWNER, 1);
        assert.equal(await profileVersionFor(OWNER), 1);
        state.profiles.get(OWNER)!.version = 14;
        assert.equal(await profileVersionFor(OWNER), 14);
    });

    it('is null for a tenant with no stored profile, and one tenant never reads another’s', async () => {
        store(OWNER, 3);
        assert.equal(await profileVersionFor(OTHER), null);
        assert.equal(await profileVersionFor(OWNER), 3);
        assert.deepEqual(db.ran(/FROM creator_profiles/).map((s) => s.params), [[OTHER], [OWNER]]);
    });

    it('is null, with no stamp failure logged, on a database without migration v33', async () => {
        db.restore();
        db = installProfileDb(state, { v33: false });
        assert.equal(await profileVersionFor(OWNER), null);
        assert.equal(stampFailures().length, 0, 'a missing table is the store’s own tolerated case (profile.table_missing), not a failure of the stamp');
    });

    it('sends one SELECT and writes nothing', async () => {
        store(OWNER, 2);
        await profileVersionFor(OWNER);
        assert.deepEqual(db.statements.map((s) => s.sql), ['SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = $1']);
    });
});

describe('profileVersionFor — a failing read never reaches the generation', () => {
    it('answers null instead of throwing, and logs profile.version_stamp_failed once, with the tenant and nothing else', async () => {
        store(OWNER, 5);
        db.failOn = /FROM creator_profiles/;
        db.failWith = Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' });
        assert.equal(await profileVersionFor(OWNER), null);
        assert.equal(stampFailures().length, 1);
        const { level, fields } = stampFailures()[0]!;
        assert.equal(level, 'warn');
        assert.equal(fields.creator_id, OWNER);
        assert.deepEqual(Object.keys(fields).sort(), ['creator_id', 'event', 'level', 'ts'], 'no error text, no code: the tenant only');
    });

    it('is null for a failure that is not a database error too', async () => {
        db.failOn = /FROM creator_profiles/;
        db.failWith = new TypeError('Cannot read properties of undefined');
        assert.equal(await profileVersionFor(OWNER), null);
        assert.equal(stampFailures().length, 1);
    });

    it('stamps again once the database is back: nothing is remembered about the failure', async () => {
        store(OWNER, 5);
        db.failOn = /FROM creator_profiles/;
        assert.equal(await profileVersionFor(OWNER), null);
        db.failOn = null;
        assert.equal(await profileVersionFor(OWNER), 5);
        assert.equal(stampFailures().length, 1);
    });
});

describe('profileVersionFor — the request’s cache', () => {
    it('costs one query however many rows a request stamps, and another tenant is another query', async () => {
        store(OWNER, 7);
        store(OTHER, 2);
        await withProfileCache(async () => {
            assert.deepEqual(await Promise.all([profileVersionFor(OWNER), profileVersionFor(OWNER)]), [7, 7], 'two at once share one query');
            assert.equal(await profileVersionFor(OWNER), 7);
            assert.equal(await profileVersionFor(OWNER), 7);
            assert.equal(await profileVersionFor(OTHER), 2);
        });
        assert.equal(reads(), 2, 'one for each tenant');
    });

    it('costs nothing when the request already read its settings, which asks for the same profile', async () => {
        store(OWNER, 7);
        await withProfileCache(async () => {
            await getStudioSettings(OWNER);
            const before = reads();
            assert.equal(before, 1, 'the settings reader asked for the profile once');
            assert.equal(await profileVersionFor(OWNER), 7);
            assert.equal(reads(), before, 'the stamp reused it');
        });
    });

    it('asks every time outside a scope, so the cache is what saves the queries', async () => {
        store(OWNER, 7);
        await profileVersionFor(OWNER);
        await profileVersionFor(OWNER);
        assert.equal(reads(), 2);
    });

    it('is one query per scope: a job’s own scope, even inside a request’s, reads for itself', async () => {
        store(OWNER, 7);
        await withProfileCache(async () => {
            await profileVersionFor(OWNER);
            await withProfileCache(async () => {
                await profileVersionFor(OWNER);
                await profileVersionFor(OWNER);
            });
            await profileVersionFor(OWNER);
        });
        assert.equal(reads(), 2, 'one for the request, one for the job');
    });

    it('does not keep a failed read: the next row of the same request stamps normally', async () => {
        store(OWNER, 7);
        await withProfileCache(async () => {
            db.failOn = /FROM creator_profiles/;
            assert.equal(await profileVersionFor(OWNER), null);
            db.failOn = null;
            assert.equal(await profileVersionFor(OWNER), 7);
            assert.equal(await profileVersionFor(OWNER), 7);
        });
        assert.equal(reads(), 2, 'the failed one, then one that was kept');
    });
});

describe('profileVersionFor — inside the job runner', () => {
    /** The real `drainJobs`, so the scope it opens per job is the one under test; the queue and handlers are stand-ins. */
    const drain = async (handle: (job: Job) => Promise<void>, ids: string[]) => {
        const jobs = ids.map((id) => ({ id, kind: 'comment.process', payload: {}, attempts: 1, max_attempts: 3, request_id: null, creator_id: OWNER, tenant_key: null }) as Job);
        let claimed = false;
        const queue = {
            enqueue: async () => 'job-new',
            claim: async () => (claimed ? [] : ((claimed = true), jobs)),
            complete: async () => {},
            fail: async () => {},
            reapStale: async () => 0,
            pruneCompleted: async () => 0,
        } as unknown as JobQueue;
        const run = async (_payload: unknown, job: Job) => handle(job);
        return drainJobs({ queue, handlers: { 'comment.process': run } as unknown as JobHandlerRegistry, budgetMs: 60_000 });
    };

    it('is one query per job however many rows the job stamps, and a profile saved between two jobs reaches the second', async () => {
        store(OWNER, 7);
        const seen: (number | null)[] = [];
        const result = await drain(async (job) => {
            seen.push(await profileVersionFor(OWNER), await profileVersionFor(OWNER));
            if (job.id === 'a') state.profiles.get(OWNER)!.version = 8; // saved elsewhere while the drain runs
        }, ['a', 'b']);
        assert.deepEqual([result.succeeded, result.failed], [2, 0]);
        assert.deepEqual(seen, [7, 7, 8, 8]);
        assert.equal(reads(), 2, 'one read for each job');
    });
});
