/**
 * The routes of DM plan S8: `GET/POST /api/settings/notify` (the Telegram alert and the echo switch), `POST /api/settings/notify/test`, the
 * inbox's AI switch (`PUT /api/conversations/:id/toggle-bot`, which now re-discloses on a hand-back) and the inbox list's two new facts.
 *
 * Run through each route's WHOLE stack (guards, then handler) with `pool.query` stubbed and `telegramHttp.post` stubbed: the guard is the point
 * of the settings routes (the chat is the deployment's, so a tenant owner gets the same 404 a stranger would), and the secret is the point of
 * the rest: the bot token goes in encrypted, comes out as `{ set, last4 }`, and is in no response and no log line. The email channel (Resend,
 * `emailHttp.post` stubbed) is held to the same: its API key is the same kind of secret, saving one switches email on and sends ONE test
 * email whose result comes back with the save, and `POST /settings/notify/test-email` is the button for it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { telegramHttp } from '../services/notify.js';
import { DEFAULT_EMAIL_FROM, emailHttp } from '../services/notifyEmail.js';
import { DEFAULT_CONTACT_EMAIL } from '../services/appSettings.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

const TOKEN = '123456789:AAH_fake_token_for_tests_0123456789abcd';
const CHAT = '4242424242';
const KEY = 're_AbCdEfGh_0123456789abcdefghijkl';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';

function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

const ADMIN = { userId: 'u-admin', role: 'platform_admin', tenantId: TENANT };
const OWNER = { userId: 'u-owner', role: 'user', tenantId: TENANT };

/** Every guard in order, then the handler, as the router would. `tenantRole` is what resolveTenant would have set. */
async function run(method: 'get' | 'post' | 'put', path: string, session: Record<string, unknown>, req: { body?: unknown; params?: Record<string, string> } = {}) {
    const res = fakeRes();
    const r = { session, body: {}, params: {}, query: {}, headers: {}, tenantRole: session['role'] === 'platform_admin' ? 'owner' : 'operator', ...req };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(r, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

interface Row { key: string; value: string; is_secret: boolean }

let lines: string[];
let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let originalTelegram: typeof telegramHttp.post;
let originalEncryptionKey: string | undefined;
let stored: Map<string, Row>;
let sent: Array<{ sql: string; params: unknown[] }>;
let posted: Array<{ url: string; body: any }>;
let telegramAnswer: (url: string, body: any) => Promise<any>;
let originalEmail: typeof emailHttp.post;
let emailPosted: Array<{ url: string; body: any; config: any }>;
let emailAnswer: (url: string, body: any, config: any) => Promise<any>;
let conversationRows: unknown[];
/** How many rows the hand-back's stage reset finds in the `handoff` stage, and whether that statement throws (v39 not applied). */
let stageResetCount: number;
let stageResetFails: boolean;

beforeEach(() => {
    lines = [];
    const previous = setLogSink((_level, line) => { lines.push(line); });
    restoreSink = () => setLogSink(previous);
    originalEncryptionKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
    stored = new Map();
    sent = [];
    posted = [];
    conversationRows = [];
    stageResetCount = 0;
    stageResetFails = false;
    telegramAnswer = async () => ({ data: { ok: true } });
    originalTelegram = telegramHttp.post;
    (telegramHttp as any).post = async (url: string, body: any) => { posted.push({ url, body }); return telegramAnswer(url, body); };
    emailPosted = [];
    emailAnswer = async () => ({ status: 200, data: { id: 'email-1' } });
    originalEmail = emailHttp.post;
    (emailHttp as any).post = async (url: string, body: any, config: any) => { emailPosted.push({ url, body, config }); return emailAnswer(url, body, config); };
    originalQuery = pool.query;
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
        if (/INSERT INTO app_settings/.test(sql)) {
            stored.set(String(params[0]), { key: String(params[0]), value: String(params[1]), is_secret: Boolean(params[2]) });
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM app_settings WHERE key = \$1/.test(sql)) { stored.delete(String(params[0])); return { rows: [], rowCount: 1 }; }
        if (/FROM app_settings WHERE key = ANY/.test(sql)) {
            const keys = params[0] as string[];
            const rows = keys.filter((k) => stored.has(k)).map((k) => stored.get(k)!);
            return { rows, rowCount: rows.length };
        }
        if (/^\s*SELECT\b[\s\S]*FROM app_settings WHERE key = \$1/.test(sql)) {
            const row = stored.get(String(params[0]));
            return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/UPDATE conversations\s+SET is_bot_active/.test(sql)) return { rows: conversationRows, rowCount: conversationRows.length };
        if (/UPDATE conversations SET stage = 'new'/.test(sql)) {
            if (stageResetFails) throw Object.assign(new Error('column "stage" does not exist'), { code: '42703' });
            return { rows: [], rowCount: stageResetCount };
        }
        if (/FROM conversations c/.test(sql) && /COUNT\(\*\)/.test(sql)) return { rows: [{ total: 1 }], rowCount: 1 };
        if (/SELECT c\.\*/.test(sql)) return { rows: conversationRows, rowCount: conversationRows.length };
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    (telegramHttp as any).post = originalTelegram;
    (emailHttp as any).post = originalEmail;
    if (originalEncryptionKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
    restoreSink?.();
});

const saveBody = (over: Record<string, unknown> = {}) => ({ telegram: { botToken: TOKEN, chatId: CHAT, enabled: true, hotLeads: true }, ...over });

// ─── Who may ────────────────────────────────────────────────────────────────────────────────

describe('/settings/notify: who may see and change it', () => {
    it('404s a tenant owner on every route, touching nothing: the chat is the deployment\'s', async () => {
        for (const [method, path] of [['get', '/settings/notify'], ['post', '/settings/notify'], ['post', '/settings/notify/test'], ['post', '/settings/notify/test-email']] as const) {
            const res = await run(method, path, OWNER, { body: { ...saveBody(), email: { apiKey: KEY } } });
            assert.equal(res.statusCode, 404, `${method} ${path}`);
        }
        assert.equal(sent.length, 0);
        assert.equal(posted.length, 0, 'and no message was sent anywhere');
        assert.equal(emailPosted.length, 0, 'nor any email');
    });

    it('checks the platform-admin guard first, then the owner guard api.test.ts requires of every write', () => {
        for (const path of ['/settings/notify', '/settings/notify/test', '/settings/notify/test-email']) {
            const guards = stackFor('post', path) as Array<{ minimumRole?: string }>;
            assert.equal(guards.length, 3, path);
            assert.equal(guards[0]!.minimumRole, undefined, 'requirePlatformAdmin first');
            assert.equal(guards[1]!.minimumRole, 'owner');
        }
        assert.equal(stackFor('get', '/settings/notify').length, 2);
    });
});

// ─── Reading and saving ─────────────────────────────────────────────────────────────────────

describe('GET /settings/notify', () => {
    it('is empty and off on a fresh deployment: alerts off, hot leads on, takeover off, the documented ids listed', async () => {
        const res = await run('get', '/settings/notify', ADMIN);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.telegram, { botToken: { set: false, last4: null }, chatId: null, enabled: false, hotLeads: true, ready: false });
        assert.equal(res.body.echo.takeover, false);
        assert.deepEqual(res.body.echo.ownerAppIds, []);
        assert.ok(res.body.echo.documentedAppIds.includes('263902037430900'));
    });
});

describe('POST /settings/notify', () => {
    it('stores the token ENCRYPTED, and answers { set, last4 } and never the token', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: saveBody() });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.telegram, { botToken: { set: true, last4: 'abcd' }, chatId: CHAT, enabled: true, hotLeads: true, ready: true });
        const row = stored.get('notify.telegram_bot_token')!;
        assert.equal(row.is_secret, true);
        assert.ok(row.value.startsWith('enc:v1:') && !row.value.includes(TOKEN), 'encrypted at rest');
        assert.ok(!JSON.stringify(res.body).includes(TOKEN));
        const again = await run('get', '/settings/notify', ADMIN);
        assert.ok(!JSON.stringify(again.body).includes(TOKEN), 'and the read says nothing more');
        assert.deepEqual(again.body.telegram.botToken, { set: true, last4: 'abcd' });
    });

    it('keeps a saved token when a later save carries none, and removes it only on an explicit null', async () => {
        await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        const keep = await run('post', '/settings/notify', ADMIN, { body: { telegram: { chatId: '777000', hotLeads: false } } });
        assert.equal(keep.statusCode, 200);
        assert.deepEqual([keep.body.telegram.botToken.set, keep.body.telegram.chatId, keep.body.telegram.hotLeads], [true, '777000', false]);
        const clear = await run('post', '/settings/notify', ADMIN, { body: { telegram: { botToken: null, enabled: false } } });
        assert.deepEqual(clear.body.telegram.botToken, { set: false, last4: null });
        assert.equal(clear.body.telegram.ready, false);
    });

    it('refuses to switch alerts on while the token or the chat id is missing, naming the switch, and writes nothing', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { telegram: { enabled: true } } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.field, 'enabled');
        assert.equal(stored.size, 0);
        const half = await run('post', '/settings/notify', ADMIN, { body: { telegram: { enabled: true, botToken: TOKEN } } });
        assert.equal(half.statusCode, 400, 'a token with no chat to send to');
        assert.equal(stored.size, 0);
    });

    it('refuses a bad token, chat id or switch with a 400 that names the field, repeats nothing typed, and writes nothing, even beside good fields', async () => {
        const typo = '12345:short-token';
        for (const [telegram, field] of [
            [{ botToken: typo, chatId: CHAT }, 'botToken'],
            [{ botToken: TOKEN, chatId: 'my chat' }, 'chatId'],
            [{ enabled: 'yes' }, 'enabled'],
            [{ botToken: TOKEN, hotLeads: 1 }, 'hotLeads'],
        ] as const) {
            const res = await run('post', '/settings/notify', ADMIN, { body: { telegram } });
            assert.equal(res.statusCode, 400, JSON.stringify(telegram));
            assert.equal(res.body.field, field);
            assert.ok(!String(res.body.error).includes(typo));
        }
        assert.equal(stored.size, 0);
    });

    it('400s an empty body rather than pretending to have saved', async () => {
        for (const body of [{}, { telegram: {} }, { echo: {} }, { telegram: { botToken: '' } }]) {
            const res = await run('post', '/settings/notify', ADMIN, { body });
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        assert.equal(stored.size, 0);
    });

    it('saves the echo switch and the owner\'s extra app ids, and a refused id saves nothing at all', async () => {
        const ok = await run('post', '/settings/notify', ADMIN, { body: { echo: { takeover: true, ownerAppIds: '1217981644879628, 99887766' } } });
        assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.echo.takeover, true);
        assert.deepEqual(ok.body.echo.ownerAppIds, ['1217981644879628', '99887766']);
        assert.equal(stored.get('dm.echo_takeover')!.value, 'true');
        assert.equal(stored.get('dm.echo_owner_app_ids')!.value, '1217981644879628,99887766');

        stored.clear();
        const bad = await run('post', '/settings/notify', ADMIN, { body: { telegram: { chatId: CHAT }, echo: { takeover: true, ownerAppIds: '12345, 12ab' } } });
        assert.equal(bad.statusCode, 400);
        assert.equal(bad.body.field, 'ownerAppIds');
        assert.equal(stored.size, 0, 'the good chat id beside it was not saved either');
        const notBool = await run('post', '/settings/notify', ADMIN, { body: { echo: { takeover: 'on' } } });
        assert.equal(notBool.body.field, 'takeover');

        const cleared = await run('post', '/settings/notify', ADMIN, { body: { echo: { ownerAppIds: '' } } });
        assert.deepEqual(cleared.body.echo.ownerAppIds, []);
        assert.equal(stored.has('dm.echo_owner_app_ids'), false);
    });

    it('logs which settings changed, never their values: the token is one of them', async () => {
        await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        const written = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'api.notify_settings_written');
        assert.ok(written);
        assert.deepEqual(written.changed.sort(), ['telegram.botToken', 'telegram.chatId', 'telegram.enabled', 'telegram.hotLeads']);
        for (const line of lines) {
            assert.ok(!line.includes(TOKEN), line);
            assert.ok(!line.includes(CHAT), line);
        }
    });
});

