/**
 * A WhatsApp message, stored and either answered or marked "not answered, and here is why" (`handleWhatsAppInbound`), through the whole path a real one
 * takes: Meta's own sample payloads -> `planJobs` -> the job's stored change -> the handler -> the database. Nothing here is a mock of the code under test,
 * except the agent: the handler takes its answer as a dependency (`whatsappAnswer.ts` is tested on its own, with a model, a sender and a profile), and
 * here it is a stub that FAILS THE TEST if it is asked for a message the handler should not have sent to it.
 *
 * The database is a small in-memory model that answers by SQL, with the semantics the statements depend on: the unique index on a contact and on
 * a message id, `COALESCE` on conflict, a transaction that really rolls back. It throws on a statement the handler was not expected to make, and
 * every statement and parameter is recorded. `metaHttp` and `axios` are recorders that count EVERY call and fail it: this phase talks to
 * Meta not at all. `.env` holds live credentials; nothing here may reach Postgres or Meta.
 *
 * What is pinned, because each is a way this could go wrong in front of real people:
 *   - a person who is not on the owner's test list leaves no words, phone, username, name, media or raw event behind (C3): swept over every
 *     statement parameter and every log line, not just the columns it should be in
 *   - the agent is asked for a listed test sender's words in mode `test`, an active connection, an unpaused thread, and for nobody else, ever; a reason is
 *     recorded for every message it is not asked for
 *   - every inbound stamps `last_inbound_at`, and a redelivery does not
 *   - a BSUID that changes follows the person through the thread, their consents and the test list, and never merges or deletes a thread
 *   - (W6, W7, W8 wired in) a stop phrase from a tester is decided by the opt-out step and never reaches the agent; a stranger's file is NEVER downloaded; a voice note
 *     or a captioned file reaches the agent as words and a file with none as the one line; a known entry-link ref attributes the thread and is out of the agent's words
 *     (the stored text is as received) while a referral alone never sets the free window. The steps are stand-ins that FAIL THE TEST when asked for what they should not be.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';
import { handlers } from '../jobs/handlers.js';
import { failureRedaction } from '../jobs/redaction.js';
import { drainJobs } from '../jobs/runner.js';
import { memoryQueue } from '../jobs/testSupport.js';
import type { Job, JobKind, WhatsAppDmPayload } from '../jobs/types.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import { planJobs, processWebhookBody } from './router.js';
import { handleWhatsAppInbound, isTestSender, noReplyReasonFor, type InboundSteps } from './whatsappInbound.js';
import type { WhatsAppAnswerFn, WhatsAppAnswerInput } from './whatsappAnswer.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE_ID = '106540352242922';
const WABA = '102290129340398';

const BSUID = 'EG.13491208655302741918';
const PHONE = '201001234567';
const NAME = 'Zainab Al-Fassi';
const USERNAME = 'zainab_secret_handle';
const BODY = 'Is the blue one still in stock? My card ends 4242';

const FIXTURES = fileURLToPath(new URL('./__fixtures__/whatsapp/', import.meta.url));
const fixture = (name: string): any => JSON.parse(readFileSync(`${FIXTURES}${name}.json`, 'utf8'));

// ─── The world ──────────────────────────────────────────────────────────────────────────

interface Conv {
    id: string; creator_id: string; instagram_user_id: string; platform: string | null; status: string;
    last_message_at: number; last_inbound_at: number | null;
    wa_phone: string | null; wa_username: string | null; wa_parent_user_id: string | null; profile_name: string | null; entry_source: any | null;
    is_bot_active?: boolean; ai_disclosed_at?: string | null;
}
interface Msg {
    id: string; conversation_id: string; creator_id: string; direction: string; message_type: string; text: string; payload: string | null;
    raw_payload: string | null; meta_message_id: string; handled_at: number | null; reply_claimed_at: number | null; reply_attempts: number;
    no_reply_reason: string | null; sender: string;
}
interface Db {
    convs: Conv[]; msgs: Msg[]; consents: Array<{ creator_id: string; platform: string; contact_ref: string }>;
    agent: { whatsapp_mode: string; whatsapp_test_senders: string[] } | null;
}

let db: Db;
let clock: number;
let statements: Array<{ sql: string; params: unknown[] }>;
let logs: Array<Record<string, any>>;
let metaCalls: string[];
let connection: Record<string, unknown> | null;
let creatorActive: boolean;
let agentReadFails: boolean;
let failNextThreadRekey: boolean;
let failConversationUpsert: boolean;
let nextId: number;
let snapshot: string | null;
/** What the agent was asked, and what it says. The default FAILS: a test that expects an answer says so with `answers(...)`. */
let answerCalls: WhatsAppAnswerInput[];
let answerImpl: WhatsAppAnswerFn;
const unexpectedAnswer: WhatsAppAnswerFn = async () => { throw new Error('the agent must not be asked for this message'); };
const answers = (impl: WhatsAppAnswerFn = async () => ({ reason: null })) => { answerImpl = impl; };

/** The other steps (an opt-out, a file, its words, the entry-link labels), each a recorder that FAILS unless the test arranged it. */
type StepCalls = {
    stop: Parameters<InboundSteps['stop']>[0][]; saveFile: Parameters<InboundSteps['saveFile']>[0][]; readMedia: Parameters<InboundSteps['readMedia']>[0][];
    acknowledge: Parameters<InboundSteps['acknowledge']>[0][]; labels: string[];
};
let stepCalls: StepCalls;
let steps: InboundSteps;
const freshSteps = (): InboundSteps => ({
    stop: async (input) => { stepCalls.stop.push(input); throw new Error('the opt-out step must not be asked for this message'); },
    saveFile: async (input) => { stepCalls.saveFile.push(input); throw new Error('a file must not be saved for this message'); },
    readMedia: async (input) => { stepCalls.readMedia.push(input); throw new Error('the media step must not be asked for this message'); },
    acknowledge: async (input) => { stepCalls.acknowledge.push(input); throw new Error('the one line must not be asked for this message'); },
    labels: async (creatorId) => { stepCalls.labels.push(creatorId); return {}; },
});
const stops = (impl: InboundSteps['stop'] = async () => ({ newlyOptedOut: true, followupsCancelled: 0, confirmation: 'sent' })) => { steps.stop = async (input) => { stepCalls.stop.push(input); return impl(input); }; };
const saves = (impl: InboundSteps['saveFile'] = async () => ({ uploadId: 'upload-1', mimeType: 'audio/ogg' })) => { steps.saveFile = async (input) => { stepCalls.saveFile.push(input); return impl(input); }; };
const reads = (impl: InboundSteps['readMedia']) => { steps.readMedia = async (input) => { stepCalls.readMedia.push(input); return impl(input); }; };
const acknowledges = (impl: InboundSteps['acknowledge'] = async () => null) => { steps.acknowledge = async (input) => { stepCalls.acknowledge.push(input); return impl(input); }; };

const originalQuery = pool.query;
const originalConnect = pool.connect;
const originals = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, put: (metaHttp as any).put, axiosGet: axios.get, axiosPost: axios.post };
let restoreSink: (() => void) | undefined;
const START = Date.parse('2026-10-19T12:00:00Z');

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function connectionRow(over: Record<string, unknown> = {}) {
    return {
        id: 'conn-1', creator_id: CREATOR, external_account_id: PHONE_ID, display_name: 'Test Number', status: 'active', last_error: null, scopes: [],
        has_token: true, access_expires_at: null, last_refreshed_at: null, created_at: new Date('2026-10-18T08:00:00Z'), profile: {}, settings: {}, ...over,
    };
}

function fakeQuery(sqlIn: string, params: any[] = []): { rows: any[]; rowCount: number } {
    const sql = norm(sqlIn);
    statements.push({ sql, params });
    const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });

    if (sql === 'BEGIN') { snapshot = JSON.stringify(db); return result([]); }
    if (sql === 'COMMIT') { snapshot = null; return result([]); }
    if (sql === 'ROLLBACK') { if (snapshot) db = JSON.parse(snapshot); snapshot = null; return result([]); }

    if (sql.includes('FROM platform_connections')) {
        const live = connection && connection.status !== 'revoked' && connection.external_account_id === params[0];
        return result(live ? [connection] : []);
    }
    if (sql.startsWith('SELECT id FROM creators WHERE id = $1 AND is_active = true')) {
        return result(creatorActive && params[0] === CREATOR ? [{ id: CREATOR }] : []);
    }
    if (sql.startsWith('SELECT whatsapp_mode, whatsapp_test_senders FROM ai_agents WHERE creator_id = $1')) {
        if (agentReadFails) throw new Error('connection terminated unexpectedly');
        return result(db.agent ? [{ ...db.agent }] : []);
    }

    if (sql.startsWith('SELECT id FROM messages WHERE meta_message_id = $1 AND handled_at IS NOT NULL')) {
        return result(db.msgs.filter((m) => m.meta_message_id === params[0] && m.handled_at !== null).map((m) => ({ id: m.id })));
    }

    // The Instagram pipeline's tenant lookup: nobody owns the page, so an Instagram job in these tests ends at `dm.no_creator`.
    if (sql.includes('FROM creators') && sql.includes('instagram_page_id = ANY')) return result([]);

    if (sql.startsWith('INSERT INTO conversations')) {
        if (failConversationUpsert) throw new Error('disk full');
        const withInbound = sql.includes('last_inbound_at');
        const [creator, userId] = params;
        const existing = db.convs.find((c) => c.creator_id === creator && c.instagram_user_id === userId);
        if (withInbound) {
            const [, , phone, username, parent, name, entry] = params;
            if (existing) {
                existing.last_message_at = clock;
                existing.last_inbound_at = clock;
                existing.platform = existing.platform ?? 'whatsapp';
                existing.wa_phone = existing.wa_phone ?? phone;
                existing.wa_username = username ?? existing.wa_username;
                existing.wa_parent_user_id = existing.wa_parent_user_id ?? parent;
                existing.profile_name = name ?? existing.profile_name;
                existing.entry_source = existing.entry_source ?? JSON.parse(entry);
                return result([{ id: existing.id, is_bot_active: existing.is_bot_active ?? true, ai_disclosed_at: existing.ai_disclosed_at ?? null, entry_source: existing.entry_source }]);
            }
            const c: Conv = {
                id: `conv-${++nextId}`, creator_id: creator, instagram_user_id: userId, platform: 'whatsapp', status: 'active', last_message_at: clock, last_inbound_at: clock,
                wa_phone: phone, wa_username: username, wa_parent_user_id: parent, profile_name: name, entry_source: JSON.parse(entry),
            };
            db.convs.push(c);
            return result([{ id: c.id, is_bot_active: true, ai_disclosed_at: null, entry_source: c.entry_source }]);
        }
        // The system-message variant: no `last_inbound_at`, no `last_message_at` bump.
        const [, , phone, parent] = params;
        if (existing) {
            existing.platform = existing.platform ?? 'whatsapp';
            existing.wa_phone = phone ?? existing.wa_phone;
            existing.wa_parent_user_id = existing.wa_parent_user_id ?? parent;
            return result([{ id: existing.id }]);
        }
        const c: Conv = {
            id: `conv-${++nextId}`, creator_id: creator, instagram_user_id: userId, platform: 'whatsapp', status: 'active', last_message_at: clock, last_inbound_at: null,
            wa_phone: phone, wa_username: null, wa_parent_user_id: parent, profile_name: null, entry_source: null,
        };
        db.convs.push(c);
        return result([{ id: c.id }]);
    }

    if (sql.startsWith('INSERT INTO messages')) {
        assert.ok(sql.includes("'inbound'"), `only inbound rows are written in this phase, got: ${sql}`);
        const [conversationId, creatorId, messageType, text, payload, raw, wamid] = params;
        if (db.msgs.some((m) => m.meta_message_id === wamid)) return result([]);
        const m: Msg = {
            id: `msg-${++nextId}`, conversation_id: conversationId, creator_id: creatorId, direction: 'inbound', message_type: messageType, text, payload, raw_payload: raw,
            meta_message_id: wamid, handled_at: null, reply_claimed_at: clock, reply_attempts: 1, no_reply_reason: null, sender: 'customer',
        };
        db.msgs.push(m);
        return result([{ id: m.id }]);
    }
    if (sql.startsWith('UPDATE messages SET reply_claimed_at = NOW(), reply_attempts')) {
        const [wamid, secs] = params;
        const m = db.msgs.find((x) => x.meta_message_id === wamid && x.handled_at === null && (x.reply_claimed_at === null || x.reply_claimed_at < clock - secs * 1000));
        if (!m) return result([]);
        m.reply_claimed_at = clock;
        m.reply_attempts += 1;
        return result([{ id: m.id, reply_attempts: m.reply_attempts }]);
    }
    if (sql.startsWith('UPDATE messages SET reply_claimed_at = NULL WHERE id = $1 AND handled_at IS NULL')) {
        const m = db.msgs.find((x) => x.id === params[0] && x.handled_at === null);
        if (m) m.reply_claimed_at = null;
        return result([], m ? 1 : 0);
    }
    if (sql.startsWith('UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL, no_reply_reason = $2 WHERE id = $1')) {
        // `$2` is NULL for a message the agent answered.
        const m = db.msgs.find((x) => x.id === params[0]);
        if (m) { m.handled_at = clock; m.reply_claimed_at = null; m.no_reply_reason = params[1]; }
        return result([], m ? 1 : 0);
    }

    if (sql.startsWith('UPDATE conversations SET instagram_user_id = $3')) {
        if (failNextThreadRekey) {
            failNextThreadRekey = false;
            throw Object.assign(new Error('duplicate key value violates unique constraint "unique_creator_user"'), { code: '23505' });
        }
        const [creator, from, to] = params;
        const c = db.convs.find((x) => x.creator_id === creator && x.platform === 'whatsapp' && x.instagram_user_id === from);
        const taken = db.convs.some((x) => x.creator_id === creator && x.instagram_user_id === to);
        if (!c || taken) return result([]);
        c.instagram_user_id = to;
        return result([{ id: c.id }]);
    }
    if (sql.startsWith('SELECT instagram_user_id FROM conversations WHERE creator_id = $1 AND instagram_user_id = ANY($2::text[])')) {
        const [creator, ids] = params;
        return result(db.convs.filter((c) => c.creator_id === creator && ids.includes(c.instagram_user_id)).map((c) => ({ instagram_user_id: c.instagram_user_id })));
    }
    if (sql.startsWith('UPDATE contact_consents SET contact_ref = $3')) {
        const [creator, from, to] = params;
        const hit = db.consents.filter((c) => c.creator_id === creator && c.platform === 'whatsapp' && c.contact_ref === from);
        for (const c of hit) c.contact_ref = to;
        return result([], hit.length);
    }
    if (sql.startsWith('UPDATE ai_agents SET whatsapp_test_senders = CASE')) {
        const [, from, to] = params;
        const a = db.agent;
        if (!a || !a.whatsapp_test_senders.includes(from)) return result([], 0);
        a.whatsapp_test_senders = a.whatsapp_test_senders.includes(to)
            ? a.whatsapp_test_senders.filter((s) => s !== from)
            : a.whatsapp_test_senders.map((s) => (s === from ? to : s));
        return result([], 1);
    }
    throw new Error(`no result arranged for SQL: ${sql}`);
}

