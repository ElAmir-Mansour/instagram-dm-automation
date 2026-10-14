/**
 * The DM funnel (docs/DM_SALES_PLAN.md S12): the counting, from fact rows worked out by hand.
 *
 * The rows below are what `DM_FUNNEL_CONVERSATIONS_SQL`, `DM_FUNNEL_CLICKS_SQL` and `DM_FUNNEL_REPLY_SQL` answer for the fixture world described
 * in `dmFunnelTestFixtures.ts`, and the expected numbers are that file's, counted by hand from the world and not by this code. The same numbers
 * are checked against the real statements on a real Postgres by `dmFunnel.sql.test.ts` (which needs a database and is skipped without one).
 *
 * What is pinned:
 *   - the counts, the rates and the reply times for 30 days and for 90, when one more conversation joins the cohort;
 *   - a visit that was a prefetch (a link-preview crawler, a HEAD request) is never a click, and a conversation whose only visits were
 *     prefetches has not clicked: the rule the mutation test breaks;
 *   - a step never exceeds the one before it, and `clicked` needs a link that was sent;
 *   - what was reached is read from the stage, the stages the replies remember and the columns a step sets;
 *   - the statements: every one binds the tenant as `$1`, none writes, the nudge is not a reply, the owner's own reply is not the bot's.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildDmFunnel, DM_FUNNEL_CLICKS_SQL, DM_FUNNEL_CONVERSATIONS_SQL, DM_FUNNEL_REPLY_SQL, DM_FUNNEL_STEP_IDS, DM_FUNNEL_WINDOWS,
    parseDmFunnelWindow, reachedOf,
    type ClickFact, type ConversationFact, type ReplyFact,
} from './dmFunnel.js';
import { EXPECTED_30, EXPECTED_90 } from './dmFunnelTestFixtures.js';

const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const when = (daysAgo: number): Date => new Date(NOW - daysAgo * DAY);

const fact = (id: string, over: Partial<ConversationFact> = {}): ConversationFact => ({
    id, stage: 'new', qualifier_turns: 0, links_sent: 0, last_link_at: null, followups_sent: 0, handoff_at: null, handoff_reason: null,
    opted_out_at: null, stages_seen: [], ...over,
});
const linked = { links_sent: 1, last_link_at: when(1) };

/** What the conversations statement answers for the fixture world (c12 is the one that began 40 days ago). */
const C1 = fact('c1');
const C2 = fact('c2', { stage: 'qualify', qualifier_turns: 1 });
const C3 = fact('c3', { stage: 'recommend', stages_seen: ['recommend'] });
const C4 = fact('c4', { stage: 'link', ...linked, stages_seen: ['link'] });
const C5 = fact('c5', { stage: 'follow_up', ...linked, followups_sent: 1, stages_seen: ['follow_up', 'link'] });
const C6 = fact('c6', { stage: 'link', ...linked, stages_seen: ['link'] });
const C7 = fact('c7', { stage: 'handoff', handoff_at: when(8), handoff_reason: 'refund', stages_seen: ['handoff'] });
const C8 = fact('c8', { stage: 'handoff', handoff_at: when(9), handoff_reason: 'complaint', stages_seen: ['handoff', 'objection', 'recommend'] });
const C9 = fact('c9', { stage: 'closed', opted_out_at: when(10), stages_seen: ['closed'] });
const C10 = fact('c10', { stage: 'link', ...linked, stages_seen: ['link'] });
const C12 = fact('c12', { stage: 'link', ...linked, stages_seen: ['link'] });

const COHORT_30 = [C1, C2, C3, C4, C5, C6, C7, C8, C9, C10];

/** The clicks statement's answer: grouped by conversation and by whether it was a person. c5 had previews only. */
const CLICKS_30: ClickFact[] = [
    { conversation_id: 'c5', is_prefetch: true, n: 2 },
    { conversation_id: 'c6', is_prefetch: false, n: 1 },
    { conversation_id: 'c6', is_prefetch: true, n: 1 },
    { conversation_id: 'c10', is_prefetch: false, n: 3 },
];
const CLICKS_90: ClickFact[] = [...CLICKS_30, { conversation_id: 'c12', is_prefetch: false, n: 1 }];

const REPLY_30: ReplyFact = { n: 11, p50_ms: 10000, p90_ms: 16000 };
const REPLY_90: ReplyFact = { n: 12, p50_ms: 10500, p90_ms: 19600 };

const withoutSince = ({ since: _since, ...rest }: ReturnType<typeof buildDmFunnel>) => rest;