describe('POST /settings/notify/test', () => {
    it('sends the test message with what is saved, in the dashboard\'s language, and says it worked', async () => {
        await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        const ar = await run('post', '/settings/notify/test', ADMIN, { body: {} });
        assert.deepEqual(ar.body, { ok: true });
        assert.equal(posted.length, 1);
        assert.equal(posted[0]!.url, `/bot${TOKEN}/sendMessage`);
        assert.equal(posted[0]!.body.chat_id, CHAT);
        assert.ok(!('parse_mode' in posted[0]!.body));
        assert.match(posted[0]!.body.text, /^رسالة تجريبية/);

        const en = await run('post', '/settings/notify/test', ADMIN, { body: { lang: 'en' } });
        assert.deepEqual(en.body, { ok: true });
        assert.match(posted[1]!.body.text, /^Test message/);
    });

    it('says plainly when there is no token or chat id to send with, and sends nothing', async () => {
        const res = await run('post', '/settings/notify/test', ADMIN, { body: {} });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: false, reason: 'not_configured', status: null, description: '' });
        assert.equal(posted.length, 0);
    });

    it('answers Telegram\'s refusal as a result with its status and words, never the token, and never as a server error', async () => {
        await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        telegramAnswer = async () => {
            throw Object.assign(new Error(`Request failed with status code 401`), {
                config: { url: `/bot${TOKEN}/sendMessage` }, response: { status: 401, data: { ok: false, error_code: 401, description: 'Unauthorized' } },
            });
        };
        const res = await run('post', '/settings/notify/test', ADMIN, { body: {} });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: false, reason: 'rejected', status: 401, description: 'Unauthorized' });
        assert.ok(!JSON.stringify(res.body).includes(TOKEN));
        for (const line of lines) assert.ok(!line.includes(TOKEN), line);

        telegramAnswer = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
        const down = await run('post', '/settings/notify/test', ADMIN, { body: {} });
        assert.deepEqual(down.body, { ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' });
    });
});

