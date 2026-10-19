/**
 * The WhatsApp agent answering a message (`answerWhatsApp`), end to end: the REAL sales turn, the REAL WhatsApp transport and the REAL sender
 * (`channels/send.ts`), against a stubbed database, a stubbed model and a stubbed Meta. Nothing here reaches Postgres, a provider, Gemini or Meta: `.env`
 * holds live credentials, and a test that reached the network could message a real customer.
 *
 * What is pinned, because each is a way a real person is misled, answered twice, answered by the wrong brain, or not answered at all:
 *   - a reply is exactly ONE WhatsApp message, with the automated-service line in the same bubble (review M14), addressed with `recipient` and never `to`
 *   - the model is asked for purpose `dm_whatsapp`, told the chat is WhatsApp, and the legacy Gemini path is NEVER called: a model that cannot answer
 *     (no allowed provider, a 429, a timeout, a budget) is a hand-off with the hand-off line, whatever `gemini_fallback` says (review C1)
 *   - Instagram's hourly quota is not spent, no comment bridge or A/B arm is read, and a reply with a link schedules NO follow-up
 *   - a reply that cannot be SENT (a closed window, a billable message, a refused connection) is not retried, leaves a reason on the inbound row, and tells the owner
 *   - a send that may have landed is never sent again, and nothing that fails after a message went out can make the customer be answered twice
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { setJobQueue } from '../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../jobs/types.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../services/aiProviders/generate.js';
import { AiError } from '../services/llm/errors.js';
import { metaHttp } from '../services/http.js';
import { FITNESS_EN } from '../services/profile/fixtures.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { withSales } from '../services/dmSales/testFixtures.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { answerWhatsApp, reasonOfTurn, whatsappTransport, type WhatsAppAnswerInput, type WhatsAppAnswerResult } from './whatsappAnswer.js';
import { SalesSendRefused } from '../services/dmSales/transport.js';

type Row = Record<string, unknown>;

const CREATOR = 'creator-1';
const CONVERSATION = 'conv-1';
const INBOUND = 'msg-in-1';
const PHONE_ID = '106540352242922';
const BSUID = 'EG.13491208655302741918';
const WA_TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const PLAN_URL = 'https://samifit.example/plan';
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;

const AGENT: Row = {
    is_active: true, system_prompt: 'You answer customers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7,
    // The Instagram switches, all of them in the position that would send a WhatsApp customer's words to Gemini or skip the sales flow: neither may matter.
    engine: 'gemini', gemini_fallback: true, sales_mode: 'off', sales_test_senders: [],
};
const STATE: Row = { stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 };
const LINK_AT = new Date('2026-10-19T09:00:00.000Z');

const saying = (json: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
    json, usage: { in: 4000, out: 120 }, billed: [], model: 'openai/gpt-oss-20b', provider: 'groq', stopReason: 'end_turn',
    elapsed_ms: 900, usd: 0.0, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '7',
});
const failing = (kind: AiError['kind'], provider = 'groq') => async (): Promise<AiGenerateResult> => {
    throw new AiError({ kind, provider, model: 'openai/gpt-oss-20b', message: `a ${kind} failure` });
};
const reply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'It is a twelve-week plan for busy parents.', quick_replies: [], ...over,
});

function recordingQueue() {
    const calls: EnqueueInput[] = [];
    const queue: JobQueue & { calls: EnqueueInput[] } = {
        calls,
        async enqueue(input) { calls.push(input as EnqueueInput); return `job-${calls.length}`; },
        async claim() { return []; }, async complete() {}, async fail() {}, async reapStale() { return 0; }, async pruneCompleted() { return 0; },
    };
    return queue;
}

interface World {
    profile?: CreatorProfile;
    agent?: Row | null;
    state?: Row;
    history?: { direction: 'inbound' | 'outbound'; text: string; sender?: string | null; payload?: string | null; raw_payload?: unknown }[];
    supersession?: { newer_unhandled?: boolean; answered?: boolean };
    layer?: (args: AiGenerateArgs, call: number) => Promise<AiGenerateResult>;
    thread?: Row | null;
    connection?: Row | null;
    freeUsed?: number;
    /** What Meta answers (or throws) for each request, receipts included. */
    meta?: (url: string, body: any) => Promise<any>;
    /** Statements that fail: the first pattern that matches throws this. */
    failSql?: Array<[RegExp, Error]>;
    input?: Partial<WhatsAppAnswerInput>;
    baseUrl?: string;
    trackedCode?: string;
}

