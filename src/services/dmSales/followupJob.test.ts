/**
 * The follow-up nudge, scheduled and run (`followupJob.ts`, DM plan S9).
 *
 * Nothing here touches Postgres, Meta or the network. `pool.query` answers on the SQL it is handed (any statement a test did not arrange throws),
 * `metaHttp.post` is the Send API, and `setJobQueue` is the queue. That matters in this repository: `.env` holds live credentials, and a test that
 * reached the network could message a real customer.
 *
 * What is pinned, because each is a way a real person gets a message twice, gets one they should not, or never gets the one that was due:
 *
 *   - ONE job per link sent, due the operator's delay after it (four hours by default), deduped on the conversation and the link's message;
 *     scheduling never throws, so a failure to queue can never make the turn that sent the link run again and answer twice;
 *   - the job re-reads the conversation when it runs and asks the rules: a person who replied, clicked, said stop, was handed off or paused in the
 *     meantime is simply not eligible, and nothing is sent (nothing was cancelled, because nothing needed to be);
 *   - the nudge goes out EXACTLY once: the right to send is one conditional UPDATE made before the send, so two runs at once, or a retry after a
 *     success, send nothing the second time; a send that fails gives the claim back and is retried, unless Meta's answer is final;
 *   - the nudge is the kit's line in the tenant's language: no model, no link.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setJobQueue } from '../../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../../jobs/types.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { invalidateTenantCache } from '../tenant.js';
import { FITNESS_EN, SHOP_EG } from '../profile/fixtures.js';
import { KITS } from '../profile/kits.js';
import { throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile } from '../profile/types.js';
import { followupDedupeKey, followupRunAfter } from './followup.js';
import { getFollowupMinutes, isFinalSendFailure, loadFollowupState, loadLinkClicks, runFollowup, scheduleFollowup, type FollowupSchedule } from './followupJob.js';

type Row = Record<string, unknown>;
type Logged = { level: string; event: string; [k: string]: unknown };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const NOW = new Date('2026-10-14T13:00:00Z');
const LINK_AT = new Date('2026-10-14T09:00:00Z');
const SENDER = '17841400000000001';

const PAYLOAD = {
    conversationId: 'conv-1', creatorId: 'creator-1', senderId: SENDER, offerId: 'plan', linkMessageId: 'msg-9', linkAt: LINK_AT.toISOString(),
};

// ─── Scheduling ─────────────────────────────────────────────────────────────────────────────

/** `keyed` is the real queue's rule (`ON CONFLICT (dedupe_key) DO NOTHING`): a key already taken enqueues nothing. */
function recordingQueue(behaviour: 'ok' | 'dedupe' | 'throw' | 'keyed' = 'ok'): JobQueue & { calls: EnqueueInput[]; stored: EnqueueInput[] } {
    const calls: EnqueueInput[] = [];
    const stored: EnqueueInput[] = [];
    return {
        calls,
        stored,
        async enqueue(input) {
            calls.push(input as EnqueueInput);
            if (behaviour === 'throw') throw new Error('jobs table does not exist');
            if (behaviour === 'keyed') {
                if (input.dedupeKey && stored.some((job) => job.dedupeKey === input.dedupeKey)) return null;
                stored.push(input as EnqueueInput);
                return `job-${stored.length}`;
            }
            return behaviour === 'dedupe' ? null : 'job-1';
        },
        async claim() { return []; },
        async complete() {},
        async fail() {},
        async reapStale() { return 0; },
        async pruneCompleted() { return 0; },
    };
}

const SCHEDULE: FollowupSchedule = {
    creatorId: 'creator-1', conversationId: 'conv-1', senderId: SENDER, pageId: undefined, offerId: 'plan',
    recorded: { linkAt: LINK_AT, replyId: 'msg-9' },
};

/** `app_settings` answering for the delay key only: a saved value, or nothing (the default). */
async function scheduling<T>(saved: string | null | 'db-down', body: (queue: ReturnType<typeof recordingQueue>, logged: Logged[]) => Promise<T>, behaviour: 'ok' | 'dedupe' | 'throw' | 'keyed' = 'ok'): Promise<T> {
    const queue = recordingQueue(behaviour);
    const previousQueue = setJobQueue(queue);
    const originalQuery = pool.query;
    const logged: Logged[] = [];
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    (pool as any).query = async (sql: string, params: any[] = []) => {
        if (/FROM app_settings WHERE key/.test(sql) && params[0] === 'dm.sales.followup_minutes') {
            if (saved === 'db-down') throw new Error('connection terminated');
            return { rows: saved === null ? [] : [{ value: saved, is_secret: false }], rowCount: saved === null ? 0 : 1 };
        }
        throw new Error(`no result arranged for SQL:\n${sql}`);
    };
    try {
        return await body(queue, logged);
    } finally {
        (pool as any).query = originalQuery;
        setJobQueue(previousQueue);
        setLogSink(previousSink);
    }
}