// ─── The inbox ──────────────────────────────────────────────────────────────────────────────

describe('PUT /conversations/:id/toggle-bot: a hand-back re-discloses', () => {
    const toggle = (value: unknown) => run('put', '/conversations/:id/toggle-bot', OWNER, { params: { id: CONV }, body: { is_bot_active: value } });

    it('turning the bot ON clears ai_disclosed_at when the bot was off (a human had the thread), in the same tenant-scoped statement', async () => {
        conversationRows = [{ id: CONV, is_bot_active: true, ai_disclosed_at: null }];
        const res = await toggle(true);

        assert.equal(res.statusCode, 200);
        const update = sent.find((s) => /UPDATE conversations/.test(s.sql))!;
        assert.deepEqual(update.params, [true, CONV, TENANT], 'scoped to this tenant');
        assert.match(update.sql, /ai_disclosed_at = CASE WHEN \$1::boolean AND is_bot_active IS NOT TRUE THEN NULL ELSE ai_disclosed_at END/);
        assert.match(update.sql, /is_bot_active = \$1::boolean/);
        assert.deepEqual(res.body, { id: CONV, is_bot_active: true, ai_disclosed_at: null });
    });

    it('only on a real hand-back: the CASE reads the OLD value, so switching on a bot that is already on, or switching OFF, keeps the disclosure', async () => {
        // Postgres evaluates every right-hand side against the row as it was, so `is_bot_active` in the CASE is the old value. What this
        // pins is that the clear is conditional on it, and on turning ON: neither can be dropped without this failing.
        conversationRows = [{ id: CONV }];
        await toggle(false);
        const update = sent.find((s) => /UPDATE conversations/.test(s.sql))!;
        assert.equal(update.params[0], false);
        const caseClause = /ai_disclosed_at = CASE WHEN ([^]*?) THEN NULL ELSE ai_disclosed_at END/.exec(update.sql)!;
        assert.ok(caseClause[1]!.includes('$1::boolean'), 'only when turning ON');
        assert.ok(caseClause[1]!.includes('is_bot_active IS NOT TRUE'), 'only when it was not already on');
    });

    it('turning the bot ON also moves a handoff stage on to new: the thread leaves Needs you, and the bot treats the two alike', async () => {
        conversationRows = [{ id: CONV, is_bot_active: true, stage: 'handoff' }];
        stageResetCount = 1;
        const res = await toggle(true);

        assert.equal(res.statusCode, 200);
        const reset = sent.find((s) => /SET stage = 'new'/.test(s.sql))!;
        assert.ok(reset, 'the stage statement ran');
        assert.match(reset.sql, /WHERE id = \$1 AND creator_id = \$2 AND stage = 'handoff'/, 'only a handoff, and only this tenant\'s');
        assert.deepEqual(reset.params, [CONV, TENANT]);
        assert.equal(res.body.stage, 'new', 'and the answer says so');
        assert.ok(sent.findIndex((s) => /UPDATE conversations\s+SET is_bot_active/.test(s.sql)) < sent.findIndex((s) => /SET stage = 'new'/.test(s.sql)), 'after the toggle itself');
    });

    it('a thread in any other stage is left as it is (the statement matches nothing), and turning the bot OFF touches no stage at all', async () => {
        conversationRows = [{ id: CONV, stage: 'recommend' }];
        stageResetCount = 0;
        const on = await toggle(true);
        assert.equal(on.body.stage, 'recommend');
        sent.length = 0;
        const off = await toggle(false);
        assert.equal(off.statusCode, 200);
        assert.ok(!sent.some((s) => /SET stage/.test(s.sql)), 'off: no stage statement');
    });

    it('a database that is behind (no stage column) still toggles: the stage reset fails alone, is logged, and the answer is the toggle\'s', async () => {
        conversationRows = [{ id: CONV, is_bot_active: true }];
        stageResetFails = true;
        const res = await toggle(true);

        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { id: CONV, is_bot_active: true });
        const warned = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'api.toggle_bot_stage_reset_failed');
        assert.ok(warned);
        assert.equal(warned.level, 'warn');
    });

    it('404s a conversation that is not this tenant\'s or does not exist, and a non-boolean is a 400', async () => {
        conversationRows = [];
        assert.equal((await toggle(true)).statusCode, 404);
        assert.equal((await toggle('yes')).statusCode, 400);
        const bad = await run('put', '/conversations/:id/toggle-bot', OWNER, { params: { id: 'not-a-uuid' }, body: { is_bot_active: true } });
        assert.equal(bad.statusCode, 404);
    });
});

