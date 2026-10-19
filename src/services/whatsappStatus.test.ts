/**
 * What WhatsApp says about our messages: statuses move a row up, once, and the first delivery is counted exactly once.
 *
 * The database is a small in-memory model that answers by SQL and really rolls a transaction back (the failure that matters is "the count
 * failed after the status moved", which only a rollback can show). `metaHttp` and `axios` count and refuse every call: this handler never
 * talks to Meta. Statuses arrive the way they do in production: Meta's own sample -> `planJobs` -> the job's stored change -> the handler.
 *
 * What is pinned, because each is a way this goes wrong without anyone noticing:
 *   - a duplicate, an out-of-order or a repeated status never counts a second delivery, and a `read` that arrives first counts the first
 *   - a status that fails to count is not applied either, so the retry counts it (the other order loses the count for good)
 *   - `failed` never moves a delivered or read message back, and `delivered` after `failed` wins
 *   - a status for a message with no row is logged and completes: there is nothing to retry
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { planJobs } from '../webhook/router.js';
import type { WaEventPayload } from '../jobs/types.js';
import { metaHttp } from './http.js';
import { setLogSink } from '../utils/log.js';
import { applyStatus, handleWhatsAppEvent, STATUS_RANK } from './whatsappStatus.js';
import type { WaStatus } from '../webhook/whatsapp.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const PHONE_ID = '106540352242922';
const WABA = '102290129340398';
const WAMID = 'wamid.OUR.MESSAGE.1';
const SEPTEMBER = 1789000000; // 2026-09-10
const OCTOBER = 1760875200; // 2025-10-19: any October; the period comes from the status's own time

interface Row {
    id: string; creator_id: string | null; direction: string; meta_message_id: string; delivery_status: string | null;
    delivery_error_code: number | null; delivery_error: string | null; pricing_category: string | null; pricing_type: string | null; billable: boolean | null;
}
interface Bucket { key: string; delivered: number; billable: number; est_cost_usd: number }
interface Db { rows: Row[]; ledger: Bucket[] }

let db: Db;
let statements: Array<{ sql: string; params: unknown[] }>;
let logs: Array<Record<string, any>>;
let metaCalls: string[];
let snapshot: string | null;
let ledgerFails: boolean;
const originalQuery = pool.query;
const originalConnect = pool.connect;
const originals = { get: metaHttp.get, post: metaHttp.post, delete: metaHttp.delete, axiosGet: axios.get, axiosPost: axios.post };
let restoreSink: (() => void) | undefined;
const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function fakeQuery(sqlIn: string, params: any[] = []): { rows: any[]; rowCount: number } {
    const sql = norm(sqlIn);
    statements.push({ sql, params });
    const result = (rows: any[], rowCount = rows.length) => ({ rows, rowCount });

    if (sql === 'BEGIN') { snapshot = JSON.stringify(db); return result([]); }
    if (sql === 'COMMIT') { snapshot = null; return result([]); }
    if (sql === 'ROLLBACK') { if (snapshot) db = JSON.parse(snapshot); snapshot = null; return result([]); }

    if (sql.startsWith('SELECT id, creator_id, delivery_status, pricing_category, pricing_type, billable FROM messages WHERE meta_message_id = $1')) {
        // The statement's own filter and lock are part of what is under test: both must be in the text.
        assert.match(sql, /direction = 'outbound'/);
        assert.match(sql, /FOR UPDATE$/);
        return result(db.rows.filter((r) => r.meta_message_id === params[0] && r.direction === 'outbound').map((r) => ({ ...r })));
    }
    if (sql.startsWith('UPDATE messages SET delivery_status = $2')) {
        const [id, status, code, error, category, type, billable] = params;
        const r = db.rows.find((x) => x.id === id)!;
        r.delivery_status = status;
        r.delivery_error_code = code ?? r.delivery_error_code;
        r.delivery_error = error ?? r.delivery_error;
        r.pricing_category = category ?? r.pricing_category;
        r.pricing_type = type ?? r.pricing_type;
        r.billable = billable ?? r.billable;
        return result([], 1);
    }
    if (sql.startsWith('INSERT INTO channel_usage')) {
        if (ledgerFails) throw new Error('deadlock detected');
        const [creator, phone, period, category, type, market, billable, cost] = params;
        const key = [creator, phone, period, category, type, market].join('|');
        const b = db.ledger.find((x) => x.key === key);
        if (b) { b.delivered += 1; b.billable += billable; b.est_cost_usd += cost; }
        else db.ledger.push({ key, delivered: 1, billable, est_cost_usd: cost });
        return result([], 1);
    }
    throw new Error(`no result arranged for SQL: ${sql}`);
}

beforeEach(() => {
    statements = [];
    logs = [];
    metaCalls = [];
    snapshot = null;
    ledgerFails = false;
    db = { rows: [], ledger: [] };
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => fakeQuery(sql, params);
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: async (sql: string, params: unknown[] = []) => fakeQuery(sql, params), release: () => {} });
    const refuse = (verb: string) => async (url: string) => { metaCalls.push(`${verb} ${url}`); throw new Error(`no Meta call may be made: ${verb} ${url}`); };
    (metaHttp as any).get = refuse('GET');
    (metaHttp as any).post = refuse('POST');
    (metaHttp as any).delete = refuse('DELETE');
    (axios as any).get = refuse('axios GET');
    (axios as any).post = refuse('axios POST');
});

afterEach(() => {
    assert.deepEqual(metaCalls, [], 'a Meta call was made');
    restoreSink?.();
    (pool as unknown as { query: unknown }).query = originalQuery;
    (pool as unknown as { connect: unknown }).connect = originalConnect;
    (metaHttp as any).get = originals.get;
    (metaHttp as any).post = originals.post;
    (metaHttp as any).delete = originals.delete;
    (axios as any).get = originals.axiosGet;
    (axios as any).post = originals.axiosPost;
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

const outbound = (over: Partial<Row> = {}): Row => ({
    id: 'msg-1', creator_id: CREATOR, direction: 'outbound', meta_message_id: WAMID, delivery_status: null, delivery_error_code: null, delivery_error: null,
    pricing_category: null, pricing_type: null, billable: null, ...over,
});

interface StatusOver {
    status?: string; timestamp?: number; recipient_id?: string | null; recipient_user_id?: string | null; pricing?: Record<string, unknown> | null; errors?: unknown[]; id?: string;
}
const FREE = { billable: false, pricing_model: 'PMP', type: 'free_customer_service', category: 'service' };
const PAID = { billable: true, pricing_model: 'PMP', type: 'regular', category: 'marketing' };

/** One status delivery, as Meta sends it. */
function statusBody(over: StatusOver = {}): any {
    const status: Record<string, unknown> = {
        id: over.id ?? WAMID, status: over.status ?? 'delivered', timestamp: String(over.timestamp ?? OCTOBER),
        ...(over.recipient_id === null ? {} : { recipient_id: over.recipient_id ?? '201001234567' }),
        ...(over.recipient_user_id ? { recipient_user_id: over.recipient_user_id } : {}),
        ...(over.pricing === null ? {} : { pricing: over.pricing ?? FREE }),
        ...(over.errors ? { errors: over.errors } : {}),
    };
    return {
        object: 'whatsapp_business_account',
        entry: [{ id: WABA, changes: [{ field: 'messages', value: {
            messaging_product: 'whatsapp', metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID }, statuses: [status],
        } }] }],
    };
}