beforeEach(() => {
    clock = START;
    nextId = 0;
    snapshot = null;
    statements = [];
    logs = [];
    metaCalls = [];
    connection = connectionRow();
    creatorActive = true;
    agentReadFails = false;
    failNextThreadRekey = false;
    failConversationUpsert = false;
    answerCalls = [];
    answerImpl = unexpectedAnswer;
    stepCalls = { stop: [], saveFile: [], readMedia: [], acknowledge: [], labels: [] };
    steps = freshSteps();
    db = { convs: [], msgs: [], consents: [], agent: { whatsapp_mode: 'off', whatsapp_test_senders: [] } };

    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => fakeQuery(sql, params);
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: async (sql: string, params: unknown[] = []) => fakeQuery(sql, params), release: () => {} });

    // This phase talks to Meta not at all: every call is counted and refused.
    const refuse = (verb: string) => async (url: string) => { metaCalls.push(`${verb} ${url}`); throw new Error(`no Meta call may be made: ${verb} ${url}`); };
    (metaHttp as any).get = refuse('GET');
    (metaHttp as any).post = refuse('POST');
    (metaHttp as any).delete = refuse('DELETE');
    (metaHttp as any).put = refuse('PUT');
    (axios as any).get = refuse('axios GET');
    (axios as any).post = refuse('axios POST');
});

afterEach(() => {
    // Whatever the test did, THIS file's code sent nothing and wrote no outbound row: the send is the agent's (`whatsappAnswer.ts`), and here it is a stub.
    assert.deepEqual(metaCalls, [], 'a Meta call was made');
    assert.ok(!statements.some((s) => /INSERT INTO messages[\s\S]*'outbound'/.test(s.sql)), 'an outbound row was written');
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (pool as unknown as { connect: unknown }).connect = originalConnect;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (metaHttp as any).delete = originals.delete;
    (metaHttp as any).put = originals.put;
    (axios as any).get = originals.axiosGet;
    (axios as any).post = originals.axiosPost;
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

interface Sender { userId?: string; phone?: string | null; name?: string | null; username?: string | null }

/** A text delivery from one person, in the shape Meta sends it (BSUID first, phone optional). */
function textBody(text: string, id: string, who: Sender = {}, over: Record<string, unknown> = {}): any {
    const userId = who.userId ?? BSUID;
    const phone = who.phone === undefined ? PHONE : who.phone;
    const name = who.name === undefined ? NAME : who.name;
    const username = who.username === undefined ? USERNAME : who.username;
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: WABA,
            changes: [{
                field: 'messages',
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID },
                    contacts: [{ profile: { ...(name ? { name } : {}), ...(username ? { username } : {}) }, ...(phone ? { wa_id: phone } : {}), user_id: userId }],
                    messages: [{ ...(phone ? { from: phone } : {}), from_user_id: userId, id, timestamp: '1760875200', type: 'text', text: { body: text }, ...over }],
                },
            }],
        }],
    };
}

const jobsOf = (body: any): WhatsAppDmPayload[] => planJobs(body).filter((j) => j.kind === 'dm.process').map((j) => j.payload as WhatsAppDmPayload);

/** What the runner does with a delivery: plan it, then hand each message job to the handler. */
async function deliver(body: any, options = { lastAttempt: true }): Promise<void> {
    const answer: WhatsAppAnswerFn = async (input) => { answerCalls.push(input); return answerImpl(input); };
    for (const payload of jobsOf(body)) await handleWhatsAppInbound(payload, options, answer, steps);
}

const agent = (mode: string, senders: string[] = []) => { db.agent = { whatsapp_mode: mode, whatsapp_test_senders: senders }; };
const logged = (event: string) => logs.filter((l) => l.event === event);
const only = <T>(rows: T[]): T => { assert.equal(rows.length, 1, `expected one row, got ${rows.length}`); return rows[0]!; };

/** Everything the run wrote or said, as one string: for "this never appears anywhere". */
const everythingWritten = () => JSON.stringify(statements.map((s) => s.params)) + logs.map((l) => JSON.stringify(l)).join('\n');

// ─── Who is a test sender, and why nothing is answered ─────────────────────────────────

describe('isTestSender', () => {
    it('matches on any of the person’s ids, or on their phone number', () => {
        assert.equal(isTestSender([BSUID], [BSUID], null), true);
        assert.equal(isTestSender([PHONE], ['EG.999'], PHONE), true, 'a phone on the list names the person whatever BSUID they write from');
        assert.equal(isTestSender(['EG.old'], ['EG.new', 'EG.old'], null), true, 'on a re-key either id may be the listed one');
        assert.equal(isTestSender([BSUID], ['EG.someone.else'], '201111111111'), false);
        assert.equal(isTestSender([], [BSUID], PHONE), false);
    });

    it('tolerates a leading plus on either side and never matches nothing against nothing', () => {
        assert.equal(isTestSender(['+201001234567'], [BSUID], '201001234567'), true);
        assert.equal(isTestSender(['201001234567'], [BSUID], '+201001234567'), true);
        assert.equal(isTestSender([''], [null, undefined, ''], null), false, 'an empty entry matches no one');
        assert.equal(isTestSender(['  '], [BSUID], null), false);
    });
});

describe('noReplyReasonFor', () => {
    it('answers (null) only a listed test sender in mode test, and says why for everyone else', () => {
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'test', isTestSender: true }), null);
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'off', isTestSender: true }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'off', isTestSender: false }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'test', isTestSender: false }), 'not_test_sender');
    });

    it('treats mode everyone as test-only until the go-live gate exists: a listed sender is answered, a stranger never is', () => {
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'everyone', isTestSender: true }), null);
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'everyone', isTestSender: false }), 'not_test_sender');
    });

    it('puts a message the agent cannot read first, in every mode', () => {
        for (const mode of ['off', 'test', 'everyone'] as const) {
            for (const isTest of [true, false]) assert.equal(noReplyReasonFor({ unsupported: true, mode, isTestSender: isTest }), 'unsupported_type');
        }
    });

    it('then asks, in this order: words it can read, an active connection, a thread nobody has taken over', () => {
        const base = { unsupported: false, mode: 'test' as const, isTestSender: true };
        assert.equal(noReplyReasonFor({ ...base, answerable: false, connectionActive: false, botActive: false }), 'unsupported_type');
        assert.equal(noReplyReasonFor({ ...base, connectionActive: false, botActive: false }), 'connection_invalid');
        assert.equal(noReplyReasonFor({ ...base, botActive: false }), 'bot_paused');
        assert.equal(noReplyReasonFor({ ...base, answerable: true, connectionActive: true, botActive: true }), null);
    });

    it('never lets a fact about the message or the thread decide for someone who is not a listed test sender', () => {
        for (const mode of ['test', 'everyone'] as const) {
            assert.equal(noReplyReasonFor({ unsupported: false, mode, isTestSender: false, answerable: true, connectionActive: true, botActive: true }), 'not_test_sender');
        }
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'off', isTestSender: false, answerable: false, connectionActive: false, botActive: false }), 'agent_off');
    });
});

// ─── A test sender: everything is kept ─────────────────────────────────────────────────

describe('a message from a listed test sender', () => {
    it('stores the words, the phone, the username, the profile name and the raw event, and concludes it as agent_off', async () => {
        agent('off', [BSUID]);
        await deliver(textBody(BODY, 'wamid.T1'));

        const conv = only(db.convs);
        assert.equal(conv.instagram_user_id, BSUID, 'the BSUID is the contact key');
        assert.equal(conv.platform, 'whatsapp');
        assert.equal(conv.wa_phone, PHONE);
        assert.equal(conv.wa_username, USERNAME);
        assert.equal(conv.profile_name, NAME, 'the WhatsApp profile name goes in the existing profile_name (review M24)');

        const msg = only(db.msgs);
        assert.equal(msg.direction, 'inbound');
        assert.equal(msg.message_type, 'text');
        assert.equal(msg.text, BODY);
        assert.equal(msg.meta_message_id, 'wamid.T1');
        assert.ok(msg.raw_payload && JSON.parse(msg.raw_payload).messages[0].text.body === BODY, 'the raw event is kept');
        assert.equal(msg.no_reply_reason, 'agent_off');
        assert.notEqual(msg.handled_at, null, 'concluded, so it is not left looking like unfinished work');
        assert.equal(msg.reply_claimed_at, null);
        assert.equal(msg.sender, 'customer');
        assert.equal(only(logged('wa.inbound_stored')).stored, 'full');
    });

    it('is recognised by phone number alone, when the list holds the number and the person writes from a BSUID', async () => {
        agent('off', [PHONE]);
        await deliver(textBody(BODY, 'wamid.T2', { userId: 'EG.somebody-else-entirely' }));
        assert.equal(only(db.msgs).text, BODY);
        assert.equal(only(db.convs).wa_phone, PHONE);
    });

    it('stores an interactive reply’s title as the words and its id as the payload, and a caption with the media id and type in the raw event', async () => {
        agent('off', [BSUID]);
        const reply = fixture('interactive-button-reply');
        const v = reply.entry[0].changes[0].value;
        v.contacts[0].user_id = BSUID;
        v.messages[0].from_user_id = BSUID;
        await deliver(reply);
        const button = only(db.msgs.filter((m) => m.message_type === 'interactive.button_reply'));
        assert.equal(button.text, v.messages[0].interactive.button_reply.title);
        assert.equal(button.payload, v.messages[0].interactive.button_reply.id);

        const image = fixture('image');
        const iv = image.entry[0].changes[0].value;
        iv.contacts[0].user_id = BSUID;
        iv.messages[0].from_user_id = BSUID;
        saves(async () => ({ uploadId: 'upload-photo', mimeType: 'image/jpeg' }));
        await deliver(image);
        assert.equal(stepCalls.saveFile.length, 1, 'a tester\'s file is saved even with the agent off: Meta keeps it 7 days');
        const photo = db.msgs.find((m) => m.message_type === 'image')!;
        const raw = JSON.parse(photo.raw_payload!);
        assert.equal(raw.messages[0].image.id, iv.messages[0].image.id, 'the media id is kept for the media phase');
        assert.equal(raw.messages[0].image.mime_type, iv.messages[0].image.mime_type);
        assert.equal(photo.text, iv.messages[0].image.caption, 'a caption is words');
    });

    it('keeps a name only as long as the column holds: 255 characters', async () => {
        agent('off', [BSUID]);
        await deliver(textBody(BODY, 'wamid.T3', { name: 'م'.repeat(400) }));
        assert.equal(only(db.convs).profile_name!.length, 255);
    });

    it('lets the latest username and name win, fills the phone once, and never blanks a value a later message lacks', async () => {
        agent('off', [BSUID]);
        await deliver(textBody('one', 'wamid.U1', { name: 'Old Name', username: 'old_handle' }));
        await deliver(textBody('two', 'wamid.U2', { name: 'New Name', username: 'new_handle', phone: '201009999999' }));
        let conv = only(db.convs);
        assert.equal(conv.profile_name, 'New Name');
        assert.equal(conv.wa_username, 'new_handle');
        assert.equal(conv.wa_phone, PHONE, 'the phone fills once: a number change arrives as a system message');
        await deliver(textBody('three', 'wamid.U3', { name: null, username: null, phone: null }));
        conv = only(db.convs);
        assert.equal(conv.profile_name, 'New Name', 'a message with no name does not erase it');
        assert.equal(conv.wa_username, 'new_handle');
        assert.equal(db.msgs.length, 3);
    });
});