describe('GET /conversations: the two facts "Needs you" and the countdown read', () => {
    it('asks for the last inbound message and the last operator reply from messages, and passes them through', async () => {
        conversationRows = [{
            id: CONV, platform: 'instagram', stage: 'handoff', handoff_at: '2026-10-14T09:00:00Z',
            last_inbound_message_at: '2026-10-14T08:59:00Z', last_operator_at: null,
        }];
        const res = await run('get', '/conversations', OWNER);

        assert.equal(res.statusCode, 200);
        const list = sent.find((s) => /SELECT c\.\*/.test(s.sql))!;
        assert.match(list.sql, /MAX\(m3\.created_at\) FILTER \(WHERE m3\.direction = 'inbound'\) AS last_inbound_message_at/);
        assert.match(list.sql, /MAX\(m3\.created_at\) FILTER \(WHERE m3\.direction = 'outbound' AND m3\.sender = 'operator'\) AS last_operator_at/);
        assert.match(list.sql, /fx\.last_inbound_message_at,\s+fx\.last_operator_at/, 'and they are selected');
        assert.equal(res.body.data[0].last_inbound_message_at, '2026-10-14T08:59:00Z');
        assert.equal(res.body.data[0].last_operator_at, null);
        assert.equal(res.body.data[0].stage, 'handoff', 'the v39 columns come with c.*');
    });
});

