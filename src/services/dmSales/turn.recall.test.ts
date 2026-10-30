/**
 * The sales turn when the customer asks for a video and the owner's video library may answer (`recall`, `turn.ts`, docs/specs/005-muse-sees T056, T058).
 *
 * `runSalesTurn` is driven directly, as `turn.perceived.test.ts` drives it: `pool.query` answers on the SQL it is handed (any statement a test did not arrange throws, which
 * matters because `.env` holds live credentials), `setAiCaller` stands in for the providers layer and records every model call with its purpose, and `metaHttp.post` is the Send
 * API. What recall itself does (the cue, the library, the model's number, the second, the link) is `perception/recall.test.ts`'s; `setRecallDeps` says who the gate lets through
 * and which reels the library holds, and the model's answers are scripted. What each test protects:
 *
 *   - **a match is told, checked and delivered**: the facts block says "Relevant video: <link> (watch from m:ss): <summary>" after the cached prefix; the line is among the guard's
 *     facts (the second it names is no invented number) and the link is on the allow-list for this reply alone; a reply that left the link out, or mangled it, gets the exact one;
 *   - **the guard still refuses every other library permalink**: one that was not recalled is taken out, with a reel recalled, with none, and with "no video on this topic";
 *   - **no match is honest**: "No video on this topic yet", no link, no `recalled`;
 *   - **memory off is today's turn**: no model call, no line, not one key more in `ai_meta`, whatever the message says;
 *   - **who it is for**: an Instagram message in the customer's own words, and no other: not WhatsApp, not Messenger, not a tapped button, not a model's description of a photo;
 *   - **it never costs the turn**: a recall that fails changes nothing, and typing starts before the library is read.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, afterEach, before, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setJobQueue } from '../../jobs/queue.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../aiProviders/generate.js';
import { AiError } from '../llm/errors.js';
import { setRecallDeps, type RecallDeps } from '../perception/recall.js';
import type { LibraryRow } from '../perception/reelLibrary.js';
import { perceivedFact } from '../perception/text.js';
import { contextFor } from '../profile/context.js';
import { FITNESS_EN } from '../profile/fixtures.js';
import { kitFor } from '../profile/kits.js';
import { throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile } from '../profile/types.js';
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
afterEach(() => { setRecallDeps({}); });

// ─── The library ────────────────────────────────────────────────────────────────────────────

const TENANT = '44444444-4444-4444-8444-444444444444';
const SENDER = 'user-1';

let rowNo = 0;
function reel(over: Partial<LibraryRow> & { result?: Row }): LibraryRow {
    const id = `00000000-0000-4000-8000-${String(++rowNo).padStart(12, '0')}`;
    return {
        id, creator_id: TENANT, ig_media_id: `ig${rowNo}`, permalink: null, youtube_url: null, posted_at: '2026-10-01T10:00:00.000Z', status: 'ok', model: 'muse-spark-1.3', ms: 30_000, usd: 0.02,
        created_at: '2026-10-30T08:00:00.000Z', updated_at: '2026-10-30T08:00:00.000Z', ...over,
        result: { topics: ['a topic'], seen_on_screen: ['a screen'], narration: '', key_moments: [], hook_first_3s: '', hook_score: 6, caption_ar: '', cover_second: 1, cover_reason: '', ...over.result },
    };
}

const DECORATORS_LINK = 'https://www.instagram.com/reel/DECOR8TORS/';
const DOCKER_LINK = 'https://www.youtube.com/watch?v=Zm9vYmFyYmF6';
const DOCKER_AT_7 = `${DOCKER_LINK}&t=7s`;
const GIT_LINK = 'https://www.instagram.com/reel/G1TREBASE/';

/** Reel 1, the oldest: only on Instagram. */
const DECORATORS = reel({
    ig_media_id: '1001', permalink: DECORATORS_LINK, posted_at: '2026-10-01T10:00:00.000Z',
    result: { summary: 'Python decorators: a function that wraps another function, shown with a timer.', key_moments: [{ second: 5, what: 'the @ syntax' }, { second: 21, what: 'a timing example' }] },
});
/** Reel 2: on Instagram and on YouTube, so the link can start at the second. */
const DOCKER = reel({
    ig_media_id: '1002', permalink: 'https://www.instagram.com/reel/D0CKERVOL/', youtube_url: DOCKER_LINK, posted_at: '2026-10-10T10:00:00.000Z',
    result: { summary: 'Docker volumes keep a container\'s data after it stops, shown with docker run -v.', key_moments: [{ second: 7, what: 'the -v flag' }, { second: 30, what: 'data survives a restart' }] },
});
/** Reel 3, the newest: its summary holds a number the guard must let through only because the video's line gives it. */
const GIT = reel({
    ig_media_id: '1003', permalink: GIT_LINK, posted_at: '2026-10-20T10:00:00.000Z',
    result: { summary: 'Git rebase in 3 steps, drawn as two branches.', key_moments: [{ second: 12, what: 'the rebased history' }] },
});
const LIBRARY = [DECORATORS, DOCKER, GIT];

