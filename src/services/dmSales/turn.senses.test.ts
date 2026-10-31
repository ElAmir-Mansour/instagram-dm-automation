/**
 * The sales turn when the customer asks whether a voice note or a photo would be taken in (`perception/senses.ts`, wired in `turn.ts` step 4c).
 *
 * `runSalesTurn` is driven directly, as `turn.recall.test.ts` drives it: `pool.query` answers on the SQL it is handed (any statement a test did not arrange throws, which
 * matters because `.env` holds live credentials), `setAiCaller` stands in for the providers layer, and `metaHttp.post` is the Send API. `setSensesDeps` says what the gate
 * answers. What each test protects:
 *
 *   - **an open sense is told**: the line is in the facts, before the customer's message and out of the cached system text, even when the chat still shows the kit's old
 *     "I can't open voice notes here" (the case that made this, 2026-10-31);
 *   - **a closed one is today's turn**: the gate refusing, or the real gate on every tenant's default settings, adds no line, and the second reads only the settings;
 *   - **who it is for**: an Instagram message in the customer's own words with a cue in it, and no other: not WhatsApp, not Messenger, not a tapped button, not a model's
 *     description of a photo, not a message with no cue;
 *   - **it changes nothing else**: the record keeps the same keys, and nothing is sent but the reply.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, afterEach, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setJobQueue } from '../../jobs/queue.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../aiProviders/generate.js';
import type { GateArgs, GateResult } from '../perception/gate.js';
import { setRecallDeps } from '../perception/recall.js';
import { SENSES_FACTS, setSensesDeps, type SensesDeps } from '../perception/senses.js';
import { perceivedFact } from '../perception/text.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import { kitFor } from '../profile/kits.js';
import { throughJsonb } from '../profile/testSupport.js';
import { withSales } from './testFixtures.js';
import { runSalesTurn, type PerceivedTurn, type SalesTurnInput, type SalesTurnResult } from './turn.js';
import type { SalesTransport } from './transport.js';

type Row = Record<string, unknown>;

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());
afterEach(() => { setSensesDeps({}); setRecallDeps({}); });

const TENANT = '55555555-5555-4555-8555-555555555555';
const SENDER = 'user-7';
const VOICE_ASK = 'Can I send you a voice note instead of typing?';
/** The kit's own line for a photo nobody read (`kits.ts` `attachments.media`), as an earlier reply of this chat. */
const OLD_ACK = kitFor({ code: 'en', register: null }).attachments.media;

