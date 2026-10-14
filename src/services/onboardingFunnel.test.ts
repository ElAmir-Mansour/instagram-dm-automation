/**
 * The onboarding funnel (P31): which tenants got from an invite to a finished setup, how far each went and how long it took.
 *
 * Two halves. `buildFunnel` is pure and is tested on events written out by hand, so every number in it can be checked with a pencil.
 * `loadFunnel` is two SELECTs, and is tested against a stand-in that holds a table of events and answers them by reading the cohort
 * predicate OUT OF the SQL it is given: take `HAVING MIN(at) >= $1` out of the production statement and a tenant from a year ago
 * walks into the 30-day funnel, and the test for it fails.
 *
 * What is pinned:
 *   - a stage's count is the tenants that reached it or went past it, so the counts only ever fall;
 *   - the cohort is the tenants whose FIRST event is in the window (so a window boundary is `>=`, and a slow tenant counts where it began);
 *   - medians are over the tenants that have both ends, and an even count takes the mean of the middle two;
 *   - abandoned is derived (not finished, quiet for more than a day) and never stored;
 *   - the answer has counts and durations and nothing that names a tenant.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import {
    ABANDONED_AFTER_MS, buildFunnel, FUNNEL_EVENTS_SQL, FUNNEL_STEP_TIMES_SQL, FUNNEL_WINDOWS, funnelSteps, loadFunnel, median, parseFunnelWindow,
    TARGET_OPEN_TO_COMPLETE_MS, type EventAggregate, type StepTime,
} from './onboardingFunnel.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-14T12:00:00.000Z');
const at = (msBeforeNow: number): Date => new Date(NOW - msBeforeNow);

const tenant = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One tenant's events, as the statement aggregates them: one row per event and step. */
function events(creator: string, list: Array<[event: string, step: string | null, when: Date, n?: number]>): EventAggregate[] {
    return list.map(([event, step, when, n]) => ({ creator_id: creator, event, step, first_at: when, last_at: when, n: n ?? 1 }));
}

describe('median', () => {
    it('is the middle value, the mean of the middle two for an even count, and null for none', () => {
        assert.equal(median([3, 1, 2]), 2);
        assert.equal(median([4, 1, 3, 2]), 3, '(2 + 3) / 2, rounded');
        assert.equal(median([10]), 10);
        assert.equal(median([]), null);
        assert.equal(median([NaN, 5, Infinity]), 5, 'only numbers count');
    });
});

describe('parseFunnelWindow', () => {
    it('is 30 or 90 days, 30 when not asked, and nothing else', () => {
        assert.deepEqual([...FUNNEL_WINDOWS], [30, 90]);
        assert.equal(parseFunnelWindow(undefined), 30);
        assert.equal(parseFunnelWindow(''), 30);
        assert.equal(parseFunnelWindow('30'), 30);
        assert.equal(parseFunnelWindow(90), 90);
        for (const bad of ['7', '0', '-30', '3650', '30; DROP TABLE x', 'abc', NaN, ['30'], {}]) assert.equal(parseFunnelWindow(bad), null, String(bad));
    });
});