const payloadsOf = (body: any): WaEventPayload[] => planJobs(body).filter((j) => j.kind === 'wa.event').map((j) => j.payload as WaEventPayload);

/** What the runner does: plan the delivery, hand each wa.event job to the handler. */
async function receive(over: StatusOver = {}): Promise<void> {
    for (const payload of payloadsOf(statusBody(over))) await handleWhatsAppEvent(payload);
}

const logged = (event: string) => logs.filter((l) => l.event === event);
const row = () => db.rows[0]!;
const delivered = () => db.ledger.reduce((n, b) => n + b.delivered, 0);

// ─── The order statuses move in ────────────────────────────────────────────────────────

describe('STATUS_RANK', () => {
    it('only ever goes up: sent < failed < delivered < read < played', () => {
        assert.deepEqual(Object.entries(STATUS_RANK).sort((a, b) => a[1] - b[1]).map(([k]) => k), ['sent', 'failed', 'delivered', 'read', 'played']);
    });
});

describe('the life of a message', () => {
    it('moves up through sent, delivered, read and played, and is counted once, on delivered', async () => {
        db.rows.push(outbound());
        await receive({ status: 'sent', pricing: FREE });
        assert.equal(row().delivery_status, 'sent');
        assert.equal(delivered(), 0, 'sent is not a delivery');

        await receive({ status: 'delivered', pricing: FREE });
        assert.equal(row().delivery_status, 'delivered');
        assert.equal(delivered(), 1);

        await receive({ status: 'read', pricing: null });
        await receive({ status: 'played', pricing: null });
        assert.equal(row().delivery_status, 'played');
        assert.equal(delivered(), 1, 'read and played are not second deliveries');
        assert.equal(db.ledger.length, 1);
    });

    it('copies pricing from the status that carries it and never overwrites it with nothing', async () => {
        db.rows.push(outbound());
        await receive({ status: 'sent', pricing: PAID });
        assert.deepEqual([row().pricing_category, row().pricing_type, row().billable], ['marketing', 'regular', true]);
        await receive({ status: 'delivered', pricing: null });
        await receive({ status: 'read', pricing: null });
        assert.deepEqual([row().pricing_category, row().pricing_type, row().billable], ['marketing', 'regular', true], 'a status with no pricing leaves it alone');
        await receive({ status: 'read', pricing: FREE });
        assert.deepEqual([row().pricing_category, row().pricing_type, row().billable], ['service', 'free_customer_service', false], 'a later status that does carry it is the newer word');
    });

    it('runs every status in one transaction, under a row lock', async () => {
        db.rows.push(outbound());
        await receive({ status: 'delivered' });
        const sqls = statements.map((s) => s.sql);
        const begin = sqls.indexOf('BEGIN');
        const commit = sqls.indexOf('COMMIT');
        assert.ok(begin >= 0 && commit > begin);
        assert.deepEqual(sqls.slice(begin + 1, commit).map((s) => s.split(' ').slice(0, 3).join(' ')), ['SELECT id, creator_id,', 'UPDATE messages SET', 'INSERT INTO channel_usage']);
    });
});

