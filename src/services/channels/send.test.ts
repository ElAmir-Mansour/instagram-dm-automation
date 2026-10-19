/**
 * The WhatsApp sender (`sendWhatsAppReply`, contracts/outbound-send.md section 1). `pool.query` answers on the SQL it is handed and THROWS for a statement
 * a test did not arrange; `metaHttp.post` records every request and answers (or fails) as the test says. No database, no Meta, no model.
 *
 * What is pinned, because each is a way a real person is messaged wrongly or not at all:
 *   - a step that says no (no thread, a thread of another tenant or another channel, a connection that is not active, a closed window, a billable
 *     message nobody agreed to, a reply with no words) makes NO request to Meta
 *   - the request is the exact Cloud API one: the number's own endpoint, the token in a header, `recipient` and never `to`
 *   - a failure is classified: a dead token or a payment problem marks the connection invalid, the window closing is `window_closed`, a throttle can
 *     be retried, and a failure that may have been delivered is never retried by the sender itself
 *   - the outbound row carries the `wamid`, and a row that cannot be written does not turn a delivered message into a failed send
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { encryptSecret } from '../../config/crypto.js';
import { setLogSink } from '../../utils/log.js';
import { metaHttp } from '../http.js';
import { attachWamid, sendWhatsAppReply, type SendWhatsAppReplyInput } from './send.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const OTHER_CREATOR = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const PHONE_ID = '106540352242922';
const BSUID = 'EG.13491208655302741918';
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const NOW = new Date('2026-10-19T12:00:00.000Z');
const WORDS = 'Yes, it is still in stock, and I can reserve one for you.';

interface World {
    thread: Record<string, unknown> | null;
    connection: Record<string, unknown> | null;
    freeUsed: number;
    insertFails: boolean;
    send: (url: string, body: any, config: any) => Promise<any>;
}

let world: World;
let statements: Array<{ sql: string; params: unknown[] }>;
let posts: Array<{ url: string; body: any; headers: any }>;
let logs: Array<Record<string, any>>;
let restoreSink: (() => void) | undefined;
let savedKey: string | undefined;
const originalQuery = pool.query;
const originalPost = metaHttp.post;

const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

const threadRow = (over: Record<string, unknown> = {}) => ({
    id: CONVERSATION, instagram_user_id: BSUID, platform: 'whatsapp', last_inbound_at: new Date(NOW.getTime() - 60 * 60 * 1000), free_window_expires_at: null, ...over,
});
const connectionRow = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1', creator_id: CREATOR, external_account_id: PHONE_ID, display_name: 'Test Number', status: 'active', last_error: null, scopes: [], has_token: true,
    access_expires_at: null, last_refreshed_at: null, created_at: new Date('2026-10-18T08:00:00Z'), profile: {}, settings: {}, access_token: encryptSecret(TOKEN), ...over,
});

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    world = {
        thread: threadRow(), connection: connectionRow(), freeUsed: 0, insertFails: false,
        send: async () => ({ data: { messaging_product: 'whatsapp', contacts: [{ user_id: BSUID, input: BSUID }], messages: [{ id: 'wamid.SENT1' }] } }),
    };
    statements = [];
    posts = [];
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sqlIn: string, params: unknown[] = []) => {
        const sql = norm(sqlIn);
        statements.push({ sql, params });
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (sql.includes('FROM conversations WHERE id = $1 AND creator_id = $2')) {
            return rows(world.thread && params[1] === CREATOR ? [world.thread] : []);
        }
        if (sql.includes('FROM platform_connections')) return rows(world.connection && params[0] === CREATOR ? [world.connection] : []);
        if (sql.includes('FROM channel_usage')) return rows([{ n: String(world.freeUsed) }]);
        if (sql.startsWith('INSERT INTO messages')) {
            if (world.insertFails) throw new Error('disk full');
            return rows([{ id: 'msg-out-1' }]);
        }
        if (sql.startsWith("UPDATE platform_connections SET status = 'invalid'")) return { rows: [], rowCount: 1 };
        if (sql.startsWith('UPDATE messages SET meta_message_id = $2')) return { rows: [], rowCount: 1 };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (metaHttp as any).post = async (url: string, body: any, config: any) => {
        posts.push({ url, body, headers: config?.headers });
        return world.send(url, body, config);
    };
});

afterEach(() => {
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).post = originalPost;
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

const send = (over: Partial<SendWhatsAppReplyInput> = {}) =>
    sendWhatsAppReply({ creatorId: CREATOR, conversationId: CONVERSATION, kind: 'operator', body: { text: WORDS }, now: NOW, ...over });

/** A Meta failure as `sendMessage` throws it: a `MetaApiError` over the axios error, with the code on both. */
function metaError(code: number | undefined, status: number | undefined, extra: Record<string, unknown> = {}) {
    const axiosLike: any = Object.assign(new Error('Request failed'), {
        ...(status !== undefined ? { response: { status, data: { error: { code, message: `Meta said ${code}` } } } } : {}), ...extra,
    });
    return axiosLike;
}

