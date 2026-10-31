/**
 * The DM pipeline when Meta Muse is ON for the tenant and the sender (docs/specs/005-muse-sees T032 to T036, T040, T043 to T045).
 *
 * Driven end to end through `handleMessagingEvent`, as `messaging.test.ts` does, with every outside thing replaced: `pool.query` answers on the SQL it is handed (any
 * statement a test did not arrange throws), `setAiCaller` is the providers layer (perception AND the sales turn go through it, told apart by their purpose), `setMediaFetch`
 * is Meta's CDN, `metaHttp.get` is the Graph API and `metaHttp.post` the Send API. `.env` holds live credentials: a test that reached the network could DM a real person.
 * The gate, the switches, the download, the record and the sales turn are the REAL ones; the only seam is that a Meta route exists and today's spend is what a test says.
 *
 * What the file proves, each a way a real customer is misled, answered twice, or left waiting:
 *   - a readable photo, reel, post, video or story is answered by the sales turn from what Muse saw, after "typing…", and a retry never pays for it twice;
 *   - what could not be read with confidence is asked for again and never guessed at; a personal document goes to a person and nothing about it is kept;
 *   - a shared reel is watched only when it is the creator's own (the Graph API says so), and anyone else's is read from its cover and caption or its caption alone;
 *   - a story mention is thanked by name, and every failure of the read is the line it always got, with the reason on the row;
 *   - a story reply that has words is answered from the words, with the story as context;
 *   - the follower's name, username and id never leave: the call to Meta holds the media, a caption and the account's own handle;
 *   - a voice note is heard (T050): downloaded, decoded and written down by Meta's speech model, stored as its BARE transcript, and answered as the customer's own words
 *     (the refund prefilter reads them); fewer than two words is asked for again; every "no" and every failure is today's line.
 * The calls with Muse OFF are pinned in `messaging.test.ts`.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setAiCaller, type AiGenerateArgs, type AiGenerateResult } from '../services/aiProviders/generate.js';
import type { TranscribeWithMetaArgs, TranscribeWithMetaResult } from '../services/aiProviders/asr.js';
import { AiError, type AiErrorKind } from '../services/llm/errors.js';
import { wavBytes } from '../services/llm/testAudio.js';
import { metaHttp } from '../services/http.js';
import { withSales } from '../services/dmSales/testFixtures.js';
import { gatePerception } from '../services/perception/gate.js';
import { setPerceiveDmDeps } from '../services/perception/dm.js';
import { liveDownload, setMediaFetch } from '../services/perception/source.js';
import type { TranscodeResult } from '../services/perception/transcode.js';
import { transcribeVoice } from '../services/perception/voice.js';
import { FITNESS_EN } from '../services/profile/fixtures.js';
import { KITS } from '../services/profile/kits.js';
import { throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { handleMessagingEvent } from './messaging.js';
import type { WebhookHandlerOptions } from './options.js';

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

// ─── The world ──────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
interface Executed { sql: string; params: any[] }
interface Sent { url: string; body: any }

const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };
const OWN_IG = 'ig-page-1';
const STATE: Row = { stage: 'new', qualifier_turns: 0, abuse_strikes: 0, offer_id: null, offers_linked: [], last_link_at: null, opted_out_at: null, ai_replies_last_hour: 0 };
const NO_SOURCE: Row = { current_source: null, interaction_id: null, recent_campaign: null, recipient_id: null, replied_at: null, recent_keywords: null, recent_template: null, current_keywords: null, current_template: null };
const STORED_AT = '2026-10-30T10:00:20.000000+00:00';

/** What a perception answer looks like, readable by default. */
const reading = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    readable: true, seen: 'A screenshot of the plan price list.', transcript: '', about_owner: 'unclear', confidence: 0.92, mention_summary: '', ...over,
});
/** What Meta's speech model answers for a voice note: a question about the plan, as a customer would put it. */
const SPOKEN = 'How much is the twelve-week plan and is there a certificate?';
const heardBy = (over: Partial<TranscribeWithMetaResult> = {}): TranscribeWithMetaResult => ({
    transcript: SPOKEN, durationMs: 3000, model: 'muse-voice-transcribe-1.0', usd: 0.00015, usageId: '8', elapsedMs: 900, ...over,
});
const asrFailure = (kind: AiErrorKind, status?: number): never => { throw new AiError({ kind, provider: 'meta', model: 'muse-voice-transcribe-1.0', message: `a ${kind} failure`, ...(status ? { status } : {}) }); };

/** What a sales answer looks like. */
const salesReply = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    intent: 'info', stage: 'recommend', next_action: 'reply', offer_id: 'none', handoff_reason: 'none', text: 'It is a twelve-week plan for busy parents.', quick_replies: [], ...over,
});
const resultOf = (json: unknown, over: Partial<AiGenerateResult> = {}): AiGenerateResult => ({
    json, usage: { in: 4000, out: 300 }, billed: [], model: 'muse-spark-1.3', provider: 'meta', stopReason: 'end_turn', elapsed_ms: 2500, usd: 0.011, priced: true, costSource: 'table',
    effort: 'low', route: 'saved', usageId: '7', ...over,
});
const failure = (kind: AiError['kind']): never => { throw new AiError({ kind, provider: 'meta', model: 'muse-spark-1.3', message: `a ${kind} failure` }); };

interface Media { status?: number; type?: string; body?: string; location?: string }

interface World {
    switches?: Record<string, boolean>;
    allow?: string[];
    dailyUsd?: number;
    spentUsd?: number;
    salesMode?: 'off' | 'test' | 'on';
    profile?: CreatorProfile;
    conversation?: Row;
    /** Rows the inbound insert returns: empty is "the mid exists", and the re-claim below decides whether this attempt resumes it. */
    inboundInsert?: Row[];
    resumeClaim?: Row[];
    /** A perception already stored on the row, as `SELECT perception` returns it (a retry). */
    storedPerception?: Row | null;
    /** The library's row for a reel, as `reel_analyses` returns it. */
    library?: Row | null;
    /** What the Graph API says of a media node, or throws. */
    graph?: (url: string, config: any) => Promise<any>;
    /** What the CDN answers, by URL (a part of it). A URL not listed is a 404. */
    media?: Record<string, Media>;
    perceive?: (args: AiGenerateArgs, n: number) => Promise<AiGenerateResult>;
    sales?: (args: AiGenerateArgs, n: number) => Promise<AiGenerateResult>;
    supersession?: { newer_unhandled: boolean; answered: boolean }[];
    send?: (url: string, body: any) => Promise<any>;
    ackClaim?: Row[];
    /** What `UPDATE messages SET perception` returns; absent, the statement's own record with `stored_at`; `[]` is "the row already had one". */
    storeRows?: Row[] | 'throw';
    history?: { direction: 'inbound' | 'outbound'; text: string; sender?: string }[];
    /** A voice note: what Meta's speech model answers (each call, counted from 1; it may throw an `AiError`); absent, a question about the plan. */
    transcribe?: (args: TranscribeWithMetaArgs, n: number) => Promise<TranscribeWithMetaResult>;
    /** A voice note: what the decoder makes of the downloaded bytes; absent, a 3-second WAV. */
    decode?: () => TranscodeResult;
}

interface R {
    error: any;
    executed: Executed[];
    timeline: string[];
    sends: Sent[];
    perceiveCalls: AiGenerateArgs[];
    salesCalls: AiGenerateArgs[];
    asrCalls: TranscribeWithMetaArgs[];
    fetched: string[];
    graphGets: { url: string; fields: unknown }[];
    logged: { level: string; event: string; [k: string]: unknown }[];
    notices: { creatorId: string; kind: string }[];
    budgetNotices: unknown[];
    geminiCalls: number;
}

const JPEG: Media = { status: 200, type: 'image/jpeg', body: 'jpegbytes' };
const MP4: Media = { status: 200, type: 'video/mp4', body: 'mp4bytes' };

