/**
 * The DM sales turn (`turn.ts`), driven end to end through `handleMessagingEvent`, with `sales_mode = 'on'`.
 *
 * Nothing here touches Postgres, a model, Gemini or Meta. `pool.query` answers on the SQL it is handed, `setAiCaller` is the AI providers
 * layer, `axios.post` is Gemini (the fallback) and `metaHttp.post` is the Send API; any statement a test did not arrange throws. That
 * matters in this repository: `.env` holds live credentials, and a test that reached the network could DM a real customer.
 *
 * What is pinned, because each is a way a real person is misled, answered twice, answered in the wrong words, or not answered at all:
 *
 *   - the model proposes and the CODE decides: the stage, the link, the hand-off, the byte cap, who may be sold to;
 *   - the model never writes a link: its own are stripped, the server adds the offer's after the text, and the creator's own site and
 *     socials are the only ones that survive, on an exact match;
 *   - a number the data does not hold is asked again once, and then is the safe line and a person, never the text;
 *   - refund, complaint, stop and insult are decided BEFORE a model is asked;
 *   - a burst is answered once, and a message already answered is not answered twice;
 *   - a model that fails is never silence: the legacy path once, or a hand-off;
 *   - the reply, its `ai_meta` and the new state are ONE statement, written only after the send.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { metaHttp } from '../http.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../aiProviders/generate.js';
import { AiError } from '../llm/errors.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import { throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile } from '../profile/types.js';
import { invalidateTenantCache } from '../tenant.js';
import { setLogSink } from '../../utils/log.js';
import { handleMessagingEvent } from '../../webhook/messaging.js';
import { kitFor } from '../profile/kits.js';
import { MAX_AI_REPLIES_PER_HOUR } from './flow.js';
import { claimCorrection, composeText, META_TEXT_BYTES, salesPayload, salesTurns, withDisclosure } from './turn.js';
import { utf8Bytes } from './text.js';
import { MAX_REPLY_BYTES } from './types.js';
import { withSales } from './testFixtures.js';

type Row = Record<string, unknown>;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── The world ──────────────────────────────────────────────────────────────────────────────

interface Executed { sql: string; params: any[] }
interface Sent { url: string; body: any }

interface World {
    profile?: CreatorProfile;
    /** The `ai_agents` row; null for none. The sales columns are on it as the migration adds them. */
    agent?: Row | null;
    /** Overrides of the conversation's sales state row (`UPDATE conversations SET last_inbound_at`). */
    state?: Row;
    /** The thread, oldest first, as `SELECT direction, text, sender` would give it (the message being answered included). */
    history?: { direction: 'inbound' | 'outbound'; text: string; sender?: string | null; payload?: string | null; raw_payload?: unknown }[];
    supersession?: { newer_unhandled?: boolean; answered?: boolean };
    conversation?: Row;
    /** What the AI providers layer answers with, per call. Defaults to a plain reply. */
    layer?: (args: AiGenerateArgs, call: number) => Promise<AiGenerateResult>;
    /** What Gemini answers with, or throws (the fallback). */
    gemini?: () => Promise<any>;
    /** What the Send API answers with, or throws, per request. */
    send?: (url: string, body: any) => Promise<any>;
    creatorQuotaCount?: number;
    /** `mayRetry`: false makes this the job's last attempt. */
    lastAttempt?: boolean;
    text?: string;
    /** The page the message is addressed to: the Instagram account by default; the Facebook Page id makes it a Messenger one. */
    recipient?: string;
    /** The code of the quick reply the customer tapped: the event is then a button tap, with `text` as the button's title. */
    quickReply?: string;
    /** `app.public_base_url` (here through PUBLIC_BASE_URL): set, a link is a tracked `/r/<code>` one; unset, the offer's own address. */
    baseUrl?: string;
    /** The code the `tracked_links` insert hands back; absent, the insert is not arranged and throws, as a database that is behind would. */
    trackedCode?: string;
}

const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };
const AGENT = { is_active: true, system_prompt: 'You answer followers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7, engine: 'gemini', gemini_fallback: true, sales_mode: 'on', sales_test_senders: [] };

/** A model's answer, as the layer hands it over. */
const saying = (json: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
    json, usage: { in: 4000, out: 120 }, billed: [], model: 'claude-test', provider: 'anthropic', stopReason: 'end_turn',
    elapsed_ms: 900, usd: 0.01, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '7',
});
const failing = (kind: AiError['kind']) => async (): Promise<AiGenerateResult> => {
    throw new AiError({ kind, provider: 'anthropic', model: 'claude-test', message: `a ${kind} failure` });
};
/** A full sales answer: every field the schema requires, a reply by default. */
const reply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'It is a twelve-week plan for busy parents.', quick_replies: [], ...over,
});

const STATE: Row = {
    stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0,
};

interface Run {
    executed: Executed[];
    sends: Sent[];
    layerCalls: AiGenerateArgs[];
    geminiCalls: number;
    logged: { level: string; event: string; [k: string]: unknown }[];
    error: any;
}