// ─── The world ──────────────────────────────────────────────────────────────────────────────

interface Executed { sql: string; params: any[] }

const STATE: Row = { stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 };
const NO_SOURCE: Row = {
    current_source: null, interaction_id: null, recent_campaign: null, recipient_id: null, replied_at: null,
    recent_keywords: null, recent_template: null, current_keywords: null, current_template: null,
};
const AGENT = { is_active: true, system_prompt: 'You answer followers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7, engine: 'gemini', gemini_fallback: true, sales_mode: 'on', sales_test_senders: [] };

const saying = (json: Record<string, unknown>) => async (): Promise<AiGenerateResult> => ({
    json, usage: { in: 4000, out: 120 }, billed: [], model: 'muse-spark-1.3', provider: 'meta', stopReason: 'end_turn', elapsed_ms: 900, usd: 0.01, priced: true, costSource: 'table', effort: 'low', route: 'saved', usageId: '7',
});
const reply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'It is a twelve-week plan for busy parents.', quick_replies: [], ...over,
});
/** What the recall call answers. */
const found = (match: number, second: number): Record<string, unknown> => ({ is_content_request: true, match, second, why: 'it covers it' });
const NO_REEL: Record<string, unknown> = { is_content_request: true, match: 0, second: 0, why: 'nothing on it' };
const NOT_ASKING: Record<string, unknown> = { is_content_request: false, match: 0, second: 0, why: 'a price question' };

const ASK = 'Do you have a video about docker volumes?';

interface World {
    text?: string;
    payload?: string;
    pageId?: string;
    perceived?: PerceivedTurn;
    transport?: SalesTransport;
    profile?: CreatorProfile;
    /** Over the agent's row: the owner's settings for the reply (`gemini_fallback`). */
    agent?: Partial<typeof AGENT>;
    /** The recall call's answer: JSON, or a function that throws. */
    recall?: Record<string, unknown> | (() => Promise<never>);
    /** The sales model's answer, by the number of its call (1 is the first). */
    dm?: (call: number) => Record<string, unknown>;
    /** The model call itself, for a failure. */
    dmLayer?: (args: AiGenerateArgs, call: number) => Promise<AiGenerateResult>;
    /** What `setRecallDeps` is told; `'real'` installs nothing, so the real gate reads the (empty) settings: every tenant's default, everything off. */
    deps?: RecallDeps | 'real';
}

interface Run {
    result: SalesTurnResult | null;
    error: any;
    executed: Executed[];
    sends: { url: string; body: any }[];
    layerCalls: AiGenerateArgs[];
    geminiCalls: number;
    logged: { level: string; event: string; [k: string]: unknown }[];
    /** What happened in what order: model calls by purpose, and `mark_seen` / `typing_on` as they went out. */
    order: string[];
}

const ALLOW: RecallDeps = { gate: async () => ({ ok: true }), library: async () => LIBRARY };