describe('scheduleFollowup', () => {
    it('queues ONE dm.followup job for the link, due four hours after it by default, deduped on the conversation and the link\'s message', async () => {
        await scheduling(null, async (queue) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'scheduled');
            assert.equal(queue.calls.length, 1);
            const job = queue.calls[0]!;
            assert.equal(job.kind, 'dm.followup');
            assert.equal(job.dedupeKey, followupDedupeKey('conv-1', 'msg-9'));
            assert.equal(job.dedupeKey, 'dm-followup:conv-1:msg-9');
            assert.equal(job.creatorId, 'creator-1');
            assert.equal(job.runAfter?.toISOString(), '2026-10-14T13:00:00.000Z');
            assert.equal(job.runAfter?.getTime(), followupRunAfter(LINK_AT, 240).getTime());
            assert.deepEqual(job.payload, {
                conversationId: 'conv-1', creatorId: 'creator-1', senderId: SENDER, offerId: 'plan', linkMessageId: 'msg-9', linkAt: '2026-10-14T09:00:00.000Z',
            });
        });
    });

    it('carries the Facebook Page id of a Messenger conversation, and none for Instagram', async () => {
        await scheduling(null, async (queue) => {
            await scheduleFollowup({ ...SCHEDULE, pageId: 'fb-page-1' });
            assert.equal((queue.calls[0]!.payload as any).pageId, 'fb-page-1');
            await scheduleFollowup(SCHEDULE);
            assert.ok(!('pageId' in (queue.calls[1]!.payload as object)), 'no pageId key for Instagram');
        });
    });

    it('uses the operator\'s saved delay: ten minutes for the live test', async () => {
        await scheduling('10', async (queue) => {
            await scheduleFollowup(SCHEDULE);
            assert.equal(queue.calls[0]!.runAfter?.toISOString(), '2026-10-14T09:10:00.000Z');
        });
    });

    it('queues nothing when the operator switched follow-ups off (0)', async () => {
        await scheduling('0', async (queue) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'disabled');
            assert.equal(queue.calls.length, 0);
        });
    });

    it('answers a saved value it cannot read with the default, not with "off", and says so', async () => {
        await scheduling('four hours', async (queue, logged) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'scheduled');
            assert.equal(queue.calls[0]!.runAfter?.toISOString(), '2026-10-14T13:00:00.000Z');
            assert.ok(logged.some((l) => l.event === 'dm.followup_minutes_unreadable'));
        });
        await scheduling('99999', async (queue) => {
            await scheduleFollowup(SCHEDULE);
            assert.equal(queue.calls[0]!.runAfter?.toISOString(), '2026-10-14T13:00:00.000Z', 'out of range is unreadable too');
        });
    });

    it('scheduling the same link twice (a retried turn, a re-run recording) leaves ONE job: the queue refuses the second on its key', async () => {
        await scheduling(null, async (queue, logged) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'scheduled');
            assert.equal(await scheduleFollowup(SCHEDULE), 'deduped');
            assert.equal(queue.calls.length, 2, 'both were offered to the queue');
            assert.equal(queue.stored.length, 1, 'one job exists');
            assert.equal(queue.calls[0]!.dedupeKey, queue.calls[1]!.dedupeKey);
            assert.equal(logged.filter((l) => l.event === 'dm.followup_deduped').length, 1);
        }, 'keyed');
    });

    it('a different link in the same conversation is a different job (the handler\'s one-per-conversation rule is what stops a second nudge)', async () => {
        await scheduling(null, async (queue) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'scheduled');
            assert.equal(await scheduleFollowup({ ...SCHEDULE, recorded: { linkAt: new Date('2026-10-14T10:00:00Z'), replyId: 'msg-12' } }), 'scheduled');
            assert.equal(queue.stored.length, 2);
        }, 'keyed');
    });

    it('queues NOTHING for a WhatsApp conversation, however the rest is arranged, and says why (a free-form message hours later may be outside the window)', async () => {
        await scheduling(null, async (queue, logged) => {
            assert.equal(await scheduleFollowup({ ...SCHEDULE, senderId: 'EG.13491208655302741918', channel: 'whatsapp' }), 'unsupported_channel');
            assert.equal(queue.calls.length, 0);
            assert.equal(logged.find((l) => l.event === 'dm.followup_not_scheduled')?.reason, 'channel');
        });
    });

    it('does not put a channel in the payload of an Instagram or Messenger job: it is byte for byte what it was', async () => {
        await scheduling(null, async (queue) => {
            await scheduleFollowup(SCHEDULE);
            await scheduleFollowup({ ...SCHEDULE, pageId: 'fb-page-1' });
            for (const call of queue.calls) assert.ok(!('channel' in (call.payload as object)));
        });
    });

    it('queues nothing when the link was not recorded (the statement matched no conversation)', async () => {
        await scheduling(null, async (queue, logged) => {
            assert.equal(await scheduleFollowup({ ...SCHEDULE, recorded: { linkAt: null, replyId: null } }), 'unrecorded');
            assert.equal(await scheduleFollowup({ ...SCHEDULE, recorded: { linkAt: LINK_AT, replyId: null } }), 'unrecorded');
            assert.equal(await scheduleFollowup({ ...SCHEDULE, recorded: { linkAt: null, replyId: 'msg-9' } }), 'unrecorded');
            assert.equal(queue.calls.length, 0);
            assert.equal(logged.filter((l) => l.event === 'dm.followup_not_scheduled').length, 3);
        });
    });

    it('NEVER throws: a queue that fails, or a settings read that fails, costs the nudge and nothing else', async () => {
        await scheduling(null, async (_queue, logged) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'failed');
            assert.ok(logged.some((l) => l.event === 'dm.followup_schedule_failed' && l.level === 'warn'));
        }, 'throw');
        await scheduling('db-down', async (queue) => {
            assert.equal(await scheduleFollowup(SCHEDULE), 'failed');
            assert.equal(queue.calls.length, 0);
        });
    });
});