async function run(world: World = {}): Promise<Run> {
    const profile = world.profile ?? withSales(FITNESS_EN, 'en');
    const text = world.text ?? 'How much is the plan?';
    const agent = world.agent === undefined ? AGENT : world.agent;
    const history = world.history ?? [{ direction: 'inbound', text }];
    const executed: Executed[] = [];
    const sends: Sent[] = [];
    const layerCalls: AiGenerateArgs[] = [];
    const logged: Run['logged'] = [];
    let geminiCalls = 0;

    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/FROM creator_profiles/, { rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] }],
        [/FROM app_settings WHERE key/, { rows: [] }],
        [/FROM creators\s+WHERE is_active/, { rows: [CREATOR] }],
        [/UPDATE creators/, { rowCount: 1 }],
        [/INSERT INTO conversations/, { rows: [world.conversation ?? { id: 'conv-1', is_bot_active: true, ai_disclosed_at: null }] }],
        [/ON CONFLICT \(meta_message_id\)/, { rows: [{ id: 'msg-1' }] }],
        [/reply_attempts = reply_attempts \+ 1/, { rows: [] }],
        [/SET handled_at = NOW\(\)/, { rowCount: 1 }],
        [/SET reply_claimed_at = NULL WHERE/, { rowCount: 1 }],
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [{ ...STATE, ...world.state }] }],
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, { rows: [{ newer_unhandled: false, answered: false, ...world.supersession }] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/FROM ai_agents/, { rows: agent ? [agent] : [] }],
        [/SELECT direction, text/, { rows: [...history].reverse().map((h) => ({ sender: h.direction === 'inbound' ? 'customer' : 'ai', payload: null, raw_payload: null, ...h })) }],
        [/INSERT INTO messages|UPDATE conversations SET stage/, { rowCount: 1 }],
        ...(world.trackedCode ? [[/INSERT INTO tracked_links/, { rows: [{ code: world.trackedCode }] }] as [RegExp, { rows: any[] }]] : []),
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: world.creatorQuotaCount ?? 1 }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
    ];
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    const originalKey = process.env.GEMINI_API_KEY;
    const originalBase = process.env.PUBLIC_BASE_URL;
    process.env.GEMINI_API_KEY = 'test-key';
    if (world.baseUrl) process.env.PUBLIC_BASE_URL = world.baseUrl;
    else delete process.env.PUBLIC_BASE_URL;
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    const layer = world.layer ?? saying(reply());
    const previousCaller = setAiCaller((args) => { layerCalls.push(args); return layer(args, layerCalls.length); });

    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => {
        geminiCalls++;
        return (world.gemini ?? (async () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'رد احتياطي' }) }] } }] } })))();
    };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        return (world.send ?? (async () => ({ data: { message_id: 'sent-1' } })))(url, body);
    };

    let error: any = null;
    try {
        await handleMessagingEvent(
            { sender: { id: 'user-1' }, recipient: { id: world.recipient ?? 'ig-page-1' }, message: { mid: 'mid-1', text, ...(world.quickReply ? { quick_reply: { payload: world.quickReply } } : {}) } },
            world.recipient ?? 'ig-page-1',
            { lastAttempt: world.lastAttempt ?? false }
        );
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalMeta;
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        if (originalBase === undefined) delete process.env.PUBLIC_BASE_URL;
        else process.env.PUBLIC_BASE_URL = originalBase;
        setAiCaller(previousCaller);
        setLogSink(previousSink);
        invalidateTenantCache();
    }
    return { executed, sends, layerCalls, geminiCalls, logged, error };
}

/** The messages that went to the person: everything on the Send API except the sender actions. */
const messages = (r: Run): Sent[] => r.sends.filter((s) => s.body.message);
const actions = (r: Run): string[] => r.sends.filter((s) => s.body.sender_action).map((s) => s.body.sender_action);
const handled = (r: Run): boolean => r.executed.some((e) => /SET handled_at = NOW\(\)/.test(e.sql));
const released = (r: Run): boolean => r.executed.some((e) => /SET reply_claimed_at = NULL WHERE/.test(e.sql));
/** The one statement that records a turn: the reply with the state, or the state alone. */
const recorded = (r: Run): Executed | undefined => r.executed.find((e) => /UPDATE conversations SET stage/.test(e.sql));
/** What `recordTurn` was given, by name. */
function record(r: Run): Record<string, any> {
    const e = recorded(r);
    assert.ok(e, 'the turn was recorded');
    const [conversationId, creatorId, stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut, type, text, payload, aiMeta] = e!.params;
    return {
        conversationId, creatorId, stage, qualifierTurns, abuseStrikes, intent, offerId, linkedOfferId, pauseBot, handoffReason, stampHandoff, optOut, type, text,
        payload: payload === undefined ? undefined : JSON.parse(payload), aiMeta: aiMeta === undefined ? undefined : JSON.parse(aiMeta), withMessage: /WITH reply AS/.test(e!.sql),
    };
}
const PLAN_URL = 'https://samifit.example/plan';
const logs = (r: Run, event: string) => r.logged.filter((l) => l.event === event);

// ─── A reply ────────────────────────────────────────────────────────────────────────────────