describe('the stages', () => {
    const steps = ['about', 'voice', 'brand'];
    /** Four tenants at four different points. */
    const rows = [
        ...events(tenant(1), [['invite_created', null, at(5 * DAY)]]),
        ...events(tenant(2), [['invite_created', null, at(5 * DAY)], ['invite_opened', null, at(5 * DAY - MIN)]]),
        ...events(tenant(3), [
            ['invite_created', null, at(5 * DAY)], ['invite_opened', null, at(5 * DAY - MIN)], ['invite_accepted', null, at(5 * DAY - 2 * MIN)],
            ['step_viewed', 'about', at(5 * DAY - 3 * MIN)], ['step_completed', 'about', at(5 * DAY - 4 * MIN)], ['step_viewed', 'voice', at(5 * DAY - 4 * MIN)],
        ]),
        ...events(tenant(4), [
            ['invite_created', null, at(5 * DAY)], ['invite_opened', null, at(5 * DAY - MIN)], ['invite_accepted', null, at(5 * DAY - 2 * MIN)],
            ['step_viewed', 'about', at(5 * DAY - 3 * MIN)], ['step_completed', 'about', at(5 * DAY - 4 * MIN)], ['step_completed', 'voice', at(5 * DAY - 6 * MIN)],
            ['step_skipped', 'brand', at(5 * DAY - 7 * MIN)], ['wizard_completed', null, at(5 * DAY - 8 * MIN)],
        ]),
    ];
    const funnel = buildFunnel(rows, [], { days: 30, now: NOW, steps });

    it('place each tenant at the furthest point its events reach, and count those that reached it or went past it', () => {
        assert.equal(funnel.cohort, 4);
        assert.deepEqual(funnel.stages.map((s) => [s.id, s.reached]), [
            ['invited', 4], ['opened', 3], ['accepted', 2], ['about', 2], ['voice', 2], ['brand', 1], ['completed', 1],
        ]);
    });

    it('never rise from one stage to the next', () => {
        for (let i = 1; i < funnel.stages.length; i++) assert.ok(funnel.stages[i]!.reached <= funnel.stages[i - 1]!.reached, funnel.stages[i]!.id);
    });

    it('say what share of the cohort each is, rounded, and are not NaN for an empty window', () => {
        assert.deepEqual(funnel.stages.map((s) => s.pct), [100, 75, 50, 50, 50, 25, 25]);
        const empty = buildFunnel([], [], { days: 30, now: NOW, steps });
        assert.equal(empty.cohort, 0);
        assert.ok(empty.stages.every((s) => s.reached === 0 && s.pct === 0), 'zeros, not NaN');
        assert.deepEqual(empty.medians, { invite_to_open_ms: null, invite_to_accept_ms: null, open_to_complete_ms: null, accept_to_complete_ms: null });
        assert.equal(empty.completed + empty.abandoned + empty.in_progress, 0);
    });

    it('count a step as reached by a tenant that finished or skipped it without a view being written, and a tenant that went past it', () => {
        const skipOnly = buildFunnel(events(tenant(1), [['invite_created', null, at(DAY)], ['step_skipped', 'brand', at(DAY - MIN)]]), [], { days: 30, now: NOW, steps });
        assert.deepEqual(skipOnly.steps.map((s) => [s.step, s.reached]), [['about', 1], ['voice', 1], ['brand', 1]], 'reached, or gone past');
        const completedOnly = buildFunnel(events(tenant(1), [['wizard_completed', null, at(DAY)]]), [], { days: 30, now: NOW, steps });
        assert.deepEqual(completedOnly.stages.map((s) => s.reached), [1, 1, 1, 1, 1, 1, 1], 'completing is reaching every stage on the way');
    });

    it('follow the wizard\'s registry: a step that is switched on appears by itself, and a step nobody built does not', () => {
        assert.deepEqual(funnelSteps(), ['about', 'voice', 'brand']);
        const withConnect = buildFunnel(rows, [], { days: 30, now: NOW, steps: ['about', 'voice', 'brand', 'connect'] });
        assert.deepEqual(withConnect.stages.map((s) => s.id), ['invited', 'opened', 'accepted', 'about', 'voice', 'brand', 'connect', 'completed']);
        assert.equal(withConnect.stages.find((s) => s.id === 'connect')!.reached, 1, 'the tenant that completed is past it');
    });

    it('ignore an event for a step that is not in the registry, and a name that is not an event', () => {
        const odd = buildFunnel(events(tenant(1), [['invite_created', null, at(DAY)], ['step_viewed', 'nonsense', at(DAY)], ['start_without_waiting', null, at(DAY)]]), [], { days: 30, now: NOW, steps });
        assert.deepEqual(odd.stages.map((s) => s.reached), [1, 0, 0, 0, 0, 0, 0]);
    });
});