describe('a delivery is counted exactly once', () => {
    it('ignores the same status delivered again and again', async () => {
        db.rows.push(outbound());
        for (let i = 0; i < 4; i++) await receive({ status: 'delivered' });
        assert.equal(delivered(), 1);
        assert.equal(db.ledger[0]!.delivered, 1);
        assert.equal(row().delivery_status, 'delivered');
    });

    it('counts a read that arrives before its delivered once, and the delivered that follows adds nothing', async () => {
        db.rows.push(outbound());
        await receive({ status: 'read' });
        assert.equal(row().delivery_status, 'read');
        assert.equal(delivered(), 1, 'the message did arrive: a read is a delivery');
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, 'read', 'it does not go back down');
        assert.equal(delivered(), 1);
        await receive({ status: 'sent' });
        assert.equal(row().delivery_status, 'read');
        assert.equal(delivered(), 1);
    });

    it('counts a played that arrives first once', async () => {
        db.rows.push(outbound());
        await receive({ status: 'played' });
        await receive({ status: 'read' });
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, 'played');
        assert.equal(delivered(), 1);
    });

    it('counts two different messages twice', async () => {
        db.rows.push(outbound(), outbound({ id: 'msg-2', meta_message_id: 'wamid.OUR.MESSAGE.2' }));
        await receive({ status: 'delivered' });
        await receive({ status: 'delivered', id: 'wamid.OUR.MESSAGE.2' });
        assert.equal(delivered(), 2);
    });

    it('does not move the status, or count, when the count itself fails: the retry does both', async () => {
        db.rows.push(outbound());
        ledgerFails = true;
        await assert.rejects(() => receive({ status: 'delivered' }), /deadlock detected/);
        assert.equal(row().delivery_status, null, 'rolled back: had the status stayed, the retry would find it already delivered and never count it');
        assert.equal(delivered(), 0);
        assert.ok(statements.some((s) => s.sql === 'ROLLBACK'));

        ledgerFails = false;
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, 'delivered');
        assert.equal(delivered(), 1, 'counted by the retry, once');
    });

    it('counts a failure of a message that was never delivered as no delivery at all', async () => {
        db.rows.push(outbound());
        await receive({ status: 'failed', pricing: null, errors: [{ code: 131049, title: 'Not delivered', message: 'x', error_data: { details: 'to protect the ecosystem' } }] });
        assert.equal(delivered(), 0);
    });
});

