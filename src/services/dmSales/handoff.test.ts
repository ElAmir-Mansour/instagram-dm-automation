/**
 * The handoff alert (`handoff.ts`, docs/DM_SALES_PLAN.md §8, S8), driven end to end through `handleMessagingEvent` with `sales_mode = 'on'`.
 *
 * Nothing here touches Postgres, a model, Gemini, Meta or Telegram: `pool.query` answers on the SQL it is handed (any statement a test did not
 * arrange throws), `setAiCaller` is the AI providers layer, `metaHttp.post` is the Send API and `telegramHttp.post` is Telegram. That matters
 * in this repository: `.env` holds live credentials, and a test that reached either network could message a real customer or the owner.
 *
 * What is pinned, because each is a way the owner is not told, is told twice, is told wrongly, or a customer pays for it:
 *
 *   - a handoff pauses the bot, stamps the conversation and sends the customer the handoff line (S6's statement), and THEN the owner is told;
 *   - an alert that fails, or that cannot be sent, changes nothing the customer got, nothing that was recorded, and costs the job nothing;
 *   - a hot lead is an alert of its own: the link was sent, to a person who wanted it; it does not pause the bot, and has its own switch;
 *   - alerts are the owner's tenant's: another tenant's customers are never sent to his chat;
 *   - one conversation cannot flood the chat: 3 handoff alerts and 1 hot lead an hour, counted in Postgres;
 *   - the bot token appears in no log line and no statement parameter beyond the settings read.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { metaHttp } from '../http.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../aiProviders/generate.js';
import { telegramHttp } from '../notify.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import { throughJsonb } from '../profile/testSupport.js';
import { invalidateTenantCache } from '../tenant.js';
import { setLogSink } from '../../utils/log.js';
import { handleMessagingEvent } from '../../webhook/messaging.js';
import { handoffDecision, loopDecision, abuseDecision, optOutDecision, decideTurn } from './flow.js';
import { HANDOFF_ALERTS_PER_HOUR, HOT_LEAD_ALERTS_PER_HOUR, noticeFor, notifyOwner, type NoticePlan } from './handoff.js';
import { withSales } from './testFixtures.js';
import type { Intent, SalesReply } from './types.js';

type Row = Record<string, unknown>;

/** A made-up token of the right shape. It belongs to no bot. */
const TOKEN = '123456789:AAH_fake_token_for_tests_0123456789abcd';
const CHAT = '4242424242';
const BASE = 'https://msg.example';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── The pure rule ──────────────────────────────────────────────────────────────────────────

describe('noticeFor: which turns end with an alert', () => {
    const facts = { qualifierTurns: 0, abuseStrikes: 0 };
    const reply = (over: Partial<SalesReply>): SalesReply => ({
        text: 'x', quick_replies: [], intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', ...over,
    });

    it('a handoff is one, with its reason; a reason of none is read as unsure', () => {
        for (const reason of ['unsure', 'refund', 'complaint', 'wants_human', 'hot_lead'] as const) {
            assert.deepEqual(noticeFor(handoffDecision(reason, facts), { intent: null, linkSent: false }), { kind: 'handoff', reason });
        }
        assert.deepEqual(noticeFor({ stage: 'handoff', action: 'handoff', handoffReason: 'none' }, { intent: null, linkSent: false }), { kind: 'handoff', reason: 'unsure' });
    });

    it('a conversation paused for looping is a handoff: a person has to look', () => {
        assert.deepEqual(noticeFor(loopDecision(facts), { intent: null, linkSent: false }), { kind: 'handoff', reason: 'unsure' });
    });

    it('a second insult is NOT: the plan says pause, no handoff ping. A first is a calm line, and an opt-out is not one either', () => {
        assert.equal(noticeFor(abuseDecision('new', { qualifierTurns: 0, abuseStrikes: 1 }), { intent: 'abuse', linkSent: false }), null);
        assert.equal(noticeFor(abuseDecision('new', facts), { intent: 'abuse', linkSent: false }), null);
        assert.equal(noticeFor(optOutDecision(facts), { intent: 'opt_out', linkSent: false }), null);
    });

    it('a link sent to a person who wanted it is a hot lead, and the intents that count are the buying ones', () => {
        const sent = (intent: Intent) => noticeFor(decideTurn('recommend', reply({ intent, next_action: 'send_link', stage: 'link', offer_id: 'plan' }), facts), { intent, linkSent: true });
        for (const intent of ['ready_to_buy', 'price', 'level_fit'] as const) assert.deepEqual(sent(intent), { kind: 'hot_lead' }, intent);
        for (const intent of ['objection_price', 'objection_time', 'objection_trust', 'info', 'greeting', 'off_topic', 'support', 'other'] as const) {
            assert.equal(sent(intent), null, intent);
        }
    });

    it('a hot lead needs the link to have really gone: the rules can turn send_link into a plain reply, and a plain reply is not one', () => {
        const d = decideTurn('closed', reply({ intent: 'info', next_action: 'send_link', stage: 'link', offer_id: 'plan' }), facts);
        assert.equal(d.action, 'reply', 'a person who said no is not sold to');
        assert.equal(noticeFor(d, { intent: 'ready_to_buy', linkSent: true }), null);
        const sendLink = decideTurn('recommend', reply({ intent: 'ready_to_buy', next_action: 'send_link', stage: 'link', offer_id: 'plan' }), facts);
        assert.equal(noticeFor(sendLink, { intent: 'ready_to_buy', linkSent: false }), null, 'no link was added');
        assert.equal(noticeFor(decideTurn('new', reply({ intent: 'ready_to_buy', next_action: 'recommend' }), facts), { intent: 'ready_to_buy', linkSent: false }), null, 'a recommendation is a pitch');
    });
});