describe('the sales turn: a reply', () => {
    it('is one message with the model\'s words, the disclosure in front on a first reply, and a layer call for the dm purpose that caches the static prompt', async () => {
        const r = await run({ layer: saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', text: 'Happy to help! What is your goal?' })) });

        assert.equal(r.error, null);
        assert.equal(r.geminiCalls, 0, 'Gemini is not asked: the layer answered');
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /^🤖 .*\nHappy to help! What is your goal\?$/s, 'the automated-service disclosure first');
        assert.equal(r.layerCalls.length, 1);
        const call = r.layerCalls[0]!;
        assert.equal(call.purpose, 'dm');
        assert.equal(call.creatorId, 'creator-1');
        assert.equal(call.cacheSystem, true);
        assert.ok(handled(r));
    });

    it('sends the static part of the prompt as the system text and puts the conversation\'s facts in front of the customer\'s message, so the cache can hit', async () => {
        const r = await run({ text: 'How much is the plan?', state: { stage: 'qualify', qualifier_turns: 1 } });
        const call = r.layerCalls[0]!;
        const system = String(call.system);
        const header = kitFor({ code: 'en', register: null }).sales.headers.conversation;
        assert.ok(!system.includes(header), 'the conversation\'s facts are not in the cached system text');
        assert.match(system, /offer_id: plan/, 'the offers are');
        const turns = call.user as { role: string; text: string }[];
        assert.equal(turns[turns.length - 1]!.role, 'user');
        assert.ok(turns[turns.length - 1]!.text.startsWith(header), 'the facts open the last user turn');
        assert.match(turns[turns.length - 1]!.text, /Stage so far: qualify/, 'the stage the code holds');
        assert.match(turns[turns.length - 1]!.text, /How much is the plan\?$/, 'followed by what the person said');
        // And two turns of one tenant, whatever the stage, send the same system text.
        const again = await run({ text: 'And is it for beginners?', state: { stage: 'recommend', qualifier_turns: 2, offers_linked: ['plan'] } });
        assert.equal(String(again.layerCalls[0]!.system), system);
    });

    it('sends mark_seen and typing_on while it thinks, before the reply, and a failure of either costs no reply', async () => {
        const r = await run({
            send: async (_url, body) => {
                if (body.sender_action) throw Object.assign(new Error('not allowed'), { response: { status: 400, data: { error: { code: 100, message: 'nope' } } } });
                return { data: { message_id: 'sent-1' } };
            },
        });
        assert.equal(r.error, null);
        assert.deepEqual(actions(r), ['mark_seen', 'typing_on']);
        assert.equal(messages(r).length, 1, 'the reply went out all the same');
        assert.ok(r.sends.findIndex((s) => s.body.message) > r.sends.findIndex((s) => s.body.sender_action === 'typing_on'), 'typing before the reply');
        assert.equal(logs(r, 'dm.sender_action_failed').length, 2);
        assert.ok(handled(r));
    });

    it('addresses an Instagram conversation to `me` and a Messenger one through the Page id, like the old path, for the typing indicator and the reply alike', async () => {
        const instagram = await run();
        assert.ok(instagram.sends.length >= 3 && instagram.sends.every((s) => /\/me\/messages$/.test(s.url)), 'seen, typing, reply');
        const messenger = await run({ recipient: 'fb-page-1' });
        assert.ok(messenger.sends.length >= 3 && messenger.sends.every((s) => /\/fb-page-1\/messages$/.test(s.url)), 'the Page id');
    });

    it('records the reply and the new state in ONE statement, with the ai_meta the plan names, and marks the message handled last', async () => {
        const r = await run({ layer: saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', intent: 'greeting', text: 'Hi! What is your goal?' })) });
        const rec = record(r);
        assert.equal(rec.withMessage, true);
        assert.deepEqual(
            [rec.stage, rec.qualifierTurns, rec.abuseStrikes, rec.intent, rec.linkedOfferId, rec.pauseBot, rec.stampHandoff, rec.optOut, rec.type],
            ['qualify', 1, 0, 'greeting', null, false, false, false, 'text']
        );
        assert.equal(rec.text, 'Hi! What is your goal?', 'the reply as the bot said it, without the disclosure prefix');
        for (const key of ['intent', 'stage', 'next_action', 'offer_id', 'handoff_reason', 'engine', 'latency_ms']) assert.ok(key in rec.aiMeta, `ai_meta.${key}`);
        assert.equal(rec.aiMeta.engine, 'providers');
        assert.equal(rec.aiMeta.next_action, 'ask_qualifier');
        assert.equal(rec.aiMeta.model, 'claude-test');
        assert.equal(rec.aiMeta.usage_id, '7');
        assert.ok(rec.aiMeta.latency_ms >= 0);
        const sentAt = r.executed.findIndex((e) => /UPDATE conversations SET ai_disclosed_at/.test(e.sql));
        const recordedAt = r.executed.findIndex((e) => /UPDATE conversations SET stage/.test(e.sql));
        const handledAt = r.executed.findIndex((e) => /SET handled_at = NOW\(\)/.test(e.sql));
        assert.ok(sentAt > -1 && recordedAt > sentAt && handledAt > recordedAt, 'disclosure recorded, then the turn, then handled');
        assert.equal(r.executed.filter((e) => /INSERT INTO messages/.test(e.sql) && /'outbound'/.test(e.sql)).length, 1, 'one outbound row, in the same statement as the state');
    });

    it('nothing is recorded until the send landed: a failed send leaves the state as it was, and the pipeline decides what the error means', async () => {
        const r = await run({
            send: async (_url, body) => {
                if (body.sender_action) return { data: {} };
                throw Object.assign(new Error('blocked'), { response: { status: 400, data: { error: { code: 10903 } } } });
            },
        });
        assert.equal(recorded(r), undefined, 'no state was written for a reply that never went out');
        assert.ok(handled(r), 'a permanent Meta error is final, as on the old path');
    });

    it('a stage the model names that the flow does not allow is not the stage: link, with no link sent, is not link', async () => {
        const r = await run({ layer: saying(reply({ stage: 'link', next_action: 'reply', text: 'The plan runs twelve weeks.' })) });
        assert.equal(record(r).stage, 'new');
        assert.deepEqual(record(r).aiMeta.guard.overrides, ['stage:link->new']);
    });
});

// ─── The link ───────────────────────────────────────────────────────────────────────────────

describe('the sales turn: the link', () => {
    it('send_link puts the offer\'s own address after the text, on its own line, and records that it was sent', async () => {
        const r = await run({ text: 'Send me the link', layer: saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: 'Here you go:' })) });
        const text = messages(r)[0]!.body.message.text as string;
        assert.ok(text.endsWith(`Here you go:\n${PLAN_URL}`), text);
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.linkedOfferId, rec.offerId, rec.intent], ['link', 'plan', 'plan', 'ready_to_buy']);
        assert.equal(rec.aiMeta.next_action, 'send_link');
    });

    it('a link the model wrote is taken out, and nothing the model wrote is sent as one', async () => {
        const r = await run({ layer: saying(reply({ text: 'See https://evil.example/x or www.evil.example or evil.example/buy for it.' })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(!/evil/.test(sent), sent);
        assert.ok(record(r).aiMeta.guard.links_removed >= 3);
    });

    it('a recommendation with no link sent does not carry one: recommend is a pitch, send_link is the link', async () => {
        const r = await run({ layer: saying(reply({ next_action: 'recommend', offer_id: 'plan', stage: 'recommend', text: 'The twelve-week plan fits you. Shall I send the link?' })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(!sent.includes('http'), sent);
        assert.equal(record(r).linkedOfferId, null);
        assert.equal(record(r).stage, 'recommend');
        assert.equal(record(r).offerId, 'plan', 'the offer in play is remembered');
    });

    it('an offer with no address is never recommended and never given one: a hand-off, and the model\'s text is not sent', async () => {
        const r = await run({ layer: saying(reply({ next_action: 'send_link', offer_id: 'call', text: 'The call is booked, see example.com/call' })) });
        // `call` is ordered by DM and has no address: coercion turns a link to it into a hand-off, and the model's text, which promises one, is not sent.
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(!/booked|example/.test(sent), sent);
        assert.ok(sent.endsWith(kitFor({ code: 'en', register: null }).sales.lines.unsure('Sami Fitness')), sent);
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.handoffReason, rec.linkedOfferId, rec.pauseBot], ['handoff', 'unsure', null, true]);
    });

    it('the creator\'s own social link survives, on an exact match; any other link, and a near match, does not', async () => {
        const own = 'https://instagram.com/sami.fit';
        const r = await run({ layer: saying(reply({ text: `Follow ${own} now, not https://instagram.com/sami.fit2 or https://other.example/x.` })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(sent.includes(`Follow ${own} now`), sent);
        assert.ok(!sent.includes('sami.fit2'), 'a near match is another address');
        assert.ok(!sent.includes('other.example'));
        assert.equal(record(r).aiMeta.guard.links_removed, 2);
    });

    it('the link the server is inserting is not stripped when the model repeats it, and is not added twice', async () => {
        const r = await run({ layer: saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: `Here: ${PLAN_URL}` })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.equal(sent.split(PLAN_URL).length - 1, 1, sent);
    });
});

// ─── The byte cap ───────────────────────────────────────────────────────────────────────────

describe('the sales turn: 900 UTF-8 bytes, not characters', () => {
    const arabic = 'أهلاً بك! هذا برنامج عملي لمدة اثني عشر أسبوعاً يناسب المبتدئين. '.repeat(40);

    it('an Arabic reply is cut to 900 bytes on a character boundary, and every message that goes out is within Instagram\'s 1,000', async () => {
        assert.ok(arabic.length < 3000 && utf8Bytes(arabic) > 3000);
        const r = await run({ layer: saying(reply({ text: arabic })) });
        const sent = messages(r)[0]!.body.message.text as string;
        const body = sent.slice(sent.indexOf('\n') + 1);
        assert.ok(utf8Bytes(body) <= MAX_REPLY_BYTES, `${utf8Bytes(body)} bytes`);
        assert.ok(utf8Bytes(sent) <= META_TEXT_BYTES, `${utf8Bytes(sent)} bytes with the disclosure`);
        assert.ok(!sent.includes('�'), 'no half character');
        assert.ok(!/[\ud800-\udbff]$/.test(sent) && !/^[\udc00-\udfff]/.test(sent));
    });

    it('with a link, the TEXT is cut to make room for it and the link is whole: text and link together stay within 900 bytes', async () => {
        const r = await run({ layer: saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: arabic })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(sent.endsWith(`\n${PLAN_URL}`), 'the link is last and complete');
        const body = sent.slice(sent.indexOf('\n') + 1);
        assert.ok(utf8Bytes(body) <= MAX_REPLY_BYTES, `${utf8Bytes(body)} bytes`);
        assert.ok(utf8Bytes(sent) <= META_TEXT_BYTES);
    });

    it('composeText cuts the text and never the link, and an empty text leaves the link alone', () => {
        const out = composeText('ا'.repeat(1000), PLAN_URL);
        assert.ok(out.endsWith(`\n${PLAN_URL}`));
        assert.ok(utf8Bytes(out) <= MAX_REPLY_BYTES);
        assert.equal(composeText('   ', PLAN_URL), PLAN_URL);
        assert.equal(composeText('short', null), 'short');
        assert.ok(utf8Bytes(composeText('ب'.repeat(1000), null)) <= MAX_REPLY_BYTES);
    });

    it('the disclosure rides in front when it fits the 1,000 bytes and goes first on its own when it does not', () => {
        const small = withDisclosure({ text: 'hello' }, '🤖 automated');
        assert.deepEqual([small.payload.text, small.standalone], ['🤖 automated\nhello', null]);
        const long = 'x'.repeat(995);
        const big = withDisclosure({ text: long }, '🤖 automated');
        assert.deepEqual([big.payload.text, big.standalone], [long, '🤖 automated']);
        // A template has no text to carry it either way: unchanged from the old path.
        const card = withDisclosure({ attachment: { type: 'template', payload: {} } }, '🤖 automated');
        assert.equal(card.standalone, '🤖 automated');
    });

    it('quick replies go as Meta wants them, and only when there are some', () => {
        assert.deepEqual(salesPayload('hi', []), { text: 'hi' });
        assert.deepEqual(salesPayload('hi', [{ title: 'Beginner', payload: 'LEVEL_BEGINNER' }]), {
            text: 'hi', quick_replies: [{ content_type: 'text', title: 'Beginner', payload: 'LEVEL_BEGINNER' }],
        });
    });
});

// ─── What the guard refuses ─────────────────────────────────────────────────────────────────

describe('the sales turn: a number the data does not hold', () => {
    it('is asked again once with a correction, and the second answer is what is sent', async () => {
        const r = await run({
            layer: async (args, call) => (call === 1
                ? saying(reply({ text: 'It is only 25 dollars with a discount!' }))()
                : saying(reply({ text: 'The current price is on the page.' }))()),
        });
        assert.equal(r.layerCalls.length, 2);
        const second = r.layerCalls[1]!.user as { role: string; text: string }[];
        assert.equal(second[second.length - 1]!.role, 'user');
        assert.match(second[second.length - 1]!.text, /NOT sent/);
        assert.match(second[second.length - 2]!.text, /25 dollars/, 'the model sees its own refused draft');
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /The current price is on the page\.$/);
        assert.equal(record(r).aiMeta.guard.retried, 'claims');
        assert.equal(record(r).aiMeta.attempts, 2);
        assert.equal(logs(r, 'dm.claim_blocked').length, 1);
    });

    it('twice is the kit\'s safe line and a person: the model\'s text is never sent, and the bot is paused', async () => {
        const r = await run({ layer: saying(reply({ text: 'Only 25 dollars today, 50% off!' })) });
        assert.equal(r.layerCalls.length, 2, 'one try and one correction, no more');
        assert.equal(messages(r).length, 1);
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(!/25|50%/.test(sent), sent);
        assert.ok(sent.endsWith(kitFor({ code: 'en', register: null }).sales.lines.unsure('Sami Fitness')), sent);
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.handoffReason, rec.pauseBot, rec.stampHandoff], ['handoff', 'unsure', true, true]);
        assert.equal(logs(r, 'dm.claim_blocked').length, 2);
        assert.ok(handled(r));
    });

    it('an invented coupon is the same: the data has none', async () => {
        const r = await run({ layer: saying(reply({ text: 'Use the coupon SAMI20 at checkout.' })) });
        assert.equal(r.layerCalls.length, 2);
        assert.ok(!/SAMI20/.test(messages(r)[0]!.body.message.text));
    });

    it('claimCorrection names what was found and tells the model what to do instead, in words for the model and not the customer', () => {
        const text = claimCorrection([{ kind: 'price', found: '25 dollars' }, { kind: 'discount', found: 'discount' }], 'Sami');
        assert.match(text, /NOT sent/);
        assert.match(text, /price: 25 dollars/);
        assert.match(text, /check with Sami/);
        assert.match(text, /handoff_reason = unsure/);
    });
});

// ─── Before any model ───────────────────────────────────────────────────────────────────────

describe('the sales turn: decided before a model sees the message', () => {
    it('a refund is the hand-off line, no model, no sales text, the bot paused and the conversation handed over', async () => {
        const r = await run({ text: 'I want a refund, give me my money back' });
        assert.equal(r.layerCalls.length, 0, 'no model call');
        assert.equal(r.geminiCalls, 0);
        assert.deepEqual(actions(r), [], 'no typing indicator for a message no model reads');
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /The account owner will reply soon\.$/, 'the profile\'s own hand-off message');
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.handoffReason, rec.pauseBot, rec.stampHandoff, rec.intent], ['handoff', 'refund', true, true, 'refund_or_complaint']);
        assert.equal(rec.aiMeta.engine, 'prefilter');
        assert.ok(handled(r));
    });

    it('a refund in Arabic is the same', async () => {
        const r = await run({ text: 'أبي أسترجع فلوسي' });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(record(r).handoffReason, 'refund');
    });

    it('a complaint is a hand-off too, and a hand-off without a profile message is the kit\'s line', async () => {
        const profile = withSales(FITNESS_EN, 'en');
        profile.dm = { ...profile.dm, handoff: null };
        const r = await run({ profile, text: 'This is a scam, I will report you' });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(record(r).handoffReason, 'complaint');
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(kitFor({ code: 'en', register: null }).sales.lines.handoff('Sami Fitness')));
    });

    it('"stop" is one confirmation line, the opt-out recorded, the bot paused, and nothing after', async () => {
        const r = await run({ text: 'STOP' });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(messages(r).length, 1);
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(kitFor({ code: 'en', register: null }).sales.lines.optOut));
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.optOut, rec.pauseBot, rec.handoffReason, rec.stampHandoff], ['closed', true, true, null, false]);
        assert.equal(rec.intent, 'opt_out');
    });

    it('the first insult gets one calm line and a strike, and the bot stays on', async () => {
        const r = await run({ text: 'you idiot' });
        assert.equal(r.layerCalls.length, 0);
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(kitFor({ code: 'en', register: null }).sales.lines.calm));
        const rec = record(r);
        assert.deepEqual([rec.abuseStrikes, rec.pauseBot, rec.stage, rec.handoffReason], [1, false, 'new', null]);
    });

    it('the second pauses the bot and sends nothing: no hand-off message, no sales text', async () => {
        const r = await run({ text: 'you idiot', state: { abuse_strikes: 1, stage: 'recommend' } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(messages(r).length, 0);
        const rec = record(r);
        assert.equal(rec.withMessage, false, 'no reply row: nothing was said');
        assert.deepEqual([rec.abuseStrikes, rec.pauseBot, rec.stage, rec.handoffReason, rec.stampHandoff], [2, true, 'closed', 'abuse', false]);
        assert.ok(handled(r));
    });

    it('a model that notices an insult the filter missed is held to the same two strikes', async () => {
        const r = await run({ text: 'what a waste of time', layer: saying(reply({ intent: 'abuse', text: 'Calm down' })) });
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(kitFor({ code: 'en', register: null }).sales.lines.calm), 'the kit\'s line, not the model\'s words');
        assert.equal(record(r).abuseStrikes, 1);
    });

    it('a hand-off the model asks for is the hand-off line, never its text', async () => {
        const r = await run({ text: 'Can I talk to a real person?', layer: saying(reply({ intent: 'wants_human', next_action: 'handoff', handoff_reason: 'wants_human', text: 'Certainly! Meanwhile 90% off!' })) });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(!/90%/.test(sent));
        assert.match(sent, /The account owner will reply soon\.$/);
        assert.deepEqual([record(r).stage, record(r).handoffReason, record(r).pauseBot], ['handoff', 'wants_human', true]);
        assert.equal(r.layerCalls.length, 1, 'no correction: the text was never going to be sent');
    });

    it('an "unsure" hand-off says the owner will check, in the kit\'s words', async () => {
        const r = await run({ text: 'Do you ship to Mars?', layer: saying(reply({ intent: 'other', next_action: 'handoff', handoff_reason: 'unsure', text: 'Maybe!' })) });
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(kitFor({ code: 'en', register: null }).sales.lines.unsure('Sami Fitness')));
    });
});