// ─── Anyone else: metadata only (review C3) ────────────────────────────────────────────

describe('a message from anyone who is not a listed test sender', () => {
    it('leaves a metadata-only thread and row: no words, phone, username, name, payload or raw event, anywhere', async () => {
        agent('off', [ 'EG.the.owner.tester' ]);
        await deliver(textBody(BODY, 'wamid.S1'));

        const conv = only(db.convs);
        assert.equal(conv.instagram_user_id, BSUID, 'the BSUID is the key: it is what tells the owner that someone wrote');
        assert.equal(conv.platform, 'whatsapp');
        assert.equal(conv.wa_phone, null);
        assert.equal(conv.wa_username, null);
        assert.equal(conv.wa_parent_user_id, null);
        assert.equal(conv.profile_name, null);
        assert.notEqual(conv.last_inbound_at, null, 'but when they wrote is kept: the 24 h window needs it');

        const msg = only(db.msgs);
        assert.equal(msg.text, '');
        assert.equal(msg.payload, null);
        assert.equal(msg.raw_payload, null);
        assert.equal(msg.message_type, 'text', 'the type is metadata and is kept');
        assert.equal(msg.meta_message_id, 'wamid.S1');
        assert.equal(msg.no_reply_reason, 'agent_off');
        assert.notEqual(msg.handled_at, null);
        assert.equal(only(logged('wa.inbound_stored')).stored, 'metadata_only');
    });

    it('wrote none of it into ANY statement parameter or log line, not even one that is not a text column', async () => {
        agent('off', []);
        const quick = fixture('interactive-button-reply');
        quick.entry[0].changes[0].value.contacts[0].user_id = BSUID;
        quick.entry[0].changes[0].value.messages[0].from_user_id = BSUID;
        const image = fixture('image');
        image.entry[0].changes[0].value.contacts[0].user_id = BSUID;
        image.entry[0].changes[0].value.messages[0].from_user_id = BSUID;

        await deliver(textBody(BODY, 'wamid.S2'));
        await deliver(quick);
        await deliver(image);

        const everything = everythingWritten();
        const mediaId = image.entry[0].changes[0].value.messages[0].image.id;
        const caption = image.entry[0].changes[0].value.messages[0].image.caption;
        const replyId = quick.entry[0].changes[0].value.messages[0].interactive.button_reply.id;
        for (const secret of [BODY, PHONE, NAME, USERNAME, mediaId, caption, replyId, 'Sheena Nelson']) {
            assert.ok(!everything.includes(secret), `"${secret}" reached a statement parameter or a log line`);
        }
        assert.equal(db.msgs.length, 3);
        for (const m of db.msgs) assert.deepEqual([m.text, m.payload, m.raw_payload], ['', null, null], m.message_type);
    });

    it('still records how the thread began: a click-to-WhatsApp ad is attribution, not personal data', async () => {
        agent('off', []);
        await deliver(textBody(BODY, 'wamid.S3', {}, { referral: { source_type: 'ad', source_id: 'AD-77', ctwa_clid: 'CLID-1', headline: 'Learn AI', source_url: 'https://fb.me/x' } }));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'ctwa', ad_id: 'AD-77', ctwa_clid: 'CLID-1', headline: 'Learn AI', at: '2025-10-19T12:00:00.000Z' });
    });

    it('treats a settings read that fails on the last attempt as "nobody is a tester": stored as a stranger, and says so', async () => {
        agent('test', [BSUID]);
        agentReadFails = true;
        await deliver(textBody(BODY, 'wamid.S4'), { lastAttempt: true });
        assert.deepEqual([only(db.msgs).text, only(db.convs).wa_phone], ['', null]);
        const said = only(logged('wa.settings_unreadable'));
        assert.equal(said.level, 'error');
        assert.ok(!everythingWritten().includes(BODY));
    });

    it('lets a transient settings failure retry while an attempt is left: nothing is stored half-way', async () => {
        agent('test', [BSUID]);
        agentReadFails = true;
        await assert.rejects(() => deliver(textBody(BODY, 'wamid.S5'), { lastAttempt: false }), /connection terminated/);
        assert.equal(db.convs.length + db.msgs.length, 0);
        agentReadFails = false;
        answers();
        await deliver(textBody(BODY, 'wamid.S5'), { lastAttempt: false });
        assert.equal(only(db.msgs).text, BODY, 'the retry stores it in full: the sender is a tester');
        assert.equal(answerCalls.length, 1, 'and, mode test with the sender listed, answers it');
    });
});

// ─── Nobody is answered ────────────────────────────────────────────────────────────────

describe('what each mode does with a message', () => {
    const cases: Array<[string, string[], string | null]> = [
        ['off', [], 'agent_off'],
        ['off', [BSUID], 'agent_off'],
        ['test', [], 'not_test_sender'],
        ['test', [BSUID], null],
        ['everyone', [], 'not_test_sender'],
        ['everyone', [BSUID], null],
    ];
    for (const [mode, senders, expected] of cases) {
        it(`mode ${mode}, ${senders.length ? 'a listed sender' : 'a stranger'}: ${expected === null ? 'the agent answers, and the row says nothing went unanswered' : `${expected}, and the agent is never asked`}`, async () => {
            agent(mode, senders);
            answers();
            await deliver(textBody(BODY, `wamid.M-${mode}-${senders.length}`));
            const msg = only(db.msgs);
            assert.equal(msg.no_reply_reason, expected);
            assert.notEqual(msg.handled_at, null);
            assert.equal(answerCalls.length, expected === null ? 1 : 0);
            assert.deepEqual(metaCalls, []);
            assert.ok(!statements.some((s) => /'outbound'/.test(s.sql)), 'this handler wrote no outbound row: that is the agent\'s');
        });
    }

    it('touches only the connection, the settings and the thread for a message nobody answers: no engine, no profile, no model, no quota', async () => {
        agent('test', []);
        await deliver(textBody(BODY, 'wamid.N1'));
        const touched = new Set(statements.map((s) => /(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i.exec(s.sql)?.[1]));
        assert.deepEqual([...touched].sort(), ['ai_agents', 'conversations', 'creators', 'messages', 'platform_connections']);
    });
});

// ─── The agent is asked ────────────────────────────────────────────────────────────────

describe('a message the agent answers', () => {
    it('is handed to it whole: the thread, the row, the wamid, the number, the contact, the words, and when the line was last said', async () => {
        agent('test', [BSUID]);
        answers();
        await deliver(textBody(BODY, 'wamid.A1'));
        const conv = only(db.convs);
        const msg = only(db.msgs);
        assert.deepEqual(answerCalls, [{
            creatorId: CREATOR, conversationId: conv.id, messageId: msg.id, wamid: 'wamid.A1', phoneNumberId: PHONE_ID, senderId: BSUID,
            text: BODY, payload: null, aiDisclosedAt: null, entryRef: null, lastAttempt: true,
        }]);
    });

    it('is concluded with NO reason when the agent answered, after the agent has run, and says so in the log', async () => {
        agent('test', [BSUID]);
        let concludedBeforeAnswer = true;
        answers(async () => { concludedBeforeAnswer = db.msgs.some((m) => m.handled_at !== null); return { reason: null }; });
        await deliver(textBody(BODY, 'wamid.A2'));
        assert.equal(concludedBeforeAnswer, false, 'the row is claimed and open while the agent works, and concluded after');
        const msg = only(db.msgs);
        assert.equal(msg.no_reply_reason, null);
        assert.notEqual(msg.handled_at, null);
        assert.equal(msg.reply_claimed_at, null);
        const said = only(logged('wa.inbound_stored'));
        assert.deepEqual([said.answered, said.no_reply_reason], [true, null]);
    });

    it('records the reason the agent gives when it did not answer: a provider that failed, a closed window, a billable reply, a refused connection', async () => {
        agent('test', [BSUID]);
        let n = 0;
        for (const reason of ['provider_unavailable', 'window_closed', 'billable_blocked', 'connection_invalid', 'failure', 'superseded', 'bot_paused', 'agent_off'] as const) {
            answers(async () => ({ reason }));
            await deliver(textBody(BODY, `wamid.R${n++}`));
            assert.equal(db.msgs[db.msgs.length - 1]!.no_reply_reason, reason);
        }
        assert.equal(logged('wa.inbound_stored').filter((l) => l.answered === false).length, 8);
    });

    it('is asked with the button\'s title as the words and its id as the payload for a tapped button', async () => {
        agent('test', [BSUID]);
        answers();
        const reply = fixture('interactive-button-reply');
        const v = reply.entry[0].changes[0].value;
        v.contacts[0].user_id = BSUID;
        v.messages[0].from_user_id = BSUID;
        await deliver(reply);
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.text, v.messages[0].interactive.button_reply.title);
        assert.equal(answerCalls[0]!.payload, v.messages[0].interactive.button_reply.id);
    });

    it('is asked for a list row too, and for a text from a phone-only match on the list', async () => {
        agent('test', [PHONE]);
        answers();
        await deliver(textBody(BODY, 'wamid.A3', { userId: 'EG.somebody-else-entirely' }));
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.senderId, 'EG.somebody-else-entirely', 'the contact is the BSUID, never the phone');
    });

    it('is not asked again for a redelivery: a message already concluded is never answered twice', async () => {
        agent('test', [BSUID]);
        answers();
        const body = textBody(BODY, 'wamid.A4');
        await deliver(body);
        clock += 60 * 1000;
        await deliver(body);
        assert.equal(answerCalls.length, 1);
        assert.equal(logged('wa.duplicate_ignored').length, 1);
    });

    it('stays open for a retry when the agent asks for one (it throws, after releasing the claim), and is answered when the runner comes back', async () => {
        agent('test', [BSUID]);
        answers(async (input) => {
            // What `answerWhatsApp` does before it rethrows: the claim is handed back so the retry can take it at once.
            const m = db.msgs.find((x) => x.id === input.messageId)!;
            m.reply_claimed_at = null;
            throw new Error('connection terminated unexpectedly');
        });
        await assert.rejects(() => deliver(textBody(BODY, 'wamid.A5'), { lastAttempt: false }), /connection terminated/);
        let msg = only(db.msgs);
        assert.equal(msg.handled_at, null, 'not concluded: the job will run again');
        assert.equal(answerCalls[0]!.lastAttempt, false, 'the agent was told a retry is coming');

        answers();
        await deliver(textBody(BODY, 'wamid.A5'), { lastAttempt: false });
        msg = only(db.msgs);
        assert.equal(msg.reply_attempts, 2, 'the same row, claimed again');
        assert.notEqual(msg.handled_at, null);
        assert.equal(msg.no_reply_reason, null);
    });

    it('lets an error from the agent through for a listed sender with the job\'s payload left whole, on a retry and on the failure that ends the job', async () => {
        agent('test', [BSUID]);
        answers(async () => { throw new Error('boom'); });
        const [payload] = jobsOf(textBody(BODY, 'wamid.A6'));
        const stub: WhatsAppAnswerFn = async (input) => { answerCalls.push(input); return answerImpl(input); };
        for (const lastAttempt of [false, true]) {
            // What `answerWhatsApp` does before it rethrows: the claim is given back, so the next attempt can take it.
            for (const m of db.msgs) m.reply_claimed_at = null;
            await assert.rejects(() => handleWhatsAppInbound(payload!, { lastAttempt }, stub), (err: unknown) => {
                assert.equal((err as Error).message, 'boom');
                // A tester's words are kept in `messages` anyway, so the operator can replay the job: the error carries no request to redact its payload.
                assert.equal(failureRedaction(err), null);
                return true;
            });
        }
        assert.equal(answerCalls.map((c) => c.lastAttempt).join(), 'false,true');
    });
});