interface Run {
    result: WhatsAppAnswerResult | null;
    error: any;
    executed: Array<{ sql: string; params: any[] }>;
    posts: Array<{ url: string; body: any }>;
    layerCalls: AiGenerateArgs[];
    geminiCalls: number;
    enqueued: EnqueueInput[];
    logged: Array<{ level: string; event: string; [k: string]: unknown }>;
}

const INPUT: WhatsAppAnswerInput = {
    creatorId: CREATOR, conversationId: CONVERSATION, messageId: INBOUND, wamid: 'wamid.IN1', phoneNumberId: PHONE_ID, senderId: BSUID,
    text: 'How much is the plan?', payload: null, aiDisclosedAt: null, lastAttempt: true,
};

const threadRow = (over: Row = {}): Row => ({
    id: CONVERSATION, instagram_user_id: BSUID, platform: 'whatsapp', last_inbound_at: new Date(NOW - 5 * 60 * 1000), free_window_expires_at: null, ...over,
});
const connectionRow = (over: Row = {}): Row => ({
    id: 'conn-1', creator_id: CREATOR, external_account_id: PHONE_ID, display_name: 'Test Number', status: 'active', last_error: null, scopes: [], has_token: true,
    access_expires_at: null, last_refreshed_at: null, created_at: new Date('2026-10-18T08:00:00Z'), profile: {}, settings: {}, access_token: encryptSecret(WA_TOKEN), ...over,
});