async function run(world: World = {}): Promise<Run> {
    const profile = world.profile ?? withSales(FITNESS_EN, 'en');
    const text = world.text ?? ASK;
    const executed: Executed[] = [];
    const sends: Run['sends'] = [];
    const layerCalls: AiGenerateArgs[] = [];
    const logged: Run['logged'] = [];
    const order: string[] = [];
    let geminiCalls = 0;
    let dmCalls = 0;

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    const previousSink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    const previousCaller = setAiCaller(async (args) => {
        layerCalls.push(args);
        order.push(args.purpose);
        if (args.purpose === 'recall') {
            const answer = world.recall ?? found(2, 7);
            if (typeof answer === 'function') return answer();
            return saying(answer)();
        }
        dmCalls++;
        if (world.dmLayer) return world.dmLayer(args, dmCalls);
        return saying(world.dm ? world.dm(dmCalls) : reply())();
    });
    const previousQueue = setJobQueue({
        async enqueue() { return 'job-1'; }, async claim() { return []; }, async complete() {}, async fail() {}, async reapStale() { return 0; }, async releaseUnrun() { return 0; }, async pruneCompleted() { return 0; },
    } as any);
    const previousDeps = world.deps === 'real' ? setRecallDeps({}) : setRecallDeps(world.deps ?? ALLOW);

    const routes: Array<[RegExp, { rows?: any[]; rowCount?: number }]> = [
        [/LEFT JOIN LATERAL/, { rows: [NO_SOURCE] }],
        [/FROM app_settings WHERE key/, { rows: [] }],
        [/UPDATE conversations\s+SET last_inbound_at/, { rows: [STATE] }],
        [/FROM ai_agents/, { rows: [{ ...AGENT, ...(world.agent ?? {}) }] }],
        [/SELECT direction, text/, { rows: [{ sender: 'customer', payload: null, raw_payload: null, direction: 'inbound', text }] }],
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
    (axios as any).post = async () => { geminiCalls++; return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'رد احتياطي' }) }] } }] } }; };
    (metaHttp as any).post = async (url: string, body: any) => {
        sends.push({ url, body });
        if (body?.sender_action) order.push(body.sender_action);
        return { data: { message_id: 'sent-1' } };
    };

    const input: SalesTurnInput = {
        creator: { id: TENANT, page_access_token: 'EAAGplaintext' },
        pageId: world.pageId,
        conversation: { id: 'conv-1' },
        inbound: { id: 'msg-1', senderId: SENDER, text, ...(world.payload ? { payload: world.payload } : {}) },
        ctx: contextFor(throughJsonb(profile), 'dm', 3),
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
        setLogSink(previousSink);
        setRecallDeps(previousDeps);
    }
    return { result, error, executed, sends, layerCalls, geminiCalls, logged, order };
}

const messages = (r: Run) => r.sends.filter((s) => s.body.message);
const sentText = (r: Run): string => String(messages(r)[0]!.body.message.text);
const purposes = (r: Run): string[] => r.layerCalls.map((c) => String(c.purpose));
const dmCall = (r: Run): AiGenerateArgs => r.layerCalls.find((c) => c.purpose !== 'recall')!;
const lastUserTurn = (call: AiGenerateArgs): string => { const turns = call.user as { role: string; text: string }[]; return turns[turns.length - 1]!.text; };
function record(r: Run): Record<string, any> {
    const e = r.executed.find((x) => /UPDATE conversations SET stage/.test(x.sql));
    assert.ok(e, 'the turn was recorded');
    const [, , stage, , , intent, , , pauseBot, handoffReason, stampHandoff, , type, text, , aiMeta] = e!.params;
    return { stage, intent, pauseBot, handoffReason, stampHandoff, type, text, aiMeta: aiMeta === undefined ? undefined : JSON.parse(aiMeta) };
}
const count = (text: string, part: string): number => text.split(part).length - 1;
const ordinaryKeys = ['attempts', 'engine', 'guard', 'handoff_reason', 'intent', 'latency_ms', 'model', 'model_ms', 'next_action', 'offer_id', 'proposed_action', 'proposed_stage', 'provider', 'stage', 'usage_id'];

// ─── A match ────────────────────────────────────────────────────────────────────────────────