describe('a message the agent is NOT asked for, even from a listed test sender', () => {
    const body = (over: Record<string, unknown> = {}) => textBody(BODY, `wamid.N-${Math.random()}`, {}, over);

    it('is not asked for a reaction or a type Meta added (`unsupported`, `order`), and none of them is downloaded or answered: stored in full, concluded as unsupported_type', async () => {
        agent('test', [BSUID]);
        for (const name of ['unsupported', 'order', 'reaction'] as const) {
            const f = fixture(name);
            const v = f.entry[0].changes[0].value;
            v.contacts[0].user_id = BSUID;
            v.messages[0].from_user_id = BSUID;
            v.messages[0].id = `wamid.U-${name}`;
            await deliver(f);
        }
        assert.equal(answerCalls.length, 0);
        assert.deepEqual([stepCalls.saveFile.length, stepCalls.readMedia.length, stepCalls.acknowledge.length, stepCalls.stop.length], [0, 0, 0, 0], 'not even the one line: it is for a sticker, a location or a card');
        assert.ok(db.msgs.length >= 2);
        assert.ok(db.msgs.every((m) => m.no_reply_reason === 'unsupported_type'), db.msgs.map((m) => m.no_reply_reason).join(','));
    });

    it('is not asked while the connection is not active: stored in full, concluded as connection_invalid, nothing sent', async () => {
        agent('test', [BSUID]);
        connection = connectionRow({ status: 'invalid', last_error: 'Meta reports the token as not valid.' });
        await deliver(body());
        const msg = only(db.msgs);
        assert.equal(msg.no_reply_reason, 'connection_invalid');
        assert.equal(msg.text, BODY);
        assert.equal(answerCalls.length, 0);
    });

    it('is not asked while a person has the thread (the bot is paused): concluded as bot_paused', async () => {
        agent('test', [BSUID]);
        db.convs.push({
            id: 'conv-paused', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
            wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null, is_bot_active: false,
        });
        await deliver(body());
        assert.equal(only(db.msgs).no_reply_reason, 'bot_paused');
        assert.equal(answerCalls.length, 0);
    });

    it('is not asked for a system message (a BSUID that changed), for anyone', async () => {
        agent('test', [BSUID]);
        const sys = fixture('system-user-changed-number');
        await deliver(sys);
        assert.equal(answerCalls.length, 0);
    });

    it('is not asked for a stranger in any mode, with every other fact in its favour', async () => {
        for (const mode of ['test', 'everyone'] as const) {
            agent(mode, ['EG.the.owner.tester']);
            await deliver(textBody(BODY, `wamid.X-${mode}`));
        }
        assert.equal(answerCalls.length, 0);
        assert.deepEqual(db.msgs.map((m) => m.no_reply_reason), ['not_test_sender', 'not_test_sender']);
    });
});

// ─── The thread ────────────────────────────────────────────────────────────────────────

describe('the thread and its 24 h window', () => {
    it('stamps last_inbound_at on EVERY inbound, in the statement that creates or updates the thread (review H3)', async () => {
        agent('off', []);
        await deliver(textBody('one', 'wamid.W1'));
        const first = only(db.convs).last_inbound_at;
        assert.equal(first, START, 'a new thread is stamped');

        clock += 3 * 60 * 60 * 1000;
        await deliver(textBody('two', 'wamid.W2'));
        assert.equal(only(db.convs).last_inbound_at, START + 3 * 60 * 60 * 1000, 'and every later inbound moves it');
        assert.equal(only(db.convs).last_message_at, START + 3 * 60 * 60 * 1000);

        const upserts = statements.filter((s) => s.sql.startsWith('INSERT INTO conversations'));
        for (const u of upserts) {
            assert.match(u.sql, /VALUES \(\$1, \$2, 'active', 'whatsapp', NOW\(\)/, 'the INSERT stamps it');
            assert.match(u.sql, /DO UPDATE SET last_message_at = NOW\(\), last_inbound_at = NOW\(\)/, 'and so does the UPDATE');
        }
    });

    it('stamps it for a stranger as well as a tester, and for a reaction', async () => {
        agent('off', []);
        const reaction = fixture('reaction');
        reaction.entry[0].changes[0].value.contacts[0].user_id = BSUID;
        reaction.entry[0].changes[0].value.messages[0].from_user_id = BSUID;
        await deliver(reaction);
        assert.equal(only(db.convs).last_inbound_at, START);
    });

    it('does not re-stamp it for a redelivery: a message from days ago must not reopen a window the customer closed', async () => {
        agent('off', []);
        const body = textBody('one', 'wamid.R1');
        await deliver(body);
        clock += 48 * 60 * 60 * 1000;
        await deliver(body);

        assert.equal(only(db.convs).last_inbound_at, START, 'untouched');
        assert.equal(db.msgs.length, 1);
        assert.equal(only(logged('wa.duplicate_ignored')).event, 'wa.duplicate_ignored');
        assert.equal(statements.filter((s) => s.sql.startsWith('INSERT INTO conversations')).length, 1, 'the thread was not even touched');
    });

    it('sets the platform once and keeps it, and never rewrites how the thread began', async () => {
        agent('off', []);
        await deliver(textBody('one', 'wamid.E1', {}, { referral: { source_type: 'ad', source_id: 'AD-1', ctwa_clid: 'C1' } }));
        await deliver(textBody('two', 'wamid.E2', {}, { referral: { source_type: 'ad', source_id: 'AD-2', ctwa_clid: 'C2' } }));
        const conv = only(db.convs);
        assert.equal(conv.entry_source.ad_id, 'AD-1', 'the first inbound set it');
        assert.equal(conv.platform, 'whatsapp');
        await deliver(textBody('three', 'wamid.E3'));
        assert.equal(only(db.convs).entry_source.kind, 'ctwa', 'an organic message later does not turn a ctwa thread organic');
    });

    it('records a thread with no referral as organic, dated from the message', async () => {
        agent('off', []);
        await deliver(textBody('one', 'wamid.E4'));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'organic', at: '2025-10-19T12:00:00.000Z' });
    });

    it('does not touch conversations.handled_at: the Instagram upsert does not either, yet', async () => {
        agent('off', []);
        await deliver(textBody('one', 'wamid.H1'));
        const threadWrites = statements.filter((s) => /^(INSERT INTO|UPDATE) conversations/.test(s.sql));
        assert.ok(threadWrites.length > 0);
        assert.ok(threadWrites.every((s) => !/\bhandled_at\b/.test(s.sql)), 'a later change adds the line to both pipelines at once');
    });

    it('resumes a message an earlier attempt claimed and never concluded, instead of storing a second row', async () => {
        agent('off', [BSUID]);
        db.convs.push({
            id: 'conv-x', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
            wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null,
        });
        db.msgs.push({
            id: 'msg-x', conversation_id: 'conv-x', creator_id: CREATOR, direction: 'inbound', message_type: 'text', text: BODY, payload: null, raw_payload: null,
            meta_message_id: 'wamid.C1', handled_at: null, reply_claimed_at: START - 10 * 60 * 1000, reply_attempts: 1, no_reply_reason: null, sender: 'customer',
        });
        await deliver(textBody(BODY, 'wamid.C1'));
        assert.equal(db.msgs.length, 1);
        assert.equal(db.msgs[0]!.reply_attempts, 2);
        assert.notEqual(db.msgs[0]!.handled_at, null);
        assert.equal(db.msgs[0]!.no_reply_reason, 'agent_off');
        assert.equal(only(logged('wa.resumed')).reply_attempts, 2);
    });

    it('leaves a claim another run still holds alone', async () => {
        agent('off', []);
        db.convs.push({
            id: 'conv-x', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
            wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null,
        });
        db.msgs.push({
            id: 'msg-x', conversation_id: 'conv-x', creator_id: CREATOR, direction: 'inbound', message_type: 'text', text: '', payload: null, raw_payload: null,
            meta_message_id: 'wamid.C2', handled_at: null, reply_claimed_at: START - 30 * 1000, reply_attempts: 1, no_reply_reason: null, sender: 'customer',
        });
        await deliver(textBody(BODY, 'wamid.C2'));
        assert.equal(db.msgs[0]!.handled_at, null, 'not ours to conclude');
        assert.equal(only(logged('wa.duplicate_ignored')).event, 'wa.duplicate_ignored');
    });
});

// ─── Messages with nothing to answer ───────────────────────────────────────────────────

describe('a reaction or a message the agent cannot read', () => {
    // Meta's `reaction` and `unsupported` samples share one wamid (a docs oddity), so each is given its own: they are different messages here.
    const bsuidified = (name: string) => {
        const f = fixture(name);
        f.entry[0].changes[0].value.contacts[0].user_id = BSUID;
        f.entry[0].changes[0].value.messages[0].from_user_id = BSUID;
        f.entry[0].changes[0].value.messages[0].id = `wamid.${name}`;
        return f;
    };

    it('is stored as a row that says why nobody answered, with its WhatsApp type', async () => {
        agent('test', [BSUID]);
        await deliver(bsuidified('reaction'));
        await deliver(bsuidified('unsupported'));
        const [reaction, unsupported] = db.msgs;
        assert.equal(reaction!.message_type, 'reaction');
        assert.equal(unsupported!.message_type, 'unsupported');
        for (const m of db.msgs) {
            assert.equal(m.no_reply_reason, 'unsupported_type');
            assert.notEqual(m.handled_at, null);
            assert.equal(m.text, '', 'a reaction has no words to keep');
        }
    });

    it('keeps a type Meta adds one day inside the column: an 80-character type is cut to 50 and still stored', async () => {
        agent('off', [BSUID]);
        const odd = bsuidified('unsupported');
        odd.entry[0].changes[0].value.messages[0].type = 'brand_new_type_'.padEnd(80, 'x');
        delete odd.entry[0].changes[0].value.messages[0].errors;
        await deliver(odd);
        const m = only(db.msgs);
        assert.equal(m.message_type.length, 50);
        assert.equal(m.no_reply_reason, 'unsupported_type');
    });

    it('says unsupported_type for a stranger too, in metadata only', async () => {
        agent('test', []);
        await deliver(bsuidified('unsupported'));
        const m = only(db.msgs);
        assert.deepEqual([m.no_reply_reason, m.text, m.raw_payload], ['unsupported_type', '', null]);
    });

    it('keeps no row for an edit or a deletion, and the log is the record', async () => {
        agent('off', [BSUID]);
        await deliver(bsuidified('edit'));
        await deliver(bsuidified('revoke'));
        assert.equal(db.msgs.length + db.convs.length, 0);
        assert.deepEqual(logged('wa.ignored').map((l) => l.reason), ['edit_or_revoke', 'edit_or_revoke']);
    });
});

// ─── No tenant ─────────────────────────────────────────────────────────────────────────

describe('a message for a number nobody connected', () => {
    it('is logged wa.no_creator and writes nothing: Meta has its 200 and a retry would find the same nothing', async () => {
        connection = null;
        await deliver(textBody(BODY, 'wamid.Z1'));
        assert.equal(db.convs.length + db.msgs.length, 0);
        const said = only(logged('wa.no_creator'));
        assert.equal(said.level, 'warn');
        assert.equal(said.phone_number_id, PHONE_ID);
        assert.ok(!statements.some((s) => /INSERT|UPDATE/.test(s.sql)));
    });

    it('is the same for a revoked connection and for a tenant an operator switched off', async () => {
        connection = connectionRow({ status: 'revoked' });
        await deliver(textBody(BODY, 'wamid.Z2'));
        connection = connectionRow();
        creatorActive = false;
        await deliver(textBody(BODY, 'wamid.Z3'));
        assert.equal(db.convs.length + db.msgs.length, 0);
        assert.equal(logged('wa.no_creator').length, 2);
        assert.equal(logged('wa.creator_inactive').length, 1);
    });

    it('still stores for a connection Meta refused: the message cannot be redelivered, only sending is off', async () => {
        connection = connectionRow({ status: 'invalid', last_error: 'token expired' });
        agent('off', [BSUID]);
        await deliver(textBody(BODY, 'wamid.Z4'));
        const msg = only(db.msgs);
        assert.equal(msg.text, BODY);
        assert.equal(only(logged('wa.inbound_stored')).connection_status, 'invalid');
        assert.equal(logged('wa.no_creator').length, 0);
    });

    it('says wa.job_empty for a job with nothing in it, and wa.no_creator for one with no number', async () => {
        await handleWhatsAppInbound({ object: 'whatsapp', entryId: WABA, phoneNumberId: PHONE_ID, change: { messages: [] } });
        assert.equal(only(logged('wa.job_empty')).level, 'warn');
        const noNumber = jobsOf(textBody(BODY, 'wamid.Z5'))[0]!;
        delete (noNumber.change as any).metadata;
        await handleWhatsAppInbound({ ...noNumber, phoneNumberId: null });
        assert.equal(only(logged('wa.no_creator')).phone_number_id, null);
        assert.equal(db.msgs.length, 0);
    });
});

