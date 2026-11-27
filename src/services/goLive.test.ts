/**
 * The go-live checklist (`goLive.ts`, U3 SA-12) and its activation numbers.
 *
 * The database is the stand-in of `notifyTestSupport.ts` (the facts statement answers a row a test arranges). Pinned, because each is a
 * way a checklist lies or shows where it must not:
 *
 *   - NEVER FOR THE OWNER: the platform owner's workspace, a workspace with no onboarding (legacy), every role but the owner, a hidden
 *     checklist and one live for over three days all answer `{ show: false }` and nothing else, and the owner's own workspace reads
 *     nothing of its facts;
 *   - each item is done by ONE fact (a token, a queue row, an event), never by a click; items of a module that is off are not shown, and
 *     the optional ones never count toward "live";
 *   - the first read that finds the test comment, or everything done, writes `seen.test_comment` and `liveAt` ONCE, and records
 *     `golive_live` once; a later read changes neither;
 *   - the stored copy of the test comment outlives the pruned job;
 *   - a hidden doc, an unreadable doc and an unreadable module doc are never exceptions.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    evaluateItems, goLiveKey, isLive, LIVE_LINE_MS, parseGoLiveDoc, readGoLive, setDismissed, shouldShow,
    type GoLiveDoc, type GoLiveFacts,
} from './goLive.js';
import { invalidateModulesCache } from './modules.js';
import { NotifyWorld } from './notifyTestSupport.js';

const TENANT = 'tenant-company';
const EMPTY: GoLiveDoc = { v: 1, dismissedAt: null, liveAt: null, seen: {} };
const NOW = Date.parse('2026-11-28T12:00:00.000Z');
const who = (over: Partial<{ tenantId: string; isWorkspaceOwner: boolean; userId: string | null }> = {}) => ({ tenantId: TENANT, isWorkspaceOwner: true, userId: 'u-owner', ...over });

const FACTS: GoLiveFacts = {
    onboardingCompleted: false, onboardingCompletedAt: null, metaConnected: false, handle: null, testCommentReceived: false, testCommentAt: null,
    campaignOn: false, assistantTestedAt: null, members: 1, invitedAfterFirstMember: false, alertsChosen: false, whatsapp: false, youtube: false,
};
const ALL_DONE: GoLiveFacts = {
    ...FACTS, onboardingCompleted: true, onboardingCompletedAt: '2026-11-20T10:00:00.000Z', metaConnected: true, handle: 'acme', testCommentReceived: true, testCommentAt: '2026-11-21T10:00:00.000Z',
    campaignOn: true, assistantTestedAt: '2026-11-22T10:00:00.000Z', members: 2, alertsChosen: true,
};
const ROW = {
    onboarding_status: 'in_progress', onboarding_completed_at: null, meta_ok: false, instagram_username: '@acme', campaign_on: false, assistant_tested_at: null,
    members: 1, invited_after: false, whatsapp: false, youtube: false,
};

let world: NotifyWorld;
beforeEach(() => { world = new NotifyWorld(); world.install(); invalidateModulesCache(); });
afterEach(() => world.restore());

describe('the items (pure)', () => {
    it('lists the seven required items in order, each done by its own fact', () => {
        const none = evaluateItems(FACTS, EMPTY, null);
        assert.deepEqual(none.items.map((i) => [i.id, i.done]), [
            ['profile', false], ['meta', false], ['test_comment', false], ['first_reply_on', false], ['assistant_tested', false], ['team', false], ['alerts_chosen', false],
        ]);
        const all = evaluateItems(ALL_DONE, EMPTY, null);
        assert.ok(all.items.every((i) => i.done));
        assert.equal(isLive(all.items), true);
        assert.deepEqual(all.items.find((i) => i.id === 'meta')!.detail, { handle: 'acme' }, 'the handle, without its @');
        assert.equal(none.items.find((i) => i.id === 'meta')!.detail, null);
    });

    it('team is two people, or an invite made after the first joined; alerts_chosen is a routing row or a link (one fact)', () => {
        const team = (over: Partial<GoLiveFacts>) => evaluateItems({ ...FACTS, ...over }, EMPTY, null).items.find((i) => i.id === 'team')!.done;
        assert.deepEqual([team({}), team({ members: 2 }), team({ invitedAfterFirstMember: true })], [false, true, true]);
    });

    it('the test comment stays done from the stored copy once the job is pruned', () => {
        const doc: GoLiveDoc = { ...EMPTY, seen: { test_comment: '2026-11-21T10:00:00.000Z' } };
        const item = evaluateItems(FACTS, doc, null).items.find((i) => i.id === 'test_comment')!;
        assert.deepEqual([item.done, item.doneAt], [true, '2026-11-21T10:00:00.000Z']);
    });

    it('an item of a module that is off is not shown, and the others still are; optional items never count', () => {
        const company = new Set(['inbox', 'scheduler']);
        const items = evaluateItems(FACTS, EMPTY, company).items.map((i) => i.id);
        assert.deepEqual(items, ['profile', 'meta', 'team', 'alerts_chosen']);
        const noInbox = evaluateItems(FACTS, EMPTY, new Set(['keyword_replies'])).items.map((i) => i.id);
        assert.ok(!noInbox.includes('alerts_chosen') && noInbox.includes('test_comment'));
        const withWa = evaluateItems(FACTS, EMPTY, new Set(['inbox', 'whatsapp', 'youtube', 'scheduler']));
        assert.deepEqual(withWa.optional.map((o) => [o.id, o.done]), [['whatsapp', false], ['youtube', false]]);
        assert.equal(isLive(evaluateItems({ ...ALL_DONE, whatsapp: false }, EMPTY, new Set(['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'whatsapp'])).items), true, 'an optional item left undone does not hold it back');
        assert.equal(isLive([]), false, 'a list with nothing on it is not "live"');
    });

    it('shouldShow: only an owner of a non-legacy workspace that is neither hidden nor live for over three days', () => {
        const base = { owner: false, legacy: false, isWorkspaceOwner: true, doc: EMPTY, now: NOW };
        assert.equal(shouldShow(base), true);
        assert.equal(shouldShow({ ...base, owner: true }), false);
        assert.equal(shouldShow({ ...base, legacy: true }), false);
        assert.equal(shouldShow({ ...base, isWorkspaceOwner: false }), false);
        assert.equal(shouldShow({ ...base, doc: { ...EMPTY, dismissedAt: '2026-11-27T00:00:00.000Z' } }), false);
        assert.equal(shouldShow({ ...base, doc: { ...EMPTY, liveAt: new Date(NOW - LIVE_LINE_MS + 1000).toISOString() } }), true);
        assert.equal(shouldShow({ ...base, doc: { ...EMPTY, liveAt: new Date(NOW - LIVE_LINE_MS - 1000).toISOString() } }), false);
    });

    it('the stored doc is read leniently: garbage is "nothing happened yet"', () => {
        for (const raw of [null, '', 'nope', '[]', '{"dismissedAt":5}']) assert.deepEqual(parseGoLiveDoc(raw), EMPTY, String(raw));
        assert.deepEqual(parseGoLiveDoc('{"dismissedAt":"2026-11-27T00:00:00.000Z","liveAt":"bad","seen":{"test_comment":"2026-11-21T10:00:00.000Z"}}'),
            { v: 1, dismissedAt: '2026-11-27T00:00:00.000Z', liveAt: null, seen: { test_comment: '2026-11-21T10:00:00.000Z' } });
        assert.equal(goLiveKey('t-1'), 'golive.t-1');
        assert.throws(() => goLiveKey('a.b'));
    });
});

describe('readGoLive', () => {
    it('THE CHECKLIST NEVER SHOWS FOR THE OWNER: the platform owner\'s workspace answers { show: false } and reads none of its facts', async () => {
        world.owner = TENANT;
        world.goliveFacts = ROW;
        const answer = await readGoLive(who(), NOW);
        assert.deepEqual(answer, { show: false });
        assert.ok(!world.executed.some((s) => /onboarding_status/.test(s)), 'its facts are not even read');
        assert.deepEqual(world.writes, []);
    });

    it('a workspace with no onboarding row (legacy) answers { show: false }', async () => {
        world.goliveFacts = { ...ROW, onboarding_status: null };
        assert.deepEqual(await readGoLive(who(), NOW), { show: false });
        world.goliveFacts = null;
        assert.deepEqual(await readGoLive(who(), NOW), { show: false });
    });

    it('anyone who is not the workspace\'s owner gets { show: false } before anything is read', async () => {
        world.goliveFacts = ROW;
        assert.deepEqual(await readGoLive(who({ isWorkspaceOwner: false }), NOW), { show: false });
        assert.deepEqual(world.executed, []);
    });

    it('a hidden checklist answers { show: false } and reads no facts; a doc live for four days too', async () => {
        world.goliveFacts = ROW;
        world.settings[goLiveKey(TENANT)] = JSON.stringify({ v: 1, dismissedAt: '2026-11-27T00:00:00.000Z', liveAt: null, seen: {} });
        assert.deepEqual(await readGoLive(who(), NOW), { show: false });
        world.settings[goLiveKey(TENANT)] = JSON.stringify({ v: 1, dismissedAt: null, liveAt: new Date(NOW - 4 * 86_400_000).toISOString(), seen: {} });
        assert.deepEqual(await readGoLive(who(), NOW), { show: false });
        assert.ok(!world.executed.some((s) => /onboarding_status/.test(s)));
    });

    it('a new company workspace: the seven items, progress, the activation block, and nothing written', async () => {
        world.goliveFacts = { ...ROW, onboarding_status: 'invited' };
        world.activation = { invite_accepted_at: new Date(NOW - 60 * 60_000), first_dm: new Date(NOW - 48 * 60_000), first_ai: null, staff: 2 };
        const answer = await readGoLive(who(), NOW);
        assert.equal(answer.show, true);
        if (!answer.show) return;
        assert.deepEqual([answer.done, answer.total, answer.live, answer.liveAt, answer.dismissedAt], [0, 7, false, null, null]);
        assert.deepEqual(answer.activation.minutesToFirstDm, 12);
        assert.equal(answer.activation.staffFirstReplies, 2);
        assert.equal(answer.items.find((i) => i.id === 'meta')!.href, '#/settings?s=channels&card=meta');
        assert.deepEqual(world.writes, [], 'a read that finds nothing new writes nothing');
        assert.deepEqual(world.events, []);
    });

    it('the first read that finds the test comment stores it ONCE, and a later read does not rewrite it', async () => {
        world.goliveFacts = { ...ROW, onboarding_status: 'in_progress' };
        world.commentJobs = { count: 1, latest: new Date(NOW - 5 * 60_000) };
        const first = await readGoLive(who(), NOW);
        assert.equal(first.show && first.items.find((i) => i.id === 'test_comment')!.done, true);
        const doc = JSON.parse(world.settings[goLiveKey(TENANT)]!);
        assert.equal(doc.seen.test_comment, new Date(NOW - 5 * 60_000).toISOString());
        assert.equal(doc.liveAt, null, 'one item is not live');

        // The job is pruned: the stored copy keeps the item done, without asking the queue again.
        world.commentJobs = { count: 0, latest: null };
        world.executed.length = 0;
        world.writes.length = 0;
        const second = await readGoLive(who(), NOW + 3600_000);
        assert.equal(second.show && second.items.find((i) => i.id === 'test_comment')!.done, true);
        assert.ok(!world.executed.some((s) => /FROM jobs/.test(s)), 'the queue is not asked again once the proof is stored');
        assert.deepEqual(world.writes, [], 'and nothing is rewritten');
    });

    it('LIVE: when every required item is done it writes liveAt once and records golive_live once', async () => {
        world.goliveFacts = { ...ROW, onboarding_status: 'completed', onboarding_completed_at: new Date(NOW - 86_400_000), meta_ok: true, campaign_on: true, assistant_tested_at: new Date(NOW - 1000), members: 2 };
        world.commentJobs = { count: 2, latest: new Date(NOW - 5 * 60_000) };
        world.settings['notify.routing.' + TENANT] = JSON.stringify({ v: 1, handoff: [], hotLeads: [] });
        world.members = [{ userId: 'u-owner', email: 'o@c.test', role: 'owner' }];
        const first = await readGoLive(who(), NOW);
        assert.equal(first.show && first.live, true);
        const liveAt = JSON.parse(world.settings[goLiveKey(TENANT)]!).liveAt;
        assert.equal(liveAt, new Date(NOW).toISOString());
        assert.deepEqual(world.events.map((e) => e.event), ['golive_live']);

        const later = await readGoLive(who(), NOW + 3600_000);
        assert.equal(later.show && later.liveAt, liveAt, 'liveAt is set once');
        assert.deepEqual(world.events.map((e) => e.event), ['golive_live'], 'and the event is recorded once');
    });

    it('a module that is off is not on the card, and live is judged on what is shown', async () => {
        world.settings['tenant.modules.' + TENANT] = JSON.stringify({ v: 1, on: ['inbox', 'scheduler', 'results'], preset: 'custom', metaConnect: 'self' });
        world.goliveFacts = { ...ROW, onboarding_status: 'completed', onboarding_completed_at: new Date(NOW), meta_ok: true, members: 2 };
        world.members = [{ userId: 'u-owner', email: 'o@c.test', role: 'owner' }];
        world.settings['notify.routing.' + TENANT] = JSON.stringify({ v: 1, handoff: [], hotLeads: [] });
        const answer = await readGoLive(who(), NOW);
        assert.ok(answer.show);
        if (!answer.show) return;
        assert.deepEqual(answer.items.map((i) => i.id), ['profile', 'meta', 'team', 'alerts_chosen']);
        assert.equal(answer.live, true);
        assert.ok(!world.executed.some((s) => /FROM jobs/.test(s)), 'with keyword replies off the test comment is not asked about');
    });

    it('an unreadable modules doc is "everything on", never an exception', async () => {
        world.settings['tenant.modules.' + TENANT] = '{not json';
        world.goliveFacts = { ...ROW, onboarding_status: 'invited' };
        const answer = await readGoLive(who(), NOW);
        assert.ok(answer.show && answer.total === 7);
    });

    it('a write that fails is logged and never fails the read', async () => {
        world.goliveFacts = { ...ROW, onboarding_status: 'in_progress' };
        world.commentJobs = { count: 1, latest: new Date(NOW) };
        const original = world.settings;
        void original;
        const { pool } = await import('../config/db.js');
        const query = pool.query;
        (pool as any).query = async (sql: string, params: unknown[]) => {
            if (/INSERT INTO app_settings/.test(sql)) throw new Error('connection terminated');
            return (query as any).call(pool, sql, params);
        };
        try {
            const answer = await readGoLive(who(), NOW);
            assert.ok(answer.show);
        } finally {
            (pool as any).query = query;
        }
        assert.ok(world.logged.some((l) => l.event === 'golive.write_failed'));
    });
});

describe('hiding and showing again', () => {
    it('setDismissed hides with a time and shows again with null, keeping everything else', async () => {
        world.settings[goLiveKey(TENANT)] = JSON.stringify({ v: 1, dismissedAt: null, liveAt: '2026-11-25T10:00:00.000Z', seen: { test_comment: '2026-11-21T10:00:00.000Z' } });
        const at = await setDismissed(TENANT, true, 'u-owner', NOW);
        assert.equal(at, new Date(NOW).toISOString());
        const hidden = JSON.parse(world.settings[goLiveKey(TENANT)]!);
        assert.deepEqual([hidden.dismissedAt, hidden.liveAt, hidden.seen.test_comment], [at, '2026-11-25T10:00:00.000Z', '2026-11-21T10:00:00.000Z']);
        assert.equal(await setDismissed(TENANT, false, 'u-owner', NOW), null);
        assert.equal(JSON.parse(world.settings[goLiveKey(TENANT)]!).dismissedAt, null);
    });
});