const STATE: Row = { stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 };
const NO_SOURCE: Row = {
    current_source: null, interaction_id: null, recent_campaign: null, recipient_id: null, replied_at: null,
    recent_keywords: null, recent_template: null, current_keywords: null, current_template: null,
};
const AGENT = { is_active: true, system_prompt: 'You answer followers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7, engine: 'gemini', gemini_fallback: true, sales_mode: 'on', sales_test_senders: [] };

const REPLY: Record<string, unknown> = {
    intent: 'info', stage: 'new', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'Yes, send it, and I will answer what you say.', quick_replies: [],
};
const answer = async (): Promise<AiGenerateResult> => ({
    json: REPLY, usage: { in: 4000, out: 120 }, billed: [], model: 'muse-spark-1.3', provider: 'meta', stopReason: 'end_turn', elapsed_ms: 900, usd: 0.01, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '9',
});

interface World {
    text?: string;
    payload?: string;
    pageId?: string;
    perceived?: PerceivedTurn;
    transport?: SalesTransport;
    /** Earlier rows of the chat, oldest first, before the customer's message. */
    history?: Row[];
    /** What `setSensesDeps` is told; `'real'` installs nothing, so the real gate reads the (empty) settings: every tenant's default, everything off. */
    senses?: SensesDeps | 'real';
}

interface Run {
    result: SalesTurnResult | null;
    error: any;
    executed: { sql: string; params: any[] }[];
    sends: { url: string; body: any }[];
    layerCalls: AiGenerateArgs[];
}

async function run(world: World = {}): Promise<Run> {
    const text = world.text ?? VOICE_ASK;
    const executed: Run['executed'] = [];
    const sends: Run['sends'] = [];
    const layerCalls: AiGenerateArgs[] = [];

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    const previousCaller = setAiCaller(async (args) => { layerCalls.push(args); return answer(); });
    const previousQueue = setJobQueue({
        async enqueue() { return 'job-1'; }, async claim() { return []; }, async complete() {}, async fail() {}, async reapStale() { return 0; }, async releaseUnrun() { return 0; }, async pruneCompleted() { return 0; },
    } as any);
    const previousSenses = setSensesDeps(world.senses === 'real' || !world.senses ? {} : world.senses);
    // Recall stays on its real gate: every tenant's default settings, so a recall cue ("explain") reads them and adds nothing.
    const previousRecall = setRecallDeps({});

    const history = [...(world.history ?? []), { sender: 'customer', payload: null, raw_payload: null, direction: 'inbound', text }];
    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/LEFT JOIN LATERAL/, { rows: [NO_SOURCE] }],
        [/FROM app_settings WHERE key/, { rows: [] }],
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [STATE] }],
        [/FROM ai_agents/, { rows: [AGENT] }],
        [/SELECT direction, text/, { rows: history }],
        [/INSERT INTO messages|UPDATE conversations SET stage/, { rows: [{ last_link_at: null, reply_id: 'reply-1' }] }],
        [/UPDATE conversations SET ai_disclosed_at/, { rowCount: 1 }],
        [/INSERT INTO rate_limit_counters/, { rows: [{ count: 1 }] }],
        [/INSERT INTO app_rate_limit_counters/, { rows: [{ count: 1 }] }],
    ];
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        if (/SELECT EXISTS \(SELECT 1 FROM messages n/.test(sql)) return { rows: [{ newer_unhandled: false, answered: false }], rowCount: 1 };
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1];
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => ({ data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'fallback' }) }] } }] } });
    (metaHttp as any).post = async (url: string, body: any) => { sends.push({ url, body }); return { data: { message_id: 'sent-1' } }; };

    const input: SalesTurnInput = {
        creator: { id: TENANT, page_access_token: 'EAAGplaintext' },
        pageId: world.pageId,
        conversation: { id: 'conv-7' },
        inbound: { id: 'msg-7', senderId: SENDER, text, ...(world.payload ? { payload: world.payload } : {}) },
        ctx: contextFor(throughJsonb(withSales(FITNESS_EN, 'en')), 'dm', 3),
        disclosure: { needed: false, line: 'automated' },
        ...(world.transport ? { transport: world.transport } : {}),
        ...(world.perceived ? { perceived: world.perceived } : {}),
    };

    let result: SalesTurnResult | null = null;
    let error: any = null;
    try {
        result = await runSalesTurn(input);
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalMeta;
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        setAiCaller(previousCaller);
        setJobQueue(previousQueue);
        setSensesDeps(previousSenses);
        setRecallDeps(previousRecall);
    }
    return { result, error, executed, sends, layerCalls };
}

const turnsOf = (call: AiGenerateArgs) => call.user as { role: string; text: string }[];
const lastUserTurn = (r: Run): string => { const turns = turnsOf(r.layerCalls[r.layerCalls.length - 1]!); return turns[turns.length - 1]!.text; };
const hasAnyLine = (text: string): boolean => Object.values(SENSES_FACTS).some((line) => text.includes(line));
function aiMetaOf(r: Run): Record<string, unknown> {
    const e = r.executed.find((x) => /UPDATE conversations SET stage/.test(x.sql));
    assert.ok(e, 'the turn was recorded');
    return JSON.parse(e!.params[15]);
}
const gateThat = (answerOf: (args: GateArgs) => GateResult) => {
    const asked: GateArgs[] = [];
    return { asked, deps: { gate: async (args: GateArgs) => { asked.push(args); return answerOf(args); } } satisfies SensesDeps };
};
const OPEN = (): ReturnType<typeof gateThat> => gateThat(() => ({ ok: true }));