// ─── The world ──────────────────────────────────────────────────────────────────────────────

interface Executed { sql: string; params: any[] }
interface Sent { url: string; body: any }

interface World {
    /** `app_settings` as saved (decrypted values). The Telegram alert is configured and on unless a test says otherwise. */
    settings?: Record<string, string>;
    /** Who the platform owner is: the tenant of this DM by default. Null for no creators at all. */
    owner?: string | null;
    text?: string;
    layer?: (args: AiGenerateArgs) => Promise<AiGenerateResult>;
    state?: Row;
    /** The conversation as the facts statement reads it; null = the row is gone. */
    facts?: Row | null;
    /** What Telegram answers with, or throws. */
    telegram?: (url: string, body: any) => Promise<any>;
    /** The count each bucket of `rate_limit_counters` starts at (the next hit makes it +1). */
    counters?: Record<string, number>;
    /** The limiter's statement throws for the notify buckets. */
    limiterDown?: boolean;
    /** The statement that reads the conversation's facts for the alert throws, as a database that has gone away would. */
    factsError?: boolean;
    send?: (url: string, body: any) => Promise<any>;
    profile?: ReturnType<typeof withSales>;
    /** The `ai_agents` row: `sales_mode: 'off'` for the old path. */
    agent?: Row;
    /** The job's last attempt (`mayRetry` false). Default: not. */
    lastAttempt?: boolean;
    /** What Gemini answers with, or throws (the old path). Default: not reachable. */
    gemini?: () => Promise<any>;
    /** `ai_disclosed_at` of the conversation: a date means the automated-service disclosure has been given. */
    disclosedAt?: Date | null;
    /** A reply to this message already exists (an earlier attempt, or the owner from the inbox). */
    answered?: boolean;
    /** The statement that stamps the conversation as handed over throws. */
    stampFails?: boolean;
    /** The bot's outbound row cannot be written (after the send). */
    outboundInsertFails?: boolean;
    /** The profile cannot be read at all. */
    noProfile?: boolean;
    /** The event carries no Meta message id (such an event has exactly one attempt). */
    noMid?: boolean;
}

const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };
const AGENT = { is_active: true, system_prompt: 'You answer followers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7, engine: 'gemini', gemini_fallback: true, sales_mode: 'on', sales_test_senders: [] };

const ON: Record<string, string> = {
    'notify.telegram_bot_token': TOKEN, 'notify.telegram_chat_id': CHAT, 'notify.telegram_enabled': 'true', 'app.public_base_url': BASE,
};

const saying = (json: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
    json, usage: { in: 4000, out: 120 }, billed: [], model: 'claude-test', provider: 'anthropic', stopReason: 'end_turn',
    elapsed_ms: 900, usd: 0.01, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '7',
});
const reply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'It is a twelve-week plan for busy parents.', quick_replies: [], ...over,
});

const STATE: Row = { stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 };
const FACTS: Row = {
    username: 'sara_dev', instagram_user_id: '17841400000000001', last_inbound_text: 'I want a refund, give me my money back',
    last_inbound_at: new Date(Date.now() - 3 * 3600_000),
};

interface Run {
    geminiCalls: number;
    executed: Executed[];
    /** Every call that left, in order: `SQL <start>`, `META …`, `TELEGRAM`. */
    timeline: string[];
    sends: Sent[];
    telegram: Sent[];
    logged: Array<{ level: string; event: string; [k: string]: unknown }>;
    lines: string[];
    error: any;
}

