/**
 * What the daily sweep forgets about onboarding (P31): events at 180 days, invites that expired long ago and were never used, and the
 * raw text a draft fetched. Three statements, three tables, and nothing else.
 *
 * Tested against a stand-in that holds all three tables, and a few others that must not move, and answers each statement by reading its
 * predicates OUT OF the SQL it is given: take `used_at IS NULL` out of the invite statement and a used invite from last year is deleted
 * here; take the status guard out of the draft statement and a draft still being made loses the text its next step reads; make `<` a `<=`
 * and a row exactly as old as the limit goes. The boundaries are decided in TypeScript (`onboardingCutoffs`) and handed over as a
 * parameter, so a boundary is something a test can set a row on either side of.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import {
    DRAFT_SOURCE_RETENTION_DAYS, EVENT_RETENTION_DAYS, EXPIRED_INVITE_GRACE_DAYS, ONBOARDING_PRUNE_BATCH, onboardingCutoffs, pruneOnboardingData,
    PRUNE_EVENTS_SQL, PRUNE_INVITES_SQL,
} from './onboardingRetention.js';
import { PRUNE_SOURCES_SQL } from './onboarding/draftStore.js';
import { DEFAULT_RETENTION_DEPS, runRetentionSweep } from './retention.js';
import { setLogSink } from '../utils/log.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const TENANT = '44444444-4444-4444-8444-444444444444';
const ago = (days: number, plusMs = 0): Date => new Date(NOW - days * DAY + plusMs);

interface EventRow { id: number; creator_id: string; at: Date }
interface InviteRow { id: string; creator_id: string; email: string | null; used_at: Date | null; revoked_at: Date | null; expires_at: Date }
interface DraftRow {
    id: string; creator_id: string; status: string; sources: unknown; sources_status: unknown; draft: unknown; error: string | null;
    created_at: Date; updated_at: Date; finished_at: Date | null;
}

let db: FakeDb;
let events: EventRow[];
let invites: InviteRow[];
let drafts: DraftRow[];
/** Tables the sweep must never touch, kept so a test can show they are as they were. */
let others: { onboarding: unknown[]; creator_profiles: unknown[]; scheduled_posts: unknown[] };
let logs: { level: string; event: string }[];
let restoreSink: (() => void) | undefined;

