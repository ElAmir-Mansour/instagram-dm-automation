/**
 * `POST /conversations/:id/messages` for a WhatsApp thread (phase W4): a person's reply from the inbox goes out through the WhatsApp sender, and an
 * Instagram or Messenger thread goes out exactly as it always did.
 *
 * `pool.query` answers on the SQL it is handed and throws for a statement a test did not arrange; `metaHttp.post` records every request. No database,
 * no Meta. What is pinned: a refusal (a closed window, a connection Meta refused, a billable reply nobody agreed to, a message that is too long, a
 * message Meta did not take) makes no request, stores no row and does NOT pause the bot; a reply that went pauses it AFTER it went; and the Instagram
 * and Facebook request bodies are byte for byte what `sendDirectMessage` always sent.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import apiRouter from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';
const PHONE_ID = '106540352242922';
const BSUID = 'EG.13491208655302741918';
const WA_TOKEN = 'EAAGwhatsapp-system-user-token-0123456789';
const IG_TOKEN = 'EAAGinstagram-page-token-9876543210';
const WORDS = 'Yes, it is still in stock. Shall I reserve one?';

interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
let posts: Array<{ url: string; body: any; headers: any }> = [];
let logs: Array<Record<string, any>> = [];
let conversation: Record<string, unknown> | null = null;
let thread: Record<string, unknown> | null = null;
let connection: Record<string, unknown> | null = null;
let freeUsed = 0;
let metaAnswer: (url: string, body: any) => Promise<any>;
let savedKey: string | undefined;
const original = { query: pool.query, connect: pool.connect, post: metaHttp.post };
const NOW = Date.now();

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const waConversation = (over: Record<string, unknown> = {}) => ({
    id: CONVERSATION, creator_id: TENANT, instagram_user_id: BSUID, platform: 'whatsapp', page_access_token: null, facebook_page_id: null, ...over,
});
const waThread = (over: Record<string, unknown> = {}) => ({
    id: CONVERSATION, instagram_user_id: BSUID, platform: 'whatsapp', last_inbound_at: new Date(NOW - 60 * 60 * 1000), free_window_expires_at: null, ...over,
});
const connectionRow = (over: Record<string, unknown> = {}) => ({
    id: 'conn-1', creator_id: TENANT, external_account_id: PHONE_ID, display_name: 'Test Number', status: 'active', last_error: null, scopes: [], has_token: true,
    access_expires_at: null, last_refreshed_at: null, created_at: new Date('2026-10-18T08:00:00Z'), profile: {}, settings: {}, access_token: encryptSecret(WA_TOKEN), ...over,
});

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    statements = [];
    posts = [];
    logs = [];
    conversation = waConversation();
    thread = waThread();
    connection = connectionRow();
    freeUsed = 0;
    metaAnswer = async () => ({ data: { messages: [{ id: 'wamid.SENT1' }] } });
    const run = async (sqlIn: string, params: any[] = []) => {
        const sql = sqlIn.replace(/\s+/g, ' ').trim();
        statements.push({ sql, params });
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        // The route's own lookup: scoped to the session's tenant.
        if (/FROM conversations c JOIN creators cr/.test(sql)) return rows(conversation && params[1] === TENANT ? [{ ...conversation }] : []);
        // The sender's lookups.
        if (sql.includes('FROM conversations WHERE id = $1 AND creator_id = $2')) return rows(thread && params[1] === TENANT ? [{ ...thread }] : []);
        if (sql.includes('FROM platform_connections')) return rows(connection ? [{ ...connection }] : []);
        if (sql.includes('FROM channel_usage')) return rows([{ n: String(freeUsed) }]);
        if (sql.startsWith('INSERT INTO messages')) return rows([{ id: 'msg-out-1' }]);
        if (sql.startsWith('UPDATE conversations SET last_message_at')) return { rows: [], rowCount: 1 };
        if (sql.startsWith("UPDATE platform_connections SET status = 'invalid'")) return { rows: [], rowCount: 1 };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).post = async (url: string, body: any, config: any) => {
        posts.push({ url, body, headers: config?.headers });
        return metaAnswer(url, body);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    (metaHttp as any).post = original.post;
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

function handlerFor(method: string, route: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === route && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${route} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader() {},
        send() { return this; },
    };
}

async function reply(body: Record<string, unknown> = { text: WORDS }, tenant = TENANT) {
    const res = fakeRes();
    await handlerFor('post', '/conversations/:id/messages')({ params: { id: CONVERSATION }, body, session: { userId: 'u-1', role: 'user', tenantId: tenant } }, res, () => {});
    return res;
}

const writes = (table: string) => statements.filter((s) => new RegExp(`^(UPDATE|INSERT INTO) ${table}\\b`).test(s.sql));
const paused = () => writes('conversations').some((s) => /is_bot_active = false/.test(s.sql));

describe('a reply to a WhatsApp thread, window open', () => {
    it('goes out through WhatsApp, never Instagram: the number\'s endpoint, recipient and no to, the WhatsApp token', async () => {
        const res = await reply();
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { success: true, message: 'Message sent manually. Bot is paused for this thread.' });

        assert.equal(posts.length, 1);
        assert.match(posts[0]!.url, new RegExp(`/${PHONE_ID}/messages$`));
        assert.ok(!posts.some((p) => /\/me\/messages$/.test(p.url)), 'not Instagram\'s Send API');
        assert.equal(posts[0]!.headers.Authorization, `Bearer ${WA_TOKEN}`);
        assert.deepEqual(posts[0]!.body, {
            messaging_product: 'whatsapp', recipient_type: 'individual', recipient: BSUID, type: 'text', text: { body: WORDS, preview_url: false },
        });
    });

    it('stores the row as the operator\'s, with the wamid, and pauses the bot AFTER the message went, as the Instagram branch does', async () => {
        await reply();
        const row = writes('messages')[0]!;
        assert.deepEqual([row.params[3], row.params[5], row.params[6]], [WORDS, 'wamid.SENT1', 'operator']);
        assert.ok(paused());
        const order = statements.map((s) => s.sql);
        assert.ok(order.findIndex((s) => s.startsWith('INSERT INTO messages')) < order.findIndex((s) => /is_bot_active = false/.test(s)), 'the row, then the pause');
    });

    it('is a reply that stays inside a free-entry window after the 24 hours', async () => {
        thread = waThread({ last_inbound_at: new Date(NOW - 30 * 60 * 60 * 1000), free_window_expires_at: new Date(NOW + 60 * 60 * 1000) });
        assert.equal((await reply()).statusCode, 200);
    });

    it('never logs the words of the reply', async () => {
        await reply();
        assert.ok(!logs.map((l) => JSON.stringify(l)).join('\n').includes(WORDS));
    });
});

describe('a reply to a WhatsApp thread that is refused', () => {
    const untouched = () => {
        assert.deepEqual(posts, [], 'no request to Meta');
        assert.deepEqual(writes('messages'), [], 'no outbound row for a message that did not go');
        assert.equal(paused(), false, 'the bot is not paused for a reply that was not sent');
    };

    it('with the window closed is a 409 WHATSAPP_WINDOW_CLOSED that says when it closed', async () => {
        const lastInbound = new Date(NOW - 26 * 60 * 60 * 1000);
        thread = waThread({ last_inbound_at: lastInbound });
        const res = await reply();
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'WHATSAPP_WINDOW_CLOSED');
        const closesAt = new Date(lastInbound.getTime() + 24 * 60 * 60 * 1000).toISOString();
        assert.equal(res.body.closes_at, closesAt);
        assert.deepEqual(res.body.params, { closes_at: closesAt });
        assert.match(res.body.error, /24-hour/);
        untouched();
    });

    it('for a thread nobody has written in has no window: the same 409, with no time', async () => {
        thread = waThread({ last_inbound_at: null });
        const res = await reply();
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'WHATSAPP_WINDOW_CLOSED');
        assert.equal(res.body.closes_at, null);
        untouched();
    });

    it('with no usable connection is a 409 that says to reconnect', async () => {
        for (const row of [null, connectionRow({ status: 'invalid', last_error: 'Meta reports the token as not valid.' })]) {
            connection = row;
            const res = await reply();
            assert.equal(res.statusCode, 409);
            assert.match(res.body.error, /connect/i);
            untouched();
        }
    });

    it('for a billable message nobody agreed to is a 409', async () => {
        freeUsed = 1000;
        const res = await reply();
        assert.equal(res.statusCode, 409);
        assert.match(res.body.error, /free replies/);
        untouched();
    });

    it('that Meta does not take is a 502 with nothing stored and the bot still on', async () => {
        metaAnswer = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 500, data: { error: { code: 2, message: 'Service unavailable' } } } }); };
        const res = await reply();
        assert.equal(res.statusCode, 502);
        assert.equal(posts.length, 1, 'tried once: a send that may have landed is never retried');
        assert.deepEqual(writes('messages'), []);
        assert.equal(paused(), false);
    });

    it('for a dead token marks the connection invalid and is a 409', async () => {
        metaAnswer = async () => { throw Object.assign(new Error('Request failed'), { response: { status: 401, data: { error: { code: 190, message: 'Invalid OAuth access token' } } } }); };
        const res = await reply();
        assert.equal(res.statusCode, 409);
        assert.ok(writes('platform_connections').length === 1, 'the connection says reconnect on every surface now');
        assert.equal(paused(), false);
    });

    it('with no text, or text that is not a string, is a 400, and one over 4,096 characters is refused and not cut', async () => {
        for (const body of [{}, { text: '' }, { text: '   ' }, { text: { evil: true } }]) {
            const res = await reply(body as Record<string, unknown>);
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        const long = await reply({ text: 'x'.repeat(4097) });
        assert.equal(long.statusCode, 400);
        assert.match(long.body.error, /4096/);
        untouched();
        assert.equal((await reply({ text: 'x'.repeat(4096) })).statusCode, 200, 'exactly the limit is fine');
    });

    it('for another tenant\'s conversation is a 404 and touches nothing', async () => {
        const res = await reply({ text: WORDS }, OTHER_TENANT);
        assert.equal(res.statusCode, 404);
        untouched();
    });
});

describe('Instagram and Messenger threads are untouched by the WhatsApp branch', () => {
    const igConversation = (over: Record<string, unknown> = {}) => ({
        id: CONVERSATION, creator_id: TENANT, instagram_user_id: '17841400000000001', platform: 'instagram', page_access_token: encryptSecret(IG_TOKEN), facebook_page_id: 'fb-page-1', ...over,
    });

    it('sends an Instagram reply to /me/messages with the exact body it always sent, and pauses the bot', async () => {
        conversation = igConversation();
        const res = await reply();
        assert.equal(res.statusCode, 200);
        assert.equal(posts.length, 1);
        assert.match(posts[0]!.url, /\/me\/messages$/);
        assert.deepEqual(posts[0]!.body, { recipient: { id: '17841400000000001' }, message: { text: WORDS }, messaging_type: 'RESPONSE' });
        assert.equal(posts[0]!.headers.Authorization, `Bearer ${IG_TOKEN}`);
        assert.ok(paused());
        const row = writes('messages')[0]!;
        assert.match(row.sql, /VALUES \(\$1, \$2, 'outbound', 'text', \$3, \$4, 'operator'\)/);
        assert.deepEqual(row.params, [CONVERSATION, TENANT, WORDS, JSON.stringify({ text: WORDS })]);
        assert.ok(!statements.some((s) => /platform_connections|channel_usage/.test(s.sql)), 'WhatsApp\'s connection and meter are not read');
    });

    it('sends a Messenger reply through the Page id with the same body', async () => {
        conversation = igConversation({ platform: 'facebook', instagram_user_id: '9988776655' });
        await reply();
        assert.match(posts[0]!.url, /\/fb-page-1\/messages$/);
        assert.deepEqual(posts[0]!.body, { recipient: { id: '9988776655' }, message: { text: WORDS }, messaging_type: 'RESPONSE' });
    });
});