async function run(world: World = {}): Promise<Run> {
    const settings = world.settings ?? ON;
    const profile = world.profile ?? withSales(FITNESS_EN, 'en');
    const text = world.text ?? 'I want a refund, give me my money back';
    const executed: Executed[] = [];
    const timeline: string[] = [];
    const sends: Sent[] = [];
    const telegram: Sent[] = [];
    const logged: Run['logged'] = [];
    const lines: string[] = [];
    const counters = new Map(Object.entries(world.counters ?? {}));
    let geminiCalls = 0;

    const owner = world.owner === undefined ? 'creator-1' : world.owner;
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number } | ((sql: string, params: any[]) => { rows?: any[]; rowCount?: number })]> = [
        ...(world.noProfile ? [] : [[/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] }] as [RegExp, { rows: any[] }]]),
        // `getSettings` asks for many keys (`= ANY`), `getSetting` for one: both answer from the same map.
        [/FROM app_settings WHERE key/, (_sql, params) => {
            const keys: string[] = Array.isArray(params[0]) ? params[0] : [params[0]];
            return { rows: keys.filter((k) => k in settings).map((key) => ({ key, value: settings[key], is_secret: false })) };
        }],
        [/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/, { rows: owner === null ? [] : [{ id: owner }] }],
        [/FROM creators\s+WHERE is_active/, { rows: [CREATOR] }],
        [/UPDATE creators/, { rowCount: 1 }],
        [/INSERT INTO conversations/, { rows: [{ id: 'conv-1', is_bot_active: true, ai_disclosed_at: world.disclosedAt ?? null }] }],
        [/ON CONFLICT \(meta_message_id\)/, { rows: [{ id: 'msg-1' }] }],
        [/reply_attempts = reply_attempts \+ 1/, { rows: [] }],
        [/SET handled_at = NOW\(\)/, { rowCount: 1 }],
        [/SET reply_claimed_at = NULL WHERE/, { rowCount: 1 }],
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [{ ...STATE, ...world.state }] }],
        // The first call is the sales turn's own check, the second the failure handoff's: `answered` is for the second.
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: Boolean(world.answered) }] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/FROM ai_agents/, { rows: [world.agent ?? AGENT] }],
        [/SELECT direction, text/, { rows: [{ direction: 'inbound', text, sender: 'customer', payload: null, raw_payload: null }] }],
        [/UPDATE conversations\s+SET stage = 'handoff', handoff_at = NOW\(\)/, () => {
            if (world.stampFails) throw new Error('connection terminated');
            return { rowCount: 1 };
        }],
        [/INSERT INTO messages/, (sql) => {
            if (world.outboundInsertFails && /'outbound'/.test(sql)) throw new Error('connection terminated');
            return { rowCount: 1 };
        }],
        [/UPDATE conversations SET stage/, { rowCount: 1 }],
        [/SELECT c\.username, c\.instagram_user_id/, () => {
            if (world.factsError) throw new Error('connection terminated');
            return { rows: world.facts === null ? [] : [{ ...FACTS, last_inbound_text: text, ...world.facts }] };
        }],
        [/INSERT INTO rate_limit_counters/, (_sql, params) => {
            const bucket = String(params[1]);
            if (world.limiterDown && bucket.startsWith('notify')) throw new Error('limiter down');
            const next = (counters.get(bucket) ?? 0) + 1;
            counters.set(bucket, next);
            return { rows: [{ count: next }] };
        }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
    ];
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    const originalTelegram = telegramHttp.post;
    const originalBase = process.env.PUBLIC_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    const previousSink = setLogSink((level, line) => { lines.push(line); logged.push({ level, ...JSON.parse(line) }); });
    const layer = world.layer ?? saying(reply());
    const previousCaller = setAiCaller((args) => layer(args));

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        timeline.push(`SQL ${sql.replace(/\s+/g, ' ').slice(0, 40)}`);
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const result = typeof route[1] === 'function' ? route[1](sql, params) : route[1];
        const { rows = [], rowCount } = result;
        return { rows, rowCount: rowCount ?? rows.length };
    };
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    (axios as any).post = async () => {
        geminiCalls++;
        if (!world.gemini) throw new Error('Gemini must not be reached');
        timeline.push('GEMINI');
        return world.gemini();
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        timeline.push(`META ${body?.sender_action ?? 'message'}`);
        sends.push({ url, body });
        return (world.send ?? (async () => ({ data: { message_id: 'sent-1' } })))(url, body);
    };
    (telegramHttp as any).post = async (url: string, body: any) => {
        timeline.push('TELEGRAM');
        telegram.push({ url, body });
        return (world.telegram ?? (async () => ({ data: { ok: true, result: { message_id: 1 } } })))(url, body);
    };

    let error: any = null;
    try {
        await handleMessagingEvent(
            { sender: { id: 'user-1' }, recipient: { id: 'ig-page-1' }, message: { ...(world.noMid ? {} : { mid: 'mid-1' }), text } },
            'ig-page-1',
            { lastAttempt: world.lastAttempt ?? false }
        );
    } catch (err) {
        error = err;
    } finally {
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalMeta;
        (telegramHttp as any).post = originalTelegram;
        if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = originalBase;
        setAiCaller(previousCaller);
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { geminiCalls, executed, timeline, sends, telegram, logged, lines, error };
}

const messages = (r: Run): Sent[] => r.sends.filter((s) => s.body.message);
const handled = (r: Run): boolean => r.executed.some((e) => /SET handled_at = NOW\(\)/.test(e.sql));
const recorded = (r: Run): Executed | undefined => r.executed.find((e) => /UPDATE conversations SET stage/.test(e.sql));
const logs = (r: Run, event: string) => r.logged.filter((l) => l.event === event);

/** The recorded turn's parameters, by name (the statement's order, as store.ts `recordTurn` writes it). */
function record(r: Run): Record<string, any> {
    const e = recorded(r);
    assert.ok(e, 'the turn was recorded');
    const [conversationId, creatorId, stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut] = e!.params;
    return { conversationId, creatorId, stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut };
}

// ─── A handoff ──────────────────────────────────────────────────────────────────────────────