describe('buildDmFunnel: the fixture world, counted by hand', () => {
    it('30 days: ten conversations, 7 qualified, 6 recommended, 4 with a link, 2 clicked, and the outcomes and rates beside them', () => {
        const funnel = buildDmFunnel(COHORT_30, CLICKS_30, REPLY_30, { days: 30, now: NOW });
        assert.deepEqual(withoutSince(funnel), EXPECTED_30);
    });

    it('90 days: the conversation that began 40 days ago joins, with its link and its click', () => {
        const funnel = buildDmFunnel([...COHORT_30, C12], CLICKS_90, REPLY_90, { days: 90, now: NOW });
        assert.deepEqual(withoutSince(funnel), EXPECTED_90);
    });

    it('names the window it counted: `since` is `days` before now', () => {
        for (const days of DM_FUNNEL_WINDOWS) {
            assert.equal(buildDmFunnel([], [], null, { days, now: NOW }).since, new Date(NOW - days * DAY).toISOString());
        }
    });

    it('the five steps are the plan\'s, in order, and only ever fall', () => {
        const funnel = buildDmFunnel(COHORT_30, CLICKS_30, REPLY_30, { days: 30, now: NOW });
        assert.deepEqual(funnel.steps.map((s) => s.id), [...DM_FUNNEL_STEP_IDS]);
        assert.deepEqual([...DM_FUNNEL_STEP_IDS], ['conversations', 'qualified', 'recommended', 'link_sent', 'clicked']);
        const counts = funnel.steps.map((s) => s.count);
        for (let i = 1; i < counts.length; i++) assert.ok(counts[i]! <= counts[i - 1]!, `${funnel.steps[i]!.id} <= ${funnel.steps[i - 1]!.id}`);
    });
});

describe('buildDmFunnel: a prefetch is not a click', () => {
    it('a conversation whose only visits were previews has not clicked, and the visits are counted on the side', () => {
        const funnel = buildDmFunnel([C5], [{ conversation_id: 'c5', is_prefetch: true, n: 2 }], null, { days: 30, now: NOW });
        assert.equal(funnel.steps.find((s) => s.id === 'clicked')!.count, 0);
        assert.deepEqual(funnel.clicks, { people: 0, human: 0, preview: 2 });
        assert.deepEqual(funnel.rates.click, { count: 0, of: 1, pct: 0 });
    });

    it('a person\'s visit among previews makes the conversation clicked, once, however many visits there were', () => {
        const funnel = buildDmFunnel(
            [C6],
            [{ conversation_id: 'c6', is_prefetch: false, n: 5 }, { conversation_id: 'c6', is_prefetch: true, n: 7 }],
            null, { days: 30, now: NOW }
        );
        assert.equal(funnel.steps.find((s) => s.id === 'clicked')!.count, 1);
        assert.deepEqual(funnel.clicks, { people: 1, human: 5, preview: 7 });
    });

    it('`is_prefetch` is read strictly: only TRUE is a preview, and a missing flag is not a reason to drop a person\'s click', () => {
        const funnel = buildDmFunnel([C6], [{ conversation_id: 'c6', is_prefetch: false, n: '2' }], null, { days: 30, now: NOW });
        assert.deepEqual(funnel.clicks, { people: 1, human: 2, preview: 0 }, 'a COUNT that arrives as text is still a count');
    });

    it('a click on a conversation that never had a link sent is not a click: the step needs the one before it', () => {
        const funnel = buildDmFunnel([C3], [{ conversation_id: 'c3', is_prefetch: false, n: 4 }], null, { days: 30, now: NOW });
        assert.equal(funnel.steps.find((s) => s.id === 'clicked')!.count, 0);
        assert.equal(funnel.steps.find((s) => s.id === 'link_sent')!.count, 0);
    });
});