describe('getFollowupMinutes', () => {
    it('is the saved number, or four hours when nothing is saved', async () => {
        await scheduling(null, async () => { assert.equal(await getFollowupMinutes(), 240); });
        await scheduling('45', async () => { assert.equal(await getFollowupMinutes(), 45); });
        await scheduling('0', async () => { assert.equal(await getFollowupMinutes(), 0); });
        await scheduling('1320', async () => { assert.equal(await getFollowupMinutes(), 1320); });
    });
});

// ─── Running ────────────────────────────────────────────────────────────────────────────────

interface World {
    /** Overrides of the conversation row the job reads (and the claim and release statements change). */
    conv?: Row;
    /** The visits to the conversation's tracked links. */
    clicks?: { clicked_at: Date; is_prefetch: boolean }[];
    /** The `ai_agents` sales columns; null for no agent row. */
    agent?: { sales_mode: string; sales_test_senders: string[] } | null;
    /** The saved delay. */
    minutes?: string;
    profile?: CreatorProfile;
    /** The tenant row; null for none. */
    creator?: Row | null;
    conversationGone?: boolean;
    quotaCount?: number;
    send?: (url: string, body: any, call: number) => Promise<any>;
    /** The insert of the nudge's row in the thread fails. */
    recordFails?: boolean;
    /** The statement that gives the claim back fails. */
    releaseFails?: boolean;
    now?: Date;
}

const CONV: Row = {
    stage: 'link', sender_id: SENDER, is_bot_active: true, last_link_at: LINK_AT, last_inbound_at: new Date('2026-10-14T08:59:40Z'),
    last_inbound_message_at: new Date('2026-10-14T08:59:30Z'), followups_sent: 0, opted_out_at: null, handoff_at: null, agent_active: true,
};
const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext', is_active: true };

interface Run {
    executed: { sql: string; params: any[] }[];
    sends: { url: string; body: any }[];
    /** 'claim' and 'send', in the order they happened. */
    events: string[];
    logged: Logged[];
    conv: Row;
    outcome: Awaited<ReturnType<typeof runFollowup>> | null;
    error: any;
}

