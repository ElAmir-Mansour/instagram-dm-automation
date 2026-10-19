/**
 * GET /api/uploads/:id never serves a customer's file (migration v51, docs/specs/001-whatsapp-agent T016, analysis review H4).
 *
 * The route is deliberately unauthenticated (Meta and TikTok fetch post media from it), so what keeps a WhatsApp voice note out of it is
 * the media store: `open()` answers "no such upload" for an `is_private` row, and the route answers 404 for that, byte for byte the answer
 * for an id that does not exist. This runs the REAL handler (pulled off the router) against a stubbed pool, for a private row, a public
 * one as the control, and a missing one as the comparison.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setMediaStore } from '../services/storage.js';
import apiRouter from './api.js';

const CREATOR = '11111111-1111-4111-8111-111111111111';
const PRIVATE = '3b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const PUBLIC = '4b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const MISSING = '5b8a7a0e-3c1f-4f7e-9d0a-1234567890ab';
const SECRET_BYTES = Buffer.from('CUSTOMER-VOICE-NOTE-BYTES');

interface Row { mime_type: string; data: Buffer; is_private: boolean; creator_id: string }
let rows: Map<string, Row>;
let statements: string[];

class FakeResponse {
    statusCode = 200;
    headers: Record<string, string> = {};
    sent: unknown = undefined;
    headersSent = false;
    status(code: number) { this.statusCode = code; return this; }
    setHeader(name: string, value: string) { this.headers[name.toLowerCase()] = String(value); return this; }
    send(payload: unknown) { this.sent = payload; this.headersSent = true; return this; }
    end() { this.headersSent = true; return this; }
}

function handler(): (req: unknown, res: unknown) => Promise<void> {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === '/uploads/:id' && l.route.methods.get);
    assert.ok(layer, 'GET /uploads/:id must be mounted');
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle as (req: unknown, res: unknown) => Promise<void>;
}

async function serve(id: string, method = 'GET'): Promise<FakeResponse> {
    const res = new FakeResponse();
    await handler()({ method, params: { id }, headers: {} }, res);
    return res;
}

const originalQuery = pool.query;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
    rows = new Map([
        [PRIVATE, { mime_type: 'audio/ogg', data: SECRET_BYTES, is_private: true, creator_id: CREATOR }],
        [PUBLIC, { mime_type: 'image/jpeg', data: Buffer.from('a post image'), is_private: false, creator_id: CREATOR }],
    ]);
    statements = [];
    for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
        savedEnv[name] = process.env[name];
        delete process.env[name];
    }
    setMediaStore(null);
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push(flat);
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) return { rows: [], rowCount: 0 };
        if (/^SELECT mime_type, storage_path, size_bytes, /.test(flat)) {
            const row = rows.get(String(params[0]));
            if (!row) return { rows: [], rowCount: 0 };
            return {
                rows: [{ mime_type: row.mime_type, storage_path: null, size_bytes: String(row.data.length), data: row.data, is_private: row.is_private, creator_id: row.creator_id }],
                rowCount: 1,
            };
        }
        throw new Error(`no result arranged for SQL: ${flat}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

describe('GET /api/uploads/:id and a private upload', () => {
    it('answers 404 for a private row, with none of its bytes and none of its type', async () => {
        const res = await serve(PRIVATE);
        assert.equal(res.statusCode, 404);
        assert.equal(res.sent, 'Not Found');
        assert.equal(res.headers['content-type'], undefined, 'not even the type of the file is revealed');
        assert.ok(!String(res.sent).includes(SECRET_BYTES.toString()));
    });

    it('answers a HEAD the same way: its existence is not confirmed either', async () => {
        const res = await serve(PRIVATE, 'HEAD');
        assert.equal(res.statusCode, 404);
        assert.equal(res.headers['content-type'], undefined);
    });

    it('is indistinguishable from an id that does not exist', async () => {
        const privateRow = await serve(PRIVATE);
        const missing = await serve(MISSING);
        assert.equal(privateRow.statusCode, missing.statusCode);
        assert.equal(privateRow.sent, missing.sent);
        assert.deepEqual(privateRow.headers, missing.headers);
    });

    it('still serves a public row: the control, so the 404 above is the privacy rule and not a broken route', async () => {
        const res = await serve(PUBLIC);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.sent, Buffer.from('a post image'));
        assert.equal(res.headers['content-type'], 'image/jpeg');
    });
});