describe('failed', () => {
    const ERRORS = [{ code: 131049, title: 'This message was not delivered to maintain healthy ecosystem engagement.', error_data: { details: 'In order to maintain a healthy ecosystem engagement, the message failed to be delivered.' } }];

    it('records Meta’s code and words, and says so in the log without the message', async () => {
        db.rows.push(outbound({ delivery_status: 'sent' }));
        await receive({ status: 'failed', pricing: null, errors: ERRORS });
        assert.equal(row().delivery_status, 'failed');
        assert.equal(row().delivery_error_code, 131049);
        assert.match(row().delivery_error!, /^This message was not delivered.*: In order to maintain/);
        const said = logged('wa.message_failed');
        assert.equal(said.length, 1);
        assert.deepEqual([said[0]!.level, said[0]!.code, said[0]!.phone_number_id], ['warn', 131049, PHONE_ID]);
    });

    it('never moves a delivered or read message back: the error is recorded, the status stays', async () => {
        for (const status of ['delivered', 'read']) {
            db = { rows: [outbound({ delivery_status: status })], ledger: [] };
            await receive({ status: 'failed', pricing: null, errors: ERRORS });
            assert.equal(row().delivery_status, status, `a failed after ${status}`);
            assert.equal(row().delivery_error_code, 131049, 'multi-device can produce both: the error is still on record');
            assert.equal(delivered(), 0, 'and it is not counted a second time (it was counted when it was delivered)');
        }
    });

    it('lets a delivered that follows a failed win, and counts it once', async () => {
        db.rows.push(outbound({ delivery_status: 'failed', delivery_error_code: 131049, delivery_error: 'x' }));
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, 'delivered', 'the message did arrive');
        assert.equal(delivered(), 1);
        await receive({ status: 'failed', pricing: null, errors: ERRORS });
        assert.equal(row().delivery_status, 'delivered');
        assert.equal(delivered(), 1);
    });

    it('does not write an error onto a status that is not failed', async () => {
        db.rows.push(outbound({ delivery_status: 'sent' }));
        await receive({ status: 'delivered' });
        const update = statements.find((s) => s.sql.startsWith('UPDATE messages'))!;
        assert.deepEqual([update.params[2], update.params[3]], [null, null]);
    });

    it('tolerates a failed status with no errors[] at all', async () => {
        db.rows.push(outbound({ delivery_status: 'sent' }));
        await receive({ status: 'failed', pricing: null });
        assert.equal(row().delivery_status, 'failed');
        assert.equal(row().delivery_error_code, null);
        assert.equal(logged('wa.message_failed')[0]!.code, null);
    });
});

// ─── The ledger entry ──────────────────────────────────────────────────────────────────

describe('what a delivery adds to the ledger', () => {
    it('is one row per bucket, in the recipient’s market, with the cost of a billable message', async () => {
        db.rows.push(outbound());
        await receive({ status: 'delivered', pricing: PAID, recipient_id: null, recipient_user_id: 'SA.55' });
        const b = db.ledger[0]!;
        assert.equal(b.key, [CREATOR, PHONE_ID, '2025-10', 'marketing', 'regular', 'SA'].join('|'));
        assert.deepEqual([b.delivered, b.billable, b.est_cost_usd], [1, 1, 0.0576]);
    });

    it('takes the market from the phone number when there is no BSUID, and `other` when neither says', async () => {
        db.rows.push(outbound(), outbound({ id: 'msg-2', meta_message_id: 'wamid.2' }));
        await receive({ status: 'delivered', recipient_id: '201001234567' });
        await receive({ status: 'delivered', id: 'wamid.2', recipient_id: null });
        assert.deepEqual(db.ledger.map((b) => b.key.split('|')[5]).sort(), ['EG', 'other']);
    });

    it('uses the pricing the row already holds when the delivered status carries none', async () => {
        db.rows.push(outbound({ pricing_category: 'utility', pricing_type: 'regular', billable: true }));
        await receive({ status: 'read', pricing: null });
        const b = db.ledger[0]!;
        assert.equal(b.key.split('|').slice(3, 5).join('|'), 'utility|regular');
        assert.equal(b.billable, 1);
        assert.equal(b.est_cost_usd, 0.0036, 'a billable utility message to an Egyptian number');
    });

    it('files a delivery nobody priced under `unknown`, still counted', async () => {
        db.rows.push(outbound());
        await receive({ status: 'delivered', pricing: null });
        assert.equal(db.ledger[0]!.key.split('|').slice(3, 5).join('|'), 'unknown|unknown');
        assert.equal(delivered(), 1);
    });

    it('counts it in the month the message was delivered, not the month the webhook was processed', async () => {
        db.rows.push(outbound());
        await receive({ status: 'delivered', timestamp: SEPTEMBER });
        assert.equal(db.ledger[0]!.key.split('|')[2], '2026-09');
    });

    it('still applies the status, and says so, when the row has no tenant or the job has no number: nothing to count it against', async () => {
        db.rows.push(outbound({ creator_id: null }));
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, 'delivered');
        assert.equal(delivered(), 0);
        assert.deepEqual([logged('wa.usage_not_counted')[0]!.level, logged('wa.usage_not_counted')[0]!.reason], ['warn', 'no_creator']);

        db = { rows: [outbound()], ledger: [] };
        await applyStatus({ ...(payloadsOfStatus()), status: 'delivered' }, null);
        assert.equal(logged('wa.usage_not_counted')[1]!.reason, 'no_phone_number_id');
    });
});