describe('a handoff: the bot is paused, the customer is told, and then the owner is', () => {
    it('does all four, in that order: the state and the customer\'s line first (one statement, after the send), the alert after both', async () => {
        const r = await run();

        assert.equal(r.error, null);
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.handoffReason, rec.pauseBot, rec.stampHandoff], ['handoff', 'refund', true, true], 'paused, stamped, with its reason');
        assert.equal(messages(r).length, 1);
        assert.ok(String(messages(r)[0]!.body.message.text).endsWith('The account owner will reply soon.'), 'the profile\'s own handoff line');
        assert.equal(r.telegram.length, 1, 'the owner was told once');

        const at = (re: RegExp) => r.timeline.findIndex((c) => re.test(c));
        assert.ok(at(/^META message/) < at(/UPDATE conversations SET stage/) || at(/^META message/) < at(/WITH reply AS/), 'the line went out before the state was written');
        assert.ok(r.timeline.indexOf('TELEGRAM') > r.timeline.findIndex((c) => /WITH reply AS|SET stage/.test(c)), 'the owner is told after the state is recorded');
        assert.ok(r.timeline.indexOf('TELEGRAM') < r.timeline.findIndex((c) => /SET handled_at/.test(c)), 'and before the message is closed');
        assert.ok(handled(r));
    });

    it('says who, why, what they wrote, how long the window has left and where to open it, as plain text to the owner\'s chat', async () => {
        const r = await run({ facts: { last_inbound_at: new Date(Date.now() - 3 * 3600_000 - 10_000) } });

        const post = r.telegram[0]!;
        assert.equal(post.url, `/bot${TOKEN}/sendMessage`);
        assert.deepEqual(Object.keys(post.body).sort(), ['chat_id', 'disable_web_page_preview', 'text']);
        assert.equal(post.body.chat_id, CHAT);
        assert.deepEqual(post.body.text.split('\n'), [
            'Needs you: refund request',
            'Customer: @sara_dev',
            'Last message: «I want a refund, give me my money back»',
            'Reply window: closes in 20 h 59 min',
            `Open: ${BASE}/dashboard#/inbox?c=conv-1`,
        ]);
    });

    it('is the Arabic alert for an Arabic profile, and the model\'s reason when the model handed over', async () => {
        const profile = withSales(FITNESS_EN, 'en');
        profile.language = { ...profile.language, primary: 'ar', register: 'gulf' } as typeof profile.language;
        const r = await run({
            profile, text: 'Can I talk to a real person?',
            layer: saying(reply({ intent: 'wants_human', next_action: 'handoff', handoff_reason: 'wants_human', text: 'Certainly! Meanwhile 90% off!' })),
        });
        assert.equal(r.telegram.length, 1);
        assert.match(r.telegram[0]!.body.text, /^يحتاج ردك: طلب التحدث مع شخص\n/);
        assert.ok(!r.telegram[0]!.body.text.includes('90%'), 'the model\'s own words are never in an alert');
    });

    it('a model that failed hands over too, and a conversation that was looping: a person has to look at both', async () => {
        const failed = await run({ text: 'How much is the plan?', layer: async () => { throw new Error('model down'); } });
        assert.equal(record(failed).stage, 'handoff');
        assert.match(failed.telegram[0]!.body.text, /^Needs you: the assistant was not sure how to answer\n/);

        const loop = await run({ text: 'hello again', state: { ai_replies_last_hour: 15 } });
        assert.equal(messages(loop).length, 0, 'a loop is paused quietly: nothing is sent to the customer');
        assert.equal(record(loop).pauseBot, true);
        assert.equal(loop.telegram.length, 1, 'but the owner is told');
    });

    it('a second insult pauses the bot and tells nobody; an opt-out likewise; a plain reply likewise', async () => {
        const insult = await run({ text: 'you are an idiot', state: { abuse_strikes: 1 } });
        assert.equal(record(insult).pauseBot, true);
        assert.equal(insult.telegram.length, 0);

        const stop = await run({ text: 'stop messaging me' });
        assert.equal(record(stop).optOut, true);
        assert.equal(stop.telegram.length, 0);

        const plain = await run({ text: 'How much is the plan?' });
        assert.equal(plain.telegram.length, 0);
    });
});

// ─── Best effort ────────────────────────────────────────────────────────────────────────────

describe('an alert is best effort: it is never why a customer is not answered', () => {
    it('Telegram refusing it changes nothing the customer got or the state that was recorded, and says why in the log', async () => {
        const ok = await run();
        const refused = await run({ telegram: async () => { throw Object.assign(new Error('x'), { response: { status: 401, data: { ok: false, description: 'Unauthorized' } } }); } });

        assert.equal(refused.error, null, 'the job does not fail, so it is not retried (and no customer is answered twice)');
        assert.deepEqual(messages(refused).map((m) => m.body.message.text), messages(ok).map((m) => m.body.message.text));
        assert.deepEqual(record(refused), record(ok));
        assert.ok(handled(refused));
        const failure = logs(refused, 'dm.handoff_notify_failed')[0]!;
        assert.deepEqual([failure.outcome, failure.status, failure.description], ['rejected', 401, 'Unauthorized']);
    });

    it('Telegram not answering at all is the same', async () => {
        const r = await run({ telegram: async () => { throw Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }); } });
        assert.equal(r.error, null);
        assert.ok(handled(r));
        assert.equal(messages(r).length, 1);
        assert.deepEqual([logs(r, 'dm.handoff_notify_failed')[0]!.outcome, logs(r, 'dm.handoff_notify_failed')[0]!.status], ['unreachable', null]);
    });

    it('a statement of ours failing while the alert is built is logged and swallowed, too: the conversation gone, or the database away', async () => {
        const gone = await run({ facts: null });
        assert.equal(gone.error, null);
        assert.equal(gone.telegram.length, 0);
        assert.equal(logs(gone, 'dm.handoff_notify_no_conversation').length, 1);
        assert.ok(handled(gone));
        assert.equal(messages(gone).length, 1);

        const broken = await run({ factsError: true });
        assert.equal(broken.error, null, 'a thrown statement is not the job\'s failure either');
        assert.equal(broken.telegram.length, 0);
        assert.equal(logs(broken, 'dm.handoff_notify_error').length, 1);
        assert.equal(logs(broken, 'dm.handoff_notify_error')[0]!.level, 'warn');
        assert.ok(handled(broken));
        assert.deepEqual(record(broken), record(await run()), 'the state recorded is the same');
    });

    it('alerts switched off, or half configured, say nothing and spend nothing: no limiter, no facts, no call', async () => {
        for (const settings of [
            {},
            { ...ON, 'notify.telegram_enabled': 'false' },
            { ...ON, 'notify.telegram_bot_token': '' },
            { ...ON, 'notify.telegram_chat_id': '' },
        ]) {
            const r = await run({ settings });
            assert.equal(r.telegram.length, 0);
            assert.ok(!r.executed.some((e) => /rate_limit_counters/.test(e.sql) && /notify/.test(JSON.stringify(e.params))), 'the allowance is not spent');
            assert.ok(!r.executed.some((e) => /SELECT c\.username/.test(e.sql)));
            assert.ok(handled(r));
            assert.equal(messages(r).length, 1, 'the customer was answered all the same');
        }
    });
});