describe('recall in the turn: a match', () => {
    const WATCH = reply({ text: `Yes, there is one on exactly that. Watch it from 0:07: ${DOCKER_AT_7}` });

    it('asks the library first and the sales model second, and tells the model the video as a fact in front of the customer\'s message, not in the cached system text', async () => {
        const r = await run({ dm: () => WATCH });

        assert.equal(r.error, null);
        assert.deepEqual(purposes(r), ['recall', 'dm']);
        const call = dmCall(r);
        const header = kitFor({ code: 'en', register: null }).sales.headers.conversation;
        const last = lastUserTurn(call);
        const line = last.split('\n').find((l) => l.startsWith('Relevant video: '))!;
        assert.ok(last.startsWith(header), 'the facts open the last user turn');
        assert.ok(line.startsWith(`Relevant video: ${DOCKER_AT_7} (watch from 0:07): Docker volumes keep a container's data after it stops, shown with docker run -v. `), line);
        assert.ok(last.indexOf(line) < last.indexOf(ASK), 'the fact is before the message');
        assert.ok(last.endsWith(ASK));
        assert.ok(!String(call.system).includes('Relevant video'), 'the cacheable text does not move');
    });

    it('leaves the cacheable system text exactly what it is for a turn with no recall', async () => {
        const withRecall = await run({ dm: () => WATCH });
        const without = await run({ text: 'How much is the plan?' });
        assert.equal(String(dmCall(withRecall).system), String(dmCall(without).system));
        assert.equal(dmCall(withRecall).cacheSystem, true);
    });

    it('sends the reply with the video\'s link and the second, the link allowed for this reply only: nothing is refused, nothing asked again', async () => {
        const r = await run({ dm: () => WATCH });

        assert.equal(messages(r).length, 1);
        assert.equal(sentText(r), `Yes, there is one on exactly that. Watch it from 0:07: ${DOCKER_AT_7}`);
        assert.ok(!r.logged.some((l) => l.event === 'dm.claim_blocked'), 'the second is the line\'s, so it is no invented number');
        assert.equal(r.layerCalls.length, 2);
        assert.equal(record(r).aiMeta.guard.links_removed, 0);
        assert.deepEqual(record(r).aiMeta.guard.violations, []);
    });

    it('records recalled: true and a one-line reason the code builds, with no key of perception', async () => {
        const r = await run({ dm: () => WATCH });
        const meta = record(r).aiMeta;
        assert.equal(meta.recalled, true);
        assert.equal(meta.reason, 'Found a video in the library (from 0:07); answered from the account\'s own information, because they want to know more.');
        assert.ok(!('perceived' in meta));
        assert.equal(meta.engine, 'providers');
        assert.ok(meta.reason.length <= 200 && !/\n/.test(meta.reason));
    });

    it('says the action the CODE settled on in the reason, not the model\'s words about the video', async () => {
        const r = await run({ dm: () => reply({ text: `Here: ${DOCKER_AT_7}`, intent: 'price', next_action: 'reply' }) });
        assert.equal(record(r).aiMeta.reason, 'Found a video in the library (from 0:07); answered from the account\'s own information, because they asked about the price.');
    });

    it('links the Instagram page and says nothing of a second for a reel that starts the answer', async () => {
        const r = await run({ text: 'any reel on decorators?', recall: found(1, 0), dm: () => reply({ text: `This one: ${DECORATORS_LINK}` }) });
        const line = lastUserTurn(dmCall(r)).split('\n').find((l) => l.startsWith('Relevant video: '))!;
        assert.ok(line.startsWith(`Relevant video: ${DECORATORS_LINK}: Python decorators`), line);
        assert.equal(record(r).aiMeta.reason, 'Found a video in the library; answered from the account\'s own information, because they want to know more.');
    });

    it('a number in the video\'s summary may be repeated, because the line is among the guard\'s facts; the same reply with no recall is refused', async () => {
        const says = reply({ text: `It breaks it into 3 steps: ${GIT_LINK} from 0:12` });
        const r = await run({ text: 'is there a reel on rebase?', recall: found(3, 12), dm: () => says });
        assert.equal(r.layerCalls.length, 2);
        assert.ok(!r.logged.some((l) => l.event === 'dm.claim_blocked'));
        assert.ok(sentText(r).includes('3 steps'));

        const control = await run({ text: 'is there a reel on rebase?', deps: { gate: async () => ({ ok: false, reason: 'switch_off' }) }, dm: (call) => (call === 1 ? says : reply({ text: 'There is a short one on it.' })) });
        assert.ok(control.logged.some((l) => l.event === 'dm.claim_blocked'), 'without the line, 3 and 0:12 are numbers the data does not give');
        assert.ok(!sentText(control).includes('3 steps'));
    });

    it('refuses a second the line does not give, asks again once with the correction, and never sends it', async () => {
        const r = await run({ dm: (call) => (call === 1 ? reply({ text: `Watch ${DOCKER_AT_7} from 5:42` }) : WATCH) });

        assert.deepEqual(purposes(r), ['recall', 'dm', 'dm']);
        assert.match(lastUserTurn(r.layerCalls[2]!), /NOT sent/);
        assert.ok(r.logged.some((l) => l.event === 'dm.claim_blocked'));
        assert.ok(!sentText(r).includes('5:42'));
        assert.ok(sentText(r).includes('0:07'));
        assert.equal(record(r).aiMeta.attempts, 2);
    });
});