// ─── A BSUID that changes (review M9) ──────────────────────────────────────────────────

describe('a system message that changes a contact’s BSUID', () => {
    const OLD = 'US.10230984751029384756';
    const NEW = 'US.13491208655302741918';
    const conv = (id: string, userId: string, over: Partial<Conv> = {}): Conv => ({
        id, creator_id: CREATOR, instagram_user_id: userId, platform: 'whatsapp', status: 'active', last_message_at: START - 1000, last_inbound_at: START - 1000,
        wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null, ...over,
    });
    const systemBody = () => fixture('system-user-changed-user-id');
    const rekeyStatements = () => statements.map((s) => s.sql);

    it('re-keys the thread, the consents and the test-sender entry, in one transaction, and stores the system message on the thread', async () => {
        agent('test', ['EG.other', OLD]);
        db.convs.push(conv('conv-old', OLD, { profile_name: 'Kept Name', wa_phone: '201000000001' }));
        db.consents.push({ creator_id: CREATOR, platform: 'whatsapp', contact_ref: OLD }, { creator_id: CREATOR, platform: 'whatsapp', contact_ref: 'EG.unrelated' });
        await deliver(systemBody());

        assert.deepEqual(db.convs.map((c) => [c.id, c.instagram_user_id]), [['conv-old', NEW]], 'the same thread, under the new id: its history stays with it');
        assert.equal(db.convs[0]!.profile_name, 'Kept Name');
        assert.deepEqual(db.consents.map((c) => c.contact_ref), [NEW, 'EG.unrelated'], 'an opt-out follows the person; nobody else’s moves');
        assert.deepEqual(db.agent!.whatsapp_test_senders, ['EG.other', NEW], 'replaced in place, order kept');

        const log = rekeyStatements();
        const begin = log.indexOf('BEGIN');
        const commit = log.indexOf('COMMIT');
        assert.ok(begin >= 0 && commit > begin, 'in a transaction');
        const inside = log.slice(begin + 1, commit);
        assert.deepEqual(inside.map((s) => s.split(' ').slice(0, 2).join(' ')), ['UPDATE conversations', 'UPDATE contact_consents', 'UPDATE ai_agents']);
        assert.ok(log.findIndex((s) => s.startsWith('INSERT INTO messages')) > commit, 'the message is stored after the re-key commits');

        const msg = only(db.msgs);
        assert.equal(msg.message_type, 'system');
        assert.equal(msg.no_reply_reason, 'system_event');
        assert.notEqual(msg.handled_at, null);
        assert.equal(msg.conversation_id, 'conv-old');
        assert.equal(only(logged('wa.contact_rekeyed')).outcome, 'rekeyed');
    });

    it('is not the customer writing: it does not stamp last_inbound_at or last_message_at', async () => {
        agent('off', []);
        db.convs.push(conv('conv-old', OLD));
        await deliver(systemBody());
        assert.equal(db.convs[0]!.last_inbound_at, START - 1000);
        assert.equal(db.convs[0]!.last_message_at, START - 1000);
        const insert = statements.find((s) => s.sql.startsWith('INSERT INTO conversations'))!;
        assert.ok(!insert.sql.includes('last_inbound_at') && !insert.sql.includes('last_message_at'));
    });

    it('keeps both threads when the new id already has one: nothing is merged or deleted, it warns, and the message goes on the new thread', async () => {
        agent('test', [OLD]);
        db.convs.push(conv('conv-old', OLD, { profile_name: 'Old Thread' }), conv('conv-new', NEW, { profile_name: 'New Thread' }));
        db.consents.push({ creator_id: CREATOR, platform: 'whatsapp', contact_ref: OLD });
        await deliver(systemBody());

        assert.deepEqual(db.convs.map((c) => [c.id, c.instagram_user_id, c.profile_name]), [['conv-old', OLD, 'Old Thread'], ['conv-new', NEW, 'New Thread']]);
        assert.ok(!statements.some((s) => /^DELETE/.test(s.sql)), 'nothing was deleted');
        const warned = only(logged('wa.contact_rekey_conflict'));
        assert.equal(warned.level, 'warn');
        assert.deepEqual([warned.from, warned.to, warned.creator_id], [OLD, NEW, CREATOR]);
        assert.equal(only(db.msgs).conversation_id, 'conv-new');
        assert.deepEqual(db.consents.map((c) => c.contact_ref), [NEW], 'the opt-out history still follows the person');
        assert.deepEqual(db.agent!.whatsapp_test_senders, [NEW]);
    });

    it('moves a thread only to an id nobody has, only for this tenant and only on WhatsApp: the statement says so itself, not just the index', async () => {
        // A stub cannot prove what Postgres does, so the statement's shape is pinned: the NOT EXISTS is the check that keeps a conflict from being an
        // error at all, the unique index is only the guarantee behind it.
        agent('off', []);
        db.convs.push(conv('conv-old', OLD));
        await deliver(systemBody());
        const move = statements.find((s) => s.sql.startsWith('UPDATE conversations SET instagram_user_id = $3'))!;
        assert.match(move.sql, /WHERE creator_id = \$1 AND platform = 'whatsapp' AND instagram_user_id = \$2/);
        assert.match(move.sql, /AND NOT EXISTS \(SELECT 1 FROM conversations n WHERE n\.creator_id = \$1 AND n\.instagram_user_id = \$3\)/);
        assert.deepEqual(move.params, [CREATOR, OLD, NEW]);
    });

    it('drops the old id from the test list, without a duplicate, when the new one is already listed', async () => {
        agent('test', [NEW, 'EG.other', OLD]);
        db.convs.push(conv('conv-old', OLD));
        await deliver(systemBody());
        assert.deepEqual(db.agent!.whatsapp_test_senders, [NEW, 'EG.other']);
    });

    it('treats a unique violation that races the check as the same conflict: rolled back, then everything but the thread', async () => {
        agent('test', [OLD]);
        db.convs.push(conv('conv-old', OLD));
        db.consents.push({ creator_id: CREATOR, platform: 'whatsapp', contact_ref: OLD });
        failNextThreadRekey = true;
        await deliver(systemBody());

        assert.equal(db.convs.find((c) => c.id === 'conv-old')!.instagram_user_id, OLD, 'the thread was not moved');
        assert.deepEqual(db.consents.map((c) => c.contact_ref), [NEW]);
        assert.deepEqual(db.agent!.whatsapp_test_senders, [NEW]);
        assert.equal(logged('wa.contact_rekey_conflict').length, 1);
        assert.ok(statements.filter((s) => s.sql === 'ROLLBACK').length === 1 && statements.filter((s) => s.sql === 'COMMIT').length === 1);
    });

    it('re-keys the consents and the list even when there is no thread to move (the person never wrote), and says so', async () => {
        agent('test', [OLD]);
        db.consents.push({ creator_id: CREATOR, platform: 'whatsapp', contact_ref: OLD });
        await deliver(systemBody());
        assert.equal(only(logged('wa.contact_rekeyed')).outcome, 'no_thread');
        assert.deepEqual(db.consents.map((c) => c.contact_ref), [NEW]);
        assert.deepEqual(db.agent!.whatsapp_test_senders, [NEW]);
        assert.deepEqual(db.convs.map((c) => c.instagram_user_id), [NEW], 'the system message has a thread to live on');
    });

    it('is scoped to the tenant and to WhatsApp: another tenant’s thread with the same id is not touched', async () => {
        agent('off', []);
        db.convs.push(conv('conv-other', OLD, { creator_id: '22222222-2222-4222-8222-222222222222' }), conv('conv-ig', OLD, { platform: 'instagram', instagram_user_id: 'IG-LOOKALIKE' }));
        db.consents.push({ creator_id: '22222222-2222-4222-8222-222222222222', platform: 'whatsapp', contact_ref: OLD }, { creator_id: CREATOR, platform: 'instagram', contact_ref: OLD });
        await deliver(systemBody());
        assert.equal(db.convs.find((c) => c.id === 'conv-other')!.instagram_user_id, OLD);
        assert.deepEqual(db.consents.map((c) => c.contact_ref), [OLD, OLD], 'neither the other tenant’s nor the other platform’s consent moved');
        assert.ok(statements.filter((s) => s.sql.includes('contact_consents')).every((s) => s.params[0] === CREATOR && s.sql.includes("platform = 'whatsapp'")));
    });

    it('stores a stranger’s system message as metadata only, and a tester’s with its text and new phone', async () => {
        agent('test', []);
        db.convs.push(conv('conv-old', OLD));
        await deliver(systemBody());
        let msg = only(db.msgs);
        assert.deepEqual([msg.text, msg.raw_payload], ['', null]);
        assert.equal(db.convs[0]!.wa_phone, null);

        // A tester: the same event, with the new phone Meta shares on a number change.
        db.convs = [conv('conv-t', OLD)];
        db.msgs = [];
        agent('test', [OLD]);
        const changed = fixture('system-user-changed-number');
        const system = changed.entry[0].changes[0].value.messages[0].system;
        system.previous_user_id = OLD;
        await deliver(changed);
        msg = only(db.msgs);
        assert.equal(msg.text, system.body);
        assert.ok(msg.raw_payload);
        assert.equal(db.convs[0]!.wa_phone, system.wa_id, 'the new phone wins: the number is what changed');
    });

    it('does nothing twice for a redelivered system message', async () => {
        agent('test', [OLD]);
        db.convs.push(conv('conv-old', OLD));
        await deliver(systemBody());
        const before = statements.length;
        await deliver(systemBody());
        assert.equal(only(logged('wa.duplicate_ignored')).event, 'wa.duplicate_ignored');
        const again = statements.slice(before).map((s) => s.sql);
        assert.ok(again.every((sql) => sql.startsWith('SELECT')), 'a redelivery only reads: no re-key, no write');
        assert.ok(!again.includes('BEGIN'));
        assert.equal(db.msgs.length, 1);
    });

    it('stores a system message with nothing to re-key (no previous id) without moving anything', async () => {
        agent('off', []);
        const body = systemBody();
        delete body.entry[0].changes[0].value.messages[0].system.previous_user_id;
        await deliver(body);
        assert.equal(only(logged('wa.system_event_no_rekey')).system_type, 'user_changed_user_id');
        assert.ok(!statements.some((s) => s.sql === 'BEGIN'));
        assert.equal(only(db.msgs).message_type, 'system');
    });
});

// ─── The routes into the handler ───────────────────────────────────────────────────────

describe('the two routes into the handler', () => {
    const job = <K extends JobKind>(kind: K, payload: unknown): Job<K> => ({ id: 'job-1', kind, payload, attempts: 1, max_attempts: 3, request_id: null, creator_id: null, tenant_key: PHONE_ID } as Job<K>);

    it('the job registry sends a WhatsApp dm.process to the WhatsApp handler, not the Instagram pipeline', async () => {
        agent('off', [BSUID]);
        const [payload] = jobsOf(textBody(BODY, 'wamid.J1'));
        await handlers['dm.process'](payload!, job('dm.process', payload));
        assert.equal(only(db.msgs).text, BODY);
        assert.equal(only(db.convs).platform, 'whatsapp');
        assert.equal(logged('dm.received').length, 0, 'the Instagram pipeline did not run');
    });

    it('the job registry hands a wa.event to the event handler', async () => {
        const payload = { kind: 'preference' as const, entryId: WABA, phoneNumberId: PHONE_ID, change: {} };
        await handlers['wa.event'](payload, job('wa.event', payload));
        assert.equal(only(logged('wa.preference_event')).phone_number_id, PHONE_ID);
    });

    it('the inline path (queue unavailable) stores the same message the same way, and isolates a failing one', async () => {
        agent('off', [BSUID]);
        const body = textBody(BODY, 'wamid.L1');
        body.entry[0].changes[0].value.messages.push({ ...body.entry[0].changes[0].value.messages[0], id: 'wamid.L2', text: { body: 'second' } });
        await processWebhookBody(body);
        assert.deepEqual(db.msgs.map((m) => [m.meta_message_id, m.text]), [['wamid.L1', BODY], ['wamid.L2', 'second']]);

        // A database that fails for one message does not stop the next, and the failure is logged, not thrown.
        const failing = textBody('x', 'wamid.L3');
        failing.entry[0].changes[0].value.messages.push({ ...failing.entry[0].changes[0].value.messages[0], id: 'wamid.L4', text: { body: 'fourth' } });
        const real = fakeQuery;
        let armed = true;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            if (armed && norm(sql).startsWith('INSERT INTO messages') && params[6] === 'wamid.L3') { armed = false; throw new Error('disk full'); }
            return real(sql, params as any[]);
        };
        await processWebhookBody(failing);
        assert.ok(db.msgs.some((m) => m.meta_message_id === 'wamid.L4'), 'the second message was still stored');
        assert.equal(only(logged('webhook.whatsapp_failed')).job_kind, 'dm.process');
    });

    it('the inline path also handles a status, and an account event, by logging them', async () => {
        await processWebhookBody(fixture('phone-number-quality-update'));
        assert.equal(only(logged('wa.account_event')).field, 'phone_number_quality_update');
    });
});