describe('reachedOf: what a conversation got to', () => {
    const reached = (over: Partial<ConversationFact>, human = 0) => reachedOf(fact('x', over), human);
    const steps = (r: ReturnType<typeof reachedOf>) => [r.qualified, r.recommended, r.linked, r.clicked];

    it('a conversation that is only "new" got nowhere, and one that is "qualify" or has asked a question is qualified', () => {
        assert.deepEqual(steps(reached({})), [false, false, false, false]);
        assert.deepEqual(steps(reached({ stage: 'qualify' })), [true, false, false, false]);
        assert.deepEqual(steps(reached({ qualifier_turns: 2 })), [true, false, false, false], 'a question was asked, whatever the stage says now');
        assert.deepEqual(steps(reached({ qualifier_turns: '1' as unknown as number })), [true, false, false, false], 'a count that arrives as text');
    });

    it('recommend, objection, link and follow_up each imply the steps before them', () => {
        for (const stage of ['recommend', 'objection']) assert.deepEqual(steps(reached({ stage })), [true, true, false, false], stage);
        for (const stage of ['link', 'follow_up']) assert.deepEqual(steps(reached({ stage })), [true, true, true, false], stage);
    });

    it('the stages the replies remember count: a conversation that went on to a handoff or a close was still recommended', () => {
        assert.deepEqual(steps(reached({ stage: 'handoff', stages_seen: ['recommend', 'handoff'] })), [true, true, false, false]);
        assert.deepEqual(steps(reached({ stage: 'closed', stages_seen: ['qualify', 'closed'] })), [true, false, false, false]);
        assert.deepEqual(steps(reached({ stage: 'handoff', stages_seen: ['handoff'] })), [false, false, false, false], 'a handoff alone says nothing of the steps');
    });

    it('a link is evidenced by the columns written with the reply that carried it, whatever the stage became', () => {
        assert.equal(reached({ stage: 'objection', links_sent: 1 }).linked, true, 'offers_linked');
        assert.equal(reached({ stage: 'handoff', last_link_at: when(2) }).linked, true, 'last_link_at');
        assert.equal(reached({ stage: 'handoff', followups_sent: 1 }).linked, true, 'a nudge only follows a link');
        assert.equal(reached({ stage: 'recommend', links_sent: 0 }).linked, false);
    });

    it('clicked needs a link and a person\'s visit', () => {
        assert.equal(reached({ stage: 'link', ...linked }, 1).clicked, true);
        assert.equal(reached({ stage: 'link', ...linked }, 0).clicked, false);
        assert.equal(reached({ stage: 'recommend' }, 3).clicked, false);
    });

    it('the outcomes: a follow-up, a handoff, a close, an opt-out and a complaint, each from its own evidence', () => {
        assert.equal(reached({ followups_sent: 1 }).followedUp, true);
        assert.equal(reached({ stage: 'handoff', stages_seen: ['follow_up'] }).followedUp, true);
        assert.equal(reached({ handoff_at: when(1) }).handedOff, true, 'stamped, though the stage has since moved on (the AI was switched back on)');
        assert.equal(reached({ stage: 'handoff' }).handedOff, true);
        assert.equal(reached({ stage: 'closed' }).closed, true);
        assert.equal(reached({ opted_out_at: when(1) }).closed, true, 'an opt-out is a close');
        assert.equal(reached({ opted_out_at: when(1) }).optedOut, true);
        assert.equal(reached({ stage: 'closed' }).optedOut, false, 'a close for another reason is not an opt-out');
        assert.equal(reached({ handoff_reason: 'complaint' }).complaint, true);
        assert.equal(reached({ handoff_reason: 'refund' }).complaint, false);
    });

    it('missing or odd columns read as nothing, never as an error (a database behind a migration)', () => {
        const bare = { id: 'x' } as unknown as ConversationFact;
        assert.deepEqual(Object.values(reachedOf(bare, 0)), [false, false, false, false, false, false, false, false, false]);
        assert.equal(reachedOf({ ...bare, stage: 'nonsense', stages_seen: [null as unknown as string, 'link'] }, 0).linked, true);
    });
});

describe('buildDmFunnel: the edges', () => {
    it('an empty cohort is zeros, a null rate and no reply time, never a division by zero', () => {
        const funnel = buildDmFunnel([], [], null, { days: 7, now: NOW });
        assert.equal(funnel.conversations, 0);
        assert.deepEqual(funnel.steps.map((s) => [s.count, s.pct]), [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0]]);
        for (const rate of Object.values(funnel.rates)) assert.deepEqual(rate, { count: 0, of: 0, pct: null });
        assert.deepEqual(funnel.reply, { sample: 0, median_ms: null, p90_ms: null });
        assert.deepEqual(funnel.outcomes, { follow_up: 0, handoff: 0, closed: 0, opted_out: 0, complaints: 0 });
    });

    it('a reply statement that found nothing (the aggregate\'s one row of nulls) is no reply time', () => {
        const funnel = buildDmFunnel(COHORT_30, [], { n: 0, p50_ms: null, p90_ms: null }, { days: 30, now: NOW });
        assert.deepEqual(funnel.reply, { sample: 0, median_ms: null, p90_ms: null });
    });

    it('reply times arrive as floats or text and leave as whole milliseconds', () => {
        const funnel = buildDmFunnel([], [], { n: '3', p50_ms: '4499.6', p90_ms: 19600.000000000004 }, { days: 30, now: NOW });
        assert.deepEqual(funnel.reply, { sample: 3, median_ms: 4500, p90_ms: 19600 });
    });

    it('rates round to a whole percent and carry the numbers they are made of', () => {
        const funnel = buildDmFunnel([C3, C4, C4].map((c, i) => ({ ...c, id: `k${i}` })), [], null, { days: 30, now: NOW });
        assert.deepEqual(funnel.rates.link, { count: 2, of: 3, pct: 67 });
    });

    it('holds no conversation id, name or handle: counts and rates only', () => {
        const funnel = buildDmFunnel(COHORT_30, CLICKS_30, REPLY_30, { days: 30, now: NOW });
        const text = JSON.stringify(funnel);
        for (const f of [...COHORT_30, C12]) assert.equal(text.includes(`"${f.id}"`), false, f.id);
    });
});