// ─── Whose alerts ───────────────────────────────────────────────────────────────────────────

describe('alerts are the platform owner\'s', () => {
    it('another tenant\'s customer is never sent to the owner\'s chat: it gets the inbox flag and the badge, and nothing else', async () => {
        const r = await run({ owner: 'someone-else' });
        assert.equal(r.telegram.length, 0);
        assert.ok(!r.executed.some((e) => /SELECT c\.username/.test(e.sql)), 'nothing about the conversation was even read');
        assert.equal(record(r).stage, 'handoff', 'it is still a handoff: paused, stamped, the line sent');
        assert.equal(messages(r).length, 1);
    });

    it('a deployment with no creators at all alerts nobody', async () => {
        const r = await run({ owner: null });
        assert.equal(r.telegram.length, 0);
    });
});

// ─── Hot leads ──────────────────────────────────────────────────────────────────────────────

describe('a hot lead: the link was sent to a person who wanted it', () => {
    const wantsLink = (over: Record<string, unknown> = {}) => saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: 'Here you go:', ...over }));

    it('tells the owner the link went, and does not pause the bot: it is a nudge to follow up, not a handover', async () => {
        const r = await run({ text: 'Send me the link', layer: wantsLink(), facts: { last_inbound_text: 'Send me the link' } });

        assert.equal(r.telegram.length, 1);
        assert.match(r.telegram[0]!.body.text, /^Hot lead: the link was sent\nCustomer: @sara_dev\nLast message: «Send me the link»\n/);
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.pauseBot, rec.stampHandoff, rec.linkedOfferId], ['link', false, false, 'plan']);
        assert.ok(r.timeline.indexOf('TELEGRAM') > r.timeline.findIndex((c) => /WITH reply AS|SET stage/.test(c)), 'after the reply is recorded');
    });

    it('has its own switch: off, the customer gets the link all the same and the owner hears nothing', async () => {
        const r = await run({ text: 'Send me the link', layer: wantsLink(), settings: { ...ON, 'notify.telegram_hot_leads': 'false' } });
        assert.equal(r.telegram.length, 0);
        assert.match(String(messages(r)[0]!.body.message.text), /Here you go:\nhttps:\/\/samifit\.example\/plan$/);
    });

    it('is on unless it was turned off: nothing saved means the owner\'s choice of hot leads included', async () => {
        const r = await run({ text: 'Send me the link', layer: wantsLink() });
        assert.equal(r.telegram.length, 1);
    });

    it('is not an objection that was answered with the link, nor a link a closed conversation was refused', async () => {
        const objection = await run({ text: 'too expensive', layer: wantsLink({ intent: 'objection_price' }) });
        assert.equal(objection.telegram.length, 0);
        const closed = await run({ text: 'ok send it', state: { stage: 'closed' }, layer: wantsLink({ intent: 'info' }) });
        assert.equal(closed.telegram.length, 0);
    });

    it('a handoff the model proposed for a hot lead is a handoff: always an alert, whatever the hot-lead switch says', async () => {
        const r = await run({
            text: 'How do I pay?', settings: { ...ON, 'notify.telegram_hot_leads': 'false' },
            layer: saying(reply({ intent: 'ready_to_buy', next_action: 'handoff', handoff_reason: 'hot_lead', text: 'x' })),
        });
        assert.equal(r.telegram.length, 1);
        assert.match(r.telegram[0]!.body.text, /^Needs you: ready to buy\n/);
    });
});

// ─── The rate limit ─────────────────────────────────────────────────────────────────────────