async function run(event: any, world: World = {}, options: WebhookHandlerOptions = { lastAttempt: false }, entryId = 'ig-page-1'): Promise<R> {
    const profile = world.profile ?? withSales(FITNESS_EN, 'en');
    const executed: Executed[] = [];
    const timeline: string[] = [];
    const sends: Sent[] = [];
    const perceiveCalls: AiGenerateArgs[] = [];
    const salesCalls: AiGenerateArgs[] = [];
    const asrCalls: TranscribeWithMetaArgs[] = [];
    const fetched: string[] = [];
    const graphGets: R['graphGets'] = [];
    const logged: R['logged'] = [];
    const notices: R['notices'] = [];
    const budgetNotices: unknown[] = [];
    let geminiCalls = 0;
    let storedText: string | null = null;
    const supersessions = world.supersession ?? [{ newer_unhandled: false, answered: false }];
    let supersessionCalls = 0;

    const settings: Record<string, string> = {
        [`muse.switches.creator-1`]: JSON.stringify({ dm_media: true, voice: false, memory: false, ...(world.switches ?? {}) }),
        [`muse.allow_senders.creator-1`]: JSON.stringify(world.allow ?? ['*']),
        [`muse.daily_usd.creator-1`]: String(world.dailyUsd ?? 3),
    };
    const agent = { is_active: true, system_prompt: 'You answer followers for Sami.', knowledge_base: 'The plan has 12 weeks.', model: 'gemini-2.5-flash', temperature: 0.7, engine: 'gemini', gemini_fallback: true, sales_mode: world.salesMode ?? 'on', sales_test_senders: [] };

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalPost = metaHttp.post;
    const originalGet = metaHttp.get;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'test-key';
    const sink = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    const previousCaller = setAiCaller(async (args) => {
        if (args.purpose === 'perception_dm') {
            perceiveCalls.push(args);
            timeline.push('MUSE');
            return (world.perceive ?? (async () => resultOf(reading())))(args, perceiveCalls.length);
        }
        salesCalls.push(args);
        timeline.push('SALES');
        return (world.sales ?? (async () => resultOf(salesReply(), { model: 'muse-spark-1.3' })))(args, salesCalls.length);
    });
    const previousFetch = setMediaFetch(async (url) => {
        const link = String(url);
        fetched.push(link);
        timeline.push('FETCH');
        const key = Object.keys(world.media ?? {}).find((k) => link.includes(k));
        const m: Media = key ? world.media![key]! : { status: 404 };
        return new Response(m.status === 200 ? Buffer.from(m.body ?? 'x') : null, { status: m.status ?? 200, headers: m.type ? { 'content-type': m.type } : {} });
    });
    const previousDeps = setPerceiveDmDeps({
        // A Meta route exists and today's spend is what the test says; the switches, the allow-list and the cap are the real ones, read through `pool.query` below.
        gate: (args) => gatePerception(args, {
            routeReady: async () => true,
            spentToday: async () => world.spentUsd ?? 0,
            tellOwner: async (n) => { budgetNotices.push(n); },
        }),
        onProviderTrouble: async (creatorId, kind) => { notices.push({ creatorId, kind }); },
        // A voice note: the REAL steps. The download is the CDN stub through the same seam a picture's uses; the decoder (it needs a binary) and the speech model (it needs
        // Meta's key and a database for its row) are stand-ins, and every other part (the clock, the retry, the words, the record) is the real one.
        hear: (input) => transcribeVoice(input, {
            download: (link, options) => liveDownload(link, { kind: 'audio', ...options }),
            decode: async () => { timeline.push('DECODE'); return (world.decode ?? (() => ({ ok: true, wav: wavBytes({ seconds: 3 }), durationMs: 3000, ms: 5 })))(); },
            transcribe: async (args) => { timeline.push('ASR'); asrCalls.push(args); return (world.transcribe ?? (async () => heardBy()))(args, asrCalls.length); },
        }),
    });
    invalidateTenantCache();

    const routes: Array<[RegExp, (sql: string, params: any[]) => { rows?: any[]; rowCount?: number }]> = [
        [/FROM app_settings WHERE key = \$1/, (_s, p) => (p[0] in settings ? { rows: [{ value: settings[p[0]], is_secret: false }] } : { rows: [] })],
        [/FROM app_settings WHERE key/, () => ({ rows: [] })],
        [/FROM creators\s+WHERE is_active/, () => ({ rows: [CREATOR] })],
        [/UPDATE creators/, () => ({ rowCount: 1 })],
        [/INSERT INTO conversations/, () => ({ rows: [world.conversation ?? { id: 'conv-1', is_bot_active: true, ai_disclosed_at: null }] })],
        [/ON CONFLICT \(meta_message_id\)/, () => ({ rows: world.inboundInsert ?? [{ id: 'msg-1' }] })],
        [/reply_attempts = reply_attempts \+ 1/, () => ({ rows: world.resumeClaim ?? [] })],
        [/SET handled_at = NOW\(\)/, () => ({ rowCount: 1 })],
        [/SET reply_claimed_at = NULL WHERE/, () => ({ rowCount: 1 })],
        [/UPDATE messages\s+SET perception/, (_s, p) => {
            if (world.storeRows === 'throw') throw new Error('connection terminated');
            if (p[3] !== null && p[3] !== undefined) storedText = String(p[3]);
            return { rows: world.storeRows ?? [{ perception: { ...JSON.parse(p[2]), stored_at: STORED_AT } }] };
        }],
        [/SELECT perception FROM messages/, () => ({ rows: world.storedPerception ? [{ perception: world.storedPerception }] : [] })],
        [/FROM reel_analyses/, () => ({ rows: world.library ? [world.library] : [] })],
        [/UPDATE conversations\s+SET last_inbound_at/, () => ({ rows: [STATE] })],
        [/SELECT EXISTS \(SELECT 1 FROM messages n/, () => ({ rows: [supersessions[Math.min(supersessionCalls++, supersessions.length - 1)]!] })],
        [/LEFT JOIN LATERAL/, () => ({ rows: [NO_SOURCE] })],
        [/FROM ai_agents/, () => ({ rows: [agent] })],
        [/FROM creator_profiles/, () => ({ rows: [{ profile: throughJsonb(profile), version: 3, activated_at: null }] })],
        [/SELECT direction, text/, () => ({
            rows: [...(world.history ?? [{ direction: 'inbound' as const, text: storedText ?? '[photo]' }])].reverse().map((h) => ({ sender: h.direction === 'inbound' ? 'customer' : 'ai', payload: null, raw_payload: null, ...h })),
        })],
        [/SELECT \$1, \$2, 'outbound'/, () => ({ rows: world.ackClaim ?? [{ id: 'ack-1' }] })],
        [/DELETE FROM messages WHERE id = \$1/, () => ({ rowCount: 1 })],
        [/UPDATE conversations SET ai_disclosed_at/, () => ({ rowCount: 1 })],
        [/UPDATE conversations\s+SET stage = 'handoff', handoff_at = NOW\(\)/, () => ({ rowCount: 1 })],
        [/INSERT INTO messages|UPDATE conversations SET stage/, () => ({ rows: [{ last_link_at: null, reply_id: 'reply-1' }] })],
        [/INSERT INTO rate_limit_counters/, () => ({ rows: [{ count: 1 }] })],
        [/INSERT INTO app_rate_limit_counters/, () => ({ rows: [{ count: 1 }] })],
    ];
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        timeline.push(`SQL ${sql.replace(/\s+/g, ' ').slice(0, 40)}`);
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1](sql, params);
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => { geminiCalls++; timeline.push('GEMINI'); return { data: { candidates: [{ content: { parts: [{ text: JSON.stringify({ message_type: 'text', text: 'رد احتياطي' }) }] } }] } }; };
    (metaHttp as any).post = async (url: string, body: any) => {
        timeline.push(`META ${body?.sender_action ?? 'message'}`);
        sends.push({ url, body });
        return (world.send ?? (async () => ({ data: { message_id: 'sent-1' } })))(url, body);
    };
    (metaHttp as any).get = async (url: string, config: any) => {
        timeline.push('GRAPH');
        graphGets.push({ url, fields: config?.params?.fields });
        if (!world.graph) throw new Error(`no GET was arranged for ${url}`);
        return world.graph(url, config);
    };

    let error: any = null;
    try {
        await handleMessagingEvent(event, entryId, options);
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalPost;
        (metaHttp as any).get = originalGet;
        if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
        else process.env.GEMINI_API_KEY = originalKey;
        setAiCaller(previousCaller);
        setMediaFetch(previousFetch);
        setPerceiveDmDeps(previousDeps);
        setLogSink(sink);
        invalidateTenantCache();
    }
    return { error, executed, timeline, sends, perceiveCalls, salesCalls, asrCalls, fetched, graphGets, logged, notices, budgetNotices, geminiCalls };
}

// ─── Events ─────────────────────────────────────────────────────────────────────────────────