describe('parseDmFunnelWindow', () => {
    it('is 7, 30 or 90, 30 when not asked, and nothing else', () => {
        assert.deepEqual(DM_FUNNEL_WINDOWS, [7, 30, 90]);
        assert.equal(parseDmFunnelWindow(undefined), 30);
        assert.equal(parseDmFunnelWindow(''), 30);
        assert.equal(parseDmFunnelWindow('7'), 7);
        assert.equal(parseDmFunnelWindow(90), 90);
        for (const bad of ['1', '0', '14', '365', '-7', '7.5', 'abc', ' ', ['7', '30'], { a: '7' }, true, NaN]) {
            assert.equal(parseDmFunnelWindow(bad), null, JSON.stringify(bad));
        }
    });
});

describe('the statements', () => {
    const flat = (sql: string): string => sql.replace(/\s+/g, ' ');
    const ALL = { conversations: DM_FUNNEL_CONVERSATIONS_SQL, clicks: DM_FUNNEL_CLICKS_SQL, reply: DM_FUNNEL_REPLY_SQL };

    it('bind the tenant as $1 and the start of the window as $2, and filter on the tenant\'s own conversations', () => {
        for (const [name, sql] of Object.entries(ALL)) {
            assert.match(flat(sql), /creator_id = \$1/, `${name} is scoped to the tenant`);
            assert.match(flat(sql), />= \$2/, `${name} is scoped to the window`);
            assert.ok(!/\$3/.test(sql), `${name} binds no more than two`);
        }
        assert.match(flat(DM_FUNNEL_CONVERSATIONS_SQL), /WHERE c\.creator_id = \$1 AND/);
        assert.match(flat(DM_FUNNEL_CLICKS_SQL), /WHERE tl\.creator_id = \$1 AND tl\.conversation_id IN \(SELECT c\.id FROM conversations c WHERE c\.creator_id = \$1/);
        assert.match(flat(DM_FUNNEL_REPLY_SQL), /JOIN conversations c ON c\.id = i\.conversation_id AND c\.creator_id = \$1/);
    });

    it('only read', () => {
        for (const [name, sql] of Object.entries(ALL)) assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)\b/i.test(sql), name);
    });

    it('the cohort is the conversations whose FIRST customer message is in the window, not the ones that merely have a row', () => {
        assert.match(flat(DM_FUNNEL_CONVERSATIONS_SQL), /\(SELECT MIN\(m\.created_at\) FROM messages m WHERE m\.conversation_id = c\.id AND m\.direction = 'inbound'\) >= \$2/);
        assert.match(flat(DM_FUNNEL_CLICKS_SQL), /\(SELECT MIN\(m\.created_at\) FROM messages m WHERE m\.conversation_id = c\.id AND m\.direction = 'inbound'\) >= \$2/);
    });

    it('the clicks come back grouped by `is_prefetch`, so the rule for what counts is in buildDmFunnel and nowhere else', () => {
        assert.match(flat(DM_FUNNEL_CLICKS_SQL), /GROUP BY tl\.conversation_id, lc\.is_prefetch/);
        // The column is selected and grouped by, and named nowhere else: a filter or a FILTER (WHERE …) on it would be a second, unseen rule.
        assert.equal((DM_FUNNEL_CLICKS_SQL.match(/is_prefetch/g) ?? []).length, 2);
    });

    it('the reply time is the bot\'s: the next outbound message counts only when sender = ai, and a follow-up nudge is not a reply', () => {
        const sql = flat(DM_FUNNEL_REPLY_SQL);
        assert.match(sql, /ORDER BY o\.created_at ASC LIMIT 1/);
        assert.match(sql, /\) nx ON nx\.sender = 'ai'/, 'the owner\'s own reply to a message is not the bot\'s time');
        assert.match(sql, /COALESCE\(o\.ai_meta ->> 'kind', ''\) <> 'followup'/);
        assert.match(sql, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY r\.ms\)/);
        assert.match(sql, /percentile_cont\(0\.9\) WITHIN GROUP \(ORDER BY r\.ms\)/);
    });
});