/** One or several runs against ONE world: the conversation row is shared and changes as the claim and release statements change it, as the database's would. */
async function running(world: World = {}, payloads: any[] = [PAYLOAD], concurrently = false): Promise<Run & { outcomes: Run['outcome'][]; errors: any[] }> {
    const profile = world.profile ?? FITNESS_EN;
    const conv: Row = { ...CONV, ...world.conv };
    const executed: Run['executed'] = [];
    const sends: Run['sends'] = [];
    const events: string[] = [];
    const logged: Logged[] = [];
    const agent = world.agent === undefined ? { sales_mode: 'on', sales_test_senders: [] } : world.agent;
    const creator = world.creator === undefined ? CREATOR : world.creator;
    let sendCalls = 0;
    invalidateTenantCache();

    const answer = (sql: string, params: any[]): { rows?: any[]; rowCount?: number } => {
        if (/FROM conversations c\s+WHERE c\.id = \$1/.test(sql)) return { rows: world.conversationGone ? [] : [{ ...conv }] };
        if (/FROM link_clicks lc/.test(sql)) return { rows: world.clicks ?? [] };
        if (/FROM ai_agents WHERE creator_id/.test(sql)) return { rows: agent ? [agent] : [] };
        if (/FROM app_settings WHERE key/.test(sql)) return { rows: params[0] === 'dm.sales.followup_minutes' && world.minutes !== undefined ? [{ value: world.minutes, is_secret: false }] : [] };
        if (/FROM creators WHERE id = \$1/.test(sql)) return { rows: creator ? [{ ...creator }] : [] };
        if (/FROM creator_profiles/.test(sql)) return { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] };
        if (/INSERT INTO rate_limit_counters/.test(sql)) return { rows: [{ count: world.quotaCount ?? 1 }] };
        if (/INSERT INTO app_rate_limit_counters/.test(sql)) return { rows: [{ count: 1 }] };
        if (/UPDATE conversations\s+SET followups_sent = followups_sent \+ 1/.test(sql)) {
            // The claim, as the statement says it: at most `$3` nudges, at the link, the bot on, no stop, no hand-off, nothing from them since the link.
            const lastInbound = conv.last_inbound_at as Date | null;
            const won = Number(conv.followups_sent) < params[2] && conv.stage === 'link' && conv.is_bot_active === true && conv.opted_out_at === null
                && conv.handoff_at === null && conv.last_link_at !== null && (lastInbound === null || lastInbound.getTime() <= (conv.last_link_at as Date).getTime());
            events.push('claim');
            if (won) { conv.followups_sent = Number(conv.followups_sent) + 1; conv.stage = 'follow_up'; }
            return { rows: [], rowCount: won ? 1 : 0 };
        }
        if (/GREATEST\(followups_sent - 1, 0\)/.test(sql)) {
            if (world.releaseFails) throw new Error('release failed');
            const owned = conv.stage === 'follow_up' && Number(conv.followups_sent) > 0;
            if (owned) { conv.followups_sent = Number(conv.followups_sent) - 1; conv.stage = 'link'; }
            return { rows: [], rowCount: owned ? 1 : 0 };
        }
        if (/INSERT INTO messages/.test(sql)) {
            if (world.recordFails) throw new Error('messages insert failed');
            return { rows: [], rowCount: 1 };
        }
        if (/UPDATE creators/.test(sql)) return { rows: [], rowCount: 1 };
        throw new Error(`no result arranged for SQL:\n${sql}`);
    };

    const originalQuery = pool.query;
    const originalMeta = metaHttp.post;
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const { rows = [], rowCount } = answer(sql, params);
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        events.push('send');
        sendCalls++;
        return (world.send ?? (async () => ({ data: { message_id: 'sent-1' } })))(url, body, sendCalls);
    };

    const outcomes: Run['outcome'][] = [];
    const errors: any[] = [];
    const one = async (payload: any): Promise<void> => {
        try {
            outcomes.push(await runFollowup(payload, { now: () => world.now ?? NOW }));
        } catch (err) {
            errors.push(err);
        }
    };
    try {
        if (concurrently) await Promise.all(payloads.map(one));
        else for (const payload of payloads) await one(payload);
    } finally {
        (pool as any).query = originalQuery;
        (metaHttp as any).post = originalMeta;
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { executed, sends, events, logged, conv, outcome: outcomes[0] ?? null, outcomes, error: errors[0] ?? null, errors };
}

const nudges = (r: { sends: Run['sends'] }): Run['sends'] => r.sends.filter((s) => s.body.message);
const claims = (r: { executed: Run['executed'] }): number => r.executed.filter((e) => /SET followups_sent = followups_sent \+ 1/.test(e.sql)).length;
const skipped = (r: { logged: Logged[] }): string[] => r.logged.filter((l) => l.event === 'dm.followup_skipped').map((l) => String(l.reason));