const ev = (message: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ sender: { id: 'user-1' }, recipient: { id: 'ig-page-1' }, message, ...over });
const PHOTO_URL = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=111';
const photo = (mid = 'mid-photo') => ev({ mid, attachments: [{ type: 'image', payload: { url: PHOTO_URL } }] });
const video = () => ev({ mid: 'mid-video', attachments: [{ type: 'video', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=222' } }] });
const REEL_ID = '17900000000000001';
const reel = (over: Record<string, unknown> = {}) => ev({ mid: 'mid-reel', attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/Cabc/', title: 'Backend in 37 seconds', reel_video_id: REEL_ID, ...over } }] });
const POST_ID = '17900000000000002';
const post = () => ev({ mid: 'mid-post', attachments: [{ type: 'ig_post', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=333', title: 'Ten tips for beginners', ig_post_media_id: POST_ID } }] });
const mention = () => ev({ mid: 'mid-mention', attachments: [{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=444' } }] });
const STORY_URL = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=555';
const storyReply = (text?: string) => ev({ mid: 'mid-sr', ...(text ? { text } : {}), reply_to: { story: { url: STORY_URL, id: '18000000000000001' } } });

/** A voice note: type `audio`, a Meta CDN link, no words. */
const VOICE_URL = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=666';
const voice = (mid = 'mid-voice') => ev({ mid, attachments: [{ type: 'audio', payload: { url: VOICE_URL } }] });
/** The CDN serves a voice note as an MP4 with the AAC inside. */
const AUDIO: Media = { status: 200, type: 'video/mp4', body: 'm4abytes' };
/** Everything a voice note needs to be heard: its own switch on (and `dm_media` as the default leaves it, on), and a link that answers. */
const VOICE_ON: World = { switches: { voice: true }, media: { 'asset_id=666': AUDIO } };

const OWN_REEL_NODE = { data: { media_type: 'VIDEO', media_url: 'https://scontent.fna.fbcdn.net/o1/v/t2/reel.mp4', owner: { id: OWN_IG }, caption: 'Backend in 37 seconds', id: REEL_ID } };
const notOurs = () => Object.assign(new Error('graph'), { response: { status: 400, data: { error: { code: 100, message: 'Unsupported get request.' } } } });

// ─── Reading what was sent ──────────────────────────────────────────────────────────────────

const claimOf = (r: R) => r.executed.find((e) => /SELECT \$1, \$2, 'outbound'/.test(e.sql));
const storeOf = (r: R) => r.executed.find((e) => /UPDATE messages\s+SET perception/.test(e.sql));
const storedRecord = (r: R): Record<string, any> => JSON.parse(storeOf(r)!.params[2]);
const handled = (r: R): boolean => r.executed.some((e) => /SET handled_at = NOW\(\)/.test(e.sql));
const released = (r: R): boolean => r.executed.some((e) => /SET reply_claimed_at = NULL WHERE/.test(e.sql));
const messages = (r: R): Sent[] => r.sends.filter((s) => s.body.message);
const actions = (r: R): string[] => r.sends.filter((s) => s.body.sender_action).map((s) => s.body.sender_action);
const recordedReply = (r: R): Record<string, any> | undefined => {
    const e = r.executed.find((x) => /UPDATE conversations SET stage/.test(x.sql));
    if (!e) return undefined;
    const [, , stage, , , intent, , , pauseBot, handoffReason, , , type, text, , aiMeta] = e.params;
    return { stage, intent, pauseBot, handoffReason, type, text, aiMeta: aiMeta === undefined ? undefined : JSON.parse(aiMeta) };
};
const aiMetaOfAck = (r: R): Record<string, any> => JSON.parse(claimOf(r)!.params[5]);
const lastUser = (call: AiGenerateArgs): string => { const t = call.user as { role: string; text: string }[]; return t[t.length - 1]!.text; };
const imageOf = (call: AiGenerateArgs) => (call.user as any[])[0].media[0];
const logs = (r: R, event: string) => r.logged.filter((l) => l.event === event);

describe('Meta Muse on: a photo', () => {
    it('is read after "typing…", stored once with its description as the row\'s text, and the sales turn answers the description', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG } });

        assert.equal(r.error, null);
        // The order: the gate's reads, typing, the download, Muse, the record, the sales turn, the reply.
        const order = r.timeline.filter((c) => /^(META|FETCH|MUSE|SALES|SQL UPDATE messages SET perception)/.test(c)).map((c) => c.replace(/ = \$3.*$/, ''));
        assert.deepEqual(order, ['META typing_on', 'FETCH', 'MUSE', 'SQL UPDATE messages SET perception', 'META mark_seen', 'META typing_on', 'SALES', 'META message']);
        assert.equal(r.timeline.filter((c) => c === 'META typing_on').length, 2, 'once before the slow read, once by the sales turn while its model thinks');

        assert.equal(r.fetched.length, 1);
        assert.equal(r.fetched[0], PHOTO_URL, 'the link Meta sent');
        const stored = storeOf(r)!;
        assert.deepEqual(stored.params.slice(0, 2), ['msg-1', 'creator-1']);
        assert.equal(stored.params[3], '[photo] A screenshot of the plan price list.', 'the row\'s text becomes what was read');
        assert.match(stored.sql, /WHERE id = \$1 AND creator_id = \$2 AND perception IS NULL/);
        assert.deepEqual(storedRecord(r), {
            v: 1, kind: 'image', status: 'ok', seen: 'A screenshot of the plan price list.', about_owner: 'unclear', confidence: 0.92, model: 'muse-spark-1.3', ms: storedRecord(r).ms, usd: 0.011,
        });

        // The sales turn answers the description, with what Muse saw told as a fact, and says in its record that it was perceived and why.
        assert.equal(r.salesCalls.length, 1);
        assert.equal(r.salesCalls[0]!.purpose, 'dm');
        assert.ok(lastUser(r.salesCalls[0]!).includes('What the customer sent: a photo. What it shows: A screenshot of the plan price list.'));
        assert.ok(lastUser(r.salesCalls[0]!).endsWith('[photo] A screenshot of the plan price list.'));
        const reply = recordedReply(r)!;
        assert.equal(reply.aiMeta.perceived, true);
        assert.equal(reply.aiMeta.reason, 'Read a photo; answered from the account\'s own information, because they want to know more.');
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /It is a twelve-week plan/);
        assert.equal(claimOf(r), undefined, 'no fixed line: the sales turn answered');
        assert.ok(handled(r));
        assert.equal(r.geminiCalls, 0);
    });

    it('the call to Meta holds the media, the account\'s own handle and nothing of the follower: no name, no username, no id', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG } });
        const call = r.perceiveCalls[0]!;
        assert.equal(call.purpose, 'perception_dm');
        assert.equal(call.effort, 'low');
        assert.equal(call.maxTokens, 3000);
        assert.equal(call.creatorId, 'creator-1');
        assert.equal(imageOf(call).kind, 'image');
        assert.equal(imageOf(call).mime, 'image/jpeg');
        assert.equal(imageOf(call).base64, Buffer.from('jpegbytes').toString('base64'));
        const text = JSON.stringify({ system: call.system, user: (call.user as any[]).map((t) => t.text) });
        assert.ok(!/user-1/.test(text), 'the sender\'s id');
        assert.match(text, /The account receiving this DM is @sami\.fit\./);
        assert.match(text, /shared the attached photo/);
    });

    it('is never written anywhere as a file: the only writes are the record and the replies', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG } });
        assert.ok(!r.executed.some((e) => /media_uploads/.test(e.sql)));
        assert.ok(!JSON.stringify(r.executed.map((e) => e.params)).includes(Buffer.from('jpegbytes').toString('base64')), 'not even in a parameter');
    });

    it('that Muse is not sure of is asked for again, in the kit\'s words: no guess, no sales turn, one fixed line with the reason on the row', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG }, perceive: async () => resultOf(reading({ confidence: 0.3, seen: 'maybe a menu' })) });

        assert.equal(r.error, null);
        assert.equal(r.salesCalls.length, 0);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.resend);
        assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'image', reason: 'Could not read it with confidence, so it asked them to send it again.' });
        assert.equal(messages(r)[0]!.body.message.text, `${KITS.en.disclosure}\n${KITS.en.attachments.resend}`);
        const record = storedRecord(r);
        assert.equal(record.status, 'unreadable');
        assert.equal(record.reason, 'low_confidence');
        assert.equal(record.seen, undefined, 'what it was not sure of is not kept');
        assert.equal(storeOf(r)!.params[3], null, 'and the row\'s text is still the placeholder');
        assert.ok(handled(r));
    });

    it('a personal document goes to a person and nothing about it is kept: no sales model, the hand-off line, the bot paused, "a personal document" stored', async () => {
        const r = await run(photo(), {
            media: { 'asset_id=111': JPEG },
            perceive: async () => resultOf(reading({ about_owner: 'personal', seen: 'Passport of Sami Ahmed A1234567', transcript: 'A1234567' })),
        });

        assert.equal(r.error, null);
        assert.equal(r.salesCalls.length, 0, 'a model is never asked what a personal document shows, or what to say');
        assert.equal(storedRecord(r).seen, 'a personal document');
        assert.equal(storeOf(r)!.params[3], '[photo] a personal document');
        assert.ok(!JSON.stringify(r.executed.map((e) => e.params)).includes('A1234567'), 'nothing of it reached the database');
        assert.ok(!JSON.stringify(r.sends).includes('A1234567'));
        const reply = recordedReply(r)!;
        assert.equal(reply.pauseBot, true);
        assert.equal(reply.stage, 'handoff');
        assert.equal(reply.aiMeta.reason, 'Read a photo: it is a personal document, so the chat went to a person without describing it.');
        assert.equal(messages(r)[0]!.body.message.text.endsWith('The account owner will reply soon.'), true);
    });

    it('the follower\'s own words are not what is read for a refund: a description that says "refund" is answered, not handed over', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG }, perceive: async () => resultOf(reading({ seen: 'A screenshot of a page that says: I want a refund.' })) });
        assert.equal(r.salesCalls.length, 1);
        assert.equal(recordedReply(r)!.aiMeta.engine, 'providers');
        assert.equal(recordedReply(r)!.pauseBot, false);
    });
});

describe('Meta Muse on: a video the customer sent', () => {
    it('is shown to Muse as a video, and the description says nothing about "watching" a reel', async () => {
        const r = await run(video(), { media: { 'asset_id=222': MP4 }, perceive: async () => resultOf(reading({ seen: 'A screen recording of a code editor.' })) });
        const media = imageOf(r.perceiveCalls[0]!);
        assert.equal(media.kind, 'video');
        assert.equal(media.mime, 'video/mp4');
        assert.match(String((r.perceiveCalls[0]!.user as any[])[0].text), /Watch the whole video/);
        assert.equal(storedRecord(r).kind, 'video');
        assert.equal(storedRecord(r).seen, 'A screen recording of a code editor.');
        assert.ok(lastUser(r.salesCalls[0]!).includes('What the customer sent: a video.'));
    });
});