// ─── The link is always the video's ─────────────────────────────────────────────────────────

describe('recall in the turn: the reply carries the video\'s link, exactly once and exactly as it is', () => {
    it('adds it after the words when the model left it out (the rules in the prompt say never to write a link)', async () => {
        const r = await run({ dm: () => reply({ text: 'Yes, there is one on exactly that: start at 0:07.' }) });
        assert.equal(sentText(r), `Yes, there is one on exactly that: start at 0:07.\n${DOCKER_AT_7}`);
        assert.equal(count(sentText(r), DOCKER_AT_7), 1);
        assert.equal(record(r).aiMeta.recalled, true);
    });

    it('takes out a link the model altered (the second dropped) and adds the exact one: the customer never gets a link that goes somewhere else', async () => {
        const r = await run({ dm: () => reply({ text: `Watch it here ${DOCKER_LINK}&t=99s from 0:07` }) });
        assert.equal(count(sentText(r), 'youtube.com'), 1);
        assert.ok(sentText(r).endsWith(`\n${DOCKER_AT_7}`));
        assert.ok(!sentText(r).includes('t=99s'));
        assert.equal(record(r).aiMeta.guard.links_removed, 1);
    });

    it('does not add it twice when the model wrote it in another form the guard accepts: no www, no scheme, no closing slash', async () => {
        const r = await run({ text: 'any reel on decorators?', recall: found(1, 0), dm: () => reply({ text: 'Here it is: instagram.com/reel/DECOR8TORS' }) });
        assert.equal(sentText(r), 'Here it is: instagram.com/reel/DECOR8TORS');
        assert.equal(record(r).aiMeta.guard.links_removed, 0);
    });

    it('puts the video\'s link before the offer\'s when the model also sends the offer: both are the server\'s, each once', async () => {
        const r = await run({ dm: () => reply({ text: 'That one covers it, and the plan goes further.', next_action: 'send_link', offer_id: 'plan', stage: 'link', intent: 'info' }) });
        const text = sentText(r);
        assert.ok(text.endsWith(`\n${DOCKER_AT_7}\nhttps://samifit.example/plan`) || text.includes(`\n${DOCKER_AT_7}\n`), text);
        assert.equal(count(text, DOCKER_AT_7), 1);
        assert.equal(count(text, 'samifit.example/plan'), 1);
        assert.ok(Buffer.byteLength(text, 'utf8') <= 900);
        assert.equal(record(r).aiMeta.recalled, true);
    });

    it('is never added to a hand-off or any line that is not the model\'s own words: the kit\'s line goes alone, and nothing says a video was recalled', async () => {
        const r = await run({ dm: () => reply({ text: 'Let me check.', next_action: 'handoff', handoff_reason: 'unsure', stage: 'handoff', intent: 'support' }) });
        assert.equal(sentText(r), kitFor({ code: 'en', register: null }).sales.lines.unsure('Sami Fitness'), 'the kit\'s own line, with no link after it');
        assert.ok(!sentText(r).includes('youtube.com'));
        assert.ok(!('recalled' in record(r).aiMeta) && !('reason' in record(r).aiMeta));
    });
});

// ─── The guard ──────────────────────────────────────────────────────────────────────────────