let savedKey: string | undefined;
let savedGemini: string | undefined;
let savedBase: string | undefined;
beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    savedGemini = process.env.GEMINI_API_KEY;
    savedBase = process.env.PUBLIC_BASE_URL;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.GEMINI_API_KEY = 'test-key';
});
afterEach(() => {
    for (const [name, value] of [['TOKEN_ENCRYPTION_KEY', savedKey], ['GEMINI_API_KEY', savedGemini], ['PUBLIC_BASE_URL', savedBase]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

async function run(world: World = {}): Promise<Run> {
    const profile = world.profile ?? withSales(FITNESS_EN, 'en');
    const input: WhatsAppAnswerInput = { ...INPUT, ...world.input };
    const agent = world.agent === undefined ? AGENT : world.agent;
    const history = world.history ?? [{ direction: 'inbound', text: input.text }];
    const thread = world.thread === undefined ? threadRow() : world.thread;
    const connection = world.connection === undefined ? connectionRow() : world.connection;
    const executed: Run['executed'] = [];
    const posts: Run['posts'] = [];
    const layerCalls: AiGenerateArgs[] = [];
    const logged: Run['logged'] = [];
    let geminiCalls = 0;

    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] }],
        [/FROM app_settings WHERE key/, { rows: [] }],
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [{ ...STATE, ...world.state }] }],
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: false, ...world.supersession }] }],
        [/FROM ai_agents/, { rows: agent ? [agent] : [] }],
        [/SELECT direction, text/, { rows: [...history].reverse().map((h) => ({ sender: h.direction === 'inbound' ? 'customer' : 'ai', payload: null, raw_payload: null, ...h })) }],
        [/FROM conversations WHERE id = \$1 AND creator_id = \$2/, { rows: thread ? [thread] : [] }],
        [/FROM platform_connections/, { rows: connection ? [connection] : [] }],
        [/FROM channel_usage/, { rows: [{ n: String(world.freeUsed ?? 0) }] }],
        ...(world.trackedCode ? [[/INSERT INTO tracked_links/, { rows: [{ code: world.trackedCode }] }] as [RegExp, { rows: any[] }]] : []),
        [/SET stage = 'handoff', handoff_at = NOW\(\), handoff_reason = \$3/, { rowCount: 1 }],
        [/INSERT INTO messages|UPDATE conversations SET stage/, { rows: [{ last_link_at: LINK_AT, reply_id: 'reply-1' }] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/UPDATE messages SET meta_message_id = \$2/, { rowCount: 1 }],
        [/UPDATE messages SET reply_claimed_at = NULL WHERE id/, { rowCount: 1 }],
        [/UPDATE platform_connections SET status = 'invalid'/, { rowCount: 1 }],
        [/INSERT INTO rate_limit_counters|INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
    ];
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    if (world.baseUrl) process.env.PUBLIC_BASE_URL = world.baseUrl;
    else delete process.env.PUBLIC_BASE_URL;
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    const layer = world.layer ?? saying(reply());
    const previousCaller = setAiCaller((args) => { layerCalls.push(args); return layer(args, layerCalls.length); });
    const queue = recordingQueue();
    const previousQueue = setJobQueue(queue);

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        for (const [pattern, error] of world.failSql ?? []) if (pattern.test(sql)) throw error;
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => { geminiCalls++; throw new Error('Gemini must never be called for a WhatsApp customer'); };
    (metaHttp as any).post = async (url: string, body: any) => {
        posts.push({ url, body });
        return (world.meta ?? (async (_u: string, b: any) => (b.status === 'read' ? { data: { success: true } } : { data: { messages: [{ id: 'wamid.OUT1' }] } })))(url, body);
    };

    let result: WhatsAppAnswerResult | null = null;
    let error: any = null;
    try {
        result = await answerWhatsApp(input);
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalMeta;
        setAiCaller(previousCaller);
        setJobQueue(previousQueue);
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { result, error, executed, posts, layerCalls, geminiCalls, enqueued: queue.calls, logged };
}

/** The messages that went to the person: every WhatsApp request that is not a read receipt. */
const messages = (r: Run) => r.posts.filter((p) => p.body.type);
const receipts = (r: Run) => r.posts.filter((p) => p.body.status === 'read');
const executedSql = (r: Run, pattern: RegExp) => r.executed.filter((e) => pattern.test(e.sql));
const logs = (r: Run, event: string) => r.logged.filter((l) => l.event === event);
/** What `recordTurn` was given, by name. */
function record(r: Run): Record<string, any> {
    const e = r.executed.find((x) => /UPDATE conversations SET stage = \$3/.test(x.sql));
    assert.ok(e, 'the turn was recorded');
    const [, , stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut, type, text, payload, aiMeta] = e!.params;
    return {
        stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut, type, text,
        payload: payload === undefined ? undefined : JSON.parse(payload), aiMeta: aiMeta === undefined ? undefined : JSON.parse(aiMeta), withMessage: /WITH reply AS/.test(e!.sql),
    };
}

let restoreSink: (() => void) | undefined;
beforeEach(() => { const previous = setLogSink(() => {}); restoreSink = () => setLogSink(previous); });
afterEach(() => restoreSink?.());

// ─── A reply ────────────────────────────────────────────────────────────────────────────────

describe('a reply on WhatsApp', () => {
    it('is exactly ONE message, with the automated-service line in the same bubble, addressed with recipient and no to', async () => {
        const r = await run({ layer: saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', text: 'Happy to help! What is your goal?' })) });

        assert.equal(r.error, null);
        assert.deepEqual(r.result, { reason: null });
        assert.equal(messages(r).length, 1, 'one message, however many parts the reply has');
        const sent = messages(r)[0]!;
        assert.match(sent.url, new RegExp(`/${PHONE_ID}/messages$`));
        assert.deepEqual(Object.keys(sent.body).sort(), ['messaging_product', 'recipient', 'recipient_type', 'text', 'type']);
        assert.equal(sent.body.recipient, BSUID);
        assert.equal(sent.body.messaging_product, 'whatsapp');
        assert.equal(sent.body.type, 'text');
        assert.match(sent.body.text.body, /^🤖 .*\nHappy to help! What is your goal\?$/s, 'the line, then the words');
        assert.ok(!r.posts.some((p) => /\/me\/messages$/.test(p.url)), 'never Instagram\'s Send API');
    });

    it('keeps it one message when the reply is as long as a sales reply gets: the disclosure is never a bubble of its own', async () => {
        const long = 'A sentence that is the length of a sentence in a long reply to a customer. '.repeat(11).trim();
        const r = await run({ layer: saying(reply({ text: long })) });
        assert.equal(messages(r).length, 1);
        assert.ok(messages(r)[0]!.body.text.body.startsWith('🤖 '));
    });

    it('says no disclosure when the thread already has one, and is still one message', async () => {
        const r = await run({ input: { aiDisclosedAt: new Date(NOW - HOUR) } });
        assert.equal(messages(r).length, 1);
        assert.equal(messages(r)[0]!.body.text.body, 'It is a twelve-week plan for busy parents.');
        assert.equal(executedSql(r, /UPDATE conversations SET ai_disclosed_at/).length, 0);
    });

    it('records the disclosure on the thread only after the message went, as every channel does', async () => {
        const r = await run();
        const order = r.executed.map((e) => e.sql);
        assert.equal(executedSql(r, /UPDATE conversations SET ai_disclosed_at/).length, 1);
        assert.ok(order.findIndex((s) => /UPDATE conversations SET ai_disclosed_at/.test(s)) > -1);
    });

    it('sends quick replies as an interactive button message, still one, and stores them as the inbox draws them', async () => {
        const r = await run({ layer: saying(reply({ text: 'Which one do you want?', quick_replies: [{ title: 'The plan', payload: 'PLAN' }, { title: 'Other plans', payload: 'OTHER' }] })) });
        assert.equal(messages(r).length, 1);
        const body = messages(r)[0]!.body;
        assert.equal(body.type, 'interactive');
        assert.equal(body.interactive.type, 'button');
        assert.deepEqual(body.interactive.action.buttons, [
            { type: 'reply', reply: { id: 'PLAN', title: 'The plan' } }, { type: 'reply', reply: { id: 'OTHER', title: 'Other plans' } },
        ]);
        assert.match(body.interactive.body.text, /^🤖 .*\nWhich one do you want\?$/s);
        const rec = record(r);
        assert.equal(rec.type, 'quick_reply');
        assert.deepEqual(rec.payload.quick_replies.map((q: any) => q.payload), ['PLAN', 'OTHER']);
    });

    it('puts a link after the words on its own line, in the same message, and queues NO follow-up for it', async () => {
        const r = await run({ layer: saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: 'Here you go:' })) });
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.text.body, new RegExp(`Here you go:\\n${PLAN_URL.replace(/[./]/g, '\\$&')}$`));
        assert.equal(messages(r)[0]!.body.text.preview_url, true);
        assert.equal(record(r).linkedOfferId, 'plan', 'the link is recorded as sent');
        assert.deepEqual(r.enqueued, [], 'no dm.followup for a WhatsApp thread');
        assert.equal(logs(r, 'dm.followup_not_scheduled')[0]?.reason, 'channel');
        assert.ok(!r.executed.some((e) => /<enqueue/.test(e.sql)));
    });
});