// ─── Email ──────────────────────────────────────────────────────────────────────────────────

describe('GET /settings/notify: email', () => {
    it('is off and empty on a fresh deployment, and its address is the site contact email, which the card is told it is', async () => {
        const res = await run('get', '/settings/notify', ADMIN);
        assert.deepEqual(res.body.email, {
            apiKey: { set: false, last4: null }, to: DEFAULT_CONTACT_EMAIL, toIsDefault: true, from: null, defaultFrom: DEFAULT_EMAIL_FROM,
            enabled: false, hotLeads: false, ready: false,
        });
    });

    it('follows the contact email saved in Settings, until an address of its own is typed', async () => {
        stored.set('site.contact_email', { key: 'site.contact_email', value: 'contact@example.com', is_secret: false });
        const first = (await run('get', '/settings/notify', ADMIN)).body.email;
        assert.deepEqual([first.to, first.toIsDefault], ['contact@example.com', true]);
        await run('post', '/settings/notify', ADMIN, { body: { email: { to: 'me@example.com' } } });
        const typed = (await run('get', '/settings/notify', ADMIN)).body.email;
        assert.deepEqual([typed.to, typed.toIsDefault], ['me@example.com', false]);
        await run('post', '/settings/notify', ADMIN, { body: { email: { to: '' } } });
        assert.deepEqual([(await run('get', '/settings/notify', ADMIN)).body.email.to, stored.has('notify.email_to')], ['contact@example.com', false]);
    });
});