describe('recall in the turn: the guard still refuses a library permalink that was not recalled', () => {
    it('with a reel recalled: another reel\'s permalink is taken out, the recalled one stays', async () => {
        const r = await run({ dm: () => reply({ text: `This one ${DOCKER_AT_7} and also ${DECORATORS_LINK} and ${GIT_LINK}, from 0:07.` }) });
        assert.ok(sentText(r).includes(DOCKER_AT_7));
        assert.ok(!sentText(r).includes('DECOR8TORS') && !sentText(r).includes('G1TREBASE'), sentText(r));
        assert.equal(record(r).aiMeta.guard.links_removed, 2);
    });

    it('with "no video on this topic yet": no link is allowed, so a permalink the model writes anyway is taken out and nothing says a video was recalled', async () => {
        const r = await run({ text: 'do you have a video on kubernetes?', recall: NO_REEL, dm: () => reply({ text: `Not yet, but try ${DECORATORS_LINK}` }) });
        assert.ok(!sentText(r).includes('instagram.com'), sentText(r));
        assert.equal(sentText(r), 'Not yet, but try');
        const meta = record(r).aiMeta;
        assert.ok(!('recalled' in meta));
        assert.equal(meta.guard.links_removed, 1);
    });

    it('with the memory switch off: every permalink the model writes is taken out, like any link the data does not give', async () => {
        const r = await run({ deps: 'real', dm: () => reply({ text: `Try ${DOCKER_AT_7} or ${DECORATORS_LINK}` }) });
        assert.ok(!/youtube|instagram/.test(sentText(r)), sentText(r));
        assert.equal(record(r).aiMeta.guard.links_removed, 2);
    });
});

// ─── No match ───────────────────────────────────────────────────────────────────────────────