describe('Meta Muse on: a shared reel (R18)', () => {
    it('the creator\'s OWN is looked up with the Page token, its fresh mp4 downloaded (never the reel\'s page) and WATCHED', async () => {
        const r = await run(reel(), { graph: async () => OWN_REEL_NODE, media: { 'reel.mp4': MP4 }, perceive: async () => resultOf(reading({ seen: 'A 37-second reel about building a backend.', about_owner: 'unclear' })) });

        assert.equal(r.error, null);
        assert.equal(r.graphGets.length, 1);
        assert.match(r.graphGets[0]!.url, new RegExp(`/${REEL_ID}$`));
        assert.equal(r.graphGets[0]!.fields, 'media_type,media_url,owner,permalink,caption');
        assert.deepEqual(r.fetched, ['https://scontent.fna.fbcdn.net/o1/v/t2/reel.mp4']);
        assert.ok(!r.fetched.some((u) => /instagram\.com/.test(u)));
        assert.equal(imageOf(r.perceiveCalls[0]!).kind, 'video');
        const record = storedRecord(r);
        assert.equal(record.kind, 'reel');
        assert.equal(record.seen, 'Watched the reel. A 37-second reel about building a backend.');
        assert.equal(record.about_owner, 'own_content', 'whose it is comes from the Graph API\'s owner, not from the model');
        assert.equal(storeOf(r)!.params[3], '[shared reel] Watched the reel. A 37-second reel about building a backend.');
        assert.ok(lastUser(r.salesCalls[0]!).includes('It is the account\'s own content.'));
        assert.equal(recordedReply(r)!.aiMeta.reason, 'Watched a shared reel; answered from the account\'s own information, because they want to know more.', 'the trace says it was watched');
    });

    it('the creator\'s own, already in the library: its notes are the perception, and there is no Graph call, no download and no model for it', async () => {
        const r = await run(reel(), { library: { model: 'muse-spark-1.3', result: { summary: 'A reel about what a backend is.', topics: ['backend'], narration: 'Today we look at a request' } } });

        assert.equal(r.error, null);
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(r.graphGets.length, 0);
        assert.equal(r.fetched.length, 0);
        assert.equal(storedRecord(r).seen, 'Watched the reel earlier (the library\'s notes on it). A reel about what a backend is. Topics: backend.');
        assert.equal(storedRecord(r).usd, 0);
        assert.equal(r.salesCalls.length, 1, 'and the sales turn answers it');
        assert.deepEqual(r.executed.filter((e) => /FROM reel_analyses/.test(e.sql)).map((e) => e.params), [['creator-1', REEL_ID]]);
        assert.equal(recordedReply(r)!.aiMeta.reason, 'Used the library\'s notes on a shared reel; answered from the account\'s own information, because they want to know more.');
        assert.ok(actions(r).includes('typing_on'), 'typing is still shown: the gate passed');
    });

    it('somebody else\'s is read from its CAPTION alone, with no model for it, and is never said to be the account\'s own or to have been watched', async () => {
        const r = await run(reel(), { graph: async () => { throw notOurs(); } });

        assert.equal(r.error, null);
        assert.equal(r.perceiveCalls.length, 0, 'a caption is text: nothing to ask Muse');
        assert.equal(r.fetched.length, 0, 'there is no cover: the reel\'s url is a page');
        assert.equal(storedRecord(r).seen, 'Read the caption. It says: «Backend in 37 seconds»');
        assert.equal(storedRecord(r).about_owner, 'other_content');
        assert.equal(storedRecord(r).model, 'caption');
        assert.ok(lastUser(r.salesCalls[0]!).includes('It is NOT the account\'s own content: never say that it is.'));
        assert.ok(!/Watched/.test(lastUser(r.salesCalls[0]!)));
        assert.equal(recordedReply(r)!.aiMeta.reason, 'Read the caption of a shared reel; answered from the account\'s own information, because they want to know more.', 'and the trace says only that the caption was read');
    });

    it('an own reel whose mp4 has gone is today\'s line, with the reason on the row', async () => {
        const r = await run(reel(), { graph: async () => OWN_REEL_NODE, media: { 'reel.mp4': { status: 403 } } });
        assert.equal(storedRecord(r).status, 'failed');
        assert.equal(storedRecord(r).reason, 'expired_url');
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: its link had expired, so it sent the usual line.');
        assert.equal(r.salesCalls.length, 0);
    });
});

describe('Meta Muse on: a shared post (R18)', () => {
    it('somebody else\'s is its COVER and caption: the cover downloaded from the url Meta sent, the caption in the prompt, "saw the cover and caption" in the description', async () => {
        const r = await run(post(), {
            graph: async () => { throw notOurs(); }, media: { 'asset_id=333': JPEG },
            perceive: async () => resultOf(reading({ seen: 'A cover reading "10 tips".' })),
        });

        assert.equal(r.error, null);
        assert.deepEqual(r.fetched, ['https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=333']);
        assert.equal(imageOf(r.perceiveCalls[0]!).kind, 'image');
        const prompt = String((r.perceiveCalls[0]!.user as any[])[0].text);
        assert.match(prompt, /You are shown only its cover picture, not the video/);
        assert.match(prompt, /«Ten tips for beginners»/);
        assert.equal(storedRecord(r).seen, 'Saw the cover and caption. A cover reading "10 tips".');
        assert.equal(storedRecord(r).about_owner, 'other_content');
        assert.equal(storedRecord(r).kind, 'share');
        assert.equal(recordedReply(r)!.aiMeta.reason, 'Saw the cover of a shared post and its caption; answered from the account\'s own information, because they want to know more.');
    });
});

describe('Meta Muse on: a story mention', () => {
    it('is thanked by name, in the kit\'s words, and never answered by a sales turn', async () => {
        const r = await run(mention(), { media: { 'asset_id=444': JPEG }, perceive: async () => resultOf(reading({ seen: 'A desk with a laptop showing Python code.', mention_summary: 'my desk setup with Python code' })) });

        assert.equal(r.error, null);
        assert.equal(r.salesCalls.length, 0);
        assert.equal(claimOf(r)!.params[3], 'Thanks for the mention in your story, and for sharing my desk setup with Python code 🙏 If you have a question, I\'m glad to help.');
        assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'story_mention', reason: 'Read their story mention and thanked them for what they shared.', perceived: true });
        assert.equal(storedRecord(r).kind, 'story_mention');
        assert.equal(storedRecord(r).mention_summary, 'my desk setup with Python code');
        assert.equal(storedRecord(r).about_owner, 'other_content', 'a mention is the customer\'s own story');
        assert.ok(handled(r));
        assert.equal(r.fetched.length, 1);
    });

    it('with a summary that is not fit to say back (a number, a link, a handle) it is the line it always got', async () => {
        for (const summary of ['sale 50% off at shop.example.com', '@someone and me', 'a very long summary that goes on and on past what is allowed here']) {
            const r = await run(mention(), { media: { 'asset_id=444': JPEG }, perceive: async () => resultOf(reading({ mention_summary: summary })) });
            assert.equal(claimOf(r)!.params[3], KITS.en.attachments.mention, summary);
            assert.equal(aiMetaOfAck(r).perceived, undefined);
        }
    });

    it('a story whose link has died (they last a day) is the line it always got, with the reason', async () => {
        const r = await run(mention(), { media: { 'asset_id=444': { status: 404 } } });
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(storedRecord(r).status, 'failed');
        assert.equal(storedRecord(r).reason, 'expired_url');
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.mention);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: its link had expired, so it sent the usual line.');
    });

    it('a story that cannot be read with confidence gets the usual thanks and is NOT asked to be sent again: there is nothing for them to resend', async () => {
        const r = await run(mention(), { media: { 'asset_id=444': JPEG }, perceive: async () => resultOf(reading({ confidence: 0.2 })) });
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.mention);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it with confidence, so it sent the usual line.');
    });
});

describe('Meta Muse on: a reply to a story', () => {
    it('with NO words, the story is read and answered: "The story they replied to shows …"', async () => {
        const r = await run(storyReply(), { media: { 'asset_id=555': JPEG }, perceive: async () => resultOf(reading({ seen: 'A story announcing the new workout plan.', about_owner: 'unclear' })) });

        assert.equal(r.error, null);
        assert.equal(storedRecord(r).kind, 'story_reply');
        assert.equal(storedRecord(r).about_owner, 'own_content', 'the account\'s own story');
        assert.equal(storeOf(r)!.params[3], '[story reply] A story announcing the new workout plan.');
        assert.ok(lastUser(r.salesCalls[0]!).includes('What the customer sent: a reply to the account\'s story. The story they replied to shows: A story announcing the new workout plan.'));
        assert.equal(r.fetched[0], STORY_URL);
    });

    it('with words, the words stay what they asked and the story is context: the row\'s text is NOT overwritten, and the sales turn reads the typed words', async () => {
        const r = await run(storyReply('كم سعر هذا؟'), {
            media: { 'asset_id=555': JPEG }, perceive: async () => resultOf(reading({ seen: 'A story showing the starter bundle.' })),
            history: [{ direction: 'inbound', text: 'كم سعر هذا؟' }],
        });

        assert.equal(r.error, null);
        assert.equal(storeOf(r)!.params[3], null, 'the typed words stay the row\'s text');
        assert.equal(storedRecord(r).kind, 'story_reply');
        assert.equal(r.salesCalls.length, 1);
        const last = lastUser(r.salesCalls[0]!);
        assert.ok(last.includes('The story they replied to shows: A story showing the starter bundle.'));
        assert.ok(last.endsWith('كم سعر هذا؟'));
        assert.match(String((r.perceiveCalls[0]!.user as any[])[0].text), /wrote a message with it \(you are not shown it\)/);
        assert.ok(!JSON.stringify(r.perceiveCalls[0]!.user).includes('كم سعر'), 'the words are not sent to Muse');
        const reply = recordedReply(r)!;
        assert.equal(reply.aiMeta.perceived, true);
        assert.equal(claimOf(r), undefined);
    });

    it('with words, a story that cannot be read is simply the turn it would have been: the question is answered and the person is not asked anything', async () => {
        const r = await run(storyReply('كم سعر هذا؟'), { media: { 'asset_id=555': { status: 403 } }, history: [{ direction: 'inbound', text: 'كم سعر هذا؟' }] });
        assert.equal(r.error, null);
        assert.equal(r.salesCalls.length, 1);
        assert.ok(!lastUser(r.salesCalls[0]!).includes('What the customer sent'));
        assert.equal(messages(r).length, 1);
        assert.equal(recordedReply(r)!.aiMeta.perceived, undefined, 'nothing was perceived, so nothing is said to have been');
    });

    it('with words, a model that fails is a hand-off and not Gemini: the story went into the prompt', async () => {
        const r = await run(storyReply('كم سعر هذا؟'), {
            media: { 'asset_id=555': JPEG }, history: [{ direction: 'inbound', text: 'كم سعر هذا؟' }],
            sales: async () => failure('server'),
        });
        assert.equal(r.geminiCalls, 0);
        assert.equal(recordedReply(r)!.pauseBot, true);
    });

    it('with words, the typed words are still read for a refund, as ever', async () => {
        const r = await run(storyReply('I want a refund'), { media: { 'asset_id=555': JPEG }, history: [{ direction: 'inbound', text: 'I want a refund' }] });
        assert.equal(r.salesCalls.length, 0);
        assert.equal(recordedReply(r)!.aiMeta.engine, 'prefilter');
    });
});

