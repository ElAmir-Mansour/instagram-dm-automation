/**
 * `/api/whatsapp` entry points over real HTTP: entry links (QR codes and short links), ice breakers and commands.
 *
 * Each route runs through its WHOLE stack (the owner guard, then the handler) in a real Express app on an ephemeral port, with a database and
 * a Graph that exist only in memory: `pool.query` is a small router over the statements these routes make, `metaHttp` is an in-memory
 * `message_qrdls` / `conversational_automation` that THROWS on any call a test did not arrange. `.env` holds live production credentials, and
 * nothing here may reach Postgres or Meta.
 *
 * What is pinned, because each is a way this could go wrong in front of real people:
 *   - every write is the owner's, refused before anything is read or sent; a viewer can read;
 *   - the token is in no answer, audit row or log line;
 *   - a link is created at Meta with its tracking ` #ref` ON THE END, within Meta's 140 characters, and never twice for one click;
 *   - Meta's list is the source of truth, labels are the only thing stored, and a label save never overwrites the owner's other settings;
 *   - a delete only touches a code that belongs to this number;
 *   - ice-breaker limits (4 × 80, 30 commands, no emoji) are refused before Meta is asked.
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { pool } from '../config/db.js';
import { encryptSecret } from '../config/crypto.js';
import { metaHttp } from '../services/http.js';
import { API_VERSION } from '../services/instagram.js';
import { QR_PREFILL_MAX_CHARS } from '../services/whatsapp.js';
import { ENTRY_LABEL_MAX_CHARS, ENTRY_PREFILL_MAX_CHARS, isRef, refFromText } from '../services/whatsappEntryLinks.js';
import { setLogSink } from '../utils/log.js';
import { whatsappRouter } from './whatsapp.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const PHONE = '106540352242922';
const OTHER_PHONE = '109999999999999';
const TOKEN = 'EAAGwhatsapp-system-user-token-0123456789-SECRET';
const BASE = `https://graph.facebook.com/${API_VERSION}`;

interface Session { userId?: string | null; role?: string; tenantId?: string; tenantRole?: 'owner' | 'operator' | 'viewer' }
const OWNER: Session = { userId: USER, role: 'user', tenantId: TENANT, tenantRole: 'owner' };

// ─── The world ──────────────────────────────────────────────────────────────────────────

interface Conn {
    id: string; creator_id: string; external_account_id: string; display_name: string | null; status: string; last_error: string | null;
    scopes: string[]; access_token: string | null; access_expires_at: Date | null; last_refreshed_at: Date | null; created_at: Date;
    profile: Record<string, unknown> | null; settings: Record<string, any>;
}
interface Qr { code: string; prefilled_message: string; deep_link_url: string; qr_image_url: string }

let conn: Conn | null;
/** QR codes at Meta, newest first, by phone number id. */
let qrs: Map<string, Qr[]>;
/** What Meta holds as conversational components, by phone number id. */
let automation: Map<string, { prompts: string[]; commands: Array<{ command_name: string; command_description: string }> }>;
let audits: Array<{ action: string; targetId: unknown; detail: any }>;
let statements: Array<{ sql: string; params: unknown[] }>;
let logs: string[];
let responses: string[];
/** Every call to Meta, in order, as `METHOD path`. */
let order: string[];
let bodies: unknown[];
let authHeaders: Array<string | undefined>;
let counter: number;

/** Made to fail by a test. */
let failures: {
    create?: () => Error;
    list?: () => Error;
    remove?: () => Error;
    automationGet?: () => Error;
    automationSet?: () => Error;
    /** Meta answers 200 to a POST/DELETE without `success: true`. */
    unconfirmed?: boolean;
    /** The database refuses to save a label. */
    labelWrite?: boolean;
};

let server: Server;
let origin: string;
let restoreSink: (() => void) | undefined;
const originalQuery = pool.query;
const originals = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete };
const savedEnv: Record<string, string | undefined> = {};

function seedConnection(over: Partial<Conn> = {}): Conn {
    conn = {
        id: 'c-1', creator_id: TENANT, external_account_id: PHONE, display_name: 'Test Number', status: 'active', last_error: null,
        scopes: ['whatsapp_business_messaging', 'whatsapp_business_management'], access_token: encryptSecret(TOKEN), access_expires_at: null,
        last_refreshed_at: new Date('2026-10-19T08:00:00Z'), created_at: new Date('2026-10-18T08:00:00Z'),
        profile: { waba_id: '102290129340398', display_phone_number: '+1 555-025-3483', quality_rating: 'GREEN', is_test_number: false },
        settings: { allow_billable: true, free_tier_alert_at: 700 }, ...over,
    };
    return conn;
}