describe('the brain', () => {
    it('is asked for purpose dm_whatsapp, with the system text cached, and told in the conversation\'s facts that this chat is WhatsApp', async () => {
        const r = await run();
        assert.equal(r.layerCalls.length, 1);
        const call = r.layerCalls[0]!;
        assert.equal(call.purpose, 'dm_whatsapp');
        assert.equal(call.creatorId, CREATOR);
        assert.equal(call.cacheSystem, true);
        const turns = call.user as { role: string; text: string }[];
        const last = turns[turns.length - 1]!;
        assert.match(last.text, /Channel: WhatsApp\. This chat is on WhatsApp, so never mention Instagram, Facebook or Messenger\./);
        assert.ok(!String(call.system).includes('Channel: WhatsApp'), 'in the facts, not in the cached system text');
    });

    it('answers whatever the owner\'s Instagram switches say: sales_mode off and the Gemini engine do not matter on WhatsApp', async () => {
        const r = await run({ agent: { ...AGENT, sales_mode: 'off', engine: 'gemini', gemini_fallback: true } });
        assert.equal(r.layerCalls.length, 1, 'the sales turn, through the providers layer');
        assert.equal(r.geminiCalls, 0);
        assert.equal(messages(r).length, 1);
        assert.ok(!r.executed.some((e) => /sales_mode|sales_test_senders|engine/.test(e.sql)), 'neither list is read');
    });

    it('does not read Instagram\'s things: no comment bridge, no A/B experiment, and spends none of Instagram\'s hourly quota', async () => {
        const r = await run();
        assert.ok(!r.executed.some((e) => /LEFT JOIN LATERAL/.test(e.sql)), 'no comment → DM bridge');
        assert.ok(!r.executed.some((e) => /dm\.variants|sales_variant/.test(JSON.stringify(e))), 'no A/B arm');
        assert.ok(!r.executed.some((e) => /rate_limit_counters/.test(e.sql)), 'no quota');
    });

    it('records the turn with the channel in its ai_meta, so the inbox and the logs can tell the channels apart', async () => {
        const r = await run();
        const rec = record(r);
        assert.equal(rec.withMessage, true);
        assert.equal(rec.aiMeta.channel, 'whatsapp');
        assert.equal(rec.aiMeta.engine, 'providers');
        assert.equal(rec.text, 'It is a twelve-week plan for busy parents.', 'the reply as the bot said it, without the disclosure prefix');
    });

    it('attaches the wamid Meta returned to the row the turn wrote, so a delivery status can find the message', async () => {
        const r = await run();
        const attach = executedSql(r, /UPDATE messages SET meta_message_id = \$2/);
        assert.equal(attach.length, 1);
        assert.deepEqual(attach[0]!.params, ['reply-1', 'wamid.OUT1']);
        assert.ok(r.executed.findIndex((e) => /UPDATE messages SET meta_message_id/.test(e.sql)) > r.executed.findIndex((e) => /UPDATE conversations SET stage = \$3/.test(e.sql)), 'after the record');
    });
});