describe('runFollowup: a conversation that is still waiting gets the one nudge', () => {
    it('sends the kit\'s line, as text, to the person, through the Instagram endpoint, and records it as a follow-up', async () => {
        const r = await running();
        assert.deepEqual(r.outcome, { kind: 'sent' });
        assert.equal(r.error, null);

        assert.equal(nudges(r).length, 1, 'exactly one message');
        const sent = nudges(r)[0]!;
        assert.match(sent.url, /\/me\/messages$/);
        assert.equal(sent.body.recipient.id, SENDER);
        assert.equal(sent.body.messaging_type, 'RESPONSE');
        assert.deepEqual(Object.keys(sent.body.message), ['text'], 'plain text: no buttons, no card');
        assert.equal(sent.body.message.text, KITS.en.sales.lines.nudge);
        assert.ok(!/https?:\/\//.test(sent.body.message.text), 'no new link');

        // The thread shows it, as the bot's own row, marked as a follow-up.
        const insert = r.executed.find((e) => /INSERT INTO messages/.test(e.sql))!;
        assert.match(insert.sql, /'outbound', 'text', \$3, \$4::jsonb, 'ai', \$5::jsonb/);
        assert.deepEqual(insert.params.slice(0, 3), ['conv-1', 'creator-1', sent.body.message.text]);
        assert.deepEqual(JSON.parse(insert.params[4]), {
            kind: 'followup', engine: 'kit', stage: 'follow_up', next_action: 'reply', offer_id: 'plan', link_message_id: 'msg-9', delay_minutes: 240,
        });

        // The claim moved the conversation to follow_up and counted the nudge.
        assert.equal(r.conv.stage, 'follow_up');
        assert.equal(r.conv.followups_sent, 1);
        assert.ok(r.logged.some((l) => l.event === 'dm.followup_sent'));
    });

    it('claims the nudge BEFORE sending it, scoped to the conversation and its tenant, with the rules repeated in the statement', async () => {
        const r = await running();
        assert.deepEqual(r.events, ['claim', 'send']);

        const claim = r.executed.find((e) => /SET followups_sent = followups_sent \+ 1/.test(e.sql))!;
        const sql = claim.sql.replace(/\s+/g, ' ');
        assert.match(sql, /WHERE id = \$1 AND creator_id = \$2 AND followups_sent < \$3 AND stage = 'link' AND is_bot_active AND opted_out_at IS NULL AND handoff_at IS NULL/);
        assert.match(sql, /AND last_link_at IS NOT NULL AND \(last_inbound_at IS NULL OR last_inbound_at <= last_link_at\)/);
        assert.deepEqual(claim.params, ['conv-1', 'creator-1', 1]);
    });

    it('sends the Egyptian shop\'s nudge in its own register, from its profile', async () => {
        const r = await running({ profile: SHOP_EG });
        assert.equal(nudges(r).length, 1);
        assert.equal(nudges(r)[0]!.body.message.text, 'لو عندك أي سؤال عن الرابط اللي بعتناه ليك، يسعدنا نساعدك 🙏');
    });

    it('sends a Messenger conversation through its Page id', async () => {
        const r = await running({}, [{ ...PAYLOAD, pageId: 'fb-page-1' }]);
        assert.match(nudges(r)[0]!.url, /\/fb-page-1\/messages$/);
    });

    it('reads everything again when it runs: the conversation, the clicks, the mode and the delay, each scoped to the tenant', async () => {
        const r = await running();
        const facts = r.executed.find((e) => /FROM conversations c/.test(e.sql))!;
        assert.deepEqual(facts.params, ['conv-1', 'creator-1']);
        const clicks = r.executed.find((e) => /FROM link_clicks lc/.test(e.sql))!;
        assert.deepEqual(clicks.params, ['conv-1', 'creator-1']);
        assert.match(clicks.sql, /tl\.conversation_id = \$1 AND tl\.creator_id = \$2/);
        assert.ok(r.executed.some((e) => /FROM ai_agents WHERE creator_id = \$1/.test(e.sql)), 'the sales mode, now');
        assert.ok(r.executed.some((e) => /FROM app_settings WHERE key = \$1/.test(e.sql) && e.params[0] === 'dm.sales.followup_minutes'), 'the delay, now');
    });

    it('a link-preview fetch is not a click: the nudge still goes', async () => {
        const r = await running({ clicks: [{ clicked_at: new Date('2026-10-14T09:00:01Z'), is_prefetch: true }, { clicked_at: new Date('2026-10-14T09:00:02Z'), is_prefetch: true }] });
        assert.equal(nudges(r).length, 1);
    });

    it('test mode sends to a listed sender', async () => {
        const r = await running({ agent: { sales_mode: 'test', sales_test_senders: [SENDER] } });
        assert.equal(nudges(r).length, 1);
    });

    it('the last message of the person is the later of the stamp and the stored message: either alone is enough to open the window', async () => {
        const stampOnly = await running({ conv: { last_inbound_message_at: null } });
        assert.equal(nudges(stampOnly).length, 1);
        const messageOnly = await running({ conv: { last_inbound_at: null, last_inbound_message_at: new Date('2026-10-14T08:59:30Z') } });
        assert.equal(nudges(messageOnly).length, 1);
    });
});

describe('runFollowup: nothing is sent when the conversation has moved on (the job is the check, not a thing to cancel)', () => {
    const cases: { name: string; world: World; reason: string }[] = [
        { name: 'they replied (the stamp the sales turn keeps)', world: { conv: { last_inbound_at: new Date('2026-10-14T09:30:00Z') } }, reason: 'replied' },
        { name: 'they replied (their stored message, newer than the stamp)', world: { conv: { last_inbound_message_at: new Date('2026-10-14T10:15:00Z') } }, reason: 'replied' },
        { name: 'they clicked the link', world: { clicks: [{ clicked_at: new Date('2026-10-14T10:00:00Z'), is_prefetch: false }] }, reason: 'clicked' },
        { name: 'they clicked, among preview fetches', world: { clicks: [{ clicked_at: new Date('2026-10-14T09:00:01Z'), is_prefetch: true }, { clicked_at: new Date('2026-10-14T10:00:00Z'), is_prefetch: false }] }, reason: 'clicked' },
        { name: 'they opted out', world: { conv: { opted_out_at: new Date('2026-10-14T09:20:00Z'), stage: 'closed' } }, reason: 'opted_out' },
        { name: 'they were handed off', world: { conv: { handoff_at: new Date('2026-10-14T09:20:00Z'), stage: 'handoff', is_bot_active: false } }, reason: 'handoff' },
        { name: 'the AI was paused', world: { conv: { is_bot_active: false } }, reason: 'paused' },
        { name: 'the window closed (their last message 23 hours ago)', world: { conv: { last_inbound_at: new Date('2026-10-13T14:00:00Z'), last_inbound_message_at: new Date('2026-10-13T14:00:00Z') }, now: new Date('2026-10-14T13:00:00Z') }, reason: 'window_expired' },
        { name: 'sales mode was switched off', world: { agent: { sales_mode: 'off', sales_test_senders: [] } }, reason: 'sales_off' },
        { name: 'there is no agent row at all', world: { agent: null }, reason: 'sales_off' },
        { name: 'test mode, and this sender is not on the list', world: { agent: { sales_mode: 'test', sales_test_senders: ['17841400000000002'] } }, reason: 'sender_not_allowed' },
        { name: 'the operator turned follow-ups off', world: { minutes: '0' }, reason: 'disabled' },
        { name: 'the owner\'s agent was switched off', world: { conv: { agent_active: false } }, reason: 'agent_off' },
        { name: 'the nudge already went', world: { conv: { followups_sent: 1, stage: 'follow_up' } }, reason: 'already_nudged' },
        { name: 'the conversation is at another stage now', world: { conv: { stage: 'objection' } }, reason: 'stage' },
        { name: 'a newer link was sent: that link has its own job', world: { conv: { last_link_at: new Date('2026-10-14T10:30:00Z') } }, reason: 'newer_link' },
    ];
    for (const { name, world, reason } of cases) {
        it(`${name}: no message, no claim, ends as done (${reason})`, async () => {
            const r = await running(world);
            assert.equal(r.error, null, 'a normal return: the runner marks it done');
            assert.deepEqual(r.outcome, { kind: 'skipped', reason });
            assert.equal(nudges(r).length, 0);
            assert.equal(claims(r), 0, 'the claim is never made for a nudge that will not go');
            assert.ok(!r.executed.some((e) => /INSERT INTO messages/.test(e.sql)));
            assert.deepEqual(skipped(r), [reason]);
        });
    }

    it('the conversation was deleted: nothing, quietly', async () => {
        const r = await running({ conversationGone: true });
        assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'conversation_gone' });
        assert.equal(nudges(r).length, 0);
    });

    it('a tenant that is switched off, or has no Meta token, sends nothing', async () => {
        for (const creator of [{ ...CREATOR, is_active: false }, { ...CREATOR, page_access_token: null }, null]) {
            const r = await running({ creator });
            assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'not_connected' });
            assert.equal(nudges(r).length, 0);
            assert.equal(claims(r), 0);
        }
    });

    it('a payload with no readable link time sends nothing', async () => {
        const r = await running({}, [{ ...PAYLOAD, linkAt: 'yesterday-ish' }]);
        assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'bad_payload' });
        assert.equal(r.executed.length, 0, 'not even a read');
    });

    it('a job that names WhatsApp (none is ever written) sends nothing and reads nothing: an Instagram message is never sent to a WhatsApp user id', async () => {
        const r = await running({}, [{ ...PAYLOAD, senderId: 'EG.13491208655302741918', channel: 'whatsapp' }]);
        assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'channel' });
        assert.equal(nudges(r).length, 0);
        assert.equal(r.sends.length, 0);
        assert.equal(claims(r), 0);
        assert.equal(r.executed.length, 0, 'not even a read');
        assert.deepEqual(skipped(r), ['channel']);
    });

    it('a payload with NO channel, as every job queued before the field existed, is exactly what it was: Instagram, or Messenger with a Page id', async () => {
        assert.ok(!('channel' in PAYLOAD));
        const instagram = await running({}, [PAYLOAD]);
        assert.deepEqual(instagram.outcome, { kind: 'sent' });
        assert.match(nudges(instagram)[0]!.url, /\/me\/messages$/);
        const messenger = await running({}, [{ ...PAYLOAD, pageId: 'fb-page-1' }]);
        assert.deepEqual(messenger.outcome, { kind: 'sent' });
        assert.match(nudges(messenger)[0]!.url, /\/fb-page-1\/messages$/);
    });

    it('the send quota is spent: the nudge is the first thing to give way, and nothing is claimed', async () => {
        const r = await running({ quotaCount: 100000 });
        assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'quota' });
        assert.equal(nudges(r).length, 0);
        assert.equal(claims(r), 0);
    });
});

