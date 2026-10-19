/**
 * What the inbox shows beyond the messages themselves (`inboxDetail.ts`): the sender's profile as the list reads it, which model
 * answered, and whether a reply is failing.
 *
 * The facts are read-side and optional. The tests that matter most say what the answer is when a fact is NOT available: a database
 * behind a migration, a table that is not there, a job the queue has already pruned. The message list is never held hostage to a nicety.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import {
    annotateMessages, conversationView, countOf, deliveryOf, dmJobKey, loadMessageExtras, metaCodeOf, NO_EXTRAS, profilePicOf,
    profileView, USAGE_MATCH_WINDOW_SECONDS, type JobFacts, type MessageExtras,
} from './inboxDetail.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
let logged: string[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

describe('the numbers and links a row hands back', () => {
    it('countOf is a non-negative whole number, from a number or the string `pg` gives a bigint, and nothing else', () => {
        assert.equal(countOf(27), 27);
        assert.equal(countOf('27'), 27);
        assert.equal(countOf(0), 0);
        for (const bad of [-1, 1.5, NaN, Infinity, '', ' ', 'abc', null, undefined, {}, [], true]) assert.equal(countOf(bad), null, String(bad));
    });

    it('profilePicOf keeps only an http(s) URL: it goes into an <img src>', () => {
        assert.equal(profilePicOf(' https://cdn.example.test/a.jpg '), 'https://cdn.example.test/a.jpg');
        assert.equal(profilePicOf('HTTP://cdn.example.test/a.jpg'), 'HTTP://cdn.example.test/a.jpg');
        for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAA', '//cdn.test/a', '/a.png', '', null, 5]) assert.equal(profilePicOf(bad), null, String(bad));
    });

    it('profileView answers null for every column a database without v40 does not have', () => {
        assert.deepEqual(profileView({ id: 'a' }), {
            username: null, profile_name: null, profile_pic_url: null, follower_count: null, is_user_follow_business: null,
            is_business_follow_user: null, is_verified_user: null, profile_fetched_at: null, profile_checked_at: null,
        });
        assert.equal(profileView({ profile_name: '   ' }).profile_name, null, 'a blank name is no name');
        assert.equal(profileView({ is_verified_user: 'true' }).is_verified_user, null, 'a flag is a boolean or nothing');
        assert.equal(profileView({ is_verified_user: false }).is_verified_user, false, 'and false is an answer');
    });

    it('conversationView keeps the row, pins the platform, and types every field the detail view reads', () => {
        const view = conversationView({
            id: 'c1', is_bot_active: true, instagram_user_id: '9', last_message_text: 'x',
            profile_name: 'Sam', profile_pic_url: 'javascript:alert(1)', follower_count: 12, message_count: '27',
            last_message_type: 'carousel', last_message_cards: '2', last_message_card_title: 'Prompt engineering',
        }, 'instagram');
        assert.equal(view.id, 'c1');
        assert.equal(view.is_bot_active, true);
        assert.equal(view.platform, 'instagram');
        assert.equal(view.profile_pic_url, null, 'a non-http picture is dropped on the way out');
        assert.equal(view.message_count, 27);
        assert.equal(view.last_message_cards, 2);
        assert.equal(view.last_message_card_title, 'Prompt engineering');
        assert.equal(view.last_message_type, 'carousel');
        const bare = conversationView({ id: 'c2' }, null);
        assert.equal(bare.platform, null);
        assert.equal(bare.last_message_cards, null);
        assert.equal(bare.last_message_card_title, null);
        assert.equal(bare.last_message_type, null);
        assert.equal(bare.message_count, null);
    });
});

describe('metaCodeOf — the code in a failed job’s error', () => {
    it('reads the "(Code: N)" the Graph wrappers write', () => {
        assert.equal(metaCodeOf('DM Send Failed: (#10903) This person has blocked messages (Code: 10903)'), 10903);
        assert.equal(metaCodeOf('Private Reply Failed [me]: x (Code: 190)'), 190);
    });

    it('is null when there is no code, or the text is not an error string', () => {
        for (const v of ['Send quota exhausted (creator: 181/180).', 'x (Code: N/A)', 'Code: 12', '', null, undefined, 5, {}]) {
            assert.equal(metaCodeOf(v), null, String(v));
        }
    });
});

describe('deliveryOf — what the queue says about a message’s reply', () => {
    const job = (over: Partial<JobFacts> = {}): JobFacts => ({
        dedupe_key: 'dm:m', status: 'failed', attempts: 3, max_attempts: 3, last_error: 'DM Send Failed: x (Code: 10903)', ...over,
    });

    it('is `failed`, with Meta’s code, once the job is out of attempts', () => {
        assert.deepEqual(deliveryOf(job()), { state: 'failed', code: 10903, attempts: 3, max_attempts: 3 });
    });

    it('is `retrying` while the job has failed and will be tried again, whether it waits or is running', () => {
        for (const status of ['pending', 'running']) {
            assert.deepEqual(deliveryOf(job({ status, attempts: 1 })), { state: 'retrying', code: 10903, attempts: 1, max_attempts: 3 }, status);
        }
    });

    it('is nothing for a job that has not failed, or no job at all', () => {
        assert.equal(deliveryOf(job({ status: 'pending', last_error: null })), null, 'queued, never failed');
        assert.equal(deliveryOf(job({ status: 'running', last_error: '' })), null);
        assert.equal(deliveryOf(job({ status: 'done' })), null);
        assert.equal(deliveryOf(undefined), null);
    });

    it('has a null code when the error carried none (a Gemini failure, a quota), and keeps the state', () => {
        assert.deepEqual(deliveryOf(job({ last_error: 'Send quota exhausted (creator: 181/180).' })), { state: 'failed', code: null, attempts: 3, max_attempts: 3 });
    });

    it('never hands back the error text itself', () => {
        assert.ok(!JSON.stringify(deliveryOf(job())).includes('blocked'));
        assert.ok(!('last_error' in (deliveryOf(job()) as object)));
    });
});

describe('annotateMessages', () => {
    const rows = [
        { id: 'q1', direction: 'inbound', sender: 'customer', meta_message_id: 'mid-1', text: 'hi' },
        { id: 'a1', direction: 'outbound', sender: 'ai', meta_message_id: null, text: 'hello' },
        { id: 'o1', direction: 'outbound', sender: 'operator', meta_message_id: null, text: 'by hand' },
        { id: 'q2', direction: 'inbound', sender: 'customer', meta_message_id: null, text: 'no mid' },
        { id: 'old', direction: 'outbound', sender: null, meta_message_id: null, text: 'before v26' },
    ];
    const extras = (over: Partial<MessageExtras> = {}): MessageExtras => ({
        usage: [{ message_id: 'a1', model: 'claude-sonnet-5-5', provider: 'anthropic' }],
        agentModel: 'gemini-2.5-flash',
        jobs: [{ dedupe_key: dmJobKey('mid-1'), status: 'failed', attempts: 3, max_attempts: 3, last_error: 'x (Code: 10903)' }],
        ...over,
    });

    it('names the model from the usage row when one matched the reply, and says that is where it came from', () => {
        const out = annotateMessages(rows, extras());
        assert.deepEqual(out.find((r) => r.id === 'a1')!.ai, { model: 'claude-sonnet-5-5', provider: 'anthropic', source: 'usage' });
    });

    it('falls back to the agent’s model when no usage row matched (the Gemini engine writes none), and marks it as that', () => {
        const out = annotateMessages(rows, extras({ usage: [] }));
        assert.deepEqual(out.find((r) => r.id === 'a1')!.ai, { model: 'gemini-2.5-flash', provider: null, source: 'agent' });
    });

    it('says no model rather than invent one when neither is known', () => {
        const out = annotateMessages(rows, extras({ usage: [], agentModel: null }));
        assert.equal(out.find((r) => r.id === 'a1')!.ai, null);
    });

    it('puts `ai` on the AI’s replies only: not the operator’s, not a row that cannot say who wrote it, not the customer’s', () => {
        const out = annotateMessages(rows, extras());
        for (const id of ['o1', 'old', 'q1', 'q2']) assert.equal(out.find((r) => r.id === id)!.ai, null, id);
    });

    it('puts `delivery` on the customer’s message whose job is failing, and on no other', () => {
        const out = annotateMessages(rows, extras());
        assert.deepEqual(out.find((r) => r.id === 'q1')!.delivery, { state: 'failed', code: 10903, attempts: 3, max_attempts: 3 });
        for (const id of ['a1', 'o1', 'q2', 'old']) assert.equal(out.find((r) => r.id === id)!.delivery, null, id);
    });

    it('sends a voice note\'s transcript: an audio row keeps its `text` (WhatsApp stores the transcript there), so the inbox can show it under the chip', () => {
        const voice = { id: 'v1', direction: 'inbound', sender: 'customer', message_type: 'audio', meta_message_id: 'wamid.V', text: 'كم سعر الخطة؟' };
        const out = annotateMessages([voice], NO_EXTRAS);
        assert.deepEqual([out[0]!.message_type, out[0]!.text], ['audio', 'كم سعر الخطة؟']);
    });

    it('keeps every row, in order, with every field it had, and both blocks always present', () => {
        const out = annotateMessages(rows, NO_EXTRAS);
        assert.deepEqual(out.map((r) => r.id), rows.map((r) => r.id));
        for (const [i, row] of out.entries()) {
            assert.equal(row.text, rows[i]!.text);
            assert.ok('ai' in row && 'delivery' in row);
            assert.equal(row.ai, null);
            assert.equal(row.delivery, null);
        }
    });

    it('does not mix up two replies’ models', () => {
        const two = [
            { id: 'a1', direction: 'outbound', sender: 'ai' }, { id: 'a2', direction: 'outbound', sender: 'ai' },
        ];
        const out = annotateMessages(two, { usage: [{ message_id: 'a2', model: 'm2', provider: null }], agentModel: 'agent-model', jobs: [] });
        assert.equal(out[0]!.ai!.model, 'agent-model');
        assert.equal(out[1]!.ai!.model, 'm2');
    });
});

// ─── The lookups ─────────────────────────────────────────────────────────────────────────────
interface Sent { sql: string; params: unknown[] }

async function extrasWith(
    rows: Array<Record<string, unknown>>,
    answer: (sql: string) => { rows: unknown[] } | Error
): Promise<{ extras: MessageExtras; sent: Sent[] }> {
    const sent: Sent[] = [];
    const original = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        const out = answer(sql);
        if (out instanceof Error) throw out;
        return { ...out, rowCount: out.rows.length };
    };
    try {
        return { extras: await loadMessageExtras(TENANT, rows), sent };
    } finally {
        (pool as unknown as { query: unknown }).query = original;
    }
}

describe('loadMessageExtras', () => {
    const rows = [
        { id: 'q1', direction: 'inbound', sender: 'customer', meta_message_id: 'mid-1' },
        { id: 'a1', direction: 'outbound', sender: 'ai' },
        { id: 'a2', direction: 'outbound', sender: 'ai' },
        { id: 'o1', direction: 'outbound', sender: 'operator' },
    ];
    const happy = (sql: string) => {
        if (/FROM ai_usage|JOIN ai_usage/.test(sql)) return { rows: [{ message_id: 'a1', model: 'claude-sonnet-5-5', provider: 'anthropic' }] };
        if (/FROM ai_agents/.test(sql)) return { rows: [{ model: 'gemini-2.5-flash' }] };
        if (/FROM jobs/.test(sql)) return { rows: [{ dedupe_key: 'dm:mid-1', status: 'pending', attempts: 1, max_attempts: 3, last_error: 'x (Code: 2)' }] };
        return new Error(`no result arranged for SQL: ${sql}`);
    };

    it('asks three scoped questions and returns what they answer', async () => {
        const { extras, sent } = await extrasWith(rows, happy);
        assert.equal(sent.length, 3);
        assert.deepEqual(extras.usage.map((u) => [u.message_id, u.model]), [['a1', 'claude-sonnet-5-5']]);
        assert.equal(extras.agentModel, 'gemini-2.5-flash');
        assert.deepEqual(extras.jobs.map((j) => j.dedupe_key), ['dm:mid-1']);
    });

    it('matches a reply to the newest usage row of THIS tenant’s `dm` calls that finished ok, started in the minutes before the reply', async () => {
        const { sent } = await extrasWith(rows, happy);
        const usage = sent.find((s) => /ai_usage/.test(s.sql))!;
        assert.match(usage.sql, /DISTINCT ON \(m\.id\)/);
        assert.match(usage.sql, /u\.creator_id = \$2 AND u\.purpose = 'dm' AND u\.outcome = 'ok'/);
        assert.match(usage.sql, /u\.at <= m\.created_at AND u\.at >= m\.created_at - make_interval\(secs => \$3::float8\)/);
        assert.match(usage.sql, /ORDER BY m\.id, u\.at DESC/);
        assert.deepEqual(usage.params, [['a1', 'a2'], TENANT, USAGE_MATCH_WINDOW_SECONDS], 'only the AI’s replies, only this tenant, three minutes');
        assert.equal(USAGE_MATCH_WINDOW_SECONDS, 180);
    });

    it('asks the queue only about the customer’s messages that have a Meta id, and only for jobs that are failing or failed', async () => {
        const { sent } = await extrasWith(rows, happy);
        const jobs = sent.find((s) => /FROM jobs/.test(s.sql))!;
        assert.deepEqual(jobs.params, [['dm:mid-1']]);
        assert.match(jobs.sql, /dedupe_key = ANY\(\$1::text\[\]\) AND status IN \('failed', 'pending', 'running'\)/);
        assert.ok(!/SELECT \*/.test(jobs.sql), 'the job’s payload (a whole Meta event) is not read');
    });

    it('asks nothing it does not need: no AI replies means no usage or agent query, no inbound mids means no queue query', async () => {
        const { sent: none } = await extrasWith([{ id: 'o1', direction: 'outbound', sender: 'operator' }], happy);
        assert.equal(none.length, 0);
        const { sent: inboundOnly } = await extrasWith([{ id: 'q', direction: 'inbound', sender: 'customer', meta_message_id: 'm' }], happy);
        assert.deepEqual(inboundOnly.map((s) => /jobs/.test(s.sql)), [true]);
        const { sent: noMid } = await extrasWith([{ id: 'q', direction: 'inbound', sender: 'customer', meta_message_id: null }], happy);
        assert.equal(noMid.length, 0);
    });

    it('each question may fail on its own: that block is empty, the others are kept, and nothing throws', async () => {
        logged = [];
        const { extras } = await extrasWith(rows, (sql) => (/ai_usage/.test(sql) ? new Error('relation "ai_usage" does not exist') : happy(sql)));
        assert.deepEqual([...extras.usage], []);
        assert.equal(extras.agentModel, 'gemini-2.5-flash');
        assert.equal(extras.jobs.length, 1);
        assert.ok(logged.some((l) => /inbox\.detail_failed/.test(l) && /"what":"usage"/.test(l)), 'and it is logged');

        const { extras: allDown } = await extrasWith(rows, () => new Error('connection terminated'));
        assert.deepEqual([[...allDown.usage], allDown.agentModel, [...allDown.jobs]], [[], null, []]);
    });

    it('a tenant with no agent row has no agent model', async () => {
        const { extras } = await extrasWith(rows, (sql) => (/FROM ai_agents/.test(sql) ? { rows: [] } : happy(sql)));
        assert.equal(extras.agentModel, null);
    });
});