function payloadsOfStatus(): WaStatus {
    // The normalised status of the default delivery, for the calls that bypass the job.
    const job = payloadsOf(statusBody({ status: 'delivered' }))[0] as Extract<WaEventPayload, { kind: 'status' }>;
    const status = (job.change as any).statuses[0];
    return {
        wamid: status.id, status: 'delivered', rawStatus: 'delivered', timestamp: Number(status.timestamp), phoneNumberId: PHONE_ID, recipientUserId: null,
        recipientPhone: status.recipient_id, pricing: { billable: false, category: 'service', type: 'free_customer_service' },
    };
}

// ─── What it will not touch, and what it only logs ─────────────────────────────────────

describe('a status it cannot apply', () => {
    it('completes, with a log line, when no message of ours has that id: there is nothing to retry', async () => {
        await receive({ status: 'delivered' });
        const said = logged('wa.status_unknown_message');
        assert.equal(said.length, 1);
        assert.deepEqual([said[0]!.level, said[0]!.phone_number_id, said[0]!.status], ['info', PHONE_ID, 'delivered']);
        assert.ok(!statements.some((s) => s.sql.startsWith('UPDATE') || s.sql.startsWith('INSERT')), 'nothing written');
        assert.equal(delivered(), 0);
    });

    it('never updates a customer’s message: statuses are about OURS', async () => {
        db.rows.push(outbound({ direction: 'inbound' }));
        await receive({ status: 'delivered' });
        assert.equal(row().delivery_status, null);
        assert.equal(logged('wa.status_unknown_message').length, 1);
    });

    it('warns about a status name Meta added later, and writes nothing', async () => {
        db.rows.push(outbound());
        await receive({ status: 'brand_new_status' });
        const said = logged('wa.status_unrecognised');
        assert.deepEqual([said.length, said[0]!.level, said[0]!.raw_status], [1, 'warn', 'brand_new_status']);
        assert.equal(statements.length, 0);
    });

    it('warns about a status job that holds no status', async () => {
        await handleWhatsAppEvent({ kind: 'status', entryId: WABA, phoneNumberId: PHONE_ID, change: { statuses: [] } });
        assert.equal(logged('wa.status_empty').length, 1);
    });
});

describe('account and preference events', () => {
    it('are logged with their field and number, change nothing, and need no database', async () => {
        for (const payload of payloadsOf({
            object: 'whatsapp_business_account',
            entry: [{ id: WABA, time: 1745612159, changes: [{ field: 'phone_number_quality_update', value: { display_phone_number: '15550783881', event: 'FLAGGED', current_limit: 'TIER_250' } }] }],
        })) await handleWhatsAppEvent(payload);
        await handleWhatsAppEvent({ kind: 'preference', entryId: WABA, phoneNumberId: PHONE_ID, change: { user_preferences: [{ wa_id: '201001234567', detail: 'User requested to stop marketing messages', value: 'stop' }] } });

        const account = logged('wa.account_event');
        assert.deepEqual([account.length, account[0]!.field, account[0]!.entry_id], [1, 'phone_number_quality_update', WABA]);
        const preference = logged('wa.preference_event');
        assert.deepEqual([preference.length, preference[0]!.field, preference[0]!.phone_number_id], [1, 'user_preferences', PHONE_ID]);
        assert.equal(statements.length, 0, 'nothing was read or written');
    });

    it('never log a customer’s phone number or what they chose', async () => {
        await handleWhatsAppEvent({ kind: 'preference', entryId: WABA, phoneNumberId: PHONE_ID, change: { user_preferences: [{ wa_id: '201001234567', user_id: 'EG.123', detail: 'User requested to stop marketing messages' }] } });
        const everything = logs.map((l) => JSON.stringify(l)).join('\n');
        for (const secret of ['201001234567', 'EG.123', 'stop marketing']) assert.ok(!everything.includes(secret), secret);
    });

    it('warn, and do not throw, for a kind this build does not know', async () => {
        await handleWhatsAppEvent({ kind: 'surprise' } as unknown as WaEventPayload);
        assert.equal(logged('wa.event_unknown_kind').length, 1);
    });
});