describe('runFollowup: exactly once', () => {
    it('running the job again after it sent sends nothing: the first run counted the nudge', async () => {
        const r = await running({}, [PAYLOAD, PAYLOAD]);
        assert.equal(nudges(r).length, 1);
        assert.deepEqual(r.outcomes, [{ kind: 'sent' }, { kind: 'skipped', reason: 'already_nudged' }]);
        assert.equal(r.conv.followups_sent, 1);
    });

    it('two runs at the same moment (two drains, a reaped claim) both pass the read, and only one wins the claim', async () => {
        const r = await running({}, [PAYLOAD, PAYLOAD], true);
        assert.equal(nudges(r).length, 1, 'one message');
        assert.equal(claims(r), 2, 'both reached the claim');
        assert.deepEqual(r.outcomes.map((o) => o?.kind === 'sent' ? 'sent' : (o as any)?.reason).sort(), ['claim_lost', 'sent']);
        assert.equal(r.conv.followups_sent, 1);
    });

    it('a person who writes between the read and the claim wins: the claim is refused and nothing is sent', async () => {
        // The read saw nobody reply; by the claim their message has landed (the stamp is newer than the link).
        const racing = await runWithLateReply();
        assert.equal(nudges(racing).length, 0);
        assert.deepEqual(racing.outcome, { kind: 'skipped', reason: 'claim_lost' });
    });

    it('the claim never exceeds one nudge per conversation, whatever the job count', async () => {
        const r = await running({}, [PAYLOAD, { ...PAYLOAD, linkMessageId: 'msg-10' }, { ...PAYLOAD, linkMessageId: 'msg-11' }]);
        assert.equal(nudges(r).length, 1);
    });
});