describe('the medians', () => {
    // Three tenants who opened after 1, 3 and 5 minutes, accepted after 2, 6 and 10, and finished 4, 8 and 20 minutes after opening.
    const rows = [1, 2, 3].flatMap((k) => {
        const open = [1, 3, 5][k - 1]! * MIN;
        const accept = [2, 6, 10][k - 1]! * MIN;
        const done = open + [4, 8, 20][k - 1]! * MIN;
        return events(tenant(k), [
            ['invite_created', null, at(10 * DAY)], ['invite_opened', null, at(10 * DAY - open)], ['invite_accepted', null, at(10 * DAY - accept)],
            ['wizard_completed', null, at(10 * DAY - done)],
        ]);
    });
    const funnel = buildFunnel(rows, [], { days: 30, now: NOW, steps: ['about', 'voice', 'brand'] });

    it('are over the tenants that have both ends', () => {
        assert.equal(funnel.medians.invite_to_open_ms, 3 * MIN);
        assert.equal(funnel.medians.invite_to_accept_ms, 6 * MIN);
        assert.equal(funnel.medians.open_to_complete_ms, 8 * MIN, 'the plan\'s target is five: the number to watch');
        assert.equal(funnel.medians.accept_to_complete_ms, 5 * MIN, 'completed minus accepted: 3, 5 and 15 minutes');
        assert.equal(funnel.target_open_to_complete_ms, TARGET_OPEN_TO_COMPLETE_MS);
        assert.equal(TARGET_OPEN_TO_COMPLETE_MS, 5 * MIN);
    });

    it('do not count a tenant that never took the step as zero', () => {
        const lone = buildFunnel([
            ...events(tenant(1), [['invite_created', null, at(DAY)], ['invite_opened', null, at(DAY - 4 * MIN)]]),
            ...events(tenant(2), [['invite_created', null, at(DAY)]]),
        ], [], { days: 30, now: NOW, steps: ['about'] });
        assert.equal(lone.medians.invite_to_open_ms, 4 * MIN, 'one tenant opened; the one that did not is not a zero');
        assert.equal(lone.medians.open_to_complete_ms, null);
    });

    it('take the mean of the middle two for an even number of tenants', () => {
        const two = [1, 2].flatMap((k) => events(tenant(k), [['invite_created', null, at(DAY)], ['invite_opened', null, at(DAY - [2, 6][k - 1]! * MIN)]]));
        assert.equal(buildFunnel(two, [], { days: 30, now: NOW, steps: [] }).medians.invite_to_open_ms, 4 * MIN);
    });

    it('ignore an end that came before its start, which is a clock and not a duration', () => {
        const odd = buildFunnel(events(tenant(1), [['invite_created', null, at(DAY)], ['invite_opened', null, at(DAY + MIN)]]), [], { days: 30, now: NOW, steps: [] });
        assert.equal(odd.medians.invite_to_open_ms, null);
    });

    it('per step, are the median of the time each Continue recorded, as a number the database may hand back as text', () => {
        const times: StepTime[] = [
            { step: 'about', ms: '60000' }, { step: 'about', ms: 120_000 }, { step: 'about', ms: 300_000 },
            { step: 'voice', ms: 30_000 }, { step: 'brand', ms: null }, { step: null, ms: 5 }, { step: 'about', ms: 'oops' },
        ];
        const funnel = buildFunnel(rows, times, { days: 30, now: NOW, steps: ['about', 'voice', 'brand'] });
        assert.deepEqual(funnel.steps.map((s) => [s.step, s.median_ms]), [['about', 120_000], ['voice', 30_000], ['brand', null]]);
    });
});

describe('the steps', () => {
    it('count how many pressed Continue and how many skipped, apart from how many arrived', () => {
        const steps = ['about', 'voice', 'brand'];
        const rows = [
            ...events(tenant(1), [['step_viewed', 'brand', at(DAY)], ['step_completed', 'brand', at(DAY)]]),
            ...events(tenant(2), [['step_viewed', 'brand', at(DAY)], ['step_skipped', 'brand', at(DAY)]]),
            ...events(tenant(3), [['step_viewed', 'brand', at(DAY)]]),
            ...events(tenant(4), [['step_viewed', 'about', at(DAY)]]),
        ];
        const brand = buildFunnel(rows, [], { days: 30, now: NOW, steps }).steps.find((s) => s.step === 'brand')!;
        assert.deepEqual({ reached: brand.reached, completed: brand.completed, skipped: brand.skipped }, { reached: 3, completed: 1, skipped: 1 });
    });
});

