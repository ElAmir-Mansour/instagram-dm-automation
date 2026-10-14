/**
 * The `dm.followup` handler, through the real runner (`drainJobs` with the real registry): what a drain does with the job an hour-old link left
 * in the queue (DM plan S9).
 *
 * The rules are `followup.test.ts`, the job's reads and sends are `followupJob.test.ts`; this pins the seam between them and the queue: a job that
 * finds the person has moved on ENDS AS DONE with nothing sent (the check at run time is the cancellation, so a reply needs no write to the job), a
 * send that works is sent once and completes, and a transient failure is the runner's to retry, the nudge given back each time.
 *
 * Times are relative to the real clock: the registry's handler uses it, as the drain does.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { FITNESS_EN } from '../services/profile/fixtures.js';
import { KITS } from '../services/profile/kits.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { handlers } from './handlers.js';
import { drainJobs } from './runner.js';
import { JOB_KINDS, type Job, type JobPayloads, type JobQueue } from './types.js';

type Row = Record<string, unknown>;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const HOUR = 3_600_000;
const SENDER = '17841400000000001';

/** The payload of a nudge for a link sent four hours ago. */
function payload(): JobPayloads['dm.followup'] {
    return {
        conversationId: 'conv-1', creatorId: 'creator-1', senderId: SENDER, offerId: 'plan', linkMessageId: 'msg-9', linkAt: new Date(Date.now() - 4 * HOUR).toISOString(),
    };
}

/** A conversation four hours after a link nobody answered or opened. */
function waiting(over: Row = {}): Row {
    const linkAt = new Date(Date.now() - 4 * HOUR);
    return {
        stage: 'link', sender_id: SENDER, is_bot_active: true, last_link_at: linkAt, last_inbound_at: new Date(linkAt.getTime() - 20_000),
        last_inbound_message_at: new Date(linkAt.getTime() - 30_000), followups_sent: 0, opted_out_at: null, handoff_at: null, agent_active: true, ...over,
    };
}

interface Drained {
    completed: string[];
    failed: { id: string; error: string; retryInSeconds: number | null }[];
    sends: { url: string; body: any }[];
    conv: Row;
}

/** One `dm.followup` job claimed and run by the real drain, against a conversation that changes as the claim and release statements change it. */
async function drained(conv: Row, send?: () => Promise<unknown>, attempts = 1): Promise<Drained> {
    const state: Row = { ...conv };
    const completed: string[] = [];
    const failed: Drained['failed'] = [];
    const sends: Drained['sends'] = [];
    let pending: Job[] = [{ id: 'job-1', kind: 'dm.followup', payload: payload(), attempts, max_attempts: 3, request_id: null, creator_id: 'creator-1', tenant_key: 'creator-1' }];
    const queue: JobQueue = {
        async enqueue() { return null; },
        async claim() { const batch = pending; pending = []; return batch; },
        async complete(id) { completed.push(id); },
        async fail(id, error, retryInSeconds) { failed.push({ id, error, retryInSeconds }); },
        async reapStale() { return 0; },
        async pruneCompleted() { return 0; },
    };
    const originalQuery = pool.query;
    const originalMeta = metaHttp.post;
    invalidateTenantCache();
    (pool as any).query = async (sql: string, params: any[] = []) => {
        const rows = (...r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM conversations c\s+WHERE c\.id = \$1/.test(sql)) return rows({ ...state });
        if (/FROM link_clicks lc/.test(sql)) return rows();
        if (/FROM ai_agents WHERE creator_id/.test(sql)) return rows({ sales_mode: 'on', sales_test_senders: [] });
        if (/FROM app_settings WHERE key/.test(sql)) return rows();
        if (/FROM creators WHERE id = \$1/.test(sql)) return rows({ id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: null, page_access_token: 'EAAGplaintext', is_active: true });
        if (/FROM creator_profiles/.test(sql)) return rows({ profile: throughJsonb(FITNESS_EN), version: 3, activated_at: null });
        if (/INSERT INTO rate_limit_counters|INSERT INTO app_rate_limit_counters/.test(sql)) return rows({ count: 1 });
        if (/SET followups_sent = followups_sent \+ 1/.test(sql)) {
            const lastInbound = state.last_inbound_at as Date | null;
            const won = Number(state.followups_sent) < params[2] && state.stage === 'link' && state.is_bot_active === true && state.opted_out_at === null
                && state.handoff_at === null && (lastInbound === null || lastInbound.getTime() <= (state.last_link_at as Date).getTime());
            if (won) { state.followups_sent = Number(state.followups_sent) + 1; state.stage = 'follow_up'; }
            return { rows: [], rowCount: won ? 1 : 0 };
        }
        if (/GREATEST\(followups_sent - 1, 0\)/.test(sql)) {
            if (state.stage === 'follow_up') { state.followups_sent = Number(state.followups_sent) - 1; state.stage = 'link'; }
            return { rows: [], rowCount: 1 };
        }
        if (/INSERT INTO messages/.test(sql)) return { rows: [], rowCount: 1 };
        throw new Error(`no result arranged for SQL:\n${sql}`);
    };
    (metaHttp as any).post = async (url: string, body: any) => { sends.push({ url, body }); return (send ?? (async () => ({ data: {} })))(); };
    try {
        await drainJobs({ queue, handlers, budgetMs: 60_000, batchSize: 1, random: () => 0.5 });
    } finally {
        (pool as any).query = originalQuery;
        (metaHttp as any).post = originalMeta;
        invalidateTenantCache();
    }
    return { completed, failed, sends, conv: state };
}