const outboundInserts = () => statements.filter((s) => s.sql.startsWith('INSERT INTO messages'));

describe('a reply that goes out', () => {
    it('is the exact Cloud API request: the number\'s endpoint, the token in a header, recipient and never to', async () => {
        const result = await send();
        assert.deepEqual(result, { ok: true, wamid: 'wamid.SENT1', messageId: 'msg-out-1' });

        assert.equal(posts.length, 1);
        assert.match(posts[0]!.url, new RegExp(`/${PHONE_ID}/messages$`));
        assert.equal(posts[0]!.headers.Authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(posts[0]!.body, {
            messaging_product: 'whatsapp', recipient_type: 'individual', recipient: BSUID, type: 'text', text: { body: WORDS, preview_url: false },
        });
        assert.ok(!('to' in posts[0]!.body));
        assert.ok(!JSON.stringify(posts[0]!.body).includes(TOKEN), 'the token is a header, not a field');
    });

    it('is addressed to the phone (to, never recipient) when Meta gave one: a test number checks its allowed list by phone (131030)', async () => {
        world.thread = threadRow({ wa_phone: '201007475609' });
        await send();
        assert.equal(posts.length, 1);
        assert.deepEqual(posts[0]!.body, {
            messaging_product: 'whatsapp', recipient_type: 'individual', to: '201007475609', type: 'text', text: { body: WORDS, preview_url: false },
        });
        assert.ok(!('recipient' in posts[0]!.body), 'never both');
    });

    it('keeps the BSUID for a contact with no usable phone (username-only, or a malformed value)', async () => {
        for (const wa_phone of [null, '', 'not-a-number', '123']) {
            posts = [];
            world.thread = threadRow({ wa_phone });
            await send();
            assert.equal(posts[0]!.body.recipient, BSUID, String(wa_phone));
            assert.ok(!('to' in posts[0]!.body), String(wa_phone));
        }
    });

    it('stores the outbound row with the wamid, the words, and who wrote it', async () => {
        await send();
        const insert = outboundInserts()[0]!;
        assert.match(insert.sql, /'outbound'/);
        const [conversationId, creatorId, type, text, raw, wamid, sender] = insert.params as string[];
        assert.deepEqual([conversationId, creatorId, type, text, wamid, sender], [CONVERSATION, CREATOR, 'text', WORDS, 'wamid.SENT1', 'operator']);
        assert.deepEqual(JSON.parse(raw!), { text: WORDS }, 'in the shape the inbox and the model\'s history already read');
    });

    it('tags the bot\'s replies and handoff lines as the bot\'s, and a person\'s as a person\'s', async () => {
        for (const [kind, sender] of [['agent', 'ai'], ['handoff', 'ai'], ['operator', 'operator']] as const) {
            statements = [];
            await send({ kind });
            assert.equal((outboundInserts()[0]!.params as string[])[6], sender, kind);
        }
    });

    it('sends buttons as an interactive message and stores them in the shape the inbox draws', async () => {
        await send({ body: { text: 'Which one?', quickReplies: [{ title: 'Plan A', payload: 'PLAN_A' }, { title: 'Plan B', payload: 'PLAN_B' }] } });
        assert.equal(posts[0]!.body.type, 'interactive');
        assert.equal(posts[0]!.body.interactive.type, 'button');
        const insert = outboundInserts()[0]!.params as string[];
        assert.equal(insert[2], 'quick_reply');
        assert.deepEqual(JSON.parse(insert[4]!).quick_replies, [
            { content_type: 'text', title: 'Plan A', payload: 'PLAN_A' }, { content_type: 'text', title: 'Plan B', payload: 'PLAN_B' },
        ]);
    });

    it('is ONE request to Meta for one reply, whatever the reply holds (review M14)', async () => {
        await send({ body: { text: 'Here', quickReplies: [{ title: 'Ok', payload: 'OK' }], link: { url: 'https://example.com/r/x', label: 'Open' } } });
        assert.equal(posts.length, 1);
    });

    it('does not write a row when asked not to (the sales turn writes its own), and says nothing of it', async () => {
        const result = await send({ kind: 'agent', record: false });
        assert.deepEqual(result, { ok: true, wamid: 'wamid.SENT1', messageId: null });
        assert.equal(outboundInserts().length, 0);
        assert.equal(posts.length, 1);
    });

    it('is still a success when the row cannot be written: the message has gone, and the log says the thread will not show it', async () => {
        world.insertFails = true;
        const result = await send();
        assert.deepEqual(result, { ok: true, wamid: 'wamid.SENT1', messageId: null });
        const said = logs.find((l) => l.event === 'wa.send_unrecorded');
        assert.equal(said?.level, 'error');
    });

    it('keeps a message Meta accepted without an id: sent, no wamid, and a warning that nothing can track it', async () => {
        world.send = async () => ({ data: { messages: [] } });
        const result = await send();
        assert.deepEqual(result, { ok: true, wamid: null, messageId: 'msg-out-1' });
        assert.ok(logs.some((l) => l.event === 'wa.send_no_id'));
    });

    it('never puts the words or the token in a log line', async () => {
        await send();
        const text = logs.map((l) => JSON.stringify(l)).join('\n');
        assert.ok(!text.includes(WORDS) && !text.includes(TOKEN) && !text.includes(BSUID));
    });
});

describe('a reply that is refused before Meta is asked', () => {
    const noMeta = () => assert.deepEqual(posts, [], 'no request was made to Meta');

    it('for a conversation that does not exist, or belongs to another tenant, or is not on WhatsApp', async () => {
        const gone = await send({ conversationId: '44444444-4444-4444-8444-444444444444', creatorId: OTHER_CREATOR });
        assert.equal(gone.ok === false && gone.reason, 'conversation_not_found');
        world.thread = threadRow({ platform: 'instagram' });
        const ig = await send();
        assert.equal(ig.ok === false && ig.reason, 'not_whatsapp');
        world.thread = threadRow({ platform: null });
        const unknown = await send();
        assert.equal(!unknown.ok && unknown.reason, 'not_whatsapp', 'a thread with no platform is not assumed to be WhatsApp');
        noMeta();
    });

    it('for a connection that is not active: none, revoked, invalid, or one with no token', async () => {
        for (const connection of [null, connectionRow({ status: 'revoked' }), connectionRow({ status: 'invalid', last_error: 'Meta reports the token as not valid.' }), connectionRow({ access_token: null })]) {
            world.connection = connection;
            const result = await send();
            assert.ok(!result.ok);
            assert.equal(result.reason, 'connection_invalid');
            assert.equal(result.attempted, false);
            assert.equal(result.permanent, true);
        }
        noMeta();
    });

    it('when the 24-hour window is closed, with the instant it closed, and reopened by a free-entry window or a newer message', async () => {
        world.thread = threadRow({ last_inbound_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
        const closed = await send();
        assert.ok(!closed.ok);
        assert.equal(closed.reason, 'window_closed');
        assert.equal(closed.closesAt?.toISOString(), '2026-10-19T11:00:00.000Z', 'last message plus 24 hours');
        assert.equal(closed.attempted, false);
        noMeta();

        world.thread = threadRow({ last_inbound_at: new Date(NOW.getTime() - 25 * 60 * 60 * 1000), free_window_expires_at: new Date(NOW.getTime() + 60 * 60 * 1000) });
        assert.equal((await send()).ok, true, 'a free-entry window keeps it open');
        world.thread = threadRow({ last_inbound_at: null });
        assert.ok(!(await send()).ok, 'a thread nobody has written in has no window');
        world.thread = threadRow({ last_inbound_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000) });
        assert.ok(!(await send()).ok, 'at exactly 24 hours it is closed');
    });

    it('for a message that would be billable, unless the owner allowed it, and never for one inside the free replies', async () => {
        world.freeUsed = 1000;
        const blocked = await send();
        assert.ok(!blocked.ok);
        assert.equal(blocked.reason, 'billable_blocked');
        assert.equal(blocked.attempted, false);
        noMeta();

        world.freeUsed = 999;
        assert.equal((await send()).ok, true, 'the 1,000th reply is still free');

        posts = [];
        world.freeUsed = 5000;
        world.connection = connectionRow({ settings: { allow_billable: true } });
        assert.equal((await send()).ok, true, 'the owner agreed to pay');
        assert.equal(posts.length, 1);
    });

    it('does not even read the meter when the owner allowed billable replies', async () => {
        world.connection = connectionRow({ settings: { allow_billable: true } });
        statements = [];
        await send();
        assert.ok(!statements.some((s) => s.sql.includes('channel_usage')));
    });

    it('for a reply with no words, as invalid_message', async () => {
        const result = await send({ body: { text: '   ' } });
        assert.ok(!result.ok);
        assert.equal(result.reason, 'invalid_message');
        noMeta();
        assert.equal(outboundInserts().length, 0);
    });

    it('writes no row and no log of the words for any refusal', async () => {
        world.thread = threadRow({ last_inbound_at: null });
        await send();
        assert.equal(outboundInserts().length, 0);
        assert.ok(!logs.map((l) => JSON.stringify(l)).join('\n').includes(WORDS));
    });
});

describe('a send that fails', () => {
    const failWith = (err: any) => { world.send = async () => { throw err; }; };

    it('with 131047 is the window closing under us: permanent, and nothing was delivered', async () => {
        failWith(metaError(131047, 400));
        const result = await send();
        assert.ok(!result.ok);
        assert.deepEqual([result.reason, result.permanent, result.mayHaveLanded, result.attempted, result.code], ['window_closed', true, false, true, 131047]);
        assert.equal(outboundInserts().length, 0, 'a message that did not go leaves no outbound row');
    });

    it('with 190 or 131042 marks the connection invalid, so every surface says reconnect, and is a connection_invalid result', async () => {
        for (const code of [190, 131042, 200, 10]) {
            statements = [];
            failWith(metaError(code, 401));
            const result = await send();
            assert.ok(!result.ok);
            assert.equal(result.reason, 'connection_invalid', String(code));
            assert.equal(result.permanent, true);
            const mark = statements.find((s) => s.sql.startsWith("UPDATE platform_connections SET status = 'invalid'"));
            assert.ok(mark, `${code}: the connection was marked`);
            assert.equal(mark!.params[0], 'conn-1');
        }
    });

    it('with 131026 is undeliverable and permanent; with 131056 or 130429 is rate_limited and can be tried again', async () => {
        failWith(metaError(131026, 400));
        const dead = await send();
        assert.ok(!dead.ok);
        assert.deepEqual([dead.reason, dead.permanent], ['undeliverable', true]);

        for (const code of [131056, 130429]) {
            failWith(metaError(code, 429));
            const slow = await send();
            assert.ok(!slow.ok);
            assert.deepEqual([slow.reason, slow.permanent], ['rate_limited', false], String(code));
        }
    });

    it('with an unknown code on a 4xx is a refusal of this request: permanent, not delivered', async () => {
        failWith(metaError(131062, 400));
        const result = await send();
        assert.ok(!result.ok);
        assert.deepEqual([result.reason, result.permanent, result.mayHaveLanded, result.code], ['send_failed', true, false, 131062]);
    });

    it('with a timeout or a 5xx MAY HAVE LANDED: not permanent, and the sender itself never sends it twice', async () => {
        for (const err of [metaError(undefined, undefined, { code: 'ECONNABORTED' }), metaError(2, 500), metaError(undefined, 502)]) {
            posts = [];
            failWith(err);
            const result = await send();
            assert.ok(!result.ok);
            assert.equal(result.reason, 'send_failed');
            assert.equal(result.mayHaveLanded, true);
            assert.equal(result.permanent, false);
            assert.equal(posts.length, 1, 'one request: a send that may have landed is not retried (withRetry creates)');
        }
        assert.equal(outboundInserts().length, 0);
    });

    it('whose connection never went out did not land, and may be tried again', async () => {
        failWith(metaError(undefined, undefined, { code: 'ENOTFOUND' }));
        const result = await send();
        assert.ok(!result.ok);
        assert.deepEqual([result.mayHaveLanded, result.permanent], [false, false]);
    });

    it('says what failed in the log without the words or the token', async () => {
        failWith(metaError(131047, 400));
        await send();
        const line = logs.find((l) => l.event === 'wa.send_failed')!;
        assert.equal(line.reason, 'window_closed');
        assert.equal(line.code, 131047);
        const all = logs.map((l) => JSON.stringify(l)).join('\n');
        assert.ok(!all.includes(WORDS) && !all.includes(TOKEN));
    });
});

describe('attachWamid', () => {
    it('puts the wamid on a row that has none, and never overwrites one', async () => {
        assert.equal(await attachWamid('msg-1', 'wamid.A'), true);
        const update = statements.find((s) => s.sql.startsWith('UPDATE messages SET meta_message_id = $2'))!;
        assert.match(update.sql, /meta_message_id IS NULL/);
        assert.deepEqual(update.params, ['msg-1', 'wamid.A']);
    });

    it('does nothing without both, and never throws', async () => {
        assert.equal(await attachWamid(null, 'wamid.A'), false);
        assert.equal(await attachWamid('msg-1', null), false);
        (pool as unknown as { query: unknown }).query = async () => { throw new Error('connection terminated'); };
        assert.equal(await attachWamid('msg-1', 'wamid.A'), false);
        assert.ok(logs.some((l) => l.event === 'wa.wamid_not_attached'));
    });
});