const flat = (sql: string): string => sql.replace(/\s+/g, ' ').trim();
const matches = (sql: string): RegExp => new RegExp(`^${flat(sql).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

beforeEach(() => {
    events = []; invites = []; drafts = [];
    others = { onboarding: [{ creator_id: OWNER, status: 'completed' }], creator_profiles: [{ creator_id: OWNER, version: 2 }], scheduled_posts: [{ id: 1 }] };
    logs = [];
    const previous = setLogSink((level, line) => { try { logs.push({ level, event: JSON.parse(line).event }); } catch { /* not structured */ } });
    restoreSink = () => setLogSink(previous);
    db = installFakeDb();

    db.routes.push([matches(PRUNE_EVENTS_SQL), ([cutoff, limit], sql) => {
        // Only the predicates the statement carries are applied, in the order it sorts by.
        const older = (r: EventRow) => (sql.includes('at < $1') ? r.at.getTime() < (cutoff as Date).getTime() : true);
        const doomed = events.filter(older).sort((a, b) => a.at.getTime() - b.at.getTime()).slice(0, limit).map((r) => r.id);
        events = events.filter((r) => !doomed.includes(r.id));
        return { rows: [], rowCount: doomed.length };
    }]);
    db.routes.push([matches(PRUNE_INVITES_SQL), ([cutoff, limit], sql) => {
        const keep = (r: InviteRow) => !(
            (sql.includes('used_at IS NULL') ? r.used_at === null : true)
            && (sql.includes('expires_at < $1') ? r.expires_at.getTime() < (cutoff as Date).getTime() : true)
        );
        const doomed = invites.filter((r) => !keep(r)).sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime()).slice(0, limit).map((r) => r.id);
        invites = invites.filter((r) => !doomed.includes(r.id));
        return { rows: [], rowCount: doomed.length };
    }]);
    db.routes.push([matches(PRUNE_SOURCES_SQL), ([cutoff, limit], sql) => {
        const when = (r: DraftRow) => (r.finished_at ?? r.created_at).getTime();
        const pick = (r: DraftRow) =>
            (sql.includes('sources IS NOT NULL') ? r.sources !== null : true)
            && (sql.includes("status NOT IN ('queued', 'fetching', 'drafting')") ? !['queued', 'fetching', 'drafting'].includes(r.status) : true)
            && (sql.includes('COALESCE(finished_at, created_at) < $1') ? when(r) < (cutoff as Date).getTime() : true);
        const doomed = drafts.filter(pick).sort((a, b) => when(a) - when(b)).slice(0, limit);
        // `SET sources = NULL` and nothing else: `updated_at` stays, as the statement leaves it.
        for (const r of doomed) r.sources = null;
        return { rows: [], rowCount: doomed.length };
    }]);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const event = (id: number, days: number, plusMs = 0, creator = TENANT) => events.push({ id, creator_id: creator, at: ago(days, plusMs) });
const invite = (id: string, over: Partial<InviteRow> & { expiredDays?: number; expiredPlusMs?: number }) => invites.push({
    id, creator_id: TENANT, email: 'person@example.com', used_at: null, revoked_at: null,
    expires_at: over.expires_at ?? ago(over.expiredDays ?? 0, over.expiredPlusMs ?? 0), ...(({ expiredDays, expiredPlusMs, expires_at, ...rest }) => rest)(over),
});
const draft = (id: string, over: Partial<DraftRow> & { finishedDaysAgo?: number | null; finishedPlusMs?: number; createdDaysAgo?: number }) => drafts.push({
    id, creator_id: TENANT, status: 'ready', sources: { ig: 'raw bio text', site: 'raw site text' }, sources_status: { ig: 'ok', site: 'ok' },
    draft: { fields: { niche: 'x' } }, error: null,
    created_at: ago(over.createdDaysAgo ?? 100), updated_at: ago(over.createdDaysAgo ?? 100),
    finished_at: over.finishedDaysAgo === null ? null : ago(over.finishedDaysAgo ?? 100, over.finishedPlusMs ?? 0),
    ...(({ finishedDaysAgo, finishedPlusMs, createdDaysAgo, ...rest }) => rest)(over),
});

describe('the cutoffs', () => {
    it('are the plan\'s numbers: 180 days for events, 30 for an expired invite, 30 for a draft\'s sources', () => {
        assert.deepEqual([EVENT_RETENTION_DAYS, EXPIRED_INVITE_GRACE_DAYS, DRAFT_SOURCE_RETENTION_DAYS], [180, 30, 30]);
        const cut = onboardingCutoffs(NOW);
        assert.equal(cut.events.getTime(), NOW - 180 * DAY);
        assert.equal(cut.invites.getTime(), NOW - 30 * DAY);
        assert.equal(cut.draftSources.getTime(), NOW - 30 * DAY);
    });
});

describe('events', () => {
    it('go at 180 days, and a row exactly that old is kept: the limit is "older than", not "as old as"', async () => {
        event(1, 365); event(2, 181); event(3, 180, -1); event(4, 180); event(5, 180, 1); event(6, 90); event(7, 0);
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.eventsDeleted, 3, 'a year, 181 days and a millisecond over 180');
        assert.deepEqual(events.map((e) => e.id).sort(), [4, 5, 6, 7], 'exactly 180 days, a millisecond under, 90 days and today');
    });

    it('treat every tenant alike, the owner\'s too: an old row goes, a new one stays', async () => {
        event(1, 400, 0, OWNER); event(2, 10, 0, OWNER); event(3, 400, 0, TENANT);
        await pruneOnboardingData(NOW);
        assert.deepEqual(events.map((e) => [e.id, e.creator_id]), [[2, OWNER]]);
    });

    it('are removed oldest first, a batch at a time, and say when more is waiting', async () => {
        for (let i = 0; i < ONBOARDING_PRUNE_BATCH + 5; i++) event(i + 1, 300 + (i % 7));
        const first = await pruneOnboardingData(NOW);
        assert.equal(first.eventsDeleted, ONBOARDING_PRUNE_BATCH);
        assert.equal(first.moreRemaining, true);
        assert.equal(events.length, 5);
        const second = await pruneOnboardingData(NOW);
        assert.equal(second.eventsDeleted, 5);
        assert.equal(second.moreRemaining, false);
        assert.equal(events.length, 0);
    });
});

describe('invites', () => {
    it('go once they are unused and expired for more than 30 days, and one exactly 30 days gone is kept', async () => {
        invite('old', { expiredDays: 60 });
        invite('just-over', { expiredDays: 30, expiredPlusMs: -1 });
        invite('exactly', { expiredDays: 30 });
        invite('grace', { expiredDays: 29 });
        invite('yesterday', { expiredDays: 1 });
        invite('pending', { expires_at: new Date(NOW + 5 * DAY) });
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.invitesDeleted, 2);
        assert.deepEqual(invites.map((i) => i.id).sort(), ['exactly', 'grace', 'pending', 'yesterday'].sort());
    });

    it('never delete one that was used, however long ago: it is the record of how a person came to hold their membership', async () => {
        invite('used-long-ago', { expiredDays: 400, used_at: ago(401) });
        invite('used-this-week', { expiredDays: 200, used_at: ago(205) });
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.invitesDeleted, 0);
        assert.equal(invites.length, 2);
    });

    it('leave a revoked link alone while it could still have been live, and take it with the rest once it has long expired', async () => {
        invite('revoked-live', { expires_at: new Date(NOW + 3 * DAY), revoked_at: ago(1) });
        invite('revoked-long-expired', { expiredDays: 45, revoked_at: ago(50) });
        await pruneOnboardingData(NOW);
        assert.deepEqual(invites.map((i) => i.id), ['revoked-live']);
    });
});

describe('draft sources', () => {
    it('are cleared 30 days after a draft finished, and the draft itself stays: its answers, its status, which sources worked, its cost', async () => {
        draft('d1', { finishedDaysAgo: 45, status: 'ready' });
        draft('d2', { finishedDaysAgo: 45, status: 'failed', error: 'timeout' });
        draft('d3', { finishedDaysAgo: 45, status: 'superseded' });
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.draftSourcesCleared, 3);
        assert.equal(drafts.length, 3, 'no draft row was deleted');
        for (const d of drafts) {
            assert.equal(d.sources, null, d.id);
            assert.deepEqual(d.sources_status, { ig: 'ok', site: 'ok' }, 'which sources worked is kept');
            assert.deepEqual(d.draft, { fields: { niche: 'x' } }, 'and what was drafted from them');
            assert.equal(d.updated_at.getTime(), ago(100).getTime(), 'housekeeping is not an edit');
        }
        assert.equal(drafts[1]!.error, 'timeout');
        assert.deepEqual(drafts.map((d) => d.status), ['ready', 'failed', 'superseded']);
    });

    it('wait for the 30th day: a draft that finished exactly 30 days ago, or 29, keeps its text', async () => {
        draft('over', { finishedDaysAgo: 30, finishedPlusMs: -1 });
        draft('exactly', { finishedDaysAgo: 30 });
        draft('inside', { finishedDaysAgo: 29 });
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.draftSourcesCleared, 1);
        assert.deepEqual(drafts.map((d) => [d.id, d.sources === null]), [['over', true], ['exactly', false], ['inside', false]]);
    });

    it('never touch a draft that is still being made, however old: its next step reads those sources', async () => {
        for (const status of ['queued', 'fetching', 'drafting']) draft(status, { status, finishedDaysAgo: null, createdDaysAgo: 90 });
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.draftSourcesCleared, 0);
        for (const d of drafts) assert.notEqual(d.sources, null, d.id);
    });

    it('measure a settled draft that never recorded a finish from when it was made', async () => {
        draft('no-finish-old', { finishedDaysAgo: null, createdDaysAgo: 40, status: 'failed' });
        draft('no-finish-new', { finishedDaysAgo: null, createdDaysAgo: 10, status: 'failed' });
        await pruneOnboardingData(NOW);
        assert.deepEqual(drafts.map((d) => [d.id, d.sources === null]), [['no-finish-old', true], ['no-finish-new', false]]);
    });

    it('do not count a draft that has no text left: running again clears nothing and says so', async () => {
        draft('d1', { finishedDaysAgo: 45 });
        assert.equal((await pruneOnboardingData(NOW)).draftSourcesCleared, 1);
        assert.equal((await pruneOnboardingData(NOW)).draftSourcesCleared, 0);
    });
});

describe('what it touches', () => {
    it('is three statements, each naming one table, and none of the tables a tenant\'s own data lives in', async () => {
        event(1, 400); invite('i', { expiredDays: 60 }); draft('d', { finishedDaysAgo: 60 });
        await pruneOnboardingData(NOW);
        const sent = db.statements.map((s) => s.sql);
        assert.equal(sent.length, 3);
        const tables = (sql: string) => [...new Set((sql.match(/\b(?:FROM|UPDATE|JOIN)\s+([a-z_]+)/gi) ?? []).map((m) => m.split(/\s+/)[1]!.toLowerCase()))];
        assert.deepEqual(sent.map(tables), [['onboarding_events'], ['invites'], ['profile_drafts']]);
        const text = sent.join('\n');
        for (const table of ['creators', 'creator_profiles', 'creator_profile_versions', 'studio_settings', 'growth_settings', 'scheduled_posts', 'media_uploads', 'jobs', 'users', 'memberships', 'ai_agents', 'voice_examples', 'campaigns']) {
            assert.doesNotMatch(text, new RegExp(`\\b${table}\\b`), table);
        }
        assert.doesNotMatch(text, /\bonboarding\s+(?:WHERE|SET)/i, 'not the onboarding table itself');
    });

    it('leaves the owner\'s onboarding row, profile and posts exactly as they were', async () => {
        event(1, 400, 0, OWNER); invite('i', { expiredDays: 60, creator_id: OWNER }); draft('d', { finishedDaysAgo: 60, creator_id: OWNER });
        const before = JSON.stringify(others);
        await pruneOnboardingData(NOW);
        assert.equal(JSON.stringify(others), before);
    });

    it('uses parameters for the cutoff and the batch, deletes only by id from a bounded, ordered select, and sets one column', () => {
        for (const sql of [PRUNE_EVENTS_SQL, PRUNE_INVITES_SQL, PRUNE_SOURCES_SQL]) {
            assert.match(flat(sql), /\$1/);
            assert.match(flat(sql), /LIMIT \$2/);
            assert.match(flat(sql), /ORDER BY/);
            assert.match(flat(sql), /WHERE id IN \( ?SELECT id FROM/);
            assert.doesNotMatch(sql, /\bNOW\(\)|INTERVAL/i, 'the clock is the caller\'s, so a test can set it');
        }
        assert.match(flat(PRUNE_SOURCES_SQL), /^UPDATE profile_drafts SET sources = NULL WHERE/);
        assert.doesNotMatch(PRUNE_SOURCES_SQL, /updated_at/);
    });

    it('does nothing and costs three statements on a database with nothing to forget', async () => {
        const result = await pruneOnboardingData(NOW);
        assert.deepEqual(result, { eventsDeleted: 0, invitesDeleted: 0, draftSourcesCleared: 0, moreRemaining: false });
        assert.equal(db.statements.length, 3);
        assert.deepEqual(logs, [], 'and says nothing');
    });
});

describe('failing', () => {
    it('never throws: a statement that fails is a log line, and the others still run', async () => {
        event(1, 400); draft('d', { finishedDaysAgo: 60 });
        db.routes.unshift([matches(PRUNE_INVITES_SQL), () => { throw new Error('canceling statement due to statement timeout'); }]);
        const result = await pruneOnboardingData(NOW);
        assert.equal(result.eventsDeleted, 1);
        assert.equal(result.invitesDeleted, 0);
        assert.equal(result.draftSourcesCleared, 1);
        assert.ok(logs.some((l) => l.event === 'retention.onboarding_prune_failed' && l.level === 'error'));
    });

    it('reads a database without v34 (no such table) as nothing to prune, silently', async () => {
        db.routes.unshift([/./, () => { throw Object.assign(new Error('relation "onboarding_events" does not exist'), { code: '42P01' }); }]);
        const result = await pruneOnboardingData(NOW);
        assert.deepEqual(result, { eventsDeleted: 0, invitesDeleted: 0, draftSourcesCleared: 0, moreRemaining: false });
        assert.deepEqual(logs, []);
    });
});

describe('in the daily sweep', () => {
    const quiet = {
        pruneRaw: async () => ({ cleared: 0, skipped: false }),
        pruneJobs: async () => ({ deleted: 0 }),
        pruneMedia: async () => ({ deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }),
        removeObjects: async () => ({ removed: 0, failed: 0, skipped: false as const }),
    };

    it('the real sweep has it', () => {
        assert.equal(typeof DEFAULT_RETENTION_DEPS.pruneOnboarding, 'function');
        assert.equal(DEFAULT_RETENTION_DEPS.pruneOnboarding, pruneOnboardingData);
    });

    it('runs once, after the passes and after the Storage objects, and its result is the sweep\'s', async () => {
        const order: string[] = [];
        const result = await runRetentionSweep({
            pruneRaw: async () => { order.push('raw'); return { cleared: order.length === 1 ? 5_000 : 0, skipped: false }; },
            pruneJobs: async () => { order.push('jobs'); return { deleted: 0 }; },
            pruneMedia: async () => { order.push('media'); return { deleted: 0 as const, skipped: true as const, reason: 'disabled' as const }; },
            removeObjects: async () => { order.push('objects'); return { removed: 0, failed: 0, skipped: false as const }; },
            pruneOnboarding: async () => { order.push('onboarding'); return { eventsDeleted: 4, invitesDeleted: 2, draftSourcesCleared: 1, moreRemaining: false }; },
        });
        assert.deepEqual(order, ['raw', 'jobs', 'media', 'raw', 'jobs', 'media', 'objects', 'onboarding'], 'two passes, then objects, then onboarding: once');
        assert.deepEqual(result.onboarding, { eventsDeleted: 4, invitesDeleted: 2, draftSourcesCleared: 1, moreRemaining: false });
    });

    it('is the sweep\'s own business whether it has anything: a quiet sweep reports zeros, and a sweep without it still runs', async () => {
        const without = await runRetentionSweep(quiet);
        assert.deepEqual(without.onboarding, { eventsDeleted: 0, invitesDeleted: 0, draftSourcesCleared: 0, moreRemaining: false });
        event(1, 400);
        const withIt = await runRetentionSweep({ ...quiet, pruneOnboarding: () => pruneOnboardingData(NOW) });
        assert.equal(withIt.onboarding.eventsDeleted, 1);
    });
});