/** A QR code already at Meta, as if made in WhatsApp Manager or an earlier session. Newest first. */
function seedQr(code: string, message: string, phone = PHONE): Qr {
    const q = { code, prefilled_message: message, deep_link_url: `https://wa.me/message/${code}`, qr_image_url: `https://scontent.xx.fbcdn.net/${code}.png` };
    qrs.set(phone, [q, ...(qrs.get(phone) ?? [])]);
    return q;
}

function fakeQuery(sql: string, params: any[] = []): { rows: any[]; rowCount: number } {
    const q = sql.replace(/\s+/g, ' ').trim();
    statements.push({ sql: q, params });
    const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });
    const live = () => (conn && conn.creator_id === params[0] && conn.status !== 'revoked' ? conn : null);

    if (q.startsWith('SELECT') && q.includes(', access_token FROM platform_connections')) {
        if (!conn || conn.creator_id !== params[0]) return result([]);
        const { access_token, ...rest } = conn;
        return result([{ ...rest, has_token: access_token !== null, access_token }]);
    }
    if (q.startsWith("SELECT settings -> 'entry_links' AS entry_links FROM platform_connections")) {
        const c = live();
        return result(c ? [{ entry_links: c.settings.entry_links ?? null }] : []);
    }
    if (q.startsWith('UPDATE platform_connections SET settings = jsonb_set(')) {
        if (failures.labelWrite) throw new Error('connection terminated unexpectedly');
        const c = live();
        if (!c) return result([], 0);
        c.settings = { ...c.settings, entry_links: { ...(c.settings.entry_links ?? {}), ...JSON.parse(params[1]) } };
        return result([], 1);
    }
    if (q.startsWith("UPDATE platform_connections SET settings = COALESCE(settings, '{}'::jsonb) #- ARRAY['entry_links', $2::text]")) {
        const c = live();
        if (!c) return result([], 0);
        if (c.settings.entry_links) delete c.settings.entry_links[params[1]];
        return result([], 1);
    }
    if (q.startsWith('INSERT INTO audit_log')) {
        audits.push({ action: params[2], targetId: params[4], detail: JSON.parse(params[5]) });
        return result([{ id: `audit-${audits.length}` }]);
    }
    if (q.startsWith('SELECT email FROM users WHERE id = $1')) return result([{ email: 'owner@example.test' }]);
    throw new Error(`no result arranged for SQL: ${q}`);
}