// ─── What the job table holds afterwards (review C3) ───────────────────────────────────

/**
 * The same messages, but through the REAL runner and the real handler registry, into a queue that applies what `complete` and `fail` would write
 * (src/jobs/testSupport.ts). The assertion is on the stored payload: a stranger's words, phone, name and username must be nowhere in the JSON the
 * table would hold for the next seven days (or, for a failed job, for good).
 */
describe('the stored payload of a job (the queue keeps it 7 days, a failed one for good)', () => {
    const EVERY_SECRET = [BODY, PHONE, NAME, USERNAME];
    const drain = (queue: ReturnType<typeof memoryQueue>['queue'], maxJobs = 50) =>
        drainJobs({ queue, handlers, budgetMs: 10_000, maxJobs, random: () => 0.5 });
    const stored = (job: { payload: unknown }) => JSON.stringify(job.payload);
    const assertNoSecrets = (job: { payload: unknown }, secrets = EVERY_SECRET) => {
        for (const secret of secrets) assert.ok(!stored(job).includes(secret), `"${secret}" is still in the stored payload`);
    };

    it('redacts a stranger’s message as the job completes: no words, phone, name or username, and only the audit minimum stays', async () => {
        agent('off', []);
        const planned = planJobs(textBody(BODY, 'wamid.P1'));
        const { jobs, queue, completed } = memoryQueue(planned);
        for (const secret of EVERY_SECRET) assert.ok(stored(jobs[0]!).includes(secret), 'before the handler runs the full event is in the table: said in FLOWS.md');

        await drain(queue);

        const job = jobs[0]!;
        assert.equal(job.status, 'done');
        assert.deepEqual(completed, [{ id: 'job-1', redacted: true }], 'redacted by the completing statement, not by a second write');
        assertNoSecrets(job);
        assert.deepEqual(job.payload, {
            object: 'whatsapp', entryId: WABA, phoneNumberId: PHONE_ID,
            change: { redacted: true, metadata: { phone_number_id: PHONE_ID }, messages: [{ id: 'wamid.P1', type: 'text', timestamp: '1760875200', from_user_id: BSUID }] },
        });
        assert.deepEqual(db.msgs.map((m) => m.text), [''], 'and the message row never had them either');
    });

    it('leaves a listed test sender’s payload whole', async () => {
        agent('off', [BSUID]);
        const planned = planJobs(textBody(BODY, 'wamid.P2'));
        const { jobs, queue, completed } = memoryQueue(planned);
        await drain(queue);
        assert.equal(jobs[0]!.status, 'done');
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload);
        assert.deepEqual(completed, [{ id: 'job-1', redacted: false }]);
        assert.equal(db.msgs[0]!.text, BODY);
    });

    it('redacts the stranger and keeps the tester when one delivery holds both', async () => {
        agent('off', ['EG.the.tester']);
        const body = textBody('from the stranger', 'wamid.P3a');
        const tester = textBody('from the tester', 'wamid.P3b', { userId: 'EG.the.tester', phone: '201005550000', name: 'Tester Person', username: 'tester_handle' });
        body.entry[0].changes[0].value.contacts.push(...tester.entry[0].changes[0].value.contacts);
        body.entry[0].changes[0].value.messages.push(...tester.entry[0].changes[0].value.messages);
        const planned = planJobs(body);
        const { jobs, queue } = memoryQueue(planned);
        await drain(queue);
        assert.equal(jobs.length, 2);
        assertNoSecrets(jobs[0]!, ['from the stranger', PHONE, NAME, USERNAME]);
        assert.deepEqual(jobs[1]!.payload, planned[1]!.payload);
    });

    it('redacts a job that ends without storing anything: no connection, a switched-off tenant, a duplicate, an edit', async () => {
        agent('off', []);
        const redactedAfter = async (body: any) => {
            const { jobs, queue } = memoryQueue(planJobs(body));
            await drain(queue);
            assert.equal(jobs[0]!.status, 'done');
            return jobs[0]!;
        };

        connection = null;
        assertNoSecrets(await redactedAfter(textBody(BODY, 'wamid.N1')));

        connection = connectionRow();
        creatorActive = false;
        assertNoSecrets(await redactedAfter(textBody(BODY, 'wamid.N2')));

        creatorActive = true;
        await deliver(textBody(BODY, 'wamid.N3'));
        assertNoSecrets(await redactedAfter(textBody(BODY, 'wamid.N3')));
        assert.equal(logged('wa.duplicate_ignored').length, 1);

        const edit = fixture('edit');
        edit.entry[0].changes[0].value.contacts[0].user_id = BSUID;
        edit.entry[0].changes[0].value.messages[0].from_user_id = BSUID;
        const editJob = await redactedAfter(edit);
        const original = JSON.stringify(planJobs(edit)[0]!.payload);
        for (const secret of ['Sheena Nelson', '16505551234']) assert.ok(original.includes(secret) && !stored(editJob).includes(secret), secret);
    });

    it('leaves an Instagram job’s payload exactly as it was', async () => {
        const event = { sender: { id: 'u9' }, recipient: { id: 'ig-page-1' }, message: { mid: 'mid-ig-1', text: 'hello, private words' } };
        const planned = planJobs({ object: 'instagram', entry: [{ id: 'ig-page-1', messaging: [event] }] });
        const { jobs, queue, completed } = memoryQueue(planned);
        await drain(queue);
        assert.equal(jobs[0]!.status, 'done');
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload, 'byte for byte');
        assert.deepEqual(completed, [{ id: 'job-1', redacted: false }]);
        assert.ok(stored(jobs[0]!).includes('hello, private words'));
    });

    it('keeps the payload of a stranger’s job while it will be RETRIED, and redacts it on the failure that ends it', async () => {
        agent('off', []);
        const planned = planJobs(textBody(BODY, 'wamid.F1'));
        const { jobs, queue } = memoryQueue(planned, 3);
        failConversationUpsert = true;

        await drain(queue, 1);
        assert.deepEqual([jobs[0]!.status, jobs[0]!.attempts], ['pending', 1]);
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload, 'attempt 1 failed and a retry is coming: the payload is whole');
        await drain(queue, 1);
        assert.deepEqual([jobs[0]!.status, jobs[0]!.attempts], ['pending', 2]);
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload, 'attempt 2 too');

        await drain(queue, 1);
        assert.deepEqual([jobs[0]!.status, jobs[0]!.attempts], ['failed', 3]);
        assert.match(jobs[0]!.last_error!, /disk full/);
        assertNoSecrets(jobs[0]!);
        assert.equal((jobs[0]!.payload as any).change.messages[0].id, 'wamid.F1', 'what an operator needs to find it is still there');
    });

    it('keeps a listed test sender’s payload even on the failure that ends the job: the operator can replay it', async () => {
        agent('off', [BSUID]);
        const planned = planJobs(textBody(BODY, 'wamid.F2'));
        const { jobs, queue } = memoryQueue(planned, 3);
        failConversationUpsert = true;
        await drain(queue); // all three attempts
        assert.deepEqual([jobs[0]!.status, jobs[0]!.attempts], ['failed', 3]);
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload);
    });

    it('treats a failure before it knows who the sender is as a stranger’s: redacted at the end, whole before', async () => {
        agent('test', [BSUID]);
        const planned = planJobs(textBody(BODY, 'wamid.F3'));
        const { jobs, queue } = memoryQueue(planned, 3);
        agentReadFails = true;
        await drain(queue, 1);
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload);
        await drain(queue, 1);
        assert.deepEqual(jobs[0]!.payload, planned[0]!.payload);
        // The last attempt stores it as for a stranger and completes (wa.settings_unreadable): redacted.
        await drain(queue, 1);
        assert.equal(jobs[0]!.status, 'done');
        assertNoSecrets(jobs[0]!);
        assert.equal(logged('wa.settings_unreadable').length, 1);
    });
});

// ─── W7 wired in: a stop phrase from a listed tester ───────────────────────────────────

/** A message with a file, in the shape Meta sends it, from one person (BSUID first). A message with no caption has none of the field. */
function fileBody(type: 'image' | 'video' | 'document' | 'audio' | 'sticker', id: string, fields: Record<string, unknown>, who: Sender = {}): any {
    return textBody('', id, who, { type, text: undefined, [type]: fields });
}
const VOICE = { id: 'MEDIA-VOICE-1', mime_type: 'audio/ogg; codecs=opus', voice: true };
const PHOTO = { id: 'MEDIA-PHOTO-1', mime_type: 'image/jpeg' };