// ─── Bursts, the agent's switch, loops ──────────────────────────────────────────────────────

describe('the sales turn: one reply to a burst, and none when there is nothing to say', () => {
    it('a message with a later one waiting stands down: no model, no send, handled', async () => {
        const r = await run({ supersession: { newer_unhandled: true } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(r.sends.length, 0);
        assert.equal(recorded(r), undefined);
        assert.ok(handled(r));
        assert.equal(logs(r, 'dm.sales_superseded').length, 1);
    });

    it('so does a message somebody has already replied to (a job resumed after a crash between the send and the bookkeeping)', async () => {
        const r = await run({ supersession: { answered: true } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(r.sends.length, 0);
        assert.ok(handled(r));
    });

    it('the newest message of a burst is answered with the whole burst in front of the model, as one turn', async () => {
        const r = await run({
            text: 'is it for beginners?',
            history: [
                { direction: 'inbound', text: 'hello' },
                { direction: 'inbound', text: 'I saw your reel' },
                { direction: 'inbound', text: 'is it for beginners?' },
            ],
        });
        const turns = r.layerCalls[0]!.user as { role: string; text: string }[];
        assert.equal(turns.length, 1);
        assert.match(turns[0]!.text, /hello\nI saw your reel\nis it for beginners\?$/);
        assert.equal(messages(r).length, 1, 'one reply');
    });

    it('a switched-off agent says nothing, as it always did', async () => {
        const r = await run({ agent: { ...AGENT, is_active: false } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(r.sends.length, 0);
        assert.ok(handled(r));
    });

    it('a tenant with no agent row says nothing either', async () => {
        const r = await run({ agent: null });
        assert.equal(r.sends.length, 0);
    });

    it('a conversation that has had 15 bot replies in the hour pauses itself and says nothing: a loop must end', async () => {
        const r = await run({ state: { ai_replies_last_hour: MAX_AI_REPLIES_PER_HOUR } });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(messages(r).length, 0);
        const rec = record(r);
        assert.deepEqual([rec.pauseBot, rec.stage, rec.handoffReason, rec.stampHandoff], [true, 'handoff', 'unsure', true]);
        assert.equal(logs(r, 'dm.sales_reply_cap').length, 1);
    });

    it('14 is not a loop', async () => {
        const r = await run({ state: { ai_replies_last_hour: MAX_AI_REPLIES_PER_HOUR - 1 } });
        assert.equal(messages(r).length, 1);
    });
});

// ─── Stage rules in the turn ────────────────────────────────────────────────────────────────

describe('the sales turn: the stage rules, as the turn applies them', () => {
    it('two qualifying questions, then recommend: a third is asked again once with the correction', async () => {
        const r = await run({
            state: { stage: 'qualify', qualifier_turns: 2 },
            layer: async (_args, call) => (call === 1
                ? saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', text: 'And what is your age?' }))()
                : saying(reply({ stage: 'recommend', next_action: 'recommend', offer_id: 'plan', text: 'The twelve-week plan fits you. Want the link?' }))()),
        });
        assert.equal(r.layerCalls.length, 2);
        const second = r.layerCalls[1]!.user as { role: string; text: string }[];
        assert.match(second[second.length - 1]!.text, /do not ask another/);
        assert.deepEqual([record(r).stage, record(r).qualifierTurns], ['recommend', 2]);
        assert.equal(record(r).aiMeta.guard.retried, 'flow');
    });

    it('and a model that asks again anyway is recorded as recommending, with the question it asked', async () => {
        const r = await run({ state: { stage: 'qualify', qualifier_turns: 2 }, layer: saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', text: 'What is your age?' })) });
        assert.equal(r.layerCalls.length, 2);
        assert.deepEqual([record(r).stage, record(r).qualifierTurns], ['recommend', 2]);
        assert.ok(record(r).aiMeta.guard.overrides.includes('qualifier_cap_kept'));
        assert.equal(messages(r).length, 1);
    });

    it('a qualifying question counts toward the two', async () => {
        const r = await run({ state: { stage: 'new', qualifier_turns: 1 }, layer: saying(reply({ stage: 'qualify', next_action: 'ask_qualifier', text: 'What is your goal?' })) });
        assert.deepEqual([record(r).stage, record(r).qualifierTurns], ['qualify', 2]);
    });

    it('a person who said no is not sold to: send_link from a closed conversation is a plain reply, with no link', async () => {
        const r = await run({ state: { stage: 'closed' }, layer: saying(reply({ intent: 'info', next_action: 'send_link', offer_id: 'plan', text: 'Sure, here you go!' })) });
        assert.ok(!messages(r)[0]!.body.message.text.includes('http'));
        assert.equal(record(r).stage, 'closed');
        assert.equal(record(r).linkedOfferId, null);
    });

    it('unless they say they want it', async () => {
        const r = await run({ state: { stage: 'closed' }, layer: saying(reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', text: 'Here you go:' })) });
        assert.ok(messages(r)[0]!.body.message.text.endsWith(PLAN_URL));
        assert.equal(record(r).stage, 'link');
    });

    it('an objection is the objection stage, whatever stage the model named', async () => {
        const r = await run({ state: { stage: 'recommend' }, layer: saying(reply({ intent: 'objection_price', stage: 'recommend', text: 'The current price is on the page.' })) });
        assert.equal(record(r).stage, 'objection');
        assert.equal(record(r).intent, 'objection_price');
    });

    it('a conversation the owner resumed after a hand-off starts afresh, and the model is told it is a new one', async () => {
        const r = await run({ state: { stage: 'handoff' }, layer: saying(reply({ stage: 'link', text: 'Welcome back!' })) });
        const turns = r.layerCalls[0]!.user as { text: string }[];
        assert.ok(!/handoff/.test(turns[turns.length - 1]!.text), 'the model is not shown the stage "handoff"');
        assert.equal(record(r).stage, 'new', 'a fresh start does not jump to link on the model\'s say-so');
        const forward = await run({ state: { stage: 'handoff' } });
        assert.equal(record(forward).stage, 'recommend', 'and may move forward as a new conversation does');
    });
});

// ─── A model that fails ─────────────────────────────────────────────────────────────────────

describe('the sales turn: a model that fails is never silence', () => {
    it('is answered by Gemini ONCE when the fallback is on: one reply, from the old path, and the flow does not move', async () => {
        const r = await run({ layer: failing('timeout'), state: { stage: 'qualify', qualifier_turns: 1 } });
        assert.equal(r.layerCalls.length, 1);
        assert.equal(r.geminiCalls, 1);
        assert.equal(messages(r).length, 1, 'never two replies');
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith('رد احتياطي'));
        const rec = record(r);
        assert.deepEqual([rec.stage, rec.qualifierTurns, rec.pauseBot], ['qualify', 1, false]);
        assert.equal(rec.aiMeta.engine, 'gemini_fallback');
        assert.equal(rec.aiMeta.fell_back_from, 'timeout');
        assert.equal(logs(r, 'dm.engine_fallback').length, 1);
        assert.ok(handled(r));
    });

    it('is a hand-off when the fallback is off: the kit\'s line, the bot paused, a person to answer', async () => {
        const r = await run({ layer: failing('budget'), agent: { ...AGENT, gemini_fallback: false } });
        assert.equal(r.geminiCalls, 0);
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /The account owner will reply soon\.$/);
        assert.deepEqual([record(r).stage, record(r).handoffReason, record(r).pauseBot], ['handoff', 'unsure', true]);
        assert.equal(record(r).aiMeta.model_failed, 'budget');
        assert.equal(logs(r, 'dm.engine_failed')[0]!.fallback, 'off');
    });

    it('is a hand-off when Gemini fails too: still exactly one message', async () => {
        const r = await run({ layer: failing('no_provider'), gemini: async () => { throw new Error('gemini down'); } });
        assert.equal(r.geminiCalls, 1);
        assert.equal(messages(r).length, 1);
        assert.equal(record(r).stage, 'handoff');
        assert.equal(logs(r, 'dm.engine_failed')[0]!.fallback, 'failed');
    });

    it('an answer with no words is a failure like any other', async () => {
        const r = await run({ layer: saying(reply({ text: '   ' })), agent: { ...AGENT, gemini_fallback: false } });
        assert.equal(r.layerCalls.length, 1);
        assert.equal(record(r).stage, 'handoff');
    });

    it('an answer that is not an object at all is read as a reply with nothing in it: a failure, not a crash', async () => {
        const r = await run({ layer: saying('garbage' as any), agent: { ...AGENT, gemini_fallback: false } });
        assert.equal(r.error, null);
        assert.equal(messages(r).length, 1);
    });
});

// ─── The send quota ─────────────────────────────────────────────────────────────────────────

describe('the sales turn: the send quota', () => {
    it('a spent quota sends nothing and is retried while attempts remain', async () => {
        const r = await run({ creatorQuotaCount: 181 });
        assert.equal(messages(r).length, 0);
        assert.match(String(r.error?.message), /quota exhausted/i);
        assert.ok(released(r), 'the claim is handed back so the retry reaches the work');
        assert.equal(recorded(r), undefined);
    });

    it('and is final on the last attempt', async () => {
        const r = await run({ creatorQuotaCount: 181, lastAttempt: true });
        assert.equal(r.error, null);
        assert.equal(messages(r).length, 0);
        assert.ok(handled(r));
    });
});

// ─── The conversation, as the model reads it ────────────────────────────────────────────────

describe('salesTurns: the conversation as the model\'s turns', () => {
    const row = (direction: 'inbound' | 'outbound', text: string, sender: string | null = null) => ({ direction, text, sender: sender as any });

    it('starts with the user: a leading reply of ours is dropped, and roles alternate', () => {
        const turns = salesTurns([row('outbound', 'welcome', 'ai'), row('inbound', 'hi'), row('outbound', 'hello!', 'ai'), row('inbound', 'price?')], 'price?', 'Sami');
        assert.deepEqual(turns.map((t) => [t.role, t.text]), [['user', 'hi'], ['model', 'hello!'], ['user', 'price?']]);
    });

    it('marks what a person said from the inbox and what a campaign sent, so the model can see them and not repeat them', () => {
        const turns = salesTurns([row('inbound', 'hi'), row('outbound', 'Sami here, call me', 'operator'), row('outbound', 'the link is below', 'automation'), row('inbound', 'ok')], 'ok', 'Sami');
        assert.deepEqual(turns.map((t) => [t.role, t.text]), [['user', 'hi'], ['model', '[Sami] Sami here, call me\n[auto] the link is below'], ['user', 'ok']]);
    });

    it('joins a burst into one user turn and drops blank rows', () => {
        const turns = salesTurns([row('inbound', 'a'), row('inbound', '  '), row('inbound', 'b')], 'b', 'Sami');
        assert.deepEqual(turns, [{ role: 'user', text: 'a\nb' }]);
    });

    it('adds the message being answered when the history does not end with it', () => {
        assert.deepEqual(salesTurns([row('inbound', 'hi'), row('outbound', 'hello', 'ai')], '[Story Mention]', 'Sami').map((t) => t.text), ['hi', 'hello', '[Story Mention]']);
        assert.deepEqual(salesTurns([], 'hello', 'Sami'), [{ role: 'user', text: 'hello' }]);
    });

    it('puts the conversation\'s facts in front of the last user turn, and only there', () => {
        const turns = salesTurns([row('inbound', 'hi'), row('outbound', 'hello', 'ai'), row('inbound', 'price?')], 'price?', 'Sami', 'FACTS');
        assert.deepEqual(turns.map((t) => t.text), ['hi', 'hello', 'FACTS\n\nprice?']);
    });

    it('an empty history is no conversation for Anthropic, which needs a user turn first: the answered message is always there', () => {
        assert.equal(salesTurns([row('outbound', 'only us', 'ai')], 'hi', 'Sami')[0]!.role, 'user');
    });
});

describe('the sales turn: a tenant\'s own wording', () => {
    it('speaks the language of the tenant\'s profile: an Arabic profile\'s hand-off is in Arabic', async () => {
        const profile = withSales(FITNESS_EN, 'en');
        profile.language = { ...profile.language, primary: 'ar', register: 'msa', digits: 'latin', surfaces: {} };
        profile.dm = { ...profile.dm, handoff: null };
        const r = await run({ profile, text: 'I want a refund' });
        assert.match(messages(r)[0]!.body.message.text, /[؀-ۿ]/);
    });
});

// ─── What the model remembers it sent, and what a tap meant ─────────────────────────────────

describe('the sales turn: the thread as the model reads it', () => {
    const cards = {
        attachment: { type: 'template', payload: { template_type: 'generic', elements: [{ title: 'Alpha Plan' }, { title: 'خطة المبتدئين' }, { title: 'خطة المتقدمين' }] } },
        quick_replies: [{ content_type: 'text', title: 'رابط الخطة', payload: 'LINK' }, { content_type: 'text', title: 'باقي الخطط', payload: 'OTHER_PLANS' }],
    };
    const turnsOf = (r: Run) => r.layerCalls[0]!.user as { role: string; text: string }[];

    it('shows the cards and buttons it sent, not the placeholder they are stored as, and the button the customer tapped, with its code', async () => {
        const r = await run({
            text: 'باقي الخطط',
            quickReply: 'OTHER_PLANS',
            history: [
                { direction: 'inbound', text: 'السلام عليكم' },
                { direction: 'outbound', sender: 'ai', text: '[Structured Template]', raw_payload: cards },
                { direction: 'inbound', text: 'باقي الخطط', payload: 'OTHER_PLANS' },
            ],
        });
        const turns = turnsOf(r);
        assert.deepEqual(turns.map((t) => t.role), ['user', 'model', 'user']);
        assert.equal(turns[1]!.text, '[sent cards: Alpha Plan · خطة المبتدئين · خطة المتقدمين] [buttons: رابط الخطة · باقي الخطط]');
        assert.ok(turns[2]!.text.endsWith('باقي الخطط (tapped: OTHER_PLANS)'), turns[2]!.text);
        assert.ok(!turns.some((t) => t.text.includes('Structured Template')), 'the placeholder never reaches the model');
        assert.equal(messages(r).length, 1);
    });

    it('asks for the stored payload of the bot\'s own rows only, and never for an inbound row\'s, which is the whole Meta event', async () => {
        const r = await run();
        const history = r.executed.find((e) => /SELECT direction, text, sender/.test(e.sql))!;
        assert.match(history.sql.replace(/\s+/g, ' '), /SELECT direction, text, sender, payload, CASE WHEN direction = 'outbound' THEN raw_payload END AS raw_payload FROM messages/);
    });

    it('tells the model about the tap even when the thread read does not hold the message yet (the event carried it)', async () => {
        const r = await run({
            text: 'باقي الخطط', quickReply: 'OTHER_PLANS',
            history: [{ direction: 'inbound', text: 'hi' }, { direction: 'outbound', sender: 'ai', text: 'hello' }],
        });
        const turns = turnsOf(r);
        assert.ok(turns[turns.length - 1]!.text.endsWith('باقي الخطط (tapped: OTHER_PLANS)'), turns[turns.length - 1]!.text);
    });

    it('a tap with no title is the code alone, and a plain message is as it was', async () => {
        const tap = await run({ text: '', quickReply: 'GET_STARTED', history: [{ direction: 'inbound', text: 'GET_STARTED', payload: 'GET_STARTED' }] });
        assert.ok(turnsOf(tap)[0]!.text.endsWith('(tapped: GET_STARTED)'));
        assert.ok(!/GET_STARTED \(tapped/.test(turnsOf(tap)[0]!.text), 'not said twice');
        const plain = await run({ text: 'How much?' });
        assert.ok(turnsOf(plain)[0]!.text.endsWith('How much?'));
        assert.ok(!/tapped/.test(turnsOf(plain)[0]!.text));
    });

    it('the old path sends Gemini the history exactly as it did: the placeholder and the title, no summary and no code', async () => {
        const r = await run({
            agent: { ...AGENT, sales_mode: 'off' },
            text: 'باقي الخطط', quickReply: 'OTHER_PLANS',
            history: [
                { direction: 'inbound', text: 'السلام عليكم' },
                { direction: 'outbound', sender: 'ai', text: '[Structured Template]', raw_payload: cards },
                { direction: 'inbound', text: 'باقي الخطط', payload: 'OTHER_PLANS' },
            ],
        });
        assert.equal(r.layerCalls.length, 0);
        assert.equal(r.geminiCalls, 1, 'the old path answered');
        const history = r.executed.find((e) => /SELECT direction, text/.test(e.sql))!;
        assert.doesNotMatch(history.sql, /raw_payload|payload/, 'its query reads neither');
    });
});

// ─── The tracked link (S7 through the S6 seam) ──────────────────────────────────────────────

describe('the sales turn: the link is a tracked one when it can be', () => {
    const SEND_LINK = reply({ intent: 'ready_to_buy', next_action: 'send_link', offer_id: 'plan', stage: 'link', text: 'Here you go:' });

    it('sends https://<our domain>/r/<code> and records the offer\'s own address as its target, per conversation and offer', async () => {
        const r = await run({ layer: saying(SEND_LINK), baseUrl: 'https://app.example', trackedCode: 'Ab12Cd34Ef' });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(sent.endsWith('Here you go:\nhttps://app.example/r/Ab12Cd34Ef'), sent);
        assert.ok(!sent.includes('samifit.example'), 'the product\'s own address is not what the customer was sent');
        const insert = r.executed.find((e) => /INSERT INTO tracked_links/.test(e.sql))!;
        assert.equal(insert.params.length, 5);
        assert.deepEqual([insert.params[1], insert.params[2], insert.params[3], insert.params[4]], ['creator-1', 'plan', PLAN_URL, 'conv-1']);
        assert.equal(record(r).linkedOfferId, 'plan');
        assert.equal(record(r).stage, 'link');
    });

    it('does not strip the tracked link when the model repeats it, and does not add it twice', async () => {
        const r = await run({ layer: saying({ ...SEND_LINK, text: 'Here: https://app.example/r/Ab12Cd34Ef' }), baseUrl: 'https://app.example', trackedCode: 'Ab12Cd34Ef' });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.equal(sent.split('https://app.example/r/Ab12Cd34Ef').length - 1, 1, sent);
    });

    it('takes room out of the 900 bytes for the shorter link, and keeps it whole', async () => {
        const r = await run({ layer: saying({ ...SEND_LINK, text: 'أهلاً بك! هذا برنامج عملي. '.repeat(60) }), baseUrl: 'https://app.example', trackedCode: 'Ab12Cd34Ef' });
        const sent = messages(r)[0]!.body.message.text as string;
        assert.ok(sent.endsWith('\nhttps://app.example/r/Ab12Cd34Ef'));
        assert.ok(utf8Bytes(sent.slice(sent.indexOf('\n') + 1)) <= MAX_REPLY_BYTES);
    });

    it('falls back to the offer\'s own address when the public address is not set, and says so in the log: an untracked link still sells', async () => {
        const r = await run({ layer: saying(SEND_LINK), trackedCode: 'Ab12Cd34Ef' });
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(`Here you go:\n${PLAN_URL}`));
        assert.equal(r.executed.filter((e) => /INSERT INTO tracked_links/.test(e.sql)).length, 0, 'no code is minted for a link nobody can open');
        assert.equal(logs(r, 'dm.tracked_link_failed')[0]!.reason, 'no_public_base_url');
        assert.equal(record(r).linkedOfferId, 'plan', 'it was still a link');
    });

    it('falls back the same way when the database cannot make the link (a database that has not had v38 yet)', async () => {
        const r = await run({ layer: saying(SEND_LINK), baseUrl: 'https://app.example' });
        assert.ok((messages(r)[0]!.body.message.text as string).endsWith(`Here you go:\n${PLAN_URL}`));
        const [failed] = logs(r, 'dm.tracked_link_failed');
        assert.ok(failed, 'logged');
        assert.equal(failed!.offer_id, 'plan');
        assert.equal(r.error, null, 'and the reply went out');
    });

    it('a reply that sends no link makes none: nothing is minted for a recommendation', async () => {
        const r = await run({ layer: saying(reply({ next_action: 'recommend', offer_id: 'plan', text: 'The plan fits you. Want the link?' })), baseUrl: 'https://app.example', trackedCode: 'Ab12Cd34Ef' });
        assert.equal(r.executed.filter((e) => /INSERT INTO tracked_links/.test(e.sql)).length, 0);
    });
});