const metaError = (code: number, message: string, status = 400) =>
    Object.assign(new Error(message), { response: { status, data: { error: { code, message } } } });

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const raw = req.get('x-test-session');
        if (raw) {
            const s = JSON.parse(raw) as Session;
            req.session = { userId: s.userId ?? null, role: s.role ?? 'user', tenantId: s.tenantId } as typeof req.session;
            req.tenantRole = s.tenantRole;
        }
        next();
    });
    app.use('/api/whatsapp', whatsappRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    savedEnv.TOKEN_ENCRYPTION_KEY = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);

    conn = null;
    qrs = new Map();
    automation = new Map();
    audits = [];
    statements = [];
    logs = [];
    responses = [];
    order = [];
    bodies = [];
    authHeaders = [];
    counter = 0;
    failures = {};

    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => fakeQuery(sql, params);

    const unarranged = (what: string): never => { throw new Error(`no Meta call was arranged: ${what}`); };
    const record = (label: string, body: unknown, config: any) => { order.push(label); bodies.push(body); authHeaders.push(config?.headers?.Authorization); };

    (metaHttp as any).get = async (url: string, config: any) => {
        const path = url.replace(BASE, '');
        if (/^\/\d+\/message_qrdls$/.test(path)) {
            record(`GET ${path}${config?.params?.code ? '?code' : ''}`, config?.params, config);
            if (failures.list) throw failures.list();
            const phone = path.split('/')[1]!;
            let rows = qrs.get(phone) ?? [];
            if (config?.params?.code) rows = rows.filter((r) => r.code === config.params.code);
            const wantsImage = String(config?.params?.fields ?? '').includes('qr_image_url');
            return { data: { data: rows.map(({ qr_image_url, ...r }) => (wantsImage ? { ...r, qr_image_url } : r)) } };
        }
        if (/^\/\d+$/.test(path)) {
            record(`GET ${path}`, config?.params, config);
            if (failures.automationGet) throw failures.automationGet();
            const state = automation.get(path.slice(1));
            return { data: { ...(state ? { conversational_automation: state } : {}), id: path.slice(1) } };
        }
        return unarranged(`GET ${url}`);
    };
    (metaHttp as any).post = async (url: string, body: any, config: any) => {
        const path = url.replace(BASE, '');
        if (/^\/\d+\/message_qrdls$/.test(path)) {
            record(`POST ${path}`, body, config);
            if (failures.create) throw failures.create();
            const phone = path.split('/')[1]!;
            counter += 1;
            const code = `QRCODE0000000${counter}`;
            const q = { code, prefilled_message: body.prefilled_message, deep_link_url: `https://wa.me/message/${code}`, qr_image_url: `https://scontent.xx.fbcdn.net/${code}.png` };
            qrs.set(phone, [q, ...(qrs.get(phone) ?? [])]);
            return { data: q };
        }
        if (/^\/\d+\/conversational_automation$/.test(path)) {
            record(`POST ${path}`, body, config);
            if (failures.automationSet) throw failures.automationSet();
            if (failures.unconfirmed) return { data: {} };
            const phone = path.split('/')[1]!;
            const held = automation.get(phone) ?? { prompts: [], commands: [] };
            automation.set(phone, { prompts: body.prompts ?? held.prompts, commands: body.commands ?? held.commands });
            return { data: { success: true } };
        }
        return unarranged(`POST ${url}`);
    };
    (metaHttp as any).delete = async (url: string, config: any) => {
        const path = url.replace(BASE, '');
        const m = /^\/(\d+)\/message_qrdls\/([A-Za-z0-9]+)$/.exec(path);
        if (m) {
            record(`DELETE ${path}`, undefined, config);
            if (failures.remove) throw failures.remove();
            if (failures.unconfirmed) return { data: {} };
            qrs.set(m[1]!, (qrs.get(m[1]!) ?? []).filter((r) => r.code !== m[2]));
            return { data: { success: true } };
        }
        return unarranged(`DELETE ${url}`);
    };
});