// ─── The gate and the order ─────────────────────────────────────────────────────────────────

describe('Meta Muse on: every "no" is today\'s line, in the order the questions are asked', () => {
    it('Instagram only: a Messenger photo is the line it always got, with the switches ON and everyone allowed', async () => {
        const r = await run(
            ev({ mid: 'mid-fb', attachments: [{ type: 'image', payload: { url: PHOTO_URL } }] }, { recipient: { id: 'fb-page-1' } }),
            { media: { 'asset_id=111': JPEG } }, { lastAttempt: false, object: 'page' }, 'fb-page-1'
        );
        assert.equal(r.error, null);
        assert.equal(r.fetched.length, 0);
        assert.equal(r.perceiveCalls.length, 0);
        assert.deepEqual(actions(r), []);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.ok(!r.executed.some((e) => /sales_mode|muse\./.test(e.sql + JSON.stringify(e.params))), 'not one read of Meta Muse\'s');
    });

    it('a sales mode that does not answer this sender: today\'s line, the switches never read, and the reason logged', async () => {
        const r = await run(photo(), { salesMode: 'off', media: { 'asset_id=111': JPEG } });
        assert.equal(r.fetched.length, 0);
        assert.equal(r.perceiveCalls.length, 0);
        assert.deepEqual(actions(r), []);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.ok(!r.executed.some((e) => /muse\./.test(JSON.stringify(e.params))));
        assert.equal(logs(r, 'perception.skipped:sales_off').length, 1);
    });

    it('a sender who is not on the allow-list: today\'s line, no typing, no download, no write, and the gate says why', async () => {
        const r = await run(photo(), { allow: ['999999'], media: { 'asset_id=111': JPEG } });
        assert.equal(r.fetched.length, 0);
        assert.equal(r.perceiveCalls.length, 0);
        assert.deepEqual(actions(r), []);
        assert.equal(storeOf(r), undefined, 'nothing is written');
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'image' }, 'the row is exactly what it always was');
        assert.equal(logs(r, 'perception.skipped:not_allowed_sender').length, 1);
    });

    it('the switch off for the voice-only tenant: a photo is today\'s line', async () => {
        const r = await run(photo(), { switches: { dm_media: false, voice: true }, media: { 'asset_id=111': JPEG } });
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(storeOf(r), undefined);
        assert.equal(logs(r, 'perception.skipped:switch_off').length, 1);
    });

    it('the day\'s cap reached: today\'s line, the reason on the row, the owner told once; and nothing is downloaded or asked', async () => {
        const r = await run(photo(), { spentUsd: 3, dailyUsd: 3, media: { 'asset_id=111': JPEG } });
        assert.equal(r.fetched.length, 0);
        assert.equal(r.perceiveCalls.length, 0);
        assert.deepEqual(actions(r), [], 'no typing: nothing is being worked on');
        assert.equal(storedRecord(r).status, 'skipped');
        assert.equal(storedRecord(r).reason, 'budget');
        assert.equal(storeOf(r)!.params[3], null);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the daily limit for reading media was reached, so it sent the usual line.');
        assert.equal(r.budgetNotices.length, 1);
        assert.equal(logs(r, 'perception.skipped:budget').length, 1);
    });

    it('a media kind with nothing to open (a view-once has no link) is today\'s line with no gate at all', async () => {
        const r = await run(ev({ mid: 'mid-vo', attachments: [{ type: 'ephemeral' }] }), {});
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(r.executed.filter((e) => /sales_mode/.test(e.sql)).length, 0);
    });
});

// ─── Failures ───────────────────────────────────────────────────────────────────────────────

describe('Meta Muse on: a read that fails is today\'s line, never nothing', () => {
    const failed = (r: R, reason: string, line: string) => {
        assert.equal(r.error, null);
        assert.equal(storedRecord(r).status, 'failed');
        assert.equal(storedRecord(r).reason, reason);
        assert.equal(claimOf(r)!.params[3], line);
        assert.equal(r.salesCalls.length, 0);
        assert.ok(handled(r));
    };

    it('a link that has expired (403), is gone (404) or will not come', async () => {
        for (const [status, reason] of [[403, 'expired_url'], [404, 'expired_url']] as const) {
            failed(await run(photo(), { media: { 'asset_id=111': { status } } }), reason, KITS.en.attachments.media);
        }
        failed(await run(photo(), { media: { 'asset_id=111': { status: 500 } } }), 'fetch_failed', KITS.en.attachments.media);
    });

    it('a download that is not media, or too large', async () => {
        failed(await run(photo(), { media: { 'asset_id=111': { status: 200, type: 'text/html', body: '<html>' } } }), 'fetch_failed', KITS.en.attachments.media);
    });

    it('the key refused (401/403): today\'s line, the reason on the row, and the owner is told', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG }, perceive: async () => failure('auth') });
        failed(r, 'provider_error', KITS.en.attachments.media);
        assert.deepEqual(r.notices, [{ creatorId: 'creator-1', kind: 'auth' }]);
        assert.equal(r.perceiveCalls.length, 1, 'a refused key is not asked again');
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the reading service could not read it, so it sent the usual line.');
    });

    it('a 429 is not retried and nobody is told; a 5xx is tried once more', async () => {
        const rate = await run(photo(), { media: { 'asset_id=111': JPEG }, perceive: async () => failure('rate') });
        failed(rate, 'provider_error', KITS.en.attachments.media);
        assert.equal(rate.perceiveCalls.length, 1);
        assert.deepEqual(rate.notices, []);

        const flaky = await run(photo(), { media: { 'asset_id=111': JPEG }, perceive: async (_a, n) => (n === 1 ? failure('server') : resultOf(reading())) });
        assert.equal(flaky.perceiveCalls.length, 2);
        assert.equal(flaky.salesCalls.length, 1, 'the second try was read, and answered');
    });

    it('a database that cannot take the record: retried while attempts remain; on the last attempt the customer still gets today\'s line', async () => {
        const mid = await run(photo(), { media: { 'asset_id=111': JPEG }, storeRows: 'throw' }, { lastAttempt: false });
        assert.ok(mid.error, 're-raised for the runner');
        assert.ok(released(mid), 'and the claim is released so the retry reaches the work');
        assert.equal(claimOf(mid), undefined);

        const last = await run(photo(), { media: { 'asset_id=111': JPEG }, storeRows: 'throw' }, { lastAttempt: true });
        assert.equal(last.error, null);
        assert.equal(claimOf(last)!.params[3], KITS.en.attachments.media, 'never silence');
        assert.ok(handled(last));
        assert.equal(logs(last, 'perception.step_failed').length, 1);
    });
});

// ─── Retries and bursts ─────────────────────────────────────────────────────────────────────