describe('a stop phrase from a listed tester (T044, review C2)', () => {
    it('is decided by the opt-out step, with the contact, the thread, the words and the language, and the agent is never asked: the row says opted_out', async () => {
        agent('test', [BSUID]);
        stops();
        await deliver(textBody('إيقاف', 'wamid.P1'));
        const conv = only(db.convs);
        assert.deepEqual(stepCalls.stop, [{ creatorId: CREATOR, conversationId: conv.id, senderId: BSUID, text: 'إيقاف', lang: 'ar', confirm: true }]);
        assert.equal(answerCalls.length, 0, 'one path decides: the turn is not run for a stop');
        const msg = only(db.msgs);
        assert.deepEqual([msg.no_reply_reason, msg.text], ['opted_out', 'إيقاف']);
        assert.notEqual(msg.handled_at, null);
        const said = only(logged('wa.inbound_stored'));
        assert.deepEqual([said.answered, said.no_reply_reason], [false, 'opted_out']);
    });

    it('reads English and Arabic, around punctuation and in any case, and the language of the phrase is the language of the confirmation', async () => {
        agent('test', [BSUID]);
        stops();
        await deliver(textBody('  STOP! ', 'wamid.P2'));
        await deliver(textBody('ايقاف.', 'wamid.P3'));
        await deliver(textBody('Unsubscribe', 'wamid.P4'));
        assert.deepEqual(stepCalls.stop.map((c) => c.lang), ['en', 'ar', 'en']);
        assert.ok(db.msgs.every((m) => m.no_reply_reason === 'opted_out'));
        assert.equal(answerCalls.length, 0);
    });

    it('is honoured in every mode, with the connection refused and while a person has the thread, and the confirmation goes only when the agent may speak', async () => {
        const cases: Array<[string, () => void, boolean]> = [
            ['mode test', () => agent('test', [BSUID]), true],
            ['mode everyone', () => agent('everyone', [BSUID]), true],
            ['mode off', () => agent('off', [BSUID]), false],
            ['a refused connection', () => { agent('test', [BSUID]); connection = connectionRow({ status: 'invalid' }); }, false],
            ['a person has the thread', () => {
                agent('test', [BSUID]);
                db.convs.push({
                    id: 'conv-paused', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
                    wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null, is_bot_active: false,
                });
            }, false],
        ];
        let n = 0;
        for (const [name, arrange, confirm] of cases) {
            db.convs.length = 0; db.msgs.length = 0; stepCalls.stop.length = 0; connection = connectionRow();
            arrange();
            stops();
            await deliver(textBody('stop', `wamid.Q${n++}`));
            assert.equal(stepCalls.stop.length, 1, name);
            assert.equal(stepCalls.stop[0]!.confirm, confirm, `${name}: confirm`);
            assert.equal(only(db.msgs).no_reply_reason, 'opted_out', name);
        }
        assert.equal(answerCalls.length, 0);
    });

    it('is NOT a stop when the stop word is only part of what they wrote: an order question, a place, a sentence', async () => {
        agent('test', [BSUID]);
        answers();
        const notStops = ['عايز إلغاء الطلب', 'وين موقف السيارات؟', 'stop by tomorrow?', 'nonstop', 'كيف أوقف الاشتراك', 'please stop the plan from expiring', 'إلغاء', 'cancel'];
        let n = 0;
        for (const text of notStops) await deliver(textBody(text, `wamid.NS${n++}`));
        assert.equal(stepCalls.stop.length, 0, 'the whole message must be the phrase');
        assert.deepEqual(answerCalls.map((c) => c.text), notStops, 'each went to the agent, whose own prefilter decides what it means');
    });

    it('leaves what only the TURN\'s prefilter understands («ما ابي رسايل») to the turn: the opt-out step is for the whole-message phrases', async () => {
        agent('test', [BSUID]);
        answers();
        await deliver(textBody('ما ابي رسايل', 'wamid.P5'));
        assert.equal(stepCalls.stop.length, 0);
        assert.equal(answerCalls.length, 1);
    });

    it('is not looked for in a stranger\'s message: nothing of theirs is read, kept or recorded', async () => {
        agent('test', ['EG.the.owner.tester']);
        await deliver(textBody('stop', 'wamid.P6'));
        assert.equal(stepCalls.stop.length, 0);
        const msg = only(db.msgs);
        assert.deepEqual([msg.no_reply_reason, msg.text, msg.raw_payload], ['not_test_sender', '', null]);
    });

    it('is read in a tapped button, in a photo\'s caption (and then the file is not even saved) and in what a voice note says', async () => {
        agent('test', [BSUID]);
        stops();
        saves();
        const button = fixture('interactive-button-reply');
        const bv = button.entry[0].changes[0].value;
        bv.contacts[0].user_id = BSUID;
        bv.messages[0].from_user_id = BSUID;
        bv.messages[0].id = 'wamid.P7';
        bv.messages[0].interactive.button_reply.title = 'Stop';
        await deliver(button);
        await deliver(fileBody('image', 'wamid.P8', { ...PHOTO, caption: 'وقف' }));
        assert.deepEqual(stepCalls.stop.map((c) => c.text), ['Stop', 'وقف']);
        assert.equal(stepCalls.saveFile.length, 0, 'a photo captioned with a stop is a stop, not a file to keep');

        reads(async () => ({ kind: 'text', text: 'توقف' }));
        await deliver(fileBody('audio', 'wamid.P9', VOICE));
        assert.deepEqual(stepCalls.stop.map((c) => c.text), ['Stop', 'وقف', 'توقف']);
        assert.equal(stepCalls.stop[2]!.confirm, true);
        assert.equal(answerCalls.length, 0);
        assert.ok(db.msgs.every((m) => m.no_reply_reason === 'opted_out'), db.msgs.map((m) => m.no_reply_reason).join(','));
    });

    it('a stop that could not be written is retried while an attempt is left (the claim given back at once), and never answered', async () => {
        agent('test', [BSUID]);
        steps.stop = async (input) => { stepCalls.stop.push(input); throw new Error('connection terminated unexpectedly'); };
        const body = textBody('stop', 'wamid.P10');
        await assert.rejects(() => deliver(body, { lastAttempt: false }), /connection terminated/);
        const msg = only(db.msgs);
        assert.deepEqual([msg.handled_at, msg.reply_claimed_at], [null, null], 'open, and free for the retry to take at once');
        assert.equal(logged('wa.optout_retrying').length, 1);

        stops();
        await deliver(body, { lastAttempt: false });
        assert.equal(only(db.msgs).no_reply_reason, 'opted_out');
        assert.equal(only(db.msgs).reply_attempts, 2);
        assert.equal(answerCalls.length, 0);
    });

    it('a stop that could not be written on the LAST attempt is said loudly and concluded as a failure: nothing is sent to someone who said stop', async () => {
        agent('test', [BSUID]);
        steps.stop = async (input) => { stepCalls.stop.push(input); throw new Error('connection terminated unexpectedly'); };
        await deliver(textBody('stop', 'wamid.P11'), { lastAttempt: true });
        assert.equal(only(db.msgs).no_reply_reason, 'failure');
        const said = only(logged('wa.optout_not_recorded'));
        assert.equal(said.level, 'error');
        assert.equal(answerCalls.length, 0);
    });
});

// ─── W6 wired in: what a tester sends that is not typed words ──────────────────────────

// ─── A sticker, a location, a contact card: the chat never goes silent ─────────────────

/** A sticker, a location or a contact card from one person, in the shape Meta sends it. */
function wordlessBody(type: 'sticker' | 'location' | 'contacts', id: string, who: Sender = {}): any {
    const content: Record<string, unknown> = {
        sticker: { id: 'MEDIA-STICKER-1', mime_type: 'image/webp', animated: false },
        location: { latitude: 21.4858, longitude: 39.1925, name: 'Jeddah Corniche', address: 'Jeddah' },
        contacts: [{ name: { formatted_name: 'Sami A.', first_name: 'Sami' }, phones: [{ phone: '+966500000000', type: 'CELL' }] }],
    };
    return textBody('', id, who, { type, text: undefined, [type]: content[type] });
}

describe('a sticker, a location or a contact card from a listed tester: one short line, and the chat is never silent', () => {
    const KINDS = ['sticker', 'location', 'contacts'] as const;

    for (const kind of KINDS) {
        it(`${kind}: the one-line step is asked once, with the thread and the row, and nothing is downloaded, read or sent to the agent; the row says NULL because the line went out`, async () => {
            agent('test', [BSUID]);
            acknowledges(async () => null);
            await deliver(wordlessBody(kind, `wamid.W-${kind}`));

            const conv = only(db.convs);
            const msg = only(db.msgs);
            assert.deepEqual(stepCalls.acknowledge, [{ creatorId: CREATOR, conversationId: conv.id, messageId: msg.id, what: kind, aiDisclosedAt: null }]);
            assert.deepEqual([answerCalls.length, stepCalls.saveFile.length, stepCalls.readMedia.length, stepCalls.stop.length], [0, 0, 0, 0]);
            assert.equal(msg.no_reply_reason, null, 'answered: the line went out');
            assert.notEqual(msg.handled_at, null);
            assert.equal(msg.message_type, kind);
            const said = only(logged('wa.inbound_stored'));
            assert.deepEqual([said.answered, said.no_reply_reason], [true, null]);
        });
    }

    it('what the one-line step concludes is what the row says: superseded in a burst, a closed window, an agent switched off, a refused send', async () => {
        agent('test', [BSUID]);
        const reasons = [null, 'superseded', 'window_closed', 'agent_off', 'failure'] as const;
        let n = 0;
        for (const reason of reasons) {
            acknowledges(async () => reason);
            await deliver(wordlessBody('sticker', `wamid.W2-${n++}`));
        }
        assert.deepEqual(db.msgs.map((m) => m.no_reply_reason), [...reasons]);
        assert.equal(answerCalls.length, 0);
    });

    it('is said to a tester in mode test and in mode everyone (which is test-only until the go-live gate)', async () => {
        acknowledges(async () => null);
        for (const mode of ['test', 'everyone'] as const) {
            agent(mode, [BSUID]);
            db.convs.length = 0;
            db.msgs.length = 0;
            await deliver(wordlessBody('location', `wamid.W3-${mode}`));
            assert.equal(only(db.msgs).no_reply_reason, null, mode);
        }
        assert.equal(stepCalls.acknowledge.length, 2);
    });

    it('is NEVER said to a stranger, in any mode, with every other fact in their favour: store-only, no line, the reason is not_test_sender (or agent_off for a thread in mode off), and nothing of theirs is kept', async () => {
        for (const mode of ['off', 'test', 'everyone'] as const) {
            agent(mode, ['EG.the.owner.tester']);
            for (const kind of KINDS) await deliver(wordlessBody(kind, `wamid.X-${mode}-${kind}`));
        }
        assert.equal(stepCalls.acknowledge.length, 0, 'not one line to a stranger');
        assert.deepEqual([answerCalls.length, stepCalls.saveFile.length, stepCalls.readMedia.length], [0, 0, 0]);
        assert.equal(db.msgs.length, 9);
        assert.deepEqual(db.msgs.map((m) => m.no_reply_reason), [
            'agent_off', 'agent_off', 'agent_off', 'not_test_sender', 'not_test_sender', 'not_test_sender', 'not_test_sender', 'not_test_sender', 'not_test_sender',
        ]);
        for (const m of db.msgs) assert.deepEqual([m.text, m.payload, m.raw_payload], ['', null, null], m.message_type);
    });

    it('is not said when the agent may not answer a tester: mode off, a connection Meta refused, a thread a person has. Each keeps its own reason, and nothing is sent', async () => {
        const cases: Array<[string, () => void, string]> = [
            ['mode off', () => agent('off', [BSUID]), 'agent_off'],
            ['a refused connection', () => { agent('test', [BSUID]); connection = connectionRow({ status: 'invalid' }); }, 'connection_invalid'],
            ['a person has the thread', () => {
                agent('test', [BSUID]);
                db.convs.push({
                    id: 'conv-paused', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
                    wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null, is_bot_active: false,
                });
            }, 'bot_paused'],
        ];
        let n = 0;
        for (const [name, arrange, reason] of cases) {
            db.convs.length = 0;
            db.msgs.length = 0;
            connection = connectionRow();
            arrange();
            await deliver(wordlessBody('sticker', `wamid.W4-${n++}`));
            assert.equal(only(db.msgs).no_reply_reason, reason, name);
        }
        assert.equal(stepCalls.acknowledge.length, 0);
    });

    it('a sticker is never read as a stop: no opt-out step is asked, only the one line', async () => {
        agent('test', [BSUID]);
        acknowledges();
        await deliver(wordlessBody('sticker', 'wamid.W5'));
        assert.equal(stepCalls.stop.length, 0);
        assert.equal(stepCalls.acknowledge.length, 1);
    });

    it('a one-line step that fails with the database is an error the runner retries, with the claim still held: nothing is concluded half-way', async () => {
        agent('test', [BSUID]);
        acknowledges(async () => { throw new Error('connection terminated unexpectedly'); });
        await assert.rejects(() => deliver(wordlessBody('contacts', 'wamid.W6'), { lastAttempt: false }), /connection terminated/);
        const msg = only(db.msgs);
        assert.equal(msg.handled_at, null);
        assert.equal(msg.no_reply_reason, null);
        assert.equal(answerCalls.length, 0);
    });

    it('a retried message is handed to the one-line step again (which finds its own claim and does not say it twice)', async () => {
        agent('test', [BSUID]);
        acknowledges(async () => { throw new Error('connection terminated unexpectedly'); });
        const body = wordlessBody('location', 'wamid.W7');
        await assert.rejects(() => deliver(body, { lastAttempt: false }), /connection terminated/);
        db.msgs.forEach((m) => { m.reply_claimed_at = null; });
        acknowledges(async () => null);
        await deliver(body, { lastAttempt: true });
        assert.equal(stepCalls.acknowledge.length, 2);
        assert.equal(only(db.msgs).no_reply_reason, null);
        assert.equal(only(db.msgs).reply_attempts, 2);
    });
});

