/**
 * A WhatsApp message, stored and not answered (`handleWhatsAppInbound`), through the whole path a real one takes: Meta's own sample payloads ->
 * `planJobs` -> the job's stored change -> the handler -> the database. Nothing here is a mock of the code under test.
 *
 * The database is a small in-memory model that answers by SQL, with the semantics the statements depend on: the unique index on a contact and on
 * a message id, `COALESCE` on conflict, a transaction that really rolls back. It throws on a statement the handler was not expected to make, and
 * every statement and parameter is recorded. `metaHttp` and `axios` are recorders that count EVERY call and fail it: this phase talks to
 * Meta not at all. `.env` holds live credentials; nothing here may reach Postgres or Meta.
 *
 * What is pinned, because each is a way this could go wrong in front of real people:
 *   - a person who is not on the owner's test list leaves no words, phone, username, name, media or raw event behind (C3): swept over every
 *     statement parameter and every log line, not just the columns it should be in
 *   - nothing is sent, in any mode, for any sender, ever
 *   - every inbound stamps `last_inbound_at`, and a redelivery does not
 *   - a BSUID that changes follows the person through the thread, their consents and the test list, and never merges or deletes a thread
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pool } from '../config/db.js';
import { handlers } from '../jobs/handlers.js';
import { drainJobs } from '../jobs/runner.js';
import { memoryQueue } from '../jobs/testSupport.js';
import type { Job, JobKind, WhatsAppDmPayload } from '../jobs/types.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import { planJobs, processWebhookBody } from './router.js';
import { handleWhatsAppInbound, isTestSender, noReplyReasonFor } from './whatsappInbound.js';

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
                return result([{ id: existing.id }]);
            }
            const c: Conv = {
                id: `conv-${++nextId}`, creator_id: creator, instagram_user_id: userId, platform: 'whatsapp', status: 'active', last_message_at: clock, last_inbound_at: clock,
                wa_phone: phone, wa_username: username, wa_parent_user_id: parent, profile_name: name, entry_source: JSON.parse(entry),
            };
            db.convs.push(c);
            return result([{ id: c.id }]);
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
    if (sql.startsWith('UPDATE messages SET handled_at = NOW(), reply_claimed_at = NULL, no_reply_reason = $2 WHERE id = $1')) {
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
    // Whatever the test did, nothing was sent.
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
    for (const payload of jobsOf(body)) await handleWhatsAppInbound(payload, options);
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
    it('says why, in this phase', () => {
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'off', isTestSender: true }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'off', isTestSender: false }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'test', isTestSender: false }), 'not_test_sender');
        // W5 replaces this: the agent answers test senders. Nothing is sent until it does.
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'test', isTestSender: true }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'everyone', isTestSender: false }), 'agent_off');
        assert.equal(noReplyReasonFor({ unsupported: false, mode: 'everyone', isTestSender: true }), 'agent_off');
    });

    it('puts a message the agent cannot read first, in every mode', () => {
        for (const mode of ['off', 'test', 'everyone'] as const) {
            for (const isTest of [true, false]) assert.equal(noReplyReasonFor({ unsupported: true, mode, isTestSender: isTest }), 'unsupported_type');
        }
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
        await deliver(image);
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
        await deliver(textBody(BODY, 'wamid.S5'), { lastAttempt: false });
        assert.equal(only(db.msgs).text, BODY, 'the retry stores it in full: the sender is a tester');
    });
});

// ─── Nobody is answered ────────────────────────────────────────────────────────────────

describe('what each mode says about a message nobody answers', () => {
    const cases: Array<[string, string[], string]> = [
        ['off', [], 'agent_off'],
        ['off', [BSUID], 'agent_off'],
        ['test', [], 'not_test_sender'],
        ['test', [BSUID], 'agent_off'],
        ['everyone', [], 'agent_off'],
        ['everyone', [BSUID], 'agent_off'],
    ];
    for (const [mode, senders, expected] of cases) {
        it(`mode ${mode}, ${senders.length ? 'a listed sender' : 'a stranger'}: ${expected}, and nothing is sent`, async () => {
            agent(mode, senders);
            await deliver(textBody(BODY, `wamid.M-${mode}-${senders.length}`));
            const msg = only(db.msgs);
            assert.equal(msg.no_reply_reason, expected);
            assert.notEqual(msg.handled_at, null);
            assert.deepEqual(metaCalls, []);
            assert.ok(!statements.some((s) => /'outbound'/.test(s.sql)), 'no outbound row');
        });
    }

    it('never reads the agent for a reply: no engine, no profile, no model, no quota: only the connection, the settings and the thread', async () => {
        agent('test', [BSUID]);
        await deliver(textBody(BODY, 'wamid.N1'));
        const touched = new Set(statements.map((s) => /(?:FROM|INTO|UPDATE)\s+([a-z_]+)/i.exec(s.sql)?.[1]));
        assert.deepEqual([...touched].sort(), ['ai_agents', 'conversations', 'creators', 'messages', 'platform_connections']);
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