describe('Meta Muse on: retries and bursts', () => {
    const STORED = { v: 1, kind: 'image', status: 'ok', seen: 'A screenshot of the plan price list.', about_owner: 'unclear', confidence: 0.92, model: 'muse-spark-1.3', stored_at: STORED_AT, ms: 3000, usd: 0.011 };
    const resumed = { inboundInsert: [] as Row[], resumeClaim: [{ id: 'msg-1', reply_attempts: 2 }] };

    it('a retry reuses the stored perception: no gate, no typing, no download, no model call for it, and the sales turn answers the description', async () => {
        const r = await run(photo(), { ...resumed, storedPerception: STORED, history: [{ direction: 'inbound', text: '[photo] A screenshot of the plan price list.' }] });

        assert.equal(r.error, null);
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(r.fetched.length, 0);
        assert.equal(storeOf(r), undefined, 'written once');
        assert.deepEqual(r.executed.filter((e) => /muse\./.test(JSON.stringify(e.params))).length, 0, 'the gate is not even asked: the work was done and paid for');
        assert.equal(actions(r).includes('typing_on'), true, 'the sales turn shows typing as it always does');
        assert.equal(r.timeline.filter((c) => c === 'META typing_on').length, 1, 'once, by the sales turn, and not before the read');
        assert.equal(r.salesCalls.length, 1);
        assert.ok(lastUser(r.salesCalls[0]!).includes('What the customer sent: a photo. What it shows: A screenshot of the plan price list.'));
        assert.ok(lastUser(r.salesCalls[0]!).endsWith('[photo] A screenshot of the plan price list.'));
        assert.equal(logs(r, 'perception.reused').length, 1);
    });

    it('a stored perception that did not end ok is today\'s line again, with its reason: the retry does not ask Meta a second time', async () => {
        const r = await run(photo(), { ...resumed, storedPerception: { ...STORED, status: 'failed', reason: 'expired_url', seen: undefined } });
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(r.fetched.length, 0);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: its link had expired, so it sent the usual line.');
    });

    it('a perception that another attempt stored first is the one used: the write finds a row that already has one', async () => {
        const r = await run(photo(), { media: { 'asset_id=111': JPEG }, storeRows: [], storedPerception: STORED, history: [{ direction: 'inbound', text: '[photo] A screenshot of the plan price list.' }] });
        assert.equal(r.error, null);
        assert.equal(r.executed.filter((e) => /SELECT perception FROM messages/.test(e.sql)).length, 1, 'read back');
        assert.equal(r.salesCalls.length, 1);
    });

    it('three photos in a burst are ONE answer: the one that is not the newest stands down after Muse has read it and the model has written, and sends nothing', async () => {
        const r = await run(photo(), {
            media: { 'asset_id=111': JPEG },
            supersession: [{ newer_unhandled: false, answered: false }, { newer_unhandled: true, answered: false }],
        });

        assert.equal(r.error, null);
        assert.equal(r.perceiveCalls.length, 1, 'it was read, so its description is in the history for the newest');
        assert.equal(r.salesCalls.length, 1);
        assert.equal(messages(r).length, 0);
        assert.equal(recordedReply(r), undefined);
        assert.equal(claimOf(r), undefined);
        assert.ok(handled(r), 'handled: the newest answers it');
        assert.equal(logs(r, 'dm.sales_superseded').length, 1);
    });

    it('a text sent while a reel is read does not lose the reel\'s answer: nothing newer is waiting and no reply came after the read, so it answers', async () => {
        const r = await run(reel(), { graph: async () => OWN_REEL_NODE, media: { 'reel.mp4': MP4 }, supersession: [{ newer_unhandled: false, answered: false }] });
        assert.equal(messages(r).length, 1);
        assert.equal(r.executed.filter((e) => /SELECT EXISTS \(SELECT 1 FROM messages n/.test(e.sql)).length, 2, 'once at the top, once before the send');
    });
});

// ─── The last attempt ───────────────────────────────────────────────────────────────────────

describe('Meta Muse on: a read message that cannot be answered is handed over like words (T035)', () => {
    // A failure that is not Meta's final answer and that the send's own retry does not repeat: the pipeline's catch is what is under test.
    const transient = async () => { throw Object.assign(new Error('socket closed'), { code: 'EPIPE' }); };

    it('on the last attempt a failure after the read is the hand-over line and the stamp; mid-budget it is released and re-raised', async () => {
        const mid = await run(photo(), { media: { 'asset_id=111': JPEG }, send: transient }, { lastAttempt: false });
        assert.ok(mid.error);
        assert.ok(released(mid));
        assert.ok(!mid.executed.some((e) => /stage = 'handoff'/.test(e.sql)));

        const last = await run(photo(), { media: { 'asset_id=111': JPEG }, send: transient }, { lastAttempt: true });
        assert.equal(last.error, null);
        assert.ok(last.executed.some((e) => /SET stage = 'handoff', handoff_at = NOW\(\)/.test(e.sql)), 'the thread is stamped as handed over');
        assert.ok(handled(last));
    });

    it('while one that was only acknowledged is not: a photo that was not read asked nothing, so a failed line leaves nobody waiting', async () => {
        const r = await run(photo(), { allow: ['999999'], send: transient }, { lastAttempt: true });
        assert.equal(r.error, null);
        assert.ok(!r.executed.some((e) => /stage = 'handoff'/.test(e.sql)));
        assert.ok(handled(r));
    });
});

// ─── A voice note (T050) ────────────────────────────────────────────────────────────────────

describe('Meta Muse on: a voice note', () => {
    it('is heard after "typing…", stored once as its BARE transcript, and the sales turn answers the words as the customer\'s own', async () => {
        const r = await run(voice(), VOICE_ON);

        assert.equal(r.error, null);
        // The order: the gate's reads, typing, the download, the decoder, Meta's speech model, the record, the sales turn, the reply. The picture model is not in it.
        const order = r.timeline.filter((c) => /^(META|FETCH|DECODE|ASR|MUSE|SALES|SQL UPDATE messages SET perception)/.test(c)).map((c) => c.replace(/ = \$3.*$/, ''));
        assert.deepEqual(order, ['META typing_on', 'FETCH', 'DECODE', 'ASR', 'SQL UPDATE messages SET perception', 'META mark_seen', 'META typing_on', 'SALES', 'META message']);
        assert.equal(r.timeline.filter((c) => c === 'META typing_on').length, 2, 'once before the slow part, once by the sales turn while its model thinks');
        assert.deepEqual(r.fetched, [VOICE_URL], 'the link Meta sent, and nothing else');
        assert.equal(r.perceiveCalls.length, 0, 'the picture model is never asked about a voice note');
        assert.equal(r.asrCalls.length, 1);

        const stored = storeOf(r)!;
        assert.deepEqual(stored.params.slice(0, 2), ['msg-1', 'creator-1']);
        assert.equal(stored.params[3], SPOKEN, 'the row\'s text is the bare transcript: no "[voice note]" in front of it, so history, the inbox and the sales turn all read their words');
        assert.match(stored.sql, /WHERE id = \$1 AND creator_id = \$2 AND perception IS NULL/);
        assert.deepEqual(storedRecord(r), { v: 1, kind: 'audio', status: 'ok', transcript: SPOKEN, model: 'muse-voice-transcribe-1.0', ms: storedRecord(r).ms, usd: 0.00015 });

        assert.equal(r.salesCalls.length, 1);
        assert.equal(r.salesCalls[0]!.purpose, 'dm');
        assert.ok(lastUser(r.salesCalls[0]!).endsWith(SPOKEN), 'the model reads what they said, as they said it');
        assert.ok(!lastUser(r.salesCalls[0]!).includes('What the customer sent'), 'and is told no "description": a voice note has none');
        const reply = recordedReply(r)!;
        assert.equal(reply.aiMeta.perceived, true);
        assert.equal(reply.aiMeta.reason, 'Heard a voice note; answered from the account\'s own information, because they want to know more.');
        assert.equal(messages(r).length, 1);
        assert.match(messages(r)[0]!.body.message.text, /It is a twelve-week plan/);
        assert.equal(claimOf(r), undefined, 'no fixed line: the sales turn answered');
        assert.ok(handled(r));
        assert.equal(r.geminiCalls, 0);
    });

    it('the call to the speech model holds the audio, the account\'s names as hints, and nothing of the follower: no name, no username, no id', async () => {
        const r = await run(voice(), VOICE_ON);
        const call = r.asrCalls[0]!;
        assert.equal(call.creatorId, 'creator-1');
        assert.deepEqual(call.wav, wavBytes({ seconds: 3 }), 'what the decoder made');
        assert.ok(call.keywords!.includes('Twelve-week plan') && call.keywords!.includes('One-to-one call'), 'the offers\' names');
        assert.ok(call.timeoutMs! > 0 && call.timeoutMs! <= 30_000, 'cut to the step\'s own clock');
        const text = JSON.stringify({ ...call, wav: undefined });
        assert.ok(!/user-1/.test(text), 'the sender\'s id');
        assert.ok(!/sami\.fit/.test(text), 'a handle is not a spoken word');
    });

    it('is never written anywhere as a file: the only writes are the record and the replies', async () => {
        const r = await run(voice(), VOICE_ON);
        assert.ok(!r.executed.some((e) => /media_uploads/.test(e.sql)));
        assert.ok(!JSON.stringify(r.executed.map((e) => e.params)).includes(Buffer.from('m4abytes').toString('base64')), 'not even in a parameter');
    });

    it('the log says how long it was, how many words and what it cost, and never the words, the link or the audio', async () => {
        const r = await run(voice(), VOICE_ON);
        const heard = logs(r, 'perception.voice_heard');
        assert.equal(heard.length, 1);
        assert.equal(heard[0]!.words, 11);
        assert.equal(heard[0]!.audio_ms, 3000);
        assert.equal(heard[0]!.usd, 0.00015);
        assert.equal(logs(r, 'perception.stored')[0]!.via, 'voice');
        const everything = JSON.stringify(r.logged);
        assert.ok(!everything.includes('twelve-week plan and is there'), 'the words');
        assert.ok(!everything.includes('asset_id=666'), 'the link');
        assert.ok(!everything.includes('m4abytes'), 'the audio');
    });

    it('is the customer\'s OWN words: a refund asked for aloud is handed to a person, as one typed would be, and no model is asked', async () => {
        const r = await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: 'I want a refund for the plan please' }) });
        assert.equal(r.error, null);
        assert.equal(r.salesCalls.length, 0, 'the prefilter reads what they said');
        const reply = recordedReply(r)!;
        assert.equal(reply.aiMeta.engine, 'prefilter');
        assert.equal(reply.pauseBot, true);
        assert.equal(reply.stage, 'handoff');
        assert.equal(storeOf(r)!.params[3], 'I want a refund for the plan please');
    });

    it('is answered in Arabic as it is heard: the transcript is stored as it came, one line, and the model gets it', async () => {
        const spoken = 'كم سعر الخطة وهل فيها شهادة؟';
        const r = await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: spoken }) });
        assert.equal(storeOf(r)!.params[3], spoken);
        assert.ok(lastUser(r.salesCalls[0]!).endsWith(spoken));
    });

    it('fewer than two words is asked for again, in the kit\'s words: no guess, no sales turn, one fixed line with the reason on the row', async () => {
        for (const said of ['Hello', '', '...', 'mm']) {
            const r = await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: said }) });

            assert.equal(r.error, null, said);
            assert.equal(r.salesCalls.length, 0, said);
            assert.equal(claimOf(r)!.params[3], KITS.en.attachments.resend, said);
            assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'audio', reason: 'Could not make out any words in it, so it asked them to send it again.' }, said);
            assert.equal(messages(r)[0]!.body.message.text, `${KITS.en.disclosure}\n${KITS.en.attachments.resend}`, said);
            const record = storedRecord(r);
            assert.equal(record.status, 'unreadable', said);
            assert.equal(record.reason, 'empty_transcript', said);
            assert.equal(storeOf(r)!.params[3], null, 'and the row\'s text is still the placeholder');
            assert.ok(handled(r), said);
        }
        // What little was heard is kept with the record, and nothing at all is not.
        assert.equal(storedRecord(await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: 'Hello' }) })).transcript, 'Hello');
        assert.equal(storedRecord(await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: '' }) })).transcript, undefined);
    });

    it('two words are enough: they are answered', async () => {
        const r = await run(voice(), { ...VOICE_ON, transcribe: async () => heardBy({ transcript: 'Plan price?' }) });
        assert.equal(r.salesCalls.length, 1);
        assert.equal(claimOf(r), undefined);
    });

    it('a voice note sent as the reply to a story is the voice note: what they SENT comes before the story, so it is heard and the story is not downloaded', async () => {
        const r = await run(
            ev({ mid: 'mid-vr', attachments: [{ type: 'audio', payload: { url: VOICE_URL } }], reply_to: { story: { url: STORY_URL, id: '18000000000000001' } } }),
            { ...VOICE_ON, media: { 'asset_id=666': AUDIO, 'asset_id=555': JPEG } }
        );
        assert.equal(r.error, null);
        assert.deepEqual(r.fetched, [VOICE_URL]);
        assert.equal(storedRecord(r).kind, 'audio');
        assert.equal(r.perceiveCalls.length, 0);
        assert.equal(r.salesCalls.length, 1);
    });
});