describe('recall in the turn: no match is told honestly', () => {
    it('tells the model "No video on this topic yet" with no link, and the reply says so; no `recalled`, and a reason that says the library had nothing', async () => {
        const r = await run({ text: 'do you have a video on kubernetes?', recall: NO_REEL, dm: () => reply({ text: 'I do not have a video on that yet.' }) });
        const last = lastUserTurn(dmCall(r));
        assert.ok(last.includes('No video on this topic yet. Tell them so honestly'), last);
        assert.ok(!last.includes('Relevant video'));
        assert.ok(!/https?:\/\//.test(last.split('\n').find((l) => l.startsWith('No video'))!));
        assert.equal(sentText(r), 'I do not have a video on that yet.');
        const meta = record(r).aiMeta;
        assert.ok(!('recalled' in meta));
        assert.equal(meta.reason, 'Looked in the video library and found nothing on it; answered from the account\'s own information, because they want to know more.');
    });

    it('a message the model says is not a request for content adds no line, no key and no reason: the turn is an ordinary one that spent one more call', async () => {
        const r = await run({ text: 'how much is the video plan?', recall: NOT_ASKING });
        assert.deepEqual(purposes(r), ['recall', 'dm']);
        assert.ok(!/Relevant video|No video/.test(lastUserTurn(dmCall(r))));
        assert.deepEqual(Object.keys(record(r).aiMeta).sort(), ordinaryKeys);
    });
});

// ─── Memory off ─────────────────────────────────────────────────────────────────────────────

describe('recall in the turn: with the memory switch off the turn is today\'s turn', () => {
    it('asks no recall model and reads no library, whatever the message says: the real gate reads the tenant\'s own settings, which are off', async () => {
        const r = await run({ deps: 'real' });

        assert.equal(r.error, null);
        assert.deepEqual(purposes(r), ['dm'], 'one model call, the sales turn\'s');
        assert.ok(!r.executed.some((e) => /reel_analyses/.test(e.sql)), 'the library was not read');
        assert.ok(!/Relevant video|No video/.test(lastUserTurn(dmCall(r))));
        assert.deepEqual(Object.keys(record(r).aiMeta).sort(), ordinaryKeys, 'not one key more in ai_meta than an ordinary reply has');
        assert.equal(messages(r).length, 1);
    });

    it('is the same facts and the same system text as the same message with no cue in it: byte for byte, whatever the gate says', async () => {
        const cue = await run({ deps: { gate: async () => ({ ok: false, reason: 'switch_off' }) }, text: 'Do you have a video about the plan?' });
        const plain = await run({ text: 'Do you have an answer about the plan?' });
        assert.equal(String(dmCall(cue).system), String(dmCall(plain).system));
        const strip = (call: AiGenerateArgs, text: string): string => lastUserTurn(call).replace(text, '');
        assert.equal(strip(dmCall(cue), 'Do you have a video about the plan?'), strip(dmCall(plain), 'Do you have an answer about the plan?'));
        assert.deepEqual(purposes(cue), ['dm']);
    });

    it('a refused sender or a cap reached is the same: the gate said no, so there is no call and no line', async () => {
        for (const reason of ['not_allowed_sender', 'budget', 'no_key'] as const) {
            const r = await run({ deps: { gate: async () => ({ ok: false, reason }), library: async () => { throw new Error('the library was read'); } } });
            assert.deepEqual(purposes(r), ['dm'], reason);
            assert.deepEqual(Object.keys(record(r).aiMeta).sort(), ordinaryKeys, reason);
        }
    });

    it('an empty library is the same: nothing was watched yet, so there is nothing to ask', async () => {
        const r = await run({ deps: { gate: async () => ({ ok: true }), library: async () => [] } });
        assert.deepEqual(purposes(r), ['dm']);
        assert.ok(!/Relevant video|No video/.test(lastUserTurn(dmCall(r))));
    });

    it('a message with no cue never reaches a setting: the gate is not asked at all', async () => {
        let asked = 0;
        const r = await run({ text: 'How much is the plan?', deps: { gate: async () => { asked++; return { ok: true }; }, library: async () => LIBRARY } });
        assert.equal(asked, 0);
        assert.deepEqual(purposes(r), ['dm']);
    });
});

// ─── Who it is for ──────────────────────────────────────────────────────────────────────────

describe('recall in the turn: for an Instagram message in the customer\'s own words, and no other', () => {
    const REEL_DESCRIPTION = '[shared reel] Watched the reel. A short reel about editing a video with captions.';
    const noRecall = (r: Run, expected: string[] = ['dm']): void => {
        assert.deepEqual(purposes(r), expected);
        assert.ok(!/Relevant video|No video/.test(lastUserTurn(r.layerCalls[r.layerCalls.length - 1]!)));
        assert.ok(!('recalled' in record(r).aiMeta));
    };
    const askedGate = (): { deps: RecallDeps; asked: () => number } => {
        let asked = 0;
        return { deps: { gate: async () => { asked++; return { ok: true }; }, library: async () => LIBRARY }, asked: () => asked };
    };

    it('not WhatsApp: its words are not read by a provider that is not in its list, and the gate is not even asked', async () => {
        const g = askedGate();
        const transport: SalesTransport = { channel: 'whatsapp', send: async () => ({ wamid: 'w1' }), seen: async () => undefined, recorded: async () => undefined };
        const r = await run({ transport, deps: g.deps });
        assert.equal(g.asked(), 0);
        assert.deepEqual(purposes(r), ['dm_whatsapp']);
    });

    it('not Messenger: perception and recall are Instagram\'s', async () => {
        const g = askedGate();
        const r = await run({ pageId: '1234567890', deps: g.deps });
        assert.equal(g.asked(), 0);
        noRecall(r);
    });

    it('not a button the customer tapped, whatever its words say', async () => {
        const g = askedGate();
        const r = await run({ text: 'Do you have a video?', payload: 'ICEBREAKER_VIDEO', deps: g.deps });
        assert.equal(g.asked(), 0);
        noRecall(r);
    });

    it('not a model\'s description of what they sent: it says "reel" and "video" whatever they wanted, so a cue test could not mean anything', async () => {
        const g = askedGate();
        const r = await run({ text: REEL_DESCRIPTION, perceived: { kind: 'reel', describedText: true, sent: perceivedFact({ kind: 'reel', status: 'ok', seen: 'A short reel about editing a video.', about_owner: 'other_content' }) }, deps: g.deps });
        assert.equal(g.asked(), 0);
        noRecall(r);
        assert.equal(record(r).aiMeta.perceived, true);
        assert.ok(!('recalled' in record(r).aiMeta));
    });

    it('but a reply to a story that has WORDS is the customer\'s own words: the library is looked into, and the trace says both', async () => {
        const sent = perceivedFact({ kind: 'story_reply', status: 'ok', seen: 'A story with a barbell.', about_owner: 'own_content' });
        const r = await run({ perceived: { kind: 'story_reply', describedText: false, sent }, dm: () => reply({ text: `Yes: ${DOCKER_AT_7}` }) });

        assert.deepEqual(purposes(r), ['recall', 'dm']);
        const last = lastUserTurn(dmCall(r));
        assert.ok(last.indexOf('What the customer sent: a reply to the account') < last.indexOf('Relevant video: '), 'what they sent, then the video');
        const meta = record(r).aiMeta;
        assert.equal(meta.perceived, true);
        assert.equal(meta.recalled, true);
        assert.equal(meta.reason, 'Read a reply to the account\'s story, and found a video in the library (from 0:07); answered from the account\'s own information, because they want to know more.');
    });

    it('a typed message in Arabic, with a voice-note transcript\'s shape (their own words, no perception): the same path', async () => {
        const r = await run({ text: 'عندك فيديو بيشرح docker؟', dm: () => reply({ text: `أيوه: ${DOCKER_AT_7}` }) });
        assert.deepEqual(purposes(r), ['recall', 'dm']);
        assert.equal(record(r).aiMeta.recalled, true);
    });
});

// ─── It never costs the turn ────────────────────────────────────────────────────────────────

describe('recall in the turn: it never costs the turn', () => {
    it('starts typing before the library is asked, and only once', async () => {
        const r = await run({ dm: () => reply({ text: `Here: ${DOCKER_AT_7}` }) });
        const seen = r.order.indexOf('mark_seen');
        const typing = r.order.indexOf('typing_on');
        assert.ok(seen >= 0 && typing >= 0);
        assert.ok(seen < r.order.indexOf('recall') && typing < r.order.indexOf('recall'), `${r.order.join(' > ')}`);
        assert.deepEqual(r.order.filter((o) => o === 'mark_seen' || o === 'typing_on'), ['mark_seen', 'typing_on'], 'not sent a second time before the reply');
    });

    it('starts typing where it always did for a turn that has no recall in it', async () => {
        const r = await run({ text: 'How much is the plan?' });
        assert.deepEqual(r.order, ['mark_seen', 'typing_on', 'dm']);
    });

    it('a recall that fails changes nothing: the customer is answered as they would have been, with no line and no key', async () => {
        const r = await run({ recall: async () => { throw new AiError({ kind: 'server', provider: 'meta', model: 'muse-spark-1.3', message: 'a server failure' }); }, dm: () => reply({ text: 'Let me find that for you.' }) });
        assert.equal(r.error, null);
        assert.deepEqual(purposes(r), ['recall', 'recall', 'dm'], 'one retry, as the layer allows, then the turn goes on');
        assert.equal(sentText(r), 'Let me find that for you.');
        assert.ok(!/Relevant video|No video/.test(lastUserTurn(dmCall(r))));
        assert.deepEqual(Object.keys(record(r).aiMeta).sort(), ordinaryKeys);
        assert.ok(r.logged.some((l) => l.event === 'recall.failed' && l['outcome'] === 'server'));
    });

    it('a failure of the gate itself is the same', async () => {
        const r = await run({ deps: { gate: async () => { throw new Error('boom'); }, library: async () => LIBRARY } });
        assert.equal(r.error, null);
        assert.deepEqual(purposes(r), ['dm']);
        assert.equal(messages(r).length, 1);
    });

    it('a sales model that then fails is answered as any text turn is (Gemini once, as the owner set it), and nothing says a video was recalled', async () => {
        const r = await run({ dmLayer: async () => { throw new AiError({ kind: 'server', provider: 'meta', model: 'muse-spark-1.3', message: 'a server failure' }); } });
        assert.equal(r.geminiCalls, 1);
        const meta = record(r).aiMeta;
        assert.equal(meta.engine, 'gemini_fallback');
        assert.ok(!('recalled' in meta) && !('reason' in meta));
    });

    it('with Gemini\'s fallback off it is a hand-off with the kit\'s line, and nothing says a video was recalled: the reply did not use it', async () => {
        const r = await run({ agent: { gemini_fallback: false }, dmLayer: async () => { throw new AiError({ kind: 'auth', provider: 'meta', model: 'muse-spark-1.3', message: 'refused' }); } });
        assert.equal(r.geminiCalls, 0);
        assert.equal(sentText(r), 'The account owner will reply soon.');
        const meta = record(r).aiMeta;
        assert.equal(meta.engine, 'rule');
        assert.ok(!('recalled' in meta) && !('reason' in meta));
        assert.equal(record(r).pauseBot, true);
    });
});