describe('a file or a voice note from a listed tester (T035, T036, review M17)', () => {
    it('a photo WITH a caption is saved privately, and the caption is the message the agent answers', async () => {
        agent('test', [BSUID]);
        saves(async () => ({ uploadId: 'upload-photo', mimeType: 'image/jpeg' }));
        reads(async (input) => ({ kind: 'text', text: input.caption }));
        answers();
        await deliver(fileBody('image', 'wamid.F1', { ...PHOTO, caption: 'كم سعر الخطة؟' }));

        const conv = only(db.convs);
        const msg = only(db.msgs);
        assert.deepEqual(stepCalls.saveFile, [{ creatorId: CREATOR, messageId: msg.id, phoneNumberId: PHONE_ID, media: { kind: 'image', id: 'MEDIA-PHOTO-1', mime: 'image/jpeg', caption: 'كم سعر الخطة؟' }, resumed: false }]);
        assert.deepEqual(
            [stepCalls.readMedia[0]!.kind, stepCalls.readMedia[0]!.caption, stepCalls.readMedia[0]!.saved, stepCalls.readMedia[0]!.conversationId],
            ['media', 'كم سعر الخطة؟', { uploadId: 'upload-photo', mimeType: 'image/jpeg' }, conv.id],
        );
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.text, 'كم سعر الخطة؟');
        assert.equal(msg.no_reply_reason, null);
        assert.equal(msg.text, 'كم سعر الخطة؟', 'stored as received');
    });

    it('a document and a video with a caption are the same: the PDF named «my receipt» is a message about a receipt', async () => {
        agent('test', [BSUID]);
        saves();
        reads(async (input) => ({ kind: 'text', text: input.caption }));
        answers();
        await deliver(fileBody('document', 'wamid.F2', { id: 'MEDIA-DOC-1', mime_type: 'application/pdf', filename: 'r.pdf', caption: 'my receipt' }));
        await deliver(fileBody('video', 'wamid.F3', { id: 'MEDIA-VID-1', mime_type: 'video/mp4', caption: 'what is wrong here?' }));
        assert.deepEqual(answerCalls.map((c) => c.text), ['my receipt', 'what is wrong here?']);
        assert.deepEqual(stepCalls.readMedia.map((c) => c.kind), ['media', 'media']);
    });

    it('a photo with NO caption is not answered by the agent: the one line (or why not) is the media step\'s, and the row says what happened', async () => {
        agent('test', [BSUID]);
        saves();
        for (const [reason, id] of [[null, 'wamid.F4'], ['superseded', 'wamid.F5'], ['window_closed', 'wamid.F6']] as const) {
            reads(async () => ({ kind: 'concluded', reason }));
            await deliver(fileBody('image', id, PHOTO));
        }
        assert.equal(answerCalls.length, 0);
        assert.deepEqual(db.msgs.map((m) => m.no_reply_reason), [null, 'superseded', 'window_closed']);
        assert.deepEqual(db.msgs.map((m) => m.text), ['[photo]', '[photo]', '[photo]'], 'a word-less message is stored under its kind\'s placeholder, as on Instagram');
    });

    it('a voice note is saved, then read: its transcript is what the agent answers', async () => {
        agent('test', [BSUID]);
        saves(async () => ({ uploadId: 'upload-voice', mimeType: 'audio/ogg' }));
        reads(async () => ({ kind: 'text', text: 'هل الخطة يناسب المبتدئين؟' }));
        answers();
        await deliver(fileBody('audio', 'wamid.F7', VOICE));
        assert.equal(stepCalls.saveFile[0]!.media!.id, 'MEDIA-VOICE-1');
        assert.deepEqual([stepCalls.readMedia[0]!.kind, stepCalls.readMedia[0]!.saved], ['voice', { uploadId: 'upload-voice', mimeType: 'audio/ogg' }]);
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.text, 'هل الخطة يناسب المبتدئين؟');
        assert.equal(only(db.msgs).no_reply_reason, null);
    });

    it('a voice note that could not be read is concluded by the media step, which sent ONE line asking for text: the agent is not asked, and the file is still kept', async () => {
        agent('test', [BSUID]);
        saves();
        reads(async () => ({ kind: 'concluded', reason: null }));
        await deliver(fileBody('audio', 'wamid.F8', VOICE));
        assert.equal(answerCalls.length, 0);
        assert.equal(stepCalls.saveFile.length, 1);
        assert.equal(only(db.msgs).no_reply_reason, null, 'the line went out: the customer was answered');
    });

    it('a voice note whose file could not be had still reaches the media step, which says so to the customer (never ignored)', async () => {
        agent('test', [BSUID]);
        saves(async () => null);
        reads(async (input) => { assert.equal(input.saved, null); return { kind: 'concluded', reason: null }; });
        await deliver(fileBody('audio', 'wamid.F9', VOICE));
        assert.equal(stepCalls.readMedia.length, 1);
    });

    it('is saved in every mode and while a person has the thread, but read ONLY when the agent will answer: mode off, and a paused thread, spend nothing on a transcription', async () => {
        saves();
        agent('off', [BSUID]);
        await deliver(fileBody('audio', 'wamid.F10', VOICE));
        agent('test', [BSUID]);
        db.convs.length = 0;
        db.convs.push({
            id: 'conv-paused', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
            wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null, is_bot_active: false,
        });
        await deliver(fileBody('image', 'wamid.F11', { ...PHOTO, caption: 'hello' }));
        assert.equal(stepCalls.saveFile.length, 2);
        assert.equal(stepCalls.readMedia.length, 0);
        assert.deepEqual(db.msgs.map((m) => m.no_reply_reason), ['agent_off', 'bot_paused']);
    });

    it('is not downloaded on a connection Meta refused (there is no token to try), and is stored all the same with the media id in the raw event', async () => {
        agent('test', [BSUID]);
        connection = connectionRow({ status: 'invalid' });
        await deliver(fileBody('audio', 'wamid.F12', VOICE));
        assert.deepEqual([stepCalls.saveFile.length, stepCalls.readMedia.length], [0, 0]);
        const msg = only(db.msgs);
        assert.equal(msg.no_reply_reason, 'connection_invalid');
        assert.equal(JSON.parse(msg.raw_payload!).messages[0].audio.id, 'MEDIA-VOICE-1');
    });

    it('NEVER downloads or reads a stranger\'s file: a photo, a voice note, a document, in every mode, with every fact in favour', async () => {
        for (const mode of ['off', 'test', 'everyone'] as const) {
            agent(mode, ['EG.the.owner.tester']);
            await deliver(fileBody('image', `wamid.X1-${mode}`, { ...PHOTO, caption: 'secret caption' }));
            await deliver(fileBody('audio', `wamid.X2-${mode}`, VOICE));
            await deliver(fileBody('document', `wamid.X3-${mode}`, { id: 'MEDIA-DOC-9', mime_type: 'application/pdf', filename: 'passport.pdf' }));
        }
        assert.deepEqual([stepCalls.saveFile.length, stepCalls.readMedia.length, stepCalls.stop.length, answerCalls.length], [0, 0, 0, 0]);
        assert.equal(db.msgs.length, 9);
        for (const m of db.msgs) assert.deepEqual([m.text, m.payload, m.raw_payload], ['', null, null], m.message_type);
        const everything = everythingWritten();
        for (const secret of ['MEDIA-PHOTO-1', 'MEDIA-VOICE-1', 'MEDIA-DOC-9', 'secret caption', 'passport.pdf']) assert.ok(!everything.includes(secret), secret);
    });

    it('hands a retried message to the steps as RESUMED, so a file already saved and a transcript already made are not fetched or paid for again', async () => {
        agent('test', [BSUID]);
        db.convs.push({
            id: 'conv-x', creator_id: CREATOR, instagram_user_id: BSUID, platform: 'whatsapp', status: 'active', last_message_at: START, last_inbound_at: START,
            wa_phone: null, wa_username: null, wa_parent_user_id: null, profile_name: null, entry_source: null,
        });
        db.msgs.push({
            id: 'msg-x', conversation_id: 'conv-x', creator_id: CREATOR, direction: 'inbound', message_type: 'audio', text: '', payload: null, raw_payload: null,
            meta_message_id: 'wamid.F13', handled_at: null, reply_claimed_at: START - 10 * 60 * 1000, reply_attempts: 1, no_reply_reason: null, sender: 'customer',
        });
        saves();
        reads(async () => ({ kind: 'text', text: 'سؤال' }));
        answers();
        await deliver(fileBody('audio', 'wamid.F13', VOICE));
        assert.equal(stepCalls.saveFile[0]!.resumed, true);
        assert.equal(stepCalls.readMedia[0]!.resumed, true);
        assert.equal(db.msgs.length, 1);
    });

    it('a media step that fails with the database is an error the runner retries, with the claim still held: nothing is concluded half-way', async () => {
        agent('test', [BSUID]);
        saves();
        reads(async () => { throw new Error('connection terminated unexpectedly'); });
        await assert.rejects(() => deliver(fileBody('audio', 'wamid.F14', VOICE), { lastAttempt: false }), /connection terminated/);
        assert.equal(only(db.msgs).handled_at, null);
        assert.equal(answerCalls.length, 0);
    });
});

// ─── W8 wired in: where a thread came from ─────────────────────────────────────────────

describe('an entry link\'s tracking code (T049, review M20)', () => {
    const REF = 'K7M3QA';
    const labels = { 'wa-code-1': { label: 'Instagram bio', ref: REF, created_at: '2026-10-19T08:00:00.000Z' } };
    const PREFILL = 'مرحبا، أبغى أعرف عن الخطة';
    const withLabels = () => { steps.labels = async (creatorId) => { stepCalls.labels.push(creatorId); return labels; }; };

    it('a known ref in the first message attributes the thread to the link, with the owner\'s label: a QR code and a short link are the same kind', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L1'));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'link', ref: REF, label: 'Instagram bio', at: '2025-10-19T12:00:00.000Z' });
        assert.deepEqual(stepCalls.labels, [CREATOR]);
    });

    it('the agent reads the words WITHOUT the code, and the stored row keeps them exactly as they arrived', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L2'));
        assert.equal(only(db.msgs).text, `${PREFILL} #${REF}`, 'as received');
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.text, PREFILL);
        assert.equal(answerCalls[0]!.entryRef, REF, 'and the turn is told the ref, so it can take it out of the history it reads too');
    });

    it('is read in lower case too (a phone may change the case), and only the tenant\'s OWN refs count: an unknown one is organic and untouched', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF.toLowerCase()}`, 'wamid.L3'));
        assert.equal(only(db.convs).entry_source.kind, 'link');
        assert.equal(answerCalls[0]!.text, PREFILL);

        db.convs.length = 0; db.msgs.length = 0; answerCalls.length = 0;
        await deliver(textBody('hello #ZZ9ZZ9', 'wamid.L4'));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'organic', at: '2025-10-19T12:00:00.000Z' });
        assert.equal(answerCalls[0]!.text, 'hello #ZZ9ZZ9', 'a code that is not the tenant\'s is the customer\'s own text');
        assert.equal(answerCalls[0]!.entryRef, null);
    });

    it('costs no query at all for a message with no code in it, which is nearly every message', async () => {
        agent('test', [BSUID]);
        answers();
        await deliver(textBody(BODY, 'wamid.L5'));
        await deliver(textBody('I am #1 fan', 'wamid.L6'));
        assert.deepEqual(stepCalls.labels, []);
    });

    it('only the FIRST inbound sets it, and a later message of the thread is still read without the code (the thread\'s own ref)', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L7'));
        await deliver(textBody('and the price?', 'wamid.L8'));
        assert.equal(only(db.convs).entry_source.kind, 'link');
        assert.deepEqual(answerCalls.map((c) => c.entryRef), [REF, REF]);

        await deliver(textBody('one more time #K7M3QA', 'wamid.L9'));
        assert.equal(answerCalls[2]!.text, 'one more time');
        assert.equal(only(db.convs).entry_source.ref, REF);
    });

    it('a click-to-WhatsApp referral stays ctwa: the code does not overwrite it, and is still out of the agent\'s words', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L10', {}, { referral: { source_type: 'ad', source_id: 'AD-77', ctwa_clid: 'CLID-1', headline: 'Learn AI' } }));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'ctwa', ad_id: 'AD-77', ctwa_clid: 'CLID-1', headline: 'Learn AI', at: '2025-10-19T12:00:00.000Z' });
        assert.equal(answerCalls[0]!.text, PREFILL);
    });

    it('labels that cannot be read cost the attribution and nothing else: the message is stored and answered, and the warning says why', async () => {
        agent('test', [BSUID]);
        steps.labels = async () => { throw new Error('connection terminated unexpectedly'); };
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L11'));
        assert.equal(only(db.convs).entry_source.kind, 'organic');
        assert.equal(only(logged('wa.entry_link_unreadable')).level, 'warn');
        assert.equal(answerCalls.length, 1);
        assert.equal(answerCalls[0]!.text, `${PREFILL} #${REF}`);
    });

    it('is metadata, so a stranger\'s first message through a link is attributed too, and none of their words are kept', async () => {
        agent('test', ['EG.the.owner.tester']);
        withLabels();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L12'));
        assert.deepEqual(only(db.convs).entry_source, { kind: 'link', ref: REF, label: 'Instagram bio', at: '2025-10-19T12:00:00.000Z' });
        assert.deepEqual([only(db.msgs).text, only(db.msgs).raw_payload], ['', null]);
        assert.ok(!everythingWritten().includes(PREFILL));
    });

    it('never sets the free window: a referral, a link and an ad say where a thread began, and only a free_entry_point status says what it costs', async () => {
        agent('test', [BSUID]);
        withLabels();
        answers();
        await deliver(textBody(`${PREFILL} #${REF}`, 'wamid.L13'));
        await deliver(textBody('from an ad', 'wamid.L14', { userId: 'EG.another' }, { referral: { source_type: 'ad', source_id: 'AD-1', ctwa_clid: 'C1' } }));
        assert.ok(!statements.some((s) => s.sql.includes('free_window_expires_at')), 'no statement of this handler touches it');
    });
});