describe('the handler registry', () => {
    it('has a handler for every kind of job, and for nothing else: an enqueue for a kind with no handler would fail three times and sit in the table', () => {
        assert.deepEqual(Object.keys(handlers).sort(), [...JOB_KINDS].sort());
        assert.ok((JOB_KINDS as readonly string[]).includes('dm.followup'));
    });
});

describe('dm.followup through the drain', () => {
    it('a person who has not answered or opened the link gets the one nudge, and the job completes', async () => {
        const r = await drained(waiting());
        assert.deepEqual(r.completed, ['job-1']);
        assert.deepEqual(r.failed, []);
        assert.equal(r.sends.length, 1);
        assert.equal(r.sends[0]!.body.message.text, KITS.en.sales.lines.nudge);
        assert.equal(r.conv.followups_sent, 1);
        assert.equal(r.conv.stage, 'follow_up');
    });

    it('a person who replied before the job ran: nothing is sent and the job ENDS AS DONE, not failed and not retried (the check is the cancellation)', async () => {
        const linkAt = new Date(Date.now() - 4 * HOUR);
        const r = await drained(waiting({ last_inbound_at: new Date(linkAt.getTime() + 30 * 60_000) }));
        assert.deepEqual(r.completed, ['job-1']);
        assert.deepEqual(r.failed, []);
        assert.equal(r.sends.length, 0);
        assert.equal(r.conv.followups_sent, 0);
        assert.equal(r.conv.stage, 'link', 'the conversation was not touched');
    });

    it('a person who said stop, a hand-off and a paused bot likewise end as done with nothing sent', async () => {
        for (const over of [{ opted_out_at: new Date(), stage: 'closed' }, { handoff_at: new Date(), stage: 'handoff' }, { is_bot_active: false }]) {
            const r = await drained(waiting(over));
            assert.deepEqual(r.completed, ['job-1'], JSON.stringify(over));
            assert.equal(r.sends.length, 0, JSON.stringify(over));
        }
    });

    it('a job that runs a second time after it sent (a reaped claim, a manual retry) sends nothing: the first run counted the nudge', async () => {
        const first = await drained(waiting());
        assert.equal(first.sends.length, 1);
        const second = await drained(first.conv);
        assert.deepEqual(second.completed, ['job-1']);
        assert.equal(second.sends.length, 0);
        assert.equal(second.conv.followups_sent, 1);
    });

    it('a transient send failure is the runner\'s to retry (a backoff, the attempt counted), with the nudge given back so the retry can send it', async () => {
        const r = await drained(waiting(), async () => { throw new Error('socket hang up'); });
        assert.deepEqual(r.completed, []);
        assert.equal(r.failed.length, 1);
        assert.match(r.failed[0]!.error, /socket hang up/);
        assert.ok(r.failed[0]!.retryInSeconds !== null && r.failed[0]!.retryInSeconds > 0, 'a retry is scheduled');
        assert.equal(r.conv.followups_sent, 0);
        assert.equal(r.conv.stage, 'link');
        // And the retry, on the same conversation, sends it.
        const retry = await drained(r.conv, undefined, 2);
        assert.equal(retry.sends.length, 1);
        assert.deepEqual(retry.completed, ['job-1']);
    });

    it('Meta\'s final answer (a recipient who blocked DMs) is not retried: the job completes, nothing is counted', async () => {
        const r = await drained(waiting(), async () => { throw { response: { status: 400, data: { error: { code: 10903, message: 'blocked' } } } }; });
        assert.deepEqual(r.completed, ['job-1']);
        assert.deepEqual(r.failed, []);
        assert.equal(r.conv.followups_sent, 0);
    });
});