describe('abandoned', () => {
    const steps = ['about'];
    const last = (msAgo: number, finished = false) => events(tenant(1), [
        ['invite_created', null, at(msAgo + MIN)], ['step_viewed', 'about', at(msAgo)], ...(finished ? [['wizard_completed', null, at(msAgo)] as [string, string | null, Date]] : []),
    ]);

    it('is a tenant that did not finish and has made no move for more than a day: derived, never stored', () => {
        assert.equal(ABANDONED_AFTER_MS, DAY);
        const stale = buildFunnel(last(DAY + 1), [], { days: 30, now: NOW, steps });
        assert.deepEqual([stale.abandoned, stale.in_progress, stale.completed], [1, 0, 0]);
        const exactly = buildFunnel(last(DAY), [], { days: 30, now: NOW, steps });
        assert.deepEqual([exactly.abandoned, exactly.in_progress], [0, 1], 'a day to the millisecond is still in progress');
        const fresh = buildFunnel(last(HOUR), [], { days: 30, now: NOW, steps });
        assert.deepEqual([fresh.abandoned, fresh.in_progress], [0, 1]);
    });

    it('is never a tenant that finished, however long ago', () => {
        const done = buildFunnel(last(20 * DAY, true), [], { days: 30, now: NOW, steps });
        assert.deepEqual([done.completed, done.abandoned, done.in_progress], [1, 0, 0]);
    });

    it('partitions the cohort: every tenant is finished, abandoned or in progress, and one of those', () => {
        const rows = [...last(20 * DAY, true), ...events(tenant(2), [['invite_created', null, at(5 * DAY)]]), ...events(tenant(3), [['invite_created', null, at(HOUR)]])];
        const f = buildFunnel(rows, [], { days: 30, now: NOW, steps });
        assert.equal(f.cohort, 3);
        assert.deepEqual([f.completed, f.abandoned, f.in_progress], [1, 1, 1]);
    });
});

describe('the drafts', () => {
    it('counts the three moments, once each however many rows an event has', () => {
        const rows = events(tenant(1), [['draft_started', null, at(DAY), 2], ['draft_ready', null, at(DAY)], ['draft_failed', null, at(DAY), 3], ['invite_created', null, at(DAY)]]);
        assert.deepEqual(buildFunnel(rows, [], { days: 30, now: NOW, steps: [] }).drafts, { started: 2, ready: 1, failed: 3 });
    });

    it('do not move a tenant along the funnel: a draft is not a stage', () => {
        const f = buildFunnel(events(tenant(1), [['draft_ready', null, at(DAY)]]), [], { days: 30, now: NOW, steps: ['about'] });
        assert.deepEqual(f.stages.map((s) => s.reached), [1, 0, 0, 0, 0]);
    });
});

describe('what the funnel says', () => {
    it('is counts and durations: no tenant id, and nothing a person typed', () => {
        const rows = [...events(tenant(7), [['invite_created', null, at(DAY)], ['invite_opened', null, at(DAY - MIN)]]), ...events(tenant(8), [['invite_created', null, at(2 * DAY)]])];
        const text = JSON.stringify(buildFunnel(rows, [{ step: 'about', ms: 1000 }], { days: 90, now: NOW, steps: ['about'] }));
        assert.equal(text.includes(tenant(7)), false);
        assert.equal(text.includes(tenant(8)), false);
        assert.equal(/[a-z0-9]{8}-[a-z0-9]{4}-/.test(text), false, 'no uuid at all');
        assert.equal(JSON.parse(text).since, new Date(NOW - 90 * DAY).toISOString());
        assert.equal(JSON.parse(text).days, 90);
    });
});

// ─── The two statements ─────────────────────────────────────────────────────────────────────────

interface Row { creator_id: string; event: string; step: string | null; props: Record<string, unknown>; at: Date }