/** A world where the person's message lands after the job's read and before its claim. */
async function runWithLateReply() {
    const conv: Row = { ...CONV };
    const executed: Run['executed'] = [];
    const sends: Run['sends'] = [];
    const logged: Logged[] = [];
    const originalQuery = pool.query;
    const originalMeta = metaHttp.post;
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    invalidateTenantCache();
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        if (/FROM conversations c\s+WHERE c\.id = \$1/.test(sql)) {
            const row = { ...conv };
            conv.last_inbound_at = new Date('2026-10-14T12:59:00Z'); // they write right after the read
            return { rows: [row], rowCount: 1 };
        }
        if (/FROM link_clicks lc/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM ai_agents WHERE creator_id/.test(sql)) return { rows: [{ sales_mode: 'on', sales_test_senders: [] }], rowCount: 1 };
        if (/FROM app_settings WHERE key/.test(sql)) return { rows: [], rowCount: 0 };
        if (/FROM creators WHERE id = \$1/.test(sql)) return { rows: [{ ...CREATOR }], rowCount: 1 };
        if (/FROM creator_profiles/.test(sql)) return { rows: [{ profile: throughJsonb(FITNESS_EN), version: 3, activated_at: null }], rowCount: 1 };
        if (/INSERT INTO rate_limit_counters|INSERT INTO app_rate_limit_counters/.test(sql)) return { rows: [{ count: 1 }], rowCount: 1 };
        if (/UPDATE conversations\s+SET followups_sent = followups_sent \+ 1/.test(sql)) {
            const lastInbound = conv.last_inbound_at as Date | null;
            const won = lastInbound === null || lastInbound.getTime() <= (conv.last_link_at as Date).getTime();
            return { rows: [], rowCount: won ? 1 : 0 };
        }
        throw new Error(`no result arranged for SQL:\n${sql}`);
    };
    (metaHttp as any).post = async (url: string, body: any) => { sends.push({ url, body }); return { data: {} }; };
    let outcome: Run['outcome'] = null;
    try {
        outcome = await runFollowup(PAYLOAD, { now: () => NOW });
    } finally {
        (pool as any).query = originalQuery;
        (metaHttp as any).post = originalMeta;
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { executed, sends, logged, outcome };
}

describe('runFollowup: when the send fails', () => {
    const failing = (error: any) => async () => { throw error; };

    it('a transient failure gives the claim back and is re-raised, so the runner retries: the person is not nudged and the nudge is not lost', async () => {
        const r = await running({ send: failing(new Error('socket hang up')) });
        assert.equal(r.outcome, null);
        assert.match(String(r.error?.message), /socket hang up/);
        assert.equal(r.conv.followups_sent, 0, 'the nudge was not sent, so it is not counted');
        assert.equal(r.conv.stage, 'link');
        assert.ok(!r.executed.some((e) => /INSERT INTO messages/.test(e.sql)), 'nothing in the thread');
        assert.ok(r.logged.some((l) => l.event === 'dm.followup_send_failed'));
    });

    it('and the retry then sends it, once', async () => {
        let calls = 0;
        const world: World = { send: async () => { calls++; if (calls === 1) throw new Error('socket hang up'); return { data: {} }; } };
        const r = await running(world, [PAYLOAD, PAYLOAD]);
        assert.equal(r.errors.length, 1);
        assert.deepEqual(r.outcomes, [{ kind: 'sent' }]);
        assert.equal(r.conv.followups_sent, 1);
    });

    for (const [name, error] of [
        ['a dead token (190)', { response: { status: 400, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } }],
        ['a recipient who blocked DMs (10903)', { response: { status: 400, data: { error: { code: 10903, message: 'blocked' } } } }],
        ['outside the allowed window (10)', { response: { status: 400, data: { error: { code: 10, error_subcode: 2534022, message: 'outside of allowed window' } } } }],
        ['a recipient that is not valid (100)', { response: { status: 400, data: { error: { code: 100, message: 'No matching user found' } } } }],
    ] as const) {
        it(`${name}: Meta's answer is final: the claim is given back, nothing is re-raised, no retry`, async () => {
            const r = await running({ send: failing(error) });
            assert.equal(r.error, null, 'a normal return: retrying would only repeat it');
            assert.deepEqual(r.outcome, { kind: 'skipped', reason: 'send_refused' });
            assert.equal(r.conv.followups_sent, 0);
            assert.ok(r.logged.some((l) => l.event === 'dm.followup_failed' && l.level === 'error'));
        });
    }

    it('classifies Meta\'s answers: the permanent ones, 10 and 100 are final; a 5xx, a timeout and a bare error are not', () => {
        const meta = (code: number) => ({ metaCode: code });
        for (const code of [190, 200, 10903, 10, 100]) assert.equal(isFinalSendFailure(meta(code)), true, String(code));
        for (const err of [meta(1), meta(2), meta(613), { response: { status: 503 } }, { code: 'ECONNRESET' }, new Error('boom'), null, undefined]) {
            assert.equal(isFinalSendFailure(err), false, JSON.stringify(err) ?? String(err));
        }
    });

    it('a failure to give the claim back does not hide the send\'s own error', async () => {
        // The release statement fails: the claim stays taken (no nudge, never two), and the runner still sees the send's error.
        const r = await running({ send: failing(new Error('socket hang up')), releaseFails: true });
        assert.match(String(r.error?.message), /socket hang up/);
        assert.equal(r.conv.followups_sent, 1, 'still claimed: a second nudge is impossible');
        assert.ok(r.logged.some((l) => l.event === 'dm.followup_release_failed' && l.level === 'error'));
    });
});