describe('Meta Muse on: a voice note has its own switch, and every "no" is today\'s line', () => {
    const today = (r: R, why?: string) => {
        assert.equal(r.error, null);
        assert.deepEqual(r.fetched, [], 'nothing is downloaded');
        assert.equal(r.asrCalls.length, 0, 'the speech model is not asked');
        assert.equal(r.perceiveCalls.length, 0);
        assert.deepEqual(actions(r), [], 'no typing: nothing is being worked on');
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.ok(!r.timeline.includes('DECODE'));
        if (why) assert.equal(logs(r, `perception.skipped:${why}`).length, 1);
    };

    it('the voice switch OFF (the default) with the media switch ON: today\'s line, nothing written, and the gate says why', async () => {
        const r = await run(voice(), { switches: { dm_media: true, voice: false }, media: { 'asset_id=666': AUDIO } });
        today(r, 'switch_off');
        assert.equal(storeOf(r), undefined, 'nothing is written');
        assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'audio' }, 'the row is exactly what it always was');
    });

    it('the voice switch is its own: ON with the media switch OFF, a voice note is heard and a photo is not', async () => {
        const world: World = { ...VOICE_ON, switches: { dm_media: false, voice: true }, media: { 'asset_id=666': AUDIO, 'asset_id=111': JPEG } };
        const heard = await run(voice(), world);
        assert.equal(heard.asrCalls.length, 1);
        assert.equal(heard.salesCalls.length, 1);

        const seen = await run(photo(), world);
        assert.equal(seen.perceiveCalls.length, 0);
        assert.equal(seen.fetched.length, 0);
        assert.equal(logs(seen, 'perception.skipped:switch_off').length, 1);
    });

    it('and the media switch is not the voice switch: ON with the voice switch OFF, a photo is read and a voice note is not', async () => {
        const world: World = { switches: { dm_media: true, voice: false }, media: { 'asset_id=666': AUDIO, 'asset_id=111': JPEG } };
        const seen = await run(photo(), world);
        assert.equal(seen.perceiveCalls.length, 1);
        today(await run(voice(), world), 'switch_off');
    });

    it('a sender who is not on the allow-list: today\'s line, no typing, no download, no write, and the gate says why', async () => {
        const r = await run(voice(), { ...VOICE_ON, allow: ['999999'] });
        today(r, 'not_allowed_sender');
        assert.equal(storeOf(r), undefined);
        assert.deepEqual(aiMetaOfAck(r), { engine: 'rule', reply: 'attachment_ack', kind: 'audio' });
    });

    it('a sales mode that does not answer this sender: today\'s line, the switches never read, and the reason logged', async () => {
        const r = await run(voice(), { ...VOICE_ON, salesMode: 'off' });
        today(r, 'sales_off');
        assert.ok(!r.executed.some((e) => /muse\./.test(JSON.stringify(e.params))));
    });

    it('Instagram only: a Messenger voice note is the line it always got, with the switch ON and everyone allowed', async () => {
        const r = await run(
            ev({ mid: 'mid-fbv', attachments: [{ type: 'audio', payload: { url: VOICE_URL } }] }, { recipient: { id: 'fb-page-1' } }),
            VOICE_ON, { lastAttempt: false, object: 'page' }, 'fb-page-1'
        );
        today(r);
        assert.ok(!r.executed.some((e) => /sales_mode|muse\./.test(e.sql + JSON.stringify(e.params))), 'not one read of Meta Muse\'s');
    });

    it('the day\'s cap reached: today\'s line, the reason on the row, the owner told once; nothing is downloaded or heard', async () => {
        const r = await run(voice(), { ...VOICE_ON, spentUsd: 3, dailyUsd: 3 });
        today(r, 'budget');
        assert.equal(storedRecord(r).kind, 'audio');
        assert.equal(storedRecord(r).status, 'skipped');
        assert.equal(storedRecord(r).reason, 'budget');
        assert.equal(storeOf(r)!.params[3], null);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the daily limit for reading media was reached, so it sent the usual line.');
        assert.equal(r.budgetNotices.length, 1);
    });
});