describe('one conversation cannot flood the chat', () => {
    const plan = { kind: 'handoff', reason: 'refund' } as NoticePlan;
    const request = { creatorId: 'creator-1', conversationId: 'conv-9', plan, language: 'en' };

    /** `notifyOwner` against the same stubbed database, n times over, for one conversation. */
    async function callTimes(n: number, over: Partial<typeof request> & { counters?: Record<string, number> } = {}) {
        const outcomes: string[] = [];
        const telegram: Sent[] = [];
        const counters = new Map<string, number>(Object.entries(over.counters ?? {}));
        const originalQuery = pool.query;
        const originalTelegram = telegramHttp.post;
        (pool as any).query = async (sql: string, params: any[] = []) => {
            if (/FROM app_settings WHERE key/.test(sql)) {
                const keys: string[] = Array.isArray(params[0]) ? params[0] : [params[0]];
                return { rows: keys.filter((k) => k in ON).map((key) => ({ key, value: ON[key], is_secret: false })) };
            }
            if (/SELECT id FROM creators ORDER BY created_at, id LIMIT 1/.test(sql)) return { rows: [{ id: 'creator-1' }] };
            if (/INSERT INTO rate_limit_counters/.test(sql)) {
                const next = (counters.get(String(params[1])) ?? 0) + 1;
                counters.set(String(params[1]), next);
                return { rows: [{ count: next }] };
            }
            if (/SELECT c\.username/.test(sql)) return { rows: [{ ...FACTS }] };
            throw new Error(`no result arranged for SQL: ${sql}`);
        };
        (telegramHttp as any).post = async (url: string, body: any) => { telegram.push({ url, body }); return { data: { ok: true } }; };
        invalidateTenantCache();
        try {
            const { counters: _counters, ...rest } = over;
            for (let i = 0; i < n; i++) outcomes.push(await notifyOwner({ ...request, ...rest }));
        } finally {
            (pool as any).query = originalQuery;
            (telegramHttp as any).post = originalTelegram;
            invalidateTenantCache();
        }
        return { outcomes, telegram, counters };
    }

    it('lets 3 handoff alerts through in an hour and holds the rest', async () => {
        const { outcomes, telegram } = await callTimes(5);
        assert.equal(HANDOFF_ALERTS_PER_HOUR, 3);
        assert.deepEqual(outcomes, ['sent', 'sent', 'sent', 'rate_limited', 'rate_limited']);
        assert.equal(telegram.length, 3);
    });

    it('lets 1 hot-lead alert through in an hour', async () => {
        const { outcomes, telegram } = await callTimes(3, { plan: { kind: 'hot_lead' } });
        assert.equal(HOT_LEAD_ALERTS_PER_HOUR, 1);
        assert.deepEqual(outcomes, ['sent', 'rate_limited', 'rate_limited']);
        assert.equal(telegram.length, 1);
    });

    it('counts per conversation, per kind: another thread, and a hot lead beside a handoff, each have their own allowance', async () => {
        const first = await callTimes(4);
        assert.equal(first.outcomes[3], 'rate_limited');
        const other = await callTimes(1, { conversationId: 'conv-10', counters: Object.fromEntries([...first.counters]) });
        assert.deepEqual(other.outcomes, ['sent'], 'conv-10 has not been alerted');
        const mixed = await callTimes(1, { plan: { kind: 'hot_lead' }, counters: Object.fromEntries([...first.counters]) });
        assert.deepEqual(mixed.outcomes, ['sent'], 'the hot-lead bucket of conv-9 is its own');
        assert.deepEqual([...first.counters.keys()].sort(), ['notify:conv-9']);
    });

    it('keeps its buckets inside the column: rate_limit_counters.bucket is 50 characters', () => {
        const uuid = '3f9c2a40-7b1e-4c8d-9a55-0123456789ab';
        assert.ok(`notify:${uuid}`.length <= 50);
        assert.ok(`notify_hot:${uuid}`.length <= 50);
    });

    it('lets the alert through when the limiter cannot be read: a handoff missed is worse than one repeated', async () => {
        const r = await run({ limiterDown: true });
        assert.equal(r.telegram.length, 1);
        assert.equal(logs(r, 'dm.handoff_notify_limiter_failed').length, 1);
        assert.equal(r.error, null);
    });
});

// ─── The secret ─────────────────────────────────────────────────────────────────────────────

describe('the bot token', () => {
    it('is in no log line of a turn that sent an alert, one that failed to, or one that was refused', async () => {
        const failures = [
            async () => { throw Object.assign(new Error(`Request failed: /bot${TOKEN}/sendMessage`), { config: { url: `/bot${TOKEN}/sendMessage` }, response: { status: 404, data: { ok: false, description: `Not Found /bot${TOKEN}/sendMessage` } } }); },
            async () => { throw Object.assign(new Error(`connect ECONNREFUSED /bot${TOKEN}`), { code: 'ECONNREFUSED', config: { url: `/bot${TOKEN}/sendMessage` } }); },
            async () => ({ data: { ok: true } }),
        ];
        for (const telegram of failures) {
            const r = await run({ telegram });
            assert.ok(r.lines.length > 0);
            for (const line of r.lines) {
                assert.ok(!line.includes(TOKEN), line);
                assert.ok(!/\d{9}:AAH_/.test(line), line);
            }
        }
    });

    it('is read from the settings and used for the one call, and appears in no statement parameter but the one that read it', async () => {
        const r = await run();
        const withToken = r.executed.filter((e) => JSON.stringify(e.params).includes(TOKEN));
        assert.deepEqual(withToken, [], 'settings are read by key; their values come back in the rows, never go out in a statement');
        assert.ok(r.telegram[0]!.url.includes(TOKEN), 'it is in the URL of the one Telegram call, and there only');
        assert.ok(!JSON.stringify(r.telegram[0]!.body).includes(TOKEN));
        assert.ok(!r.sends.some((s) => JSON.stringify(s).includes(TOKEN)), 'and nothing that reached Meta or the customer');
    });
});

// ─── A reply that fails for the last time ───────────────────────────────────────────────────

