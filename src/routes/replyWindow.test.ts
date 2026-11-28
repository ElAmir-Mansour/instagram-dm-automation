/**
 * The manual reply on an Instagram or Facebook thread is refused when Meta's window has closed (R1-I1), and one conversation can be read alone (INBOX-L1).
 *
 * `POST /conversations/:id/messages`: the rule is `replyWindow.ts`. A manual send is `messaging_type: RESPONSE` with no message tag, so it is 24 hours
 * from the customer's last message, or an ad conversation's longer window when `ads.extended_window` is on for that platform. A refusal is 409
 * `WINDOW_CLOSED` with `closedAt`, makes NO request to Meta, stores nothing and does not pause the bot. WhatsApp keeps `WHATSAPP_WINDOW_CLOSED`
 * (`whatsappReply.test.ts`). `GET /conversations/:id` answers the list item of one thread for the session's tenant only.
 *
 * `pool.query` answers on the SQL it is handed and throws for one a test did not arrange; `metaHttp.post` records every request. No database, no Meta.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Json = any;
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
const CONV = '44444444-4444-4444-8444-444444444444';
const IG_TOKEN = 'EAAGinstagram-page-token-9876543210';
const WORDS = 'Yes, it is still in stock. Shall I reserve one?';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const at = (msAgo: number): Date => new Date(NOW - msAgo);

let statements: Array<{ sql: string; params: any[] }> = [];
let posts: Array<{ url: string; body: any }> = [];
let logs: Array<Record<string, any>> = [];
let conversation: Record<string, unknown> | null = null;
let lastInbound: Date | null = null;
let extendedWindow: string | null = null;
let metaAnswer: () => Promise<any>;
let savedKey: string | undefined;
const original = { query: pool.query, connect: pool.connect, post: metaHttp.post };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

const igConversation = (over: Record<string, unknown> = {}) => ({
    id: CONV, creator_id: TENANT, instagram_user_id: '17841400000000001', platform: 'instagram', username: 'sara_dev',
    page_access_token: encryptSecret(IG_TOKEN), facebook_page_id: 'fb-page-1', last_inbound_at: null, entry_source: null,
    is_bot_active: true, last_message_at: at(HOUR), ...over,
});

beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    statements = [];
    posts = [];
    logs = [];
    conversation = igConversation();
    lastInbound = at(HOUR);
    extendedWindow = null;
    metaAnswer = async () => ({ data: { message_id: 'm1' } });
    const run = async (sqlIn: string, params: any[] = []) => {
        const sql = sqlIn.replace(/\s+/g, ' ').trim();
        statements.push({ sql, params });
        const rows = (r: any[]) => ({ rows: r, rowCount: r.length });
        if (/FROM conversations c JOIN creators cr/.test(sql)) return rows(conversation && params[1] === TENANT ? [{ ...conversation }] : []);
        if (sql.includes('MAX(created_at) AS last_inbound_message_at FROM messages')) return rows([{ last_inbound_message_at: lastInbound }]);
        if (sql.includes('FROM app_settings WHERE key = $1')) return rows(extendedWindow === null ? [] : [{ value: extendedWindow, is_secret: false }]);
        if (sql.startsWith('INSERT INTO messages')) return rows([{ id: 'msg-out-1' }]);
        if (sql.startsWith('UPDATE conversations SET last_message_at')) return { rows: [], rowCount: 1 };
        // GET /conversations/:id: the list query (scoped by `c.creator_id = $1`), then the summary's own reads.
        if (/FROM conversations c LEFT JOIN LATERAL/.test(sql)) return rows(conversation && params[0] === TENANT && params[1] === CONV ? [{ ...conversation, last_inbound_message_at: lastInbound, message_count: 3 }] : []);
        if (sql.includes('FROM tracked_links')) return rows([]);
        if (sql.includes('FROM ai_agents')) return rows([{ is_active: true, sales_mode: 'off', sales_test_senders: [] }]);
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).post = async (url: string, body: any) => { posts.push({ url, body }); return metaAnswer(); };
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
        statusCode: 200, body: null as Json,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader() {}, send() { return this; },
    };
}

async function reply(tenant = TENANT) {
    const res = fakeRes();
    await handlerFor('post', '/conversations/:id/messages')({ params: { id: CONV }, body: { text: WORDS }, session: { userId: 'u-1', role: 'user', tenantId: tenant } }, res, () => {});
    return res;
}
async function getOne(id: string, tenant = TENANT) {
    const res = fakeRes();
    await handlerFor('get', '/conversations/:id')({ params: { id }, query: {}, session: { userId: 'u-1', role: 'user', tenantId: tenant } }, res, () => {});
    return res;
}

const writes = (table: string) => statements.filter((s) => new RegExp(`^(UPDATE|INSERT INTO) ${table}\\b`).test(s.sql));
const paused = () => writes('conversations').some((s) => /is_bot_active = false/.test(s.sql));
const refused = (res: ReturnType<typeof fakeRes>) => {
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, 'WINDOW_CLOSED');
    assert.deepEqual(posts, [], 'no request to Meta');
    assert.deepEqual(writes('messages'), [], 'no outbound row for a message that did not go');
    assert.equal(paused(), false, 'the bot is not paused for a reply that was not sent');
};

describe('POST /conversations/:id/messages: a closed window is refused before Meta is asked', () => {
    it('refuses an Instagram reply 25 hours after the customer\'s last message: 409 WINDOW_CLOSED with when it closed', async () => {
        lastInbound = at(25 * HOUR);
        const res = await reply();
        refused(res);
        const closedAt = new Date(lastInbound.getTime() + DAY).toISOString();
        assert.equal(res.body.closedAt, closedAt);
        assert.deepEqual(res.body.params, { closedAt });
        assert.equal(res.body.error, 'Meta accepts replies only within 24 hours of the customer\'s last message.');
        assert.equal(res.body.error, res.body.message);
    });

    it('refuses a Messenger reply the same way', async () => {
        conversation = igConversation({ platform: 'facebook' });
        lastInbound = at(44 * DAY);
        refused(await reply());
    });

    it('sends at 23 hours, and in the last hour before 24: a person is not given the assistant\'s margin', async () => {
        for (const age of [23 * HOUR, 24 * HOUR - 5 * 60 * 1000]) {
            posts = []; statements = [];
            lastInbound = at(age);
            assert.equal((await reply()).statusCode, 200, `${age}`);
            assert.equal(posts.length, 1);
            assert.ok(paused());
        }
    });

    it('does not refuse a thread whose customer has never written (no window to be past), and falls back to the v39 stamp', async () => {
        lastInbound = null;
        assert.equal((await reply()).statusCode, 200);
        posts = [];
        statements = [];
        conversation = igConversation({ last_inbound_at: at(30 * HOUR) });
        refused(await reply());
    });

    it('is answered before the send, and logs the refusal without the words', async () => {
        lastInbound = at(30 * HOUR);
        await reply();
        const order = statements.map((s) => s.sql);
        assert.ok(order.some((s) => s.includes('MAX(created_at)')), 'the window was read');
        assert.ok(logs.some((l) => l.event === 'inbox.manual_reply_refused' || l.msg === 'inbox.manual_reply_refused' || JSON.stringify(l).includes('inbox.manual_reply_refused')));
        assert.ok(!logs.map((l) => JSON.stringify(l)).join('\n').includes(WORDS));
    });

    it('leaves another tenant\'s conversation a 404 that reads no window', async () => {
        const res = await reply(OTHER_TENANT);
        assert.equal(res.statusCode, 404);
        assert.ok(!statements.some((s) => s.sql.includes('MAX(created_at)')));
    });
});

describe('POST /conversations/:id/messages: an ad conversation\'s longer window (ads.extended_window)', () => {
    const adThread = (platform: 'instagram' | 'messenger', clickedAgo: number, over: Record<string, unknown> = {}) =>
        igConversation({ platform: platform === 'messenger' ? 'facebook' : 'instagram', entry_source: { kind: 'ctm', platform, at: at(clickedAgo).toISOString(), ad_id: '1' }, ...over });

    it('sends on day 3 of an ad conversation when the switch for its platform is on: 7 days less an hour from the click', async () => {
        extendedWindow = JSON.stringify({ instagram: true, messenger: false });
        conversation = adThread('instagram', 3 * DAY);
        lastInbound = at(30 * HOUR);
        assert.equal((await reply()).statusCode, 200);
        assert.equal(posts.length, 1);
    });

    it('refuses the same thread with the switch off (the default): 24 hours from the last message', async () => {
        conversation = adThread('instagram', 3 * DAY);
        lastInbound = at(30 * HOUR);
        refused(await reply());
        posts = [];
        extendedWindow = JSON.stringify({ instagram: false, messenger: true });
        refused(await reply());
    });

    it('refuses past the longer window: 7 days less an hour from the click, closedAt being that instant', async () => {
        extendedWindow = JSON.stringify({ instagram: true, messenger: true });
        const clicked = at(8 * DAY);
        conversation = adThread('messenger', 8 * DAY);
        lastInbound = at(8 * DAY - HOUR);
        const res = await reply();
        refused(res);
        assert.equal(res.body.closedAt, new Date(clicked.getTime() + 7 * DAY - HOUR).toISOString());
    });

    it('treats an unreadable switch as off, never as a failed send', async () => {
        extendedWindow = '{not json';
        conversation = adThread('instagram', 3 * DAY);
        lastInbound = at(30 * HOUR);
        refused(await reply());
    });

    it('a window that does not come from an ad click is never longer, switch or no switch', async () => {
        extendedWindow = JSON.stringify({ instagram: true, messenger: true });
        conversation = igConversation({ entry_source: { kind: 'link', ref: 'bio', at: at(HOUR).toISOString() } });
        lastInbound = at(30 * HOUR);
        refused(await reply());
    });
});

describe('POST /conversations/:id/messages: Meta refuses for the window anyway', () => {
    const metaRefusal = (code: number, subcode: number | undefined) => async () => {
        throw Object.assign(new Error('Request failed'), {
            response: { status: 400, data: { error: { code, error_subcode: subcode, message: '(#10) This message is sent outside of allowed window.' } } },
        });
    };

    it('turns code 10 with subcode 2534022 (Instagram) or 2018278 (Messenger) into the same 409, with nothing stored or paused', async () => {
        for (const subcode of [2534022, 2018278]) {
            posts = []; statements = [];
            metaAnswer = metaRefusal(10, subcode);
            const res = await reply();
            assert.equal(res.statusCode, 409, String(subcode));
            assert.equal(res.body.code, 'WINDOW_CLOSED');
            assert.equal(res.body.closedAt, null, 'the time is not known when only Meta said it');
            assert.equal(posts.length, 1, 'tried once');
            assert.deepEqual(writes('messages'), []);
            assert.equal(paused(), false);
        }
    });

    it('leaves every other refusal a 500 with Meta\'s sentence: another code 10, a 551, a token', async () => {
        for (const [code, subcode] of [[10, undefined], [10, 1234567], [551, undefined], [190, undefined]] as const) {
            metaAnswer = metaRefusal(code, subcode);
            const res = await reply();
            assert.equal(res.statusCode, 500, `${code}/${subcode}`);
            assert.notEqual(res.body.code, 'WINDOW_CLOSED');
        }
    });
});

describe('GET /conversations/:id', () => {
    it('answers one thread as the list item it is, with the reply window, for the session\'s tenant', async () => {
        lastInbound = at(2 * HOUR);
        const res = await getOne(CONV);
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.id, CONV);
        assert.equal(res.body.platform, 'instagram');
        assert.equal(res.body.window_ends_at, new Date(lastInbound.getTime() + DAY).toISOString());
        assert.equal(res.body.reply_window_ends_at, res.body.window_ends_at);
        assert.equal(res.body.effective_ai, 'on');
        const query = statements.find((s) => /FROM conversations c LEFT JOIN LATERAL/.test(s.sql))!;
        assert.match(query.sql, /WHERE c\.creator_id = \$1 AND c\.id = \$2/, 'scoped to the tenant exactly as the list is');
        assert.deepEqual(query.params.slice(0, 2), [TENANT, CONV]);
    });

    it('carries an ad conversation\'s longer window when the owner switched it on', async () => {
        extendedWindow = JSON.stringify({ instagram: true, messenger: false });
        const clicked = at(3 * DAY);
        conversation = igConversation({ entry_source: { kind: 'ctm', platform: 'instagram', at: clicked.toISOString(), ad_id: '1' } });
        lastInbound = at(30 * HOUR);
        const res = await getOne(CONV);
        assert.equal(res.body.reply_window_ends_at, new Date(clicked.getTime() + 7 * DAY - HOUR).toISOString());
        assert.equal(res.body.window_ends_at, new Date(lastInbound.getTime() + DAY).toISOString(), 'the standard window field is unchanged');
    });

    it('is a 404 for another tenant\'s conversation, for one that does not exist and for an id that is not a UUID, and says nothing else', async () => {
        const foreign = await getOne(CONV, OTHER_TENANT);
        assert.equal(foreign.statusCode, 404);
        conversation = null;
        const missing = await getOne(CONV);
        assert.equal(missing.statusCode, 404);
        assert.deepEqual(missing.body, foreign.body, 'the same answer: it cannot tell whose it is');
        statements = [];
        const bad = await getOne('../../etc/passwd');
        assert.equal(bad.statusCode, 404);
        assert.equal(statements.length, 0, 'a malformed id is refused before the database');
    });
});