describe('senses in the turn: an open sense is told', () => {
    it('tells the model a voice note would be heard, in the facts in front of the message, and leaves the cached system text alone', async () => {
        const g = OPEN();
        const r = await run({ senses: g.deps });

        assert.equal(r.error, null);
        assert.deepEqual(g.asked.map((a) => [a.capability, a.kind, a.senderId]), [['voice', 'audio', SENDER]]);
        const last = lastUserTurn(r);
        const header = kitFor({ code: 'en', register: null }).sales.headers.conversation;
        assert.ok(last.startsWith(header), 'the facts open the last user turn');
        assert.ok(last.includes(`\n${SENSES_FACTS.voice}\n`), last);
        assert.ok(last.indexOf(SENSES_FACTS.voice) < last.indexOf(VOICE_ASK), 'the fact is before the message');
        const without = await run({ text: 'How much is the plan?', senses: OPEN().deps });
        assert.equal(String(r.layerCalls[0]!.system), String(without.layerCalls[0]!.system), 'the cacheable text does not move');
        assert.ok(!String(r.layerCalls[0]!.system).includes('Voice notes'));
    });

    it('is told even when the chat still shows the kit\'s old "I can\'t open that here": the line says that one is out of date', async () => {
        const r = await run({
            text: 'ممكن اسجل صوت اشرح؟', senses: OPEN().deps,
            history: [
                { sender: 'customer', payload: null, raw_payload: null, direction: 'inbound', text: '[photo]' },
                { sender: 'bot', payload: null, raw_payload: null, direction: 'outbound', text: OLD_ACK },
            ],
        });
        const turns = turnsOf(r.layerCalls[0]!);
        assert.ok(turns.some((t) => t.text.includes(OLD_ACK)), 'the old line is still in the history the model reads');
        assert.ok(lastUserTurn(r).includes(SENSES_FACTS.voice));
        assert.match(SENSES_FACTS.voice, /out of date/);
    });

    it('says the photo line for a photo, and the one line for both', async () => {
        assert.ok(lastUserTurn(await run({ text: 'ممكن ابعتلك صورة؟', senses: OPEN().deps })).includes(SENSES_FACTS.dm_media));
        const both = lastUserTurn(await run({ text: 'a screenshot or a voice note, which is easier?', senses: OPEN().deps }));
        assert.ok(both.includes(SENSES_FACTS.both));
        assert.ok(!both.includes(SENSES_FACTS.voice) && !both.includes(SENSES_FACTS.dm_media));
    });

    it('changes nothing else: the same keys in the record, one reply sent, one model call', async () => {
        const told = await run({ senses: OPEN().deps });
        const plain = await run({ text: 'How much is the plan?' });
        assert.deepEqual(Object.keys(aiMetaOf(told)).sort(), Object.keys(aiMetaOf(plain)).sort());
        assert.equal(told.layerCalls.length, 1);
        assert.equal(told.sends.filter((s) => s.body.message).length, 1);
    });
});

describe('senses in the turn: a closed sense is today\'s turn', () => {
    it('adds no line when the gate refuses: the switch, the sender, the key or the cap', async () => {
        for (const reason of ['switch_off', 'not_allowed_sender', 'no_key', 'budget'] as const) {
            const r = await run({ senses: gateThat(() => ({ ok: false, reason })).deps });
            assert.equal(r.error, null, reason);
            assert.ok(!hasAnyLine(lastUserTurn(r)), reason);
        }
    });

    it('on every tenant\'s default settings (the real gate), adds no line and reads nothing but the settings', async () => {
        const cue = await run({ senses: 'real' });
        const plain = await run({ text: 'Tell me more about the plan please', senses: 'real' });
        assert.ok(!hasAnyLine(lastUserTurn(cue)));
        const extra = cue.executed.length - plain.executed.length;
        assert.ok(extra >= 1, 'the gate read the switches');
        const strip = (r: Run) => r.executed.map((e) => e.sql).filter((sql) => !/FROM app_settings/.test(sql));
        assert.deepEqual(strip(cue), strip(plain), 'every other statement is the same, in the same order');
    });
});

describe('senses in the turn: for an Instagram message in the customer\'s own words with a cue, and no other', () => {
    it('a message with no cue never reaches the gate', async () => {
        const g = OPEN();
        const r = await run({ text: 'How much is the plan?', senses: g.deps });
        assert.equal(g.asked.length, 0);
        assert.ok(!hasAnyLine(lastUserTurn(r)));
    });

    it('not WhatsApp, not Messenger, not a tapped button, not a model\'s description of a photo', async () => {
        const transport: SalesTransport = { channel: 'whatsapp', send: async () => ({ wamid: 'w1' }), seen: async () => undefined, recorded: async () => undefined };
        const description = '[photo] Looked at the photo. A screenshot of a voice note player.';
        const cases: World[] = [
            { transport },
            { pageId: '1234567890' },
            { text: 'Voice note?', payload: 'ICEBREAKER_VOICE' },
            { text: description, perceived: { kind: 'image', describedText: true, sent: perceivedFact({ kind: 'image', status: 'ok', seen: 'A screenshot of a voice note player.', about_owner: 'other_content' }) } },
        ];
        for (const world of cases) {
            const g = OPEN();
            const r = await run({ ...world, senses: g.deps });
            assert.equal(r.error, null, JSON.stringify(Object.keys(world)));
            assert.equal(g.asked.length, 0, JSON.stringify(Object.keys(world)));
            assert.ok(!hasAnyLine(lastUserTurn(r)));
        }
    });
});