describe('loadFunnel', () => {
    let db: FakeDb;
    let table: Row[];
    beforeEach(() => {
        table = [];
        db = installFakeDb();
        const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
        /** The tenants the statement keeps: only if its text carries the cohort predicate, only with its operator, applied to `$1`. */
        const cohort = (sql: string, since: Date): Set<string> => {
            const all = [...new Set(table.map((r) => r.creator_id))];
            if (!sql.includes('HAVING MIN(at) >= $1')) return new Set(all);
            return new Set(all.filter((id) => Math.min(...table.filter((r) => r.creator_id === id).map((r) => r.at.getTime())) >= since.getTime()));
        };
        db.routes.push([new RegExp(`^${flat(FUNNEL_EVENTS_SQL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ([since], sql) => {
            const keep = cohort(sql, since);
            const groups = new Map<string, Row[]>();
            for (const r of table.filter((x) => keep.has(x.creator_id))) {
                const key = `${r.creator_id}|${r.event}|${r.step}`;
                groups.set(key, [...(groups.get(key) ?? []), r]);
            }
            return { rows: [...groups.values()].map((g) => ({
                creator_id: g[0]!.creator_id, event: g[0]!.event, step: g[0]!.step,
                first_at: new Date(Math.min(...g.map((r) => r.at.getTime()))), last_at: new Date(Math.max(...g.map((r) => r.at.getTime()))), n: g.length,
            })) };
        }]);
        db.routes.push([new RegExp(`^${flat(FUNNEL_STEP_TIMES_SQL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ([since], sql) => {
            const keep = cohort(sql, since);
            return { rows: table.filter((r) => keep.has(r.creator_id) && r.event === 'step_completed' && r.props.ms_on_step !== undefined && r.step !== null)
                .map((r) => ({ step: r.step, ms: String(r.props.ms_on_step) })) };
        }]);
    });
    afterEach(() => db.restore());

    const add = (creator: string, event: string, when: Date, step: string | null = null, props: Record<string, unknown> = {}) => table.push({ creator_id: creator, event, step, props, at: when });

    it('puts a tenant in the window its FIRST event is in, however long it then took', async () => {
        add(tenant(1), 'invite_created', at(20 * DAY));
        add(tenant(2), 'invite_created', at(60 * DAY));
        add(tenant(2), 'wizard_completed', at(DAY));
        add(tenant(3), 'invite_created', at(120 * DAY));
        const thirty = await loadFunnel(30, NOW);
        const ninety = await loadFunnel(90, NOW);
        assert.equal(thirty.cohort, 1);
        assert.equal(ninety.cohort, 2);
        assert.equal(ninety.completed, 1, 'a tenant invited 60 days ago who finished yesterday is a 90-day tenant that completed');
        assert.equal(thirty.completed, 0, 'and is no part of the 30-day cohort, as a completion with no invitation');
    });

    it('includes a tenant whose first event is exactly the window old, and not one a millisecond older', async () => {
        add(tenant(1), 'invite_created', new Date(NOW - 30 * DAY));
        add(tenant(2), 'invite_created', new Date(NOW - 30 * DAY - 1));
        assert.equal((await loadFunnel(30, NOW)).cohort, 1);
    });

    it('sends the cutoff as a parameter, and reads only onboarding_events', async () => {
        add(tenant(1), 'invite_created', at(DAY));
        await loadFunnel(30, NOW);
        const sent = db.statements.filter((s) => /onboarding_events/.test(s.sql));
        assert.equal(sent.length, 2);
        for (const s of sent) {
            assert.equal(s.params.length, 1);
            assert.equal((s.params[0] as Date).getTime(), NOW - 30 * DAY);
            assert.match(s.sql, /^SELECT /, 'read-only');
            assert.deepEqual([...new Set(s.sql.match(/\b(?:FROM|JOIN)\s+(\w+)/g) ?? [])].map((m) => m.split(/\s+/)[1]), ['onboarding_events']);
        }
    });

    it('measures a whole journey: the stages, the medians and the step time, from the rows', async () => {
        const t = tenant(1);
        add(t, 'invite_created', at(2 * DAY));
        add(t, 'invite_opened', new Date(NOW - 2 * DAY + 2 * MIN));
        add(t, 'invite_accepted', new Date(NOW - 2 * DAY + 3 * MIN));
        add(t, 'step_viewed', new Date(NOW - 2 * DAY + 4 * MIN), 'about');
        add(t, 'step_completed', new Date(NOW - 2 * DAY + 5 * MIN), 'about', { ms_on_step: 61_000 });
        add(t, 'wizard_completed', new Date(NOW - 2 * DAY + 7 * MIN), null, { by: 'tenant', total_ms: 240_000 });
        const f = await loadFunnel(30, NOW);
        assert.equal(f.stages.at(-1)!.reached, 1);
        assert.equal(f.medians.invite_to_open_ms, 2 * MIN);
        assert.equal(f.medians.open_to_complete_ms, 5 * MIN);
        assert.equal(f.steps[0]!.median_ms, 61_000);
        assert.deepEqual([f.completed, f.abandoned, f.in_progress], [1, 0, 0]);
    });

    it('answers an empty table with an empty funnel, not an error', async () => {
        const f = await loadFunnel(90, NOW);
        assert.equal(f.cohort, 0);
        assert.equal(f.stages[0]!.reached, 0);
    });
});