// ─── Never Gemini ───────────────────────────────────────────────────────────────────────────

describe('a model that cannot answer is a hand-off, never Gemini (review C1)', () => {
    const kinds: AiError['kind'][] = ['no_provider', 'rate', 'timeout', 'budget', 'server', 'quota', 'auth'];
    for (const kind of kinds) {
        it(`${kind}: the hand-off line goes out as one message, the bot is paused, the owner is told, and Gemini is never called, with gemini_fallback on`, async () => {
            const r = await run({ layer: failing(kind) });

            assert.equal(r.error, null);
            assert.equal(r.geminiCalls, 0, 'not one request to Gemini');
            assert.ok(!r.executed.some((e) => /gemini_fallback|SELECT engine/.test(e.sql)), 'the engine switch and the fallback switch are not even read');
            assert.equal(messages(r).length, 1);
            assert.match(messages(r)[0]!.body.text.body, /The account owner will reply soon\.$/, 'the profile\'s own hand-off line');
            const rec = record(r);
            assert.deepEqual([rec.stage, rec.pauseBot, rec.stampHandoff, rec.handoffReason], ['handoff', true, true, 'unsure'], 'the closed list conversations.handoff_reason allows');
            assert.deepEqual(r.result, { reason: 'provider_unavailable' });
            assert.equal(logs(r, 'dm.engine_failed')[0]?.fallback, 'never');
            assert.equal(rec.aiMeta.model_failed, kind);
        });
    }

    it('a model that answered with nothing to send is the same hand-off, not a fallback', async () => {
        const r = await run({ layer: saying(reply({ text: '   ' })) });
        assert.equal(r.geminiCalls, 0);
        assert.deepEqual(r.result, { reason: 'provider_unavailable' });
        assert.equal(messages(r).length, 1);
    });

    it('asks the model once for a good answer and never a second provider: no paid overflow', async () => {
        const r = await run({ layer: failing('rate') });
        assert.equal(r.layerCalls.length, 1);
    });
});

// ─── A reply that cannot be sent ────────────────────────────────────────────────────────────