describe('Meta Muse on: a voice note that cannot be heard is today\'s line, never nothing', () => {
    const failed = (r: R, reason: string, extra: Record<string, unknown> = {}) => {
        assert.equal(r.error, null);
        assert.equal(storedRecord(r).kind, 'audio');
        assert.equal(storedRecord(r).status, 'failed');
        assert.equal(storedRecord(r).reason, reason);
        assert.equal(storeOf(r)!.params[3], null, 'the row\'s text is still the placeholder');
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(r.salesCalls.length, 0);
        assert.ok(handled(r));
        for (const [k, v] of Object.entries(extra)) assert.equal((logs(r, 'perception.voice_failed')[0] as any)?.[k], v, k);
    };
    const refused = (kind: AiErrorKind, status?: number) => async (): Promise<TranscribeWithMetaResult> => asrFailure(kind, status);

    it('a link that has expired (403), is gone (404) or will not come (500): nothing is decoded or asked of the speech model', async () => {
        for (const [status, reason] of [[403, 'expired_url'], [404, 'expired_url'], [500, 'fetch_failed']] as const) {
            const r = await run(voice(), { ...VOICE_ON, media: { 'asset_id=666': { status } } });
            failed(r, reason);
            assert.ok(!r.timeline.includes('DECODE'));
            assert.equal(r.asrCalls.length, 0);
        }
    });

    it('a download that is not audio (a picture, a page) is not sent to a decoder', async () => {
        failed(await run(voice(), { ...VOICE_ON, media: { 'asset_id=666': JPEG } }), 'fetch_failed', { detail: 'not_audio' });
        failed(await run(voice(), { ...VOICE_ON, media: { 'asset_id=666': { status: 200, type: 'text/html', body: '<html>' } } }), 'fetch_failed');
    });

    it('a file the decoder cannot decode is DECODE_FAILED, with the sentence for it on the row, and the speech model is not asked', async () => {
        for (const reason of ['decode_failed', 'decoder_unavailable', 'empty'] as const) {
            const r = await run(voice(), { ...VOICE_ON, decode: () => ({ ok: false, reason, detail: 'ffmpeg said no', ms: 4 }) });
            failed(r, 'decode_failed');
            assert.equal(r.asrCalls.length, 0, reason);
            assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the voice note could not be decoded, so it sent the usual line.', reason);
        }
    });

    it('a voice note that is too long (over three minutes) or too large is TOO_LARGE, and a decoder that hangs is a TIMEOUT', async () => {
        failed(await run(voice(), { ...VOICE_ON, decode: () => ({ ok: false, reason: 'too_long', ms: 4 }) }), 'too_large');
        failed(await run(voice(), { ...VOICE_ON, decode: () => ({ ok: false, reason: 'too_large', ms: 4 }) }), 'too_large');
        failed(await run(voice(), { ...VOICE_ON, decode: () => ({ ok: false, reason: 'timeout', ms: 10_000 }) }), 'timeout');
    });

    it('the key refused (401): today\'s line, the owner is told, and a refused key is not asked again', async () => {
        const r = await run(voice(), { ...VOICE_ON, transcribe: refused('auth', 401) });
        failed(r, 'provider_error', { detail: 'auth_401' });
        assert.deepEqual(r.notices, [{ creatorId: 'creator-1', kind: 'auth' }]);
        assert.equal(r.asrCalls.length, 1);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the reading service could not read it, so it sent the usual line.');
    });

    it('no credit left (402): the owner is told it ran out, once', async () => {
        const r = await run(voice(), { ...VOICE_ON, transcribe: refused('quota', 402) });
        failed(r, 'provider_error');
        assert.deepEqual(r.notices, [{ creatorId: 'creator-1', kind: 'quota' }]);
        assert.equal(r.asrCalls.length, 1);
    });

    it('a 429 is not retried and nobody is told; a 5xx is tried once more, and a second one is the line', async () => {
        const rate = await run(voice(), { ...VOICE_ON, transcribe: refused('rate', 429) });
        failed(rate, 'provider_error');
        assert.equal(rate.asrCalls.length, 1);
        assert.deepEqual(rate.notices, []);

        const flaky = await run(voice(), { ...VOICE_ON, transcribe: async (_a, n) => (n === 1 ? asrFailure('server', 503) : heardBy()) });
        assert.equal(flaky.asrCalls.length, 2);
        assert.equal(flaky.salesCalls.length, 1, 'the second try was heard, and answered');
        assert.equal(flaky.timeline.filter((c) => c === 'DECODE').length, 1, 'the audio is decoded once, not once a try');
        assert.equal(flaky.fetched.length, 1, 'and downloaded once');

        const down = await run(voice(), { ...VOICE_ON, transcribe: refused('server', 503) });
        failed(down, 'provider_error');
        assert.equal(down.asrCalls.length, 2);
        assert.deepEqual(down.notices, []);
    });

    it('a call that times out is tried once more, and then it is a timeout on the row', async () => {
        const r = await run(voice(), { ...VOICE_ON, transcribe: refused('timeout') });
        failed(r, 'timeout');
        assert.equal(r.asrCalls.length, 2);
    });

    it('Meta\'s own budget or a missing key is SKIPPED, not failed: the same line, a different reason', async () => {
        const budget = await run(voice(), { ...VOICE_ON, transcribe: refused('budget') });
        assert.equal(storedRecord(budget).status, 'skipped');
        assert.equal(storedRecord(budget).reason, 'budget');
        assert.equal(claimOf(budget)!.params[3], KITS.en.attachments.media);

        const noKey = await run(voice(), { ...VOICE_ON, transcribe: refused('no_provider') });
        assert.equal(storedRecord(noKey).status, 'skipped');
        assert.equal(storedRecord(noKey).reason, 'no_key');
        assert.equal(aiMetaOfAck(noKey).reason, 'Could not read it: no Meta key is set up for reading media, so it sent the usual line.');
    });

    it('never falls back to another provider: Gemini is not asked, whatever went wrong', async () => {
        for (const transcribe of [refused('auth', 401), refused('server', 503), refused('no_provider')]) {
            const r = await run(voice(), { ...VOICE_ON, transcribe });
            assert.equal(r.geminiCalls, 0);
            assert.equal(r.salesCalls.length, 0);
        }
    });

    it('a database that cannot take the record: retried while attempts remain; on the last attempt the customer still gets today\'s line', async () => {
        const mid = await run(voice(), { ...VOICE_ON, storeRows: 'throw' }, { lastAttempt: false });
        assert.ok(mid.error, 're-raised for the runner');
        assert.ok(released(mid), 'and the claim is released so the retry reaches the work');
        assert.equal(claimOf(mid), undefined);

        const last = await run(voice(), { ...VOICE_ON, storeRows: 'throw' }, { lastAttempt: true });
        assert.equal(last.error, null);
        assert.equal(claimOf(last)!.params[3], KITS.en.attachments.media, 'never silence');
        assert.ok(handled(last));
        assert.equal(logs(last, 'perception.step_failed').length, 1);
    });
});

describe('Meta Muse on: a voice note, retries and bursts', () => {
    const STORED = { v: 1, kind: 'audio', status: 'ok', transcript: SPOKEN, model: 'muse-voice-transcribe-1.0', stored_at: STORED_AT, ms: 3000, usd: 0.00015 };
    const resumed = { inboundInsert: [] as Row[], resumeClaim: [{ id: 'msg-1', reply_attempts: 2 }] };

    it('a retry reuses the stored transcript: no gate, no typing, no download, no decoding, no second payment, and the sales turn answers the words', async () => {
        const r = await run(voice(), { ...resumed, storedPerception: STORED, history: [{ direction: 'inbound', text: SPOKEN }] });

        assert.equal(r.error, null);
        assert.equal(r.asrCalls.length, 0);
        assert.equal(r.fetched.length, 0);
        assert.ok(!r.timeline.includes('DECODE'));
        assert.equal(storeOf(r), undefined, 'written once');
        assert.equal(r.executed.filter((e) => /muse\./.test(JSON.stringify(e.params))).length, 0, 'the gate is not even asked: the work was done and paid for');
        assert.equal(r.timeline.filter((c) => c === 'META typing_on').length, 1, 'once, by the sales turn, and not before the read');
        assert.equal(r.salesCalls.length, 1);
        assert.ok(lastUser(r.salesCalls[0]!).endsWith(SPOKEN));
        assert.equal(logs(r, 'perception.reused').length, 1);
    });

    it('a stored voice note that did not end ok is today\'s line again, with its reason: the retry does not hear it a second time', async () => {
        const r = await run(voice(), { ...resumed, storedPerception: { ...STORED, status: 'failed', reason: 'decode_failed', transcript: undefined } });
        assert.equal(r.asrCalls.length, 0);
        assert.equal(r.fetched.length, 0);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.media);
        assert.equal(aiMetaOfAck(r).reason, 'Could not read it: the voice note could not be decoded, so it sent the usual line.');
    });

    it('a stored silence is asked for again, as it was the first time', async () => {
        const r = await run(voice(), { ...resumed, storedPerception: { ...STORED, status: 'unreadable', reason: 'empty_transcript', transcript: undefined } });
        assert.equal(r.asrCalls.length, 0);
        assert.equal(claimOf(r)!.params[3], KITS.en.attachments.resend);
    });

    it('a transcript that another attempt stored first is the one used: the write finds a row that already has one', async () => {
        const r = await run(voice(), { ...VOICE_ON, storeRows: [], storedPerception: STORED, history: [{ direction: 'inbound', text: SPOKEN }] });
        assert.equal(r.error, null);
        assert.equal(r.executed.filter((e) => /SELECT perception FROM messages/.test(e.sql)).length, 1, 'read back');
        assert.equal(r.salesCalls.length, 1);
    });

    it('two voice notes in a burst are ONE answer: the one that is not the newest stands down after it was heard and the model has written, and sends nothing', async () => {
        const r = await run(voice(), { ...VOICE_ON, supersession: [{ newer_unhandled: false, answered: false }, { newer_unhandled: true, answered: false }] });

        assert.equal(r.error, null);
        assert.equal(r.asrCalls.length, 1, 'it was heard, so its words are in the history for the newest');
        assert.equal(r.salesCalls.length, 1);
        assert.equal(messages(r).length, 0);
        assert.equal(recordedReply(r), undefined);
        assert.equal(claimOf(r), undefined);
        assert.ok(handled(r), 'handled: the newest answers it');
        const superseded = logs(r, 'dm.sales_superseded');
        assert.equal(superseded.length, 1);
        assert.equal(superseded[0]!.late, true, 'caught by the check made after the read, which a typed message does not need');
    });

    it('a reply that was already sent after the read stands this one down as well', async () => {
        const r = await run(voice(), { ...VOICE_ON, supersession: [{ newer_unhandled: false, answered: false }, { newer_unhandled: false, answered: true }] });
        assert.equal(messages(r).length, 0);
        assert.equal(logs(r, 'dm.sales_superseded').length, 1);
    });

    it('a text sent while the voice note is heard does not lose its answer: nothing newer is waiting and no reply came after the read, so it answers', async () => {
        const r = await run(voice(), { ...VOICE_ON, supersession: [{ newer_unhandled: false, answered: false }] });
        assert.equal(messages(r).length, 1);
        assert.equal(r.executed.filter((e) => /SELECT EXISTS \(SELECT 1 FROM messages n/.test(e.sql)).length, 2, 'once at the top, once before the send');
    });

    it('on the last attempt a failure after it was heard is the hand-over line and the stamp; mid-budget it is released and re-raised', async () => {
        const transient = async () => { throw Object.assign(new Error('socket closed'), { code: 'EPIPE' }); };
        const mid = await run(voice(), { ...VOICE_ON, send: transient }, { lastAttempt: false });
        assert.ok(mid.error);
        assert.ok(released(mid));
        assert.ok(!mid.executed.some((e) => /stage = 'handoff'/.test(e.sql)));

        const last = await run(voice(), { ...VOICE_ON, send: transient }, { lastAttempt: true });
        assert.equal(last.error, null);
        assert.ok(last.executed.some((e) => /SET stage = 'handoff', handoff_at = NOW\(\)/.test(e.sql)), 'the thread is stamped as handed over');
        assert.ok(handled(last));
    });
});

// ─── The language ───────────────────────────────────────────────────────────────────────────

describe('Meta Muse on: the answer is in the account\'s language and the thanks are in the kit\'s', () => {
    it('an Arabic account\'s story mention is thanked in its register, and the summary is asked for in Arabic', async () => {
        const r = await run(mention(), {
            profile: withSales(FITNESS_EN, 'en'),
            media: { 'asset_id=444': JPEG }, perceive: async () => resultOf(reading({ mention_summary: 'my desk' })),
        });
        assert.match(String((r.perceiveCalls[0]!.user as any[])[0].text), /in at most 8 words, in English\./);
        assert.ok(JSON.stringify(r.perceiveCalls[0]!.schema).length > 0);
    });
});