describe('POST /settings/notify: saving the Resend API key', () => {
    it('stores the key ENCRYPTED, answers { set, last4 } and never the key, and the read says nothing more', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });

        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body.email.apiKey, { set: true, last4: 'ijkl' });
        const row = stored.get('notify.email_api_key')!;
        assert.equal(row.is_secret, true);
        assert.ok(row.value.startsWith('enc:v1:') && !row.value.includes(KEY), 'encrypted at rest');
        assert.ok(!JSON.stringify(res.body).includes(KEY));
        const again = await run('get', '/settings/notify', ADMIN);
        assert.ok(!JSON.stringify(again.body).includes(KEY), 'and the read says nothing more');
        assert.deepEqual(again.body.email.apiKey, { set: true, last4: 'ijkl' });
    });

    it('SWITCHES EMAIL ON by itself (hot leads stay off), and shows it as ready, going to the contact email', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        assert.deepEqual([res.body.email.enabled, res.body.email.hotLeads, res.body.email.ready, res.body.email.to], [true, false, true, DEFAULT_CONTACT_EMAIL]);
        assert.equal(stored.get('notify.email_enabled')!.value, 'true');
        assert.equal(stored.has('notify.email_hot_leads'), false, 'a hot-lead switch nobody touched is not written');
    });

    it('sends ONE test email with it, to the address, with the key as a bearer header, and answers the result with the save', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });

        assert.deepEqual(res.body.emailTest, { ok: true });
        assert.equal(emailPosted.length, 1);
        assert.equal(emailPosted[0]!.url, '/emails');
        assert.deepEqual(emailPosted[0]!.config, { headers: { Authorization: `Bearer ${KEY}` } });
        assert.deepEqual([emailPosted[0]!.body.to, emailPosted[0]!.body.from], [[DEFAULT_CONTACT_EMAIL], DEFAULT_EMAIL_FROM]);
        assert.match(emailPosted[0]!.body.text, /^رسالة تجريبية/, 'Arabic unless the screen is English');
        const en = await run('post', '/settings/notify', ADMIN, { body: { lang: 'en', email: { apiKey: KEY } } });
        assert.match(emailPosted[1]!.body.text, /^Test email/);
        assert.deepEqual(en.body.emailTest, { ok: true });
    });

    it('answers Resend\'s refusal with the save, in its words and status, with the key scrubbed, and the save still stands', async () => {
        emailAnswer = async () => {
            throw Object.assign(new Error('Request failed with status code 403'), {
                config: { headers: { Authorization: `Bearer ${KEY}` } },
                response: { status: 403, data: { statusCode: 403, name: 'validation_error', message: `You can only send testing emails to your own email address (me@example.com). Key ${KEY}` } },
            });
        };
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY, to: 'someone@else.com' } } });

        assert.equal(res.statusCode, 200, 'a refusal by Resend is an answer, never a failed save');
        assert.deepEqual(res.body.emailTest, {
            ok: false, reason: 'rejected', status: 403, description: 'You can only send testing emails to your own email address (me@example.com). Key [key]',
        });
        assert.ok(!JSON.stringify(res.body).includes(KEY));
        assert.deepEqual([res.body.email.apiKey.set, res.body.email.enabled, res.body.email.to], [true, true, 'someone@else.com'], 'the key and the address are saved');
        for (const line of lines) assert.ok(!line.includes(KEY), line);
    });

    it('answers "unreachable" when Resend does not answer, again with the save', async () => {
        emailAnswer = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.emailTest, { ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' });
        assert.equal(res.body.email.enabled, true);
    });

    it('an explicit "off" in the same save is respected, and the test email is still sent: it tells the owner whether the key works', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY, enabled: false } } });
        assert.deepEqual([res.body.email.enabled, res.body.email.ready], [false, false]);
        assert.equal(emailPosted.length, 1);
    });

    it('sends no test email when the save carries no new key, or removes one', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        emailPosted.length = 0;
        const switches = await run('post', '/settings/notify', ADMIN, { body: { email: { hotLeads: true, to: 'me@example.com' } } });
        assert.equal(switches.body.emailTest, undefined);
        const removed = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: null, enabled: false } } });
        assert.equal(removed.body.emailTest, undefined);
        assert.deepEqual(removed.body.email.apiKey, { set: false, last4: null });
        assert.equal(emailPosted.length, 0);
        const telegramOnly = await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        assert.equal(telegramOnly.body.emailTest, undefined, 'a Telegram-only save sends no email');
        assert.equal(emailPosted.length, 0);
    });

    it('keeps a saved key when a later save carries none, and a Telegram save does not touch email at all', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        const before = [...stored.keys()].filter((k) => k.startsWith('notify.email_'));
        const telegramSave = await run('post', '/settings/notify', ADMIN, { body: saveBody() });
        assert.equal(telegramSave.statusCode, 200);
        assert.deepEqual([...stored.keys()].filter((k) => k.startsWith('notify.email_')), before, 'no email setting written');
        assert.deepEqual(telegramSave.body.email.apiKey, { set: true, last4: 'ijkl' });
        assert.equal(telegramSave.body.email.enabled, true);
    });

    it('refuses to switch email on while there is no key, naming the switch, and writes nothing; removing the key while on is refused the same way', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { enabled: true } } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.field, 'emailEnabled');
        assert.equal(stored.size, 0);
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        const removal = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: null } } });
        assert.equal(removal.statusCode, 400, 'on, and the key taken away');
        assert.equal(removal.body.field, 'emailEnabled');
        assert.equal(stored.has('notify.email_api_key'), true, 'the key is still there');
    });

    it('refuses a bad key, address, sender or switch with a 400 that names the field, repeats nothing typed, and writes nothing, even beside good fields', async () => {
        const typo = 're_short';
        for (const [email, field] of [
            [{ apiKey: typo }, 'emailApiKey'],
            [{ apiKey: KEY, to: 'not an address' }, 'emailTo'],
            [{ apiKey: KEY, to: 'a@b.com, c@d.com' }, 'emailTo'],
            [{ apiKey: KEY, from: 'no brackets@x' }, 'emailFrom'],
            [{ apiKey: KEY, enabled: 'yes' }, 'emailEnabled'],
            [{ hotLeads: 1 }, 'emailHotLeads'],
        ] as const) {
            const res = await run('post', '/settings/notify', ADMIN, { body: { telegram: { chatId: CHAT }, email } });
            assert.equal(res.statusCode, 400, JSON.stringify(email));
            assert.equal(res.body.field, field);
            for (const typed of [typo, 'not an address', 'a@b.com', 'no brackets@x']) assert.ok(!String(res.body.error).includes(typed), res.body.error);
        }
        assert.equal(stored.size, 0, 'the good chat id beside them was not saved either');
        assert.equal(emailPosted.length, 0, 'and no test email went');
    });

    it('logs which settings changed, never their values: the key and the address are among them', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY, to: 'me@example.com' } } });
        const written = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'api.notify_settings_written');
        assert.ok(written);
        assert.deepEqual(written.changed.sort(), ['email.apiKey', 'email.enabled', 'email.to']);
        for (const line of lines) {
            assert.ok(!line.includes(KEY), line);
            assert.ok(!line.includes('me@example.com'), line);
        }
        const tested = lines.map((l) => JSON.parse(l)).find((l) => l.event === 'api.notify_email_test');
        assert.deepEqual([tested.after, tested.ok], ['save', true]);
    });

    it('400s a body that carries nothing, email included, rather than pretending to have saved', async () => {
        for (const body of [{ email: {} }, { email: { apiKey: '' } }]) {
            const res = await run('post', '/settings/notify', ADMIN, { body });
            assert.equal(res.statusCode, 400, JSON.stringify(body));
        }
        assert.equal(stored.size, 0);
    });

    it('saves a sender, hot leads and an address of its own, and clears them again', async () => {
        const res = await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY, from: 'AutoReply Pro <alerts@your-domain.com>', hotLeads: true } } });
        assert.deepEqual([res.body.email.from, res.body.email.hotLeads], ['AutoReply Pro <alerts@your-domain.com>', true]);
        emailPosted.length = 0;
        const cleared = await run('post', '/settings/notify', ADMIN, { body: { email: { from: '', hotLeads: false } } });
        assert.deepEqual([cleared.body.email.from, cleared.body.email.hotLeads, stored.has('notify.email_from')], [null, false, false]);
    });
});