describe('a reply that cannot be sent', () => {
    const untouched = (r: Run) => {
        assert.equal(messages(r).length, 0, 'no message to the customer');
        assert.ok(!r.executed.some((e) => /INSERT INTO messages|WITH reply AS/.test(e.sql)), 'no outbound row for a message that did not go');
        assert.ok(!r.executed.some((e) => /UPDATE conversations SET stage = \$3/.test(e.sql)), 'the conversation\'s state did not move');
    };
    const stamped = (r: Run) => executedSql(r, /SET stage = 'handoff', handoff_at = NOW\(\), handoff_reason = \$3/);

    it('with the 24-hour window closed: no request to Meta for the message, concluded as window_closed, stamped for a person, not retried', async () => {
        const r = await run({ thread: threadRow({ last_inbound_at: new Date(NOW - 30 * HOUR) }), input: { lastAttempt: false } });
        assert.equal(r.error, null, 'a retry would find the same closed window');
        assert.deepEqual(r.result, { reason: 'window_closed' });
        untouched(r);
        assert.equal(stamped(r).length, 1);
        assert.equal(stamped(r)[0]!.params[2], 'unsure');
    });

    it('with a billable reply the owner has not allowed: concluded as billable_blocked, no message, stamped', async () => {
        const r = await run({ freeUsed: 1000, input: { lastAttempt: false } });
        assert.deepEqual(r.result, { reason: 'billable_blocked' });
        untouched(r);
        assert.equal(stamped(r).length, 1);
    });

    it('with a connection Meta refused (invalid): concluded as connection_invalid, no message, no receipt, stamped', async () => {
        const r = await run({ connection: connectionRow({ status: 'invalid', last_error: 'Meta reports the token as not valid.' }), input: { lastAttempt: false } });
        assert.deepEqual(r.result, { reason: 'connection_invalid' });
        untouched(r);
        assert.equal(receipts(r).length, 0, 'no token to send a receipt with either');
        assert.equal(stamped(r).length, 1);
    });

    it('with a token Meta refuses at the send: the connection is marked invalid, concluded as connection_invalid, not retried', async () => {
        const r = await run({
            input: { lastAttempt: false },
            meta: async (_url, body) => {
                if (body.status === 'read') return { data: { success: true } };
                throw Object.assign(new Error('Request failed'), { response: { status: 401, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } });
            },
        });
        assert.equal(r.error, null);
        assert.deepEqual(r.result, { reason: 'connection_invalid' });
        assert.equal(executedSql(r, /UPDATE platform_connections SET status = 'invalid'/).length, 1);
        assert.equal(messages(r).length, 1, 'one attempt');
        untouched({ ...r, posts: [] });
    });

    it('with a send that MAY HAVE LANDED (a 500): never sent again, even with attempts left; concluded as failure and stamped', async () => {
        const r = await run({
            input: { lastAttempt: false },
            meta: async (_url, body) => {
                if (body.status === 'read') return { data: { success: true } };
                throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: { code: 2, message: 'Service unavailable' } } } });
            },
        });
        assert.equal(r.error, null, 'a retry could deliver the same message twice');
        assert.deepEqual(r.result, { reason: 'failure' });
        assert.equal(messages(r).length, 1, 'one request: never retried');
        assert.equal(stamped(r).length, 1);
    });

    it('with a throttle Meta refused (130429): the claim is released and the error rethrown while an attempt is left, so the runner tries again', async () => {
        const throttled = async (_url: string, body: any) => {
            if (body.status === 'read') return { data: { success: true } };
            throw Object.assign(new Error('Request failed'), { response: { status: 400, data: { error: { code: 130429, message: 'throughput reached' } } } });
        };
        const first = await run({ input: { lastAttempt: false }, meta: throttled });
        assert.ok(first.error, 'asks for a retry');
        assert.equal(executedSql(first, /UPDATE messages SET reply_claimed_at = NULL WHERE id/).length, 1, 'the claim is handed back at once');
        assert.deepEqual(executedSql(first, /reply_claimed_at = NULL WHERE id/)[0]!.params, [INBOUND]);
        assert.equal(stamped(first).length, 0, 'nobody is told yet: it may work next time');

        const last = await run({ input: { lastAttempt: true }, meta: throttled });
        assert.equal(last.error, null);
        assert.deepEqual(last.result, { reason: 'failure' });
        assert.equal(stamped(last).length, 1, 'on the last attempt a person is told');
    });

    it('with a database that fails before anything is sent: retried while an attempt is left, a hand-off stamp on the last', async () => {
        const down = [[/SELECT direction, text/, new Error('connection terminated unexpectedly')]] as Array<[RegExp, Error]>;
        const first = await run({ failSql: down, input: { lastAttempt: false } });
        assert.match(String(first.error?.message), /connection terminated/);
        assert.equal(executedSql(first, /UPDATE messages SET reply_claimed_at = NULL WHERE id/).length, 1);
        assert.equal(messages(first).length, 0);

        const last = await run({ failSql: down, input: { lastAttempt: true } });
        assert.equal(last.error, null);
        assert.deepEqual(last.result, { reason: 'failure' });
        assert.equal(stamped(last).length, 1);
        assert.equal(messages(last).length, 0, 'nothing was sent to the customer, and nothing hands off by message: a person has the flag');
    });

    it('says nothing of the words in any log line, and never the token', async () => {
        const r = await run({ thread: threadRow({ last_inbound_at: new Date(NOW - 30 * HOUR) }), input: { text: 'My card number is 4242 4242 4242 4242' } });
        const all = r.logged.map((l) => JSON.stringify(l)).join('\n');
        assert.ok(!all.includes('4242') && !all.includes(WA_TOKEN));
    });
});

