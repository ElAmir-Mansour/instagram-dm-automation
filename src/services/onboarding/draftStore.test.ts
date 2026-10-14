/**
 * The statements of the draft engine, pinned by their text (P24). The in-memory table (`testDb.ts`) reads its predicates out of the SQL, so
 * these say what the SQL must contain; its behaviour is `drafts.test.ts`'s. Three rules: the lease is one UPDATE and is the claim, every write is
 * guarded by the owner, and time is the database's.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import {
    CLAIM_SQL, COUNT_START_SQL, DRAFT_COLUMNS, FINISH_FAILED_SQL, FINISH_READY_SQL, INSERT_SQL, LOCK_TENANT_DRAFTS_SQL, MARK_STATUS_SQL, RELEASE_SQL, SAVE_FETCHED_SQL,
    SAVE_RETRY_SQL, SELECT_BY_ID_SQL, SELECT_CURRENT_SQL, SELECT_DUE_SQL, SELECT_REUSABLE_SQL, startBucket, SUPERSEDE_SQL,
} from './draftStore.js';

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const ACTIVE = "status IN ('queued', 'fetching', 'drafting')";

describe('the claim is one statement, and it is the whole mutual exclusion', () => {
    const sql = flat(CLAIM_SQL);

    it('is a single UPDATE that returns the row: whoever gets a row owns the draft', () => {
        assert.match(sql, /^UPDATE profile_drafts SET /);
        assert.match(sql, /RETURNING id, creator_id/);
    });

    it('takes only a draft that is active, not held (no lease, or one that ran out) and due (no back-off, or one that is over)', () => {
        assert.ok(sql.includes(ACTIVE));
        assert.ok(sql.includes('(lease_until IS NULL OR lease_until < NOW())'));
        assert.ok(sql.includes('(next_attempt_at IS NULL OR next_attempt_at <= NOW())'));
        assert.ok(sql.includes('WHERE id = $1'));
    });

    it('counts a try when it takes the draft over from an owner that never let go, and not otherwise', () => {
        assert.ok(sql.includes('attempts = attempts + CASE WHEN lease_owner IS NOT NULL THEN 1 ELSE 0 END'));
    });

    it('holds it for the number of seconds it is given, by the database\'s clock', () => {
        assert.ok(sql.includes('lease_until = NOW() + make_interval(secs => $3::double precision)'));
        assert.ok(sql.includes('lease_owner = $2'));
    });
});

describe('every write a step makes is guarded by the owner', () => {
    const writes: Array<[string, string]> = [
        ['MARK_STATUS', MARK_STATUS_SQL], ['SAVE_FETCHED', SAVE_FETCHED_SQL], ['SAVE_RETRY', SAVE_RETRY_SQL], ['FINISH_READY', FINISH_READY_SQL], ['FINISH_FAILED', FINISH_FAILED_SQL], ['RELEASE', RELEASE_SQL],
    ];

    for (const [name, sql] of writes) {
        it(`${name}: only while the draft is still this caller's`, () => {
            assert.ok(flat(sql).includes('lease_owner = $2'), `${name} must say AND lease_owner = $2`);
            assert.ok(flat(sql).includes('WHERE id = $1'));
        });
    }

    it('and only while the draft is active: a superseded or finished draft is never written over', () => {
        for (const [name, sql] of writes.filter(([n]) => n !== 'RELEASE')) assert.ok(flat(sql).includes(ACTIVE), name);
    });

    it('a finished draft lets go of its lease and its back-off in the same statement', () => {
        for (const sql of [FINISH_READY_SQL, FINISH_FAILED_SQL]) {
            const s = flat(sql);
            assert.ok(s.includes('lease_until = NULL') && s.includes('lease_owner = NULL') && s.includes('next_attempt_at = NULL') && s.includes('finished_at = NOW()'));
        }
        assert.ok(flat(SAVE_RETRY_SQL).includes('lease_until = NULL') && flat(SAVE_RETRY_SQL).includes('lease_owner = NULL'), 'a retry is released so the sweep can take it when it is due');
    });

    it('a write returns the row it wrote, so the caller reads the state it just made', () => {
        for (const [, sql] of writes.filter(([n]) => n !== 'RELEASE')) assert.match(flat(sql), /RETURNING id, creator_id/);
    });
});

describe('time is the database\'s', () => {
    it('no statement compares against a time the application sends: NOW() decides every lease, back-off and window', () => {
        const all = [CLAIM_SQL, SELECT_DUE_SQL, SELECT_REUSABLE_SQL, SUPERSEDE_SQL, MARK_STATUS_SQL, SAVE_FETCHED_SQL, SAVE_RETRY_SQL, FINISH_READY_SQL, FINISH_FAILED_SQL, RELEASE_SQL];
        for (const sql of all) assert.equal(/\$\d+::timestamp|\$\d+ *[<>]=? *NOW|NOW\(\) *[<>]=? *\$\d+/.test(flat(sql)), false, flat(sql).slice(0, 60));
    });

    it('the 24-hour reuse window is the database\'s', () => {
        assert.ok(flat(SELECT_REUSABLE_SQL).includes("finished_at > NOW() - INTERVAL '24 hours'"));
    });
});

describe('the reads and the start', () => {
    it('what is due: active, not held, not in back-off, oldest first, bounded', () => {
        const s = flat(SELECT_DUE_SQL);
        for (const part of [ACTIVE, '(lease_until IS NULL OR lease_until < NOW())', '(next_attempt_at IS NULL OR next_attempt_at <= NOW())', 'ORDER BY created_at, id LIMIT $1']) assert.ok(s.includes(part), part);
    });

    it('what is reusable: this tenant\'s, with this hash, in flight or ready and fresh', () => {
        const s = flat(SELECT_REUSABLE_SQL);
        assert.ok(s.includes('creator_id = $1 AND inputs_hash = $2'));
        assert.ok(s.includes(ACTIVE) && s.includes("status = 'ready'"));
    });

    it('the current draft is the newest that was not replaced', () => {
        assert.ok(flat(SELECT_CURRENT_SQL).includes("status <> 'superseded' ORDER BY created_at DESC, id DESC LIMIT 1"));
        assert.ok(flat(SELECT_BY_ID_SQL).endsWith('WHERE id = $1'));
    });

    it('new inputs replace what is in flight and what is ready, never what failed', () => {
        const s = flat(SUPERSEDE_SQL);
        assert.ok(s.includes("status IN ('queued', 'fetching', 'drafting', 'ready')"));
        assert.ok(s.includes('creator_id = $1'));
        assert.ok(s.includes('lease_until = NULL') && s.includes('lease_owner = NULL'), 'so an in-flight invocation finds out at its next write');
        assert.equal(s.includes("'failed'"), false);
    });

    it('a start takes the tenant\'s advisory lock, which is held until its transaction ends', () => {
        assert.equal(flat(LOCK_TENANT_DRAFTS_SQL), 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))');
    });

    it('the day\'s count is the shared counters table\'s, one row per tenant per UTC day, incremented before it is compared', () => {
        const s = flat(COUNT_START_SQL);
        assert.ok(s.includes("date_trunc('day', NOW())") && s.includes('ON CONFLICT (bucket, window_start) DO UPDATE SET count = app_rate_limit_counters.count + 1 RETURNING count'));
        assert.equal(startBucket('00000000-0000-4000-8000-000000000100'), 'draft:00000000-0000-4000-8000-000000000100');
        assert.ok(startBucket('00000000-0000-4000-8000-000000000100').length <= 50, 'the bucket column is 50 characters');
    });

    it('the insert names no status, attempts or lease: a new draft is `queued`, with nothing held, by the table\'s own defaults', () => {
        const s = flat(INSERT_SQL);
        assert.equal(/status|attempts|lease/.test(s.slice(0, s.indexOf('VALUES'))), false);
    });
});

describe('every column the engine reads exists in the table, and nothing else is named', () => {
    it('is the table\'s own list (migration v34)', () => {
        const migration = fs.readFileSync(new URL('../../config/migration_v34_onboarding.sql', import.meta.url), 'utf8');
        const body = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS profile_drafts'), migration.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS idx_profile_drafts_one_active'));
        const columns = [...body.matchAll(/^\s{4}([a-z_]+)\s+(?:UUID|TEXT|JSONB|INT|BOOLEAN|TIMESTAMP)/gm)].map((m) => m[1]);
        assert.deepEqual(DRAFT_COLUMNS.split(', ').sort(), columns.sort());
    });

    it('the status column\'s own check allows exactly the six statuses the engine uses', () => {
        const migration = fs.readFileSync(new URL('../../config/migration_v34_onboarding.sql', import.meta.url), 'utf8');
        assert.ok(migration.includes("status IN ('queued', 'fetching', 'drafting', 'ready', 'failed', 'superseded')"));
        assert.ok(migration.includes("origin          TEXT CHECK (origin IN ('admin_create', 'wizard', 'redraft'))"));
    });
});