describe('runFollowup: the nudge is out; the thread\'s own record is secondary', () => {
    it('a failure to write the row in the thread is logged and NOT raised: a retry would find the claim taken and send nothing', async () => {
        const r = await running({ recordFails: true });
        assert.equal(r.error, null);
        assert.deepEqual(r.outcome, { kind: 'sent' });
        assert.equal(nudges(r).length, 1);
        assert.ok(r.logged.some((l) => l.event === 'dm.followup_record_failed' && l.level === 'error'));
        assert.equal(r.conv.followups_sent, 1);
    });
});

describe('loadFollowupState and loadLinkClicks', () => {
    const answering = (rows: any[]) => {
        const asked: { sql: string; params: any[] }[] = [];
        (pool as any).query = async (sql: string, params: any[] = []) => { asked.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows, rowCount: rows.length }; };
        return asked;
    };
    const original = pool.query;
    const restore = () => { (pool as any).query = original; };

    it('is scoped to the tenant, and reads a stage it does not know as the start', async () => {
        const asked = answering([{ ...CONV, stage: 'sold' }]);
        try {
            const state = await loadFollowupState('conv-1', 'creator-1');
            assert.equal(state?.stage, 'new');
            assert.match(asked[0]!.sql, /WHERE c\.id = \$1 AND c\.creator_id = \$2$/);
            assert.deepEqual(asked[0]!.params, ['conv-1', 'creator-1']);
        } finally { restore(); }
    });

    it('is null for a conversation that is not there (or is another tenant\'s)', async () => {
        answering([]);
        try { assert.equal(await loadFollowupState('gone', 'creator-1'), null); } finally { restore(); }
    });

    it('takes the later of the two times the person last wrote, from either alone, and a missing agent row as an agent that is off', async () => {
        const early = new Date('2026-10-14T08:00:00Z');
        const late = new Date('2026-10-14T08:30:00Z');
        try {
            answering([{ ...CONV, last_inbound_at: early, last_inbound_message_at: late }]);
            assert.equal((await loadFollowupState('c', 't'))?.lastInboundAt?.toISOString(), late.toISOString());
            answering([{ ...CONV, last_inbound_at: late, last_inbound_message_at: early }]);
            assert.equal((await loadFollowupState('c', 't'))?.lastInboundAt?.toISOString(), late.toISOString());
            answering([{ ...CONV, last_inbound_at: null, last_inbound_message_at: null }]);
            assert.equal((await loadFollowupState('c', 't'))?.lastInboundAt, null);
            answering([{ ...CONV, agent_active: null }]);
            assert.equal((await loadFollowupState('c', 't'))?.agentActive, false);
        } finally { restore(); }
    });

    it('lists a person\'s click ahead of preview fetches, and caps the list: a crawler\'s fifty hits cannot hide one tap', async () => {
        const asked = answering([{ clicked_at: new Date('2026-10-14T10:00:00Z'), is_prefetch: false }, { clicked_at: new Date('2026-10-14T09:00:01Z'), is_prefetch: true }]);
        try {
            const clicks = await loadLinkClicks('conv-1', 'creator-1');
            assert.deepEqual(clicks.map((c) => c.isPrefetch), [false, true]);
            assert.match(asked[0]!.sql, /ORDER BY lc\.is_prefetch ASC, lc\.clicked_at DESC LIMIT 20/);
            assert.match(asked[0]!.sql, /JOIN tracked_links tl ON tl\.code = lc\.code WHERE tl\.conversation_id = \$1 AND tl\.creator_id = \$2/);
        } finally { restore(); }
    });
});