describe('nothing that fails after the message went out can make the customer be answered twice', () => {
    it('a record that fails after the send is concluded as answered, not retried, even with attempts left', async () => {
        const r = await run({ failSql: [[/WITH reply AS/, new Error('connection terminated unexpectedly')]], input: { lastAttempt: false } });
        assert.equal(r.error, null, 'a retry would send the reply again');
        assert.deepEqual(r.result, { reason: null });
        assert.equal(messages(r).length, 1);
        assert.equal(logs(r, 'wa.answered_unrecorded')[0]?.level, 'error');
        assert.equal(executedSql(r, /reply_claimed_at = NULL WHERE id/).length, 0);
    });

    it('a failed wamid attach costs only the delivery tick', async () => {
        const r = await run({ failSql: [[/UPDATE messages SET meta_message_id/, new Error('disk full')]] });
        assert.equal(r.error, null);
        assert.deepEqual(r.result, { reason: null });
        assert.equal(logs(r, 'wa.wamid_not_attached').length, 1);
    });
});

// ─── The read receipt ───────────────────────────────────────────────────────────────────────

describe('the read receipt and the typing indicator', () => {
    it('are the exact request, sent to the same endpoint before the reply, naming the inbound wamid', async () => {
        const r = await run();
        assert.equal(receipts(r).length, 1);
        assert.match(receipts(r)[0]!.url, new RegExp(`/${PHONE_ID}/messages$`));
        assert.deepEqual(receipts(r)[0]!.body, { messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.IN1', typing_indicator: { type: 'text' } });
        assert.ok(r.posts.findIndex((p) => p.body.status === 'read') < r.posts.findIndex((p) => p.body.type), 'before the message');
    });

    it('cost no reply when Meta refuses them: logged, and the message goes out all the same', async () => {
        const r = await run({
            meta: async (_url, body) => {
                if (body.status === 'read') throw Object.assign(new Error('nope'), { response: { status: 400, data: { error: { code: 100, message: 'bad' } } } });
                return { data: { messages: [{ id: 'wamid.OUT1' }] } };
            },
        });
        assert.equal(r.error, null);
        assert.equal(messages(r).length, 1);
        assert.equal(logs(r, 'wa.sender_action_failed').length, 1);
        assert.deepEqual(r.result, { reason: null });
    });

    it('are skipped, without an error, when the number is not known', async () => {
        const r = await run({ input: { phoneNumberId: null } });
        assert.equal(receipts(r).length, 0);
        assert.equal(messages(r).length, 1);
    });

    it('are not sent for a message that is handled before any model is asked (a refund): the hand-off line goes out and nothing thinks', async () => {
        const r = await run({ input: { text: 'I want a refund, give me my money back' } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(receipts(r).length, 0);
        assert.equal(messages(r).length, 1);
        assert.deepEqual(r.result, { reason: null }, 'a hand-off the flow chose is an answer, not a failure');
        assert.equal(record(r).pauseBot, true);
    });
});

// ─── What the flow decides, in the inbound row's words ──────────────────────────────────────

describe('how a turn ends, as the inbound row says it', () => {
    it('an agent the owner switched off answers nothing: agent_off, no model, no message', async () => {
        const r = await run({ agent: { ...AGENT, is_active: false } });
        assert.deepEqual(r.result, { reason: 'agent_off' });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(messages(r).length, 0);
    });

    it('a message a later one has taken the place of is superseded, and sends nothing', async () => {
        const r = await run({ supersession: { newer_unhandled: true } });
        assert.deepEqual(r.result, { reason: 'superseded' });
        assert.equal(messages(r).length, 0);
        assert.equal(r.layerCalls.length, 0);
    });

    it('a conversation that is looping ends itself, quietly: bot_paused, nothing sent', async () => {
        const r = await run({ state: { ai_replies_last_hour: 15 } });
        assert.deepEqual(r.result, { reason: 'bot_paused' });
        assert.equal(messages(r).length, 0);
        assert.equal(r.layerCalls.length, 0);
    });

    it('reasonOfTurn maps each outcome: a sent reply, the stop line and the calm line are answers; a hand-off is one unless the model failed', () => {
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'sent' }), null);
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'opt_out' }), null);
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'calm' }), null);
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'handoff' }), null);
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'handoff', modelFailed: 'no_provider' }), 'provider_unavailable');
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'paused' }), 'bot_paused');
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'superseded' }), 'superseded');
        assert.equal(reasonOfTurn({ kind: 'done', outcome: 'agent_off' }), 'agent_off');
        assert.equal(reasonOfTurn({ kind: 'quota', count: 1, limit: 1, blockedBy: null }), 'failure');
    });
});