afterEach(() => {
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (metaHttp as any).delete = originals.delete;
    if (savedEnv.TOKEN_ENCRYPTION_KEY === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedEnv.TOKEN_ENCRYPTION_KEY;
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

async function call(method: string, path: string, over: { session?: Session; body?: unknown } = {}) {
    const res = await fetch(`${origin}/api/whatsapp${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-session': JSON.stringify(over.session ?? OWNER) },
        ...(over.body !== undefined ? { body: JSON.stringify(over.body) } : {}),
    });
    const text = await res.text();
    responses.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null, text };
}

/** Nothing Meta is asked with may appear in anything that leaves the process or is stored. */
function assertTokenNowhere(): void {
    for (const r of responses) assert.ok(!r.includes(TOKEN), 'the token is in a response');
    for (const l of logs) assert.ok(!l.includes(TOKEN), 'the token is in a log line');
    assert.ok(!JSON.stringify(audits).includes(TOKEN), 'the token is in an audit row');
    for (const s of statements) assert.ok(!JSON.stringify(s.params).includes(TOKEN), `the plaintext token is a parameter of: ${s.sql.slice(0, 80)}`);
    for (const b of bodies) assert.ok(!JSON.stringify(b ?? null).includes(TOKEN), 'the token is in a body sent to Meta');
}

const noMetaCalls = () => assert.deepEqual(order, [], 'Meta was not asked anything');
const labelsNow = () => conn?.settings.entry_links ?? {};

// ─── Who may call what ──────────────────────────────────────────────────────────────────

describe('who may call what', () => {
    for (const role of ['operator', 'viewer'] as const) {
        it(`refuses ${role} on every write, before anything is read, stored or sent`, async () => {
            seedConnection();
            const session = { ...OWNER, tenantRole: role };
            for (const [method, path, body] of [
                ['POST', '/entry-links', { label: 'Bio', prefill: 'Hello' }],
                ['DELETE', '/entry-links/QRCODE00000001', undefined],
                ['PUT', '/ice-breakers', { prompts: ['Hello'] }],
            ] as const) {
                const r = await call(method, path, { session, body });
                assert.equal(r.status, 403, `${method} ${path}`);
                assert.equal(r.body.code, 'INSUFFICIENT_TENANT_ROLE');
            }
            assert.equal(statements.length, 0, 'no database statement ran');
            noMetaCalls();
            assert.equal(audits.length, 0);
        });
    }

    it('lets a viewer read both lists', async () => {
        seedConnection();
        seedQr('QRCODE00000001', 'Hello');
        const viewer = { ...OWNER, tenantRole: 'viewer' as const };

        const links = await call('GET', '/entry-links', { session: viewer });
        const breakers = await call('GET', '/ice-breakers', { session: viewer });

        assert.equal(links.status, 200);
        assert.equal(links.body.length, 1);
        assert.equal(breakers.status, 200);
    });

    it('answers 409 not_connected on every route for a tenant with no number, asking Meta nothing', async () => {
        for (const [method, path, body] of [
            ['GET', '/entry-links', undefined],
            ['POST', '/entry-links', { label: 'Bio', prefill: 'Hello' }],
            ['DELETE', '/entry-links/QRCODE00000001', undefined],
            ['GET', '/ice-breakers', undefined],
            ['PUT', '/ice-breakers', { prompts: ['Hello'] }],
        ] as const) {
            const r = await call(method, path, { body });
            assert.equal(r.status, 409, `${method} ${path}`);
            assert.equal(r.body.code, 'not_connected');
        }
        noMetaCalls();
    });

    it('answers 409 for a connection Meta refused: nothing is sent through it', async () => {
        seedConnection({ status: 'invalid', last_error: 'Invalid OAuth access token.' });
        const r = await call('POST', '/entry-links', { body: { label: 'Bio', prefill: 'Hello' } });
        assert.equal(r.status, 409);
        assert.equal(r.body.code, 'not_connected');
        noMetaCalls();
    });
});

// ─── Entry links ────────────────────────────────────────────────────────────────────────

describe('GET /entry-links', () => {
    it('lists what Meta holds, joined with the owner\'s labels, with the token only in the header', async () => {
        seedConnection({ settings: { allow_billable: true, entry_links: { QRCODE00000002: { label: 'Instagram bio', ref: 'K7M3QA', created_at: '2026-10-19T08:00:00.000Z' } } } });
        seedQr('QRCODE00000001', 'Made in WhatsApp Manager');
        seedQr('QRCODE00000002', 'أريد معلومات #K7M3QA');

        const r = await call('GET', '/entry-links');

        assert.equal(r.status, 200);
        assert.deepEqual(r.body.map((l: any) => [l.id, l.label, l.ref, l.prefill, l.managed]), [
            ['QRCODE00000002', 'Instagram bio', 'K7M3QA', 'أريد معلومات', true],
            ['QRCODE00000001', null, null, 'Made in WhatsApp Manager', false],
        ]);
        assert.equal(r.body[0].url, 'https://wa.me/message/QRCODE00000002');
        assert.equal(r.body[0].qr_image_url, 'https://scontent.xx.fbcdn.net/QRCODE00000002.png');
        assert.deepEqual(order, [`GET /${PHONE}/message_qrdls`]);
        assert.deepEqual(authHeaders, [`Bearer ${TOKEN}`]);
        assertTokenNowhere();
    });

    it('is an empty list for a number with no links', async () => {
        seedConnection();
        const r = await call('GET', '/entry-links');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body, []);
    });

    it('answers Meta\'s refusal in its words (400) and an unreachable Meta as 502, and says nothing about a token', async () => {
        seedConnection();
        failures.list = () => metaError(200, `(#200) Permission denied for ${TOKEN}`, 403);
        const refused = await call('GET', '/entry-links');
        assert.equal(refused.status, 400);
        assert.equal(refused.body.code, 'entry_links_unreadable');
        assert.match(refused.body.error, /Permission denied/);

        failures.list = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        const down = await call('GET', '/entry-links');
        assert.equal(down.status, 502);
        assert.equal(down.body.code, 'meta_unreachable');
        assertTokenNowhere();
    });
});

describe('POST /entry-links', () => {
    it('creates the link at Meta with the tracking ref ON THE END, keeps the label, and leaves the owner\'s other settings alone', async () => {
        seedConnection();

        const r = await call('POST', '/entry-links', { body: { label: '  Instagram bio  ', prefill: '  أريد التسجيل في الخدمة  ' } });

        assert.equal(r.status, 201);
        assert.deepEqual(order, [`POST /${PHONE}/message_qrdls`]);
        const sent = bodies[0] as { prefilled_message: string; generate_qr_image: string };
        assert.equal(sent.generate_qr_image, 'PNG');
        assert.match(sent.prefilled_message, /^أريد التسجيل في الخدمة #[A-HJKMNP-Z2-9]{6}$/);
        const ref = refFromText(sent.prefilled_message)!;
        assert.equal(isRef(ref), true);
        assert.ok(sent.prefilled_message.length <= QR_PREFILL_MAX_CHARS);

        assert.equal(r.body.id, 'QRCODE00000001');
        assert.equal(r.body.label, 'Instagram bio');
        assert.equal(r.body.ref, ref);
        assert.equal(r.body.prefill, 'أريد التسجيل في الخدمة');
        assert.equal(r.body.url, 'https://wa.me/message/QRCODE00000001');
        assert.equal(r.body.qr_image_url, 'https://scontent.xx.fbcdn.net/QRCODE00000001.png');
        assert.equal(r.body.label_saved, true);
        assert.equal(r.body.managed, true);

        assert.equal(labelsNow().QRCODE00000001.label, 'Instagram bio');
        assert.equal(labelsNow().QRCODE00000001.ref, ref);
        assert.equal(conn!.settings.allow_billable, true, 'the owner\'s billing choice survived the label save');
        assert.equal(conn!.settings.free_tier_alert_at, 700);

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'whatsapp.entry_link_create');
        assert.equal(audits[0]!.detail.code, 'QRCODE00000001');
        assert.equal(audits[0]!.detail.ref, ref);
        assert.ok(!JSON.stringify(audits[0]!.detail).includes('أريد'), 'the message text is not in the audit row');
        assertTokenNowhere();
    });

    it('gives every link its own ref', async () => {
        seedConnection();
        await call('POST', '/entry-links', { body: { label: 'One', prefill: 'Hello' } });
        await call('POST', '/entry-links', { body: { label: 'Two', prefill: 'Hello' } });
        const refs = Object.values(labelsNow()).map((l: any) => l.ref);
        assert.equal(refs.length, 2);
        assert.notEqual(refs[0], refs[1]);
    });

    it(`accepts a ${ENTRY_PREFILL_MAX_CHARS}-character prefill and a ${ENTRY_LABEL_MAX_CHARS}-character label, and stays within Meta's ${QR_PREFILL_MAX_CHARS}`, async () => {
        seedConnection();
        const r = await call('POST', '/entry-links', { body: { label: 'l'.repeat(ENTRY_LABEL_MAX_CHARS), prefill: 'p'.repeat(ENTRY_PREFILL_MAX_CHARS) } });
        assert.equal(r.status, 201);
        assert.ok((bodies[0] as { prefilled_message: string }).prefilled_message.length <= QR_PREFILL_MAX_CHARS);
    });

    it('refuses an over-long prefill or label, or a missing one, with a code, before Meta or the database is touched', async () => {
        seedConnection();
        for (const [body, code] of [
            [{ label: 'Bio', prefill: 'p'.repeat(ENTRY_PREFILL_MAX_CHARS + 1) }, 'prefill_too_long'],
            [{ label: 'l'.repeat(ENTRY_LABEL_MAX_CHARS + 1), prefill: 'Hello' }, 'label_too_long'],
            [{ label: '', prefill: 'Hello' }, 'invalid_label'],
            [{ label: 'Bio', prefill: '   ' }, 'invalid_prefill'],
            [{}, 'invalid_label'],
        ] as const) {
            const r = await call('POST', '/entry-links', { body });
            assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
            assert.equal(r.body.code, code);
        }
        noMetaCalls();
        assert.equal(statements.length, 0);
        assert.equal(audits.length, 0);
    });

    it('relays Meta\'s refusal (the 2,000 limit, a bad message) as 400 in its words, and stores nothing', async () => {
        seedConnection();
        failures.create = () => metaError(100, 'Invalid prefilled_message length. Maximum 140 characters allowed');

        const r = await call('POST', '/entry-links', { body: { label: 'Bio', prefill: 'Hello' } });

        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'qr_refused');
        assert.match(r.body.error, /Maximum 140 characters/);
        assert.deepEqual(labelsNow(), {});
        assert.equal(audits.length, 0);
    });

    it('is NEVER sent twice: a timeout answers 502 "may or may not exist" after exactly one request, saving nothing', async () => {
        seedConnection();
        for (const failure of [
            Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
            metaError(2, 'Service temporarily unavailable', 500),
        ]) {
            order = [];
            failures.create = () => failure;
            const r = await call('POST', '/entry-links', { body: { label: 'Bio', prefill: 'Hello' } });
            assert.equal(r.status, 502, failure.message);
            assert.equal(r.body.code, 'meta_unreachable');
            assert.match(r.body.error, /may or may not have been created/);
            assert.deepEqual(order, [`POST /${PHONE}/message_qrdls`], `retried after ${failure.message}`);
        }
        assert.deepEqual(labelsNow(), {});
        assert.equal(audits.length, 0);
    });

    it('still answers with the link when only its label could not be saved: it exists, so an error would invite a second one', async () => {
        seedConnection();
        failures.labelWrite = true;

        const r = await call('POST', '/entry-links', { body: { label: 'Bio', prefill: 'Hello' } });

        assert.equal(r.status, 201);
        assert.equal(r.body.id, 'QRCODE00000001');
        assert.equal(r.body.label_saved, false);
        assert.equal(r.body.label, 'Bio', 'the owner still sees the name they typed');
        assert.deepEqual(labelsNow(), {});
        assert.ok(logs.some((l) => l.includes('whatsapp.entry_link_label_failed')), 'the failed save is logged');
        // …and the list still shows it, with its ref read back from the message Meta holds.
        failures.labelWrite = false;
        const list = await call('GET', '/entry-links');
        assert.equal(list.body[0].id, 'QRCODE00000001');
        assert.equal(list.body[0].label, null);
        assert.equal(list.body[0].ref, r.body.ref);
    });
});

describe('DELETE /entry-links/:code', () => {
    it('checks the code is this number\'s, deletes it at Meta, drops its label, audits, and answers 204', async () => {
        seedConnection({ settings: { allow_billable: true, entry_links: {
            QRCODE00000001: { label: 'Bio', ref: 'K7M3QA', created_at: '' },
            QRCODE00000002: { label: 'Poster', ref: 'M3K7QA', created_at: '' },
        } } });
        seedQr('QRCODE00000002', 'Poster #M3K7QA');
        seedQr('QRCODE00000001', 'Bio #K7M3QA');

        const r = await call('DELETE', '/entry-links/QRCODE00000001');

        assert.equal(r.status, 204);
        assert.deepEqual(order, [`GET /${PHONE}/message_qrdls?code`, `DELETE /${PHONE}/message_qrdls/QRCODE00000001`]);
        assert.deepEqual((qrs.get(PHONE) ?? []).map((q) => q.code), ['QRCODE00000002']);
        assert.deepEqual(Object.keys(labelsNow()), ['QRCODE00000002']);
        assert.equal(conn!.settings.allow_billable, true);
        assert.equal(audits[0]!.action, 'whatsapp.entry_link_delete');
        assert.deepEqual(audits[0]!.detail, { code: 'QRCODE00000001' });
        assert.deepEqual(authHeaders, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
        assertTokenNowhere();
    });

    it('is a 404 for a code that is not on this number, and never sends the delete (another business\'s code is out of reach)', async () => {
        seedConnection();
        seedQr('OTHERBUSINESS01', 'Someone else\'s', OTHER_PHONE);

        const r = await call('DELETE', '/entry-links/OTHERBUSINESS01');

        assert.equal(r.status, 404);
        assert.equal(r.body.code, 'not_found');
        assert.deepEqual(order, [`GET /${PHONE}/message_qrdls?code`, `GET /${PHONE}/message_qrdls`], 'the filtered read, then the number\'s own list: never a DELETE');
        assert.equal(qrs.get(OTHER_PHONE)!.length, 1, 'the other business\'s code is still there');
        assert.equal(audits.length, 0);
    });

    it('is a 400 for a code that could change the path, before anything is read or sent', async () => {
        seedConnection();
        for (const bad of ['abc', 'a%2Fb%2Fc%2Fd%2Fe%2Ff', `${'x'.repeat(40)}`, 'QRCODE0000000!']) {
            const r = await call('DELETE', `/entry-links/${bad}`);
            assert.equal(r.status, 400, bad);
            assert.equal(r.body.code, 'invalid_code');
        }
        noMetaCalls();
        assert.equal(statements.length, 0);
    });

    it('does not drop the label or write an audit row when Meta did not confirm the delete', async () => {
        seedConnection({ settings: { entry_links: { QRCODE00000001: { label: 'Bio', ref: 'K7M3QA', created_at: '' } } } });
        seedQr('QRCODE00000001', 'Bio #K7M3QA');

        // The code is found (one GET), then the DELETE answers 200 without success.
        const unconfirmed = metaHttp.delete;
        (metaHttp as any).delete = async () => ({ data: {} });
        const r = await call('DELETE', '/entry-links/QRCODE00000001');
        (metaHttp as any).delete = unconfirmed;

        assert.equal(r.status, 502);
        assert.equal(r.body.code, 'not_confirmed');
        assert.deepEqual(Object.keys(labelsNow()), ['QRCODE00000001']);
        assert.equal(audits.length, 0);
    });

    it('relays Meta\'s refusal of the delete and keeps the label', async () => {
        seedConnection({ settings: { entry_links: { QRCODE00000001: { label: 'Bio', ref: 'K7M3QA', created_at: '' } } } });
        seedQr('QRCODE00000001', 'Bio #K7M3QA');
        failures.remove = () => metaError(200, '(#200) Permission denied', 403);

        const r = await call('DELETE', '/entry-links/QRCODE00000001');

        assert.equal(r.status, 400);
        assert.equal(r.body.code, 'qr_refused');
        assert.deepEqual(Object.keys(labelsNow()), ['QRCODE00000001']);
        assert.equal(audits.length, 0);
    });
});

// ─── Ice breakers ───────────────────────────────────────────────────────────────────────

describe('GET /ice-breakers', () => {
    it('reads what Meta holds, with Meta\'s limits so the card never hardcodes a copy', async () => {
        seedConnection();
        automation.set(PHONE, { prompts: ['What services do you offer?'], commands: [{ command_name: 'price', command_description: 'See the price' }] });

        const r = await call('GET', '/ice-breakers');

        assert.equal(r.status, 200);
        assert.deepEqual(r.body.prompts, ['What services do you offer?']);
        assert.deepEqual(r.body.commands, [{ command_name: 'price', command_description: 'See the price' }]);
        assert.deepEqual(r.body.limits, { prompts: 4, prompt_chars: 80, commands: 30, command_name_chars: 32, command_description_chars: 256 });
        assert.equal(r.body.verified, true);
        assert.deepEqual(order, [`GET /${PHONE}`]);
        assert.deepEqual(bodies[0], { fields: 'conversational_automation' });
    });

    it('is empty lists for a number with nothing set', async () => {
        seedConnection();
        const r = await call('GET', '/ice-breakers');
        assert.deepEqual([r.body.prompts, r.body.commands], [[], []]);
    });
});

describe('PUT /ice-breakers', () => {
    it('sets the ice breakers at Meta (prompts only when no commands are sent), audits the counts, and answers with what Meta now holds', async () => {
        seedConnection();
        automation.set(PHONE, { prompts: [], commands: [{ command_name: 'price', command_description: 'See the price' }] });

        const r = await call('PUT', '/ice-breakers', { body: { prompts: ['  ما هي الخدمات المتاحة؟  ', 'كم سعر الخدمة؟'] } });

        assert.equal(r.status, 200);
        assert.deepEqual(order, [`POST /${PHONE}/conversational_automation`, `GET /${PHONE}`]);
        assert.deepEqual(bodies[0], { prompts: ['ما هي الخدمات المتاحة؟', 'كم سعر الخدمة؟'] }, 'commands were not sent, so Meta is not told to change them');
        assert.deepEqual(r.body.prompts, ['ما هي الخدمات المتاحة؟', 'كم سعر الخدمة؟']);
        assert.deepEqual(r.body.commands.map((c: any) => c.command_name), ['price'], 'the answer is Meta\'s state: the commands are still there');
        assert.equal(r.body.verified, true);

        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'whatsapp.ice_breakers_write');
        assert.deepEqual(audits[0]!.detail, { prompt_count: 2, command_count: null });
        assert.ok(!JSON.stringify(audits[0]!.detail).includes('الخدمة'), 'the texts are not in the audit row');
        assertTokenNowhere();
    });

    it('sends commands too when they are given', async () => {
        seedConnection();
        const commands = [{ command_name: 'tickets', command_description: 'Book flight tickets' }];

        const r = await call('PUT', '/ice-breakers', { body: { prompts: ['Hi'], commands } });

        assert.equal(r.status, 200);
        assert.deepEqual(bodies[0], { prompts: ['Hi'], commands });
        assert.deepEqual(audits[0]!.detail, { prompt_count: 1, command_count: 1 });
    });

    it('accepts the limits exactly: 4 ice breakers of 80 characters, 30 commands', async () => {
        seedConnection();
        const commands = Array.from({ length: 30 }, (_, i) => ({ command_name: `c${i}`, command_description: 'd' }));
        const r = await call('PUT', '/ice-breakers', { body: { prompts: [1, 2, 3, 4].map((n) => String(n).repeat(80)), commands } });
        assert.equal(r.status, 200);
    });

    it('refuses what is over a limit, with a code, before Meta is asked or anything is audited', async () => {
        seedConnection();
        const cmd = (name: string, description = 'd') => ({ command_name: name, command_description: description });
        for (const [body, code] of [
            [{ prompts: ['a', 'b', 'c', 'd', 'e'] }, 'too_many_prompts'],
            [{ prompts: ['x'.repeat(81)] }, 'prompt_too_long'],
            [{ prompts: ['Hello 😀'] }, 'prompt_has_emoji'],
            [{ prompts: [''] }, 'invalid_prompts'],
            [{}, 'invalid_prompts'],
            [{ prompts: ['ok'], commands: Array.from({ length: 31 }, (_, i) => cmd(`c${i}`)) }, 'too_many_commands'],
            [{ prompts: ['ok'], commands: [cmd('n'.repeat(33))] }, 'command_name_too_long'],
            [{ prompts: ['ok'], commands: [cmd('ok', 'd'.repeat(257))] }, 'command_description_too_long'],
            [{ prompts: ['ok'], commands: [cmd('/slash')] }, 'invalid_command_name'],
            [{ prompts: ['ok'], commands: [cmd('a'), cmd('a')] }, 'duplicate_command'],
        ] as const) {
            const r = await call('PUT', '/ice-breakers', { body });
            assert.equal(r.status, 400, `${code}: ${JSON.stringify(body).slice(0, 60)}`);
            assert.equal(r.body.code, code);
        }
        noMetaCalls();
        assert.equal(statements.length, 0);
        assert.equal(audits.length, 0);
    });

    it('relays Meta\'s refusal as 400 in its words, and an unreachable Meta as 502 "nothing was changed"', async () => {
        seedConnection();
        failures.automationSet = () => metaError(100, 'Invalid parameter: prompts');
        const refused = await call('PUT', '/ice-breakers', { body: { prompts: ['Hi'] } });
        assert.equal(refused.status, 400);
        assert.equal(refused.body.code, 'ice_breakers_refused');
        assert.match(refused.body.error, /Invalid parameter/);

        failures.automationSet = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
        const down = await call('PUT', '/ice-breakers', { body: { prompts: ['Hi'] } });
        assert.equal(down.status, 502);
        assert.equal(down.body.code, 'meta_unreachable');
        assert.equal(audits.length, 0);
        assertTokenNowhere();
    });

    it('is a 502 when Meta answers 200 without success: it does not claim a change it cannot confirm', async () => {
        seedConnection();
        failures.unconfirmed = true;
        const r = await call('PUT', '/ice-breakers', { body: { prompts: ['Hi'] } });
        assert.equal(r.status, 502);
        assert.equal(r.body.code, 'not_confirmed');
        assert.equal(audits.length, 0);
    });

    it('still answers 200 when the write landed but the read-back failed: verified false, with what was sent', async () => {
        seedConnection();
        failures.automationGet = () => Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });

        const r = await call('PUT', '/ice-breakers', { body: { prompts: ['Hi'] } });

        assert.equal(r.status, 200);
        assert.equal(r.body.verified, false);
        assert.deepEqual(r.body.prompts, ['Hi']);
        assert.equal(r.body.commands, null, 'commands were not sent, so they are not known');
        assert.equal(audits.length, 1, 'the change happened, so it is recorded');
    });
});