describe('a reply that fails on its last attempt is a handoff, in every sales mode (found live 2026-10-14)', () => {
    const OLD_PATH = { ...AGENT, sales_mode: 'off' };
    const geminiDown = async () => { throw Object.assign(new Error('overloaded'), { response: { status: 503, data: { error: { message: 'model overloaded' } } } }); };
    const handoffLine = 'The account owner will reply soon.';
    const lineSends = (r: Run) => messages(r).filter((m) => String(m.body.message.text).includes(handoffLine));
    const stamps = (r: Run) => r.executed.filter((e) => /UPDATE conversations\s+SET stage = 'handoff', handoff_at = NOW\(\), handoff_reason = \$3/.test(e.sql));
    /** Any statement that turns the bot off for the conversation: an engine failure must never run one. */
    const pausesOf = (r: Run) => r.executed.filter((e) => /is_bot_active\s*=\s*FALSE/i.test(e.sql));
    const outboundRows = (r: Run) => r.executed.filter((e) => /INSERT INTO messages/.test(e.sql) && /'outbound'/.test(e.sql));

    it('sales mode OFF, Gemini failing the third time: ONE handoff line to the customer, the conversation stamped and the bot left ON, the owner told, the message handled', async () => {
        const r = await run({ agent: OLD_PATH, text: 'How much is the plan?', gemini: geminiDown, lastAttempt: true, facts: { last_inbound_text: 'How much is the plan?' } });

        assert.equal(r.error, null, 'the job ends: nothing is thrown, so nothing is retried');
        assert.ok(r.geminiCalls >= 1, 'Gemini was asked (and failed: ai.ts may try it more than once within one attempt)');
        assert.equal(messages(r).length, 1, 'exactly one message reached the customer');
        assert.equal(r.sends.filter((s) => s.body.sender_action).length, 0);
        const text = String(messages(r)[0]!.body.message.text);
        assert.ok(text.endsWith(handoffLine), 'the profile\'s own handoff line');
        assert.match(text, /^🤖 .*\n/s, 'with the automated-service disclosure in front, as the first reply on this thread');
        assert.match(messages(r)[0]!.url, /\/me\/messages$/);

        assert.equal(stamps(r).length, 1);
        assert.deepEqual(stamps(r)[0]!.params, ['conv-1', 'creator-1', 'unsure'], 'stamped with the closest reason the CHECK allows');
        assert.deepEqual(pausesOf(r), [], 'the bot is NOT paused: it was an outage, and the next message gets a normal reply');
        assert.equal(outboundRows(r).length, 1, 'and the line is on the thread as the bot\'s own');
        assert.match(outboundRows(r)[0]!.sql, /'ai', \$5::jsonb/);
        assert.equal(outboundRows(r)[0]!.params[2], handoffLine);
        assert.deepEqual(JSON.parse(String(outboundRows(r)[0]!.params[4])), {
            engine: 'rule', stage: 'handoff', next_action: 'handoff', handoff_reason: 'unsure', failed: 'last_attempt',
        });
        assert.ok(r.executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)), 'the disclosure was given');

        assert.equal(r.telegram.length, 1, 'the owner was told');
        assert.match(r.telegram[0]!.body.text, /^Needs you: the assistant could not reply \(a technical failure\)\nCustomer: @sara_dev\nLast message: «How much is the plan\?»\n/);
        assert.ok(handled(r));
        assert.ok(!r.executed.some((e) => /SET reply_claimed_at = NULL WHERE/.test(e.sql)), 'not released for another try');
        assert.equal(logs(r, 'dm.failure_handoff')[0]!.line_sent, true);
    });

    it('in the order that leaves a person the most to work with: stamped first, then the customer, then the owner, then handled', async () => {
        const r = await run({ agent: OLD_PATH, text: 'hello', gemini: geminiDown, lastAttempt: true });
        const at = (re: RegExp) => r.timeline.findIndex((c) => re.test(c));
        // (a statement shows in the timeline by its first 40 characters)
        assert.ok(at(/GEMINI/) > -1 && at(/GEMINI/) < at(/UPDATE conversations SET stage = 'han/), 'after the model failed');
        assert.ok(at(/UPDATE conversations SET stage = 'han/) < at(/^META message/), 'stamped BEFORE the line: the flag is there even if it cannot go out');
        const sendAt = at(/^META message/);
        assert.ok(r.timeline.findIndex((c, i) => i > sendAt && /INSERT INTO messages/.test(c)) > sendAt, 'the line is recorded after the send landed');
        assert.ok(at(/^META message/) < r.timeline.indexOf('TELEGRAM'));
        assert.ok(r.timeline.indexOf('TELEGRAM') < at(/SET handled_at/), 'and the message is closed last');
    });

    it('a thread the disclosure was already given on gets the line alone', async () => {
        const r = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, disclosedAt: new Date() });
        assert.equal(String(messages(r)[0]!.body.message.text), handoffLine);
        assert.ok(!r.executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)));
    });

    it('sales mode ON, the reply failing to send for the last time, is the same: the turn threw, so the customer has had nothing', async () => {
        const r = await run({
            text: 'How much is the plan?', lastAttempt: true,
            send: async (_url, body) => {
                if (body.sender_action) return { data: {} };
                // The sales reply fails transiently (every try the Meta client makes); the handoff line goes through.
                if (!String(body.message?.text).includes(handoffLine)) throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } });
                return { data: { message_id: 'sent-2' } };
            },
        });
        assert.equal(r.error, null);
        assert.equal(lineSends(r).length, 1, 'the one handoff line');
        assert.equal(stamps(r).length, 1);
        assert.equal(r.telegram.length, 1);
        assert.ok(handled(r));
    });

    it('is not a second answer: sales mode on, a model that fails is handed over by the turn itself, once, and the pipeline adds nothing', async () => {
        const r = await run({ text: 'How much is the plan?', lastAttempt: true, layer: async () => { throw new Error('model down'); } });
        assert.equal(r.error, null);
        assert.equal(messages(r).length, 1, 'the turn\'s own handoff line, and no second');
        assert.equal(stamps(r).length, 0, 'the turn recorded the handoff in its own statement');
        assert.equal(r.telegram.length, 1, 'one alert, not two');
        assert.equal(logs(r, 'dm.failure_handoff').length, 0);
    });

    it('NOT on an attempt that can be retried: it throws as it always did, releases the claim, and sends, stamps and tells nobody', async () => {
        const r = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: false });

        assert.ok(r.error, 'the runner only backs off if the error reaches it');
        assert.match(r.error.message, /Gemini request failed \[HTTP 503\]/);
        assert.equal(messages(r).length, 0);
        assert.equal(stamps(r).length, 0);
        assert.equal(r.telegram.length, 0);
        assert.ok(r.executed.some((e) => /SET reply_claimed_at = NULL WHERE/.test(e.sql)), 'released');
        assert.ok(!handled(r));
    });

    it('a PERMANENT Meta error keeps today\'s behaviour: nothing is sent to a recipient who blocked us or with a dead token', async () => {
        for (const code of [10903, 190]) {
            const r = await run({
                agent: OLD_PATH, lastAttempt: true, gemini: async () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'hi' }) }] } }] } }),
                send: async () => { throw Object.assign(new Error('blocked'), { response: { status: 400, data: { error: { code, error_subcode: code === 190 ? 463 : undefined } } } }); },
            });
            assert.equal(r.error, null, String(code));
            assert.equal(messages(r).length, 1, `only the reply that failed; no handoff line (${code})`);
            assert.equal(stamps(r).length, 0);
            assert.equal(r.telegram.length, 0);
            assert.equal(logs(r, 'dm.failure_handoff').length, 0);
            assert.ok(handled(r));
        }
    });

    it('a handoff line that cannot be sent is logged and let go: never retried, never a loop, the message handled, the owner still told', async () => {
        const r = await run({
            agent: OLD_PATH, gemini: geminiDown, lastAttempt: true,
            send: async () => { throw Object.assign(new Error('boom'), { response: { status: 500, data: {} } }); },
        });

        assert.equal(r.error, null);
        // One logical send: the Meta client's own retries of a 5xx send the same text again, and nothing here sends another.
        assert.equal(new Set(messages(r).map((m) => m.body.message.text)).size, 1, 'one message, tried once by this code');
        assert.equal(logs(r, 'dm.failure_handoff_send_failed').length, 1);
        assert.equal(outboundRows(r).length, 0, 'no line is recorded that the customer never got');
        assert.equal(stamps(r).length, 1, 'the conversation is flagged all the same');
        assert.equal(r.telegram.length, 1, 'and the owner is told: this is exactly when somebody has to look');
        assert.ok(handled(r));
        assert.equal(logs(r, 'dm.failure_handoff')[0]!.line_sent, false);
        assert.ok(!r.executed.some((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql)), 'the disclosure was not recorded for a message that did not go');
    });

    it('answers nobody who has been answered: a reply that already exists, or one sent before the failure, is not followed by a handoff line', async () => {
        const answered = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, answered: true });
        assert.equal(answered.error, null);
        assert.equal(messages(answered).length, 0);
        assert.equal(stamps(answered).length, 0);
        assert.equal(answered.telegram.length, 0);
        assert.ok(handled(answered));

        // Gemini answered and the reply WENT OUT; it was writing it down that failed.
        const sentThenFailed = await run({
            agent: OLD_PATH, lastAttempt: true, outboundInsertFails: true,
            gemini: async () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'It is 49.' }) }] } }] } }),
        });
        assert.equal(sentThenFailed.error, null);
        assert.equal(messages(sentThenFailed).length, 1, 'the one reply, and no handoff line after it');
        assert.equal(stamps(sentThenFailed).length, 0);
        assert.equal(sentThenFailed.telegram.length, 0);
        assert.ok(handled(sentThenFailed));
    });

    it('is the owner\'s alert only: another tenant\'s customer still gets the line and the flag, and nothing goes to the owner\'s chat', async () => {
        const r = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, owner: 'someone-else' });
        assert.equal(lineSends(r).length, 1);
        assert.equal(stamps(r).length, 1);
        assert.equal(r.telegram.length, 0);
    });

    it('with no Telegram configured it is the same without the alert, and a stamp that cannot be written is logged and swallowed', async () => {
        const quiet = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, settings: {} });
        assert.equal(lineSends(quiet).length, 1);
        assert.equal(quiet.telegram.length, 0);
        assert.ok(handled(quiet));

        const broken = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, stampFails: true });
        assert.equal(broken.error, null, 'a database that cannot stamp is not the job\'s failure');
        assert.equal(logs(broken, 'dm.failure_handoff_stamp_failed').length, 1);
        assert.deepEqual(pausesOf(broken), [], 'and there is no fallback that pauses the bot instead');
        assert.equal(lineSends(broken).length, 1, 'the customer still gets the line');
        assert.equal(broken.telegram.length, 1);
        assert.ok(handled(broken));
    });

    it('a profile that cannot be read sends no line (it would not be in the tenant\'s words) but still stamps', async () => {
        const r = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: true, noProfile: true, owner: 'someone-else' });
        assert.equal(r.error, null);
        assert.equal(messages(r).length, 0);
        assert.equal(logs(r, 'dm.failure_handoff_no_profile').length, 1);
        assert.equal(stamps(r).length, 1);
        assert.ok(handled(r));
    });

    it('a mid-less event has exactly one attempt, so its failure is the last: handed over, not dropped', async () => {
        const r = await run({ agent: OLD_PATH, gemini: geminiDown, lastAttempt: false, noMid: true });
        assert.equal(r.error, null);
        assert.equal(lineSends(r).length, 1);
        assert.ok(handled(r));
    });
});