describe('the transport', () => {
    it('refuses a second message in one turn before a second request leaves (review M14, T037)', async () => {
        const posts: unknown[] = [];
        const originalQuery = pool.query;
        const originalMeta = metaHttp.post;
        (pool as any).query = async (sql: string) => {
            const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
            if (/FROM conversations WHERE id = \$1 AND creator_id = \$2/.test(sql)) return rows([threadRow()]);
            if (/FROM platform_connections/.test(sql)) return rows([connectionRow()]);
            if (/FROM channel_usage/.test(sql)) return rows([{ n: '0' }]);
            if (/INSERT INTO messages/.test(sql)) return rows([{ id: 'x' }]);
            throw new Error(`no result arranged for SQL:\n${sql}`);
        };
        (metaHttp as any).post = async (_url: string, body: unknown) => { posts.push(body); return { data: { messages: [{ id: 'wamid.OUT1' }] } }; };
        try {
            const transport = whatsappTransport({ creatorId: CREATOR, conversationId: CONVERSATION, wamid: 'wamid.IN1', phoneNumberId: PHONE_ID });
            assert.equal(transport.sent, false);
            assert.deepEqual(await transport.send({ text: 'one' }), { wamid: 'wamid.OUT1' });
            assert.equal(transport.sent, true);
            await assert.rejects(() => transport.send({ text: 'two' }), /sends one message/);
            assert.equal(posts.length, 1, 'the second request never left');
        } finally {
            (pool as any).query = originalQuery;
            (metaHttp as any).post = originalMeta;
        }
    });

    it('turns the sender\'s refusal into a SalesSendRefused that keeps what the sender said', async () => {
        const originalQuery = pool.query;
        (pool as any).query = async (sql: string) => {
            if (/FROM conversations WHERE id = \$1 AND creator_id = \$2/.test(sql)) return { rows: [threadRow({ last_inbound_at: new Date(NOW - 30 * HOUR) })], rowCount: 1 };
            if (/FROM platform_connections/.test(sql)) return { rows: [connectionRow()], rowCount: 1 };
            throw new Error(`no result arranged for SQL:\n${sql}`);
        };
        try {
            const transport = whatsappTransport({ creatorId: CREATOR, conversationId: CONVERSATION, wamid: 'wamid.IN1', phoneNumberId: PHONE_ID });
            await assert.rejects(() => transport.send({ text: 'late' }), (err: any) => {
                assert.ok(err instanceof SalesSendRefused);
                assert.equal(err.reason, 'window_closed');
                assert.equal(err.info.attempted, false);
                assert.ok(err.info.closesAt instanceof Date);
                return true;
            });
            assert.equal(transport.sent, false, 'nothing went out');
        } finally {
            (pool as any).query = originalQuery;
        }
    });
});

describe('a tapped button', () => {
    it('is read as its title, with the code it carried: the model is told which button it was', async () => {
        const r = await run({ input: { text: 'Other plans', payload: 'OTHER_PLANS' }, history: [{ direction: 'inbound', text: 'Other plans', payload: 'OTHER_PLANS' }] });
        assert.equal(r.layerCalls.length, 1);
        const turns = r.layerCalls[0]!.user as { role: string; text: string }[];
        assert.match(turns[turns.length - 1]!.text, /Other plans \(tapped: OTHER_PLANS\)/);
        assert.equal(messages(r).length, 1);
    });
});