describe('POST /settings/notify/test-email', () => {
    it('says plainly when there is no key to send with, and sends nothing', async () => {
        const res = await run('post', '/settings/notify/test-email', ADMIN, { body: {} });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: false, reason: 'not_configured', status: null, description: '' });
        assert.equal(emailPosted.length, 0);
    });

    it('sends with what is saved, in the dashboard\'s language, whether or not email is on, and says it worked', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY, enabled: false } } });
        emailPosted.length = 0;
        const ar = await run('post', '/settings/notify/test-email', ADMIN, { body: {} });
        assert.deepEqual(ar.body, { ok: true });
        assert.equal(emailPosted.length, 1);
        assert.match(emailPosted[0]!.body.text, /^رسالة تجريبية/);
        assert.equal(emailPosted[0]!.config.headers.Authorization, `Bearer ${KEY}`, 'the saved key, though none travelled in this request');
        const en = await run('post', '/settings/notify/test-email', ADMIN, { body: { lang: 'en' } });
        assert.deepEqual(en.body, { ok: true });
        assert.match(emailPosted[1]!.body.text, /^Test email/);
    });

    it('answers Resend\'s refusal as a result with its status and words, never the key, and never as a server error', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { email: { apiKey: KEY } } });
        emailAnswer = async () => {
            throw Object.assign(new Error('Request failed with status code 401'), {
                config: { headers: { Authorization: `Bearer ${KEY}` } }, response: { status: 401, data: { statusCode: 401, name: 'validation_error', message: `API key is invalid: ${KEY}` } },
            });
        };
        const res = await run('post', '/settings/notify/test-email', ADMIN, { body: {} });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { ok: false, reason: 'rejected', status: 401, description: 'API key is invalid: [key]' });
        assert.ok(!JSON.stringify(res.body).includes(KEY));
        for (const line of lines) assert.ok(!line.includes(KEY), line);

        emailAnswer = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
        const down = await run('post', '/settings/notify/test-email', ADMIN, { body: {} });
        assert.deepEqual(down.body, { ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' });
    });

    it('does not touch the Telegram test, and the Telegram test does not touch email', async () => {
        await run('post', '/settings/notify', ADMIN, { body: { ...saveBody(), email: { apiKey: KEY } } });
        posted.length = 0; emailPosted.length = 0;
        await run('post', '/settings/notify/test', ADMIN, { body: {} });
        assert.deepEqual([posted.length, emailPosted.length], [1, 0]);
        await run('post', '/settings/notify/test-email', ADMIN, { body: {} });
        assert.deepEqual([posted.length, emailPosted.length], [1, 1]);
    });
});
