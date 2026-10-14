/**
 * GET/POST /api/settings/sales-variants: the owner's A/B wording experiment for the DM sales turn (DM plan S14, `dmSales/variants.ts`).
 *
 * Run through the route's WHOLE stack (guard, then handler) with `pool.query` stubbed, as `salesFollowupSettings.test.ts` does, because the guard
 * and the tenant key are the point: the row is the SESSION's tenant's (`dm.variants.<tenant>`), a viewer may read it and not write it, an invalid
 * body is a 400 that names every problem and writes nothing, and what is stored is only what survived `parseVariantConfig`.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;

const PATH = '/settings/sales-variants';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const KEY = `dm.variants.${TENANT}`;

function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

function fakeRes() {
    const headers: Record<string, string> = {};
    return {
        statusCode: 200,
        body: null as any,
        headers,
        status(code: number) { this.statusCode = code; return this; },
        set(name: string, value: string) { headers[name.toLowerCase()] = value; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function run(method: 'get' | 'post', session: Record<string, unknown>, role: 'owner' | 'operator' | 'viewer', body: Record<string, unknown> = {}) {
    const res = fakeRes();
    const req = { session, body, params: {}, tenantRole: role, headers: {} };
    for (const handle of stackFor(method, PATH)) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const OWNER = { userId: 'u-owner', role: 'user', tenantId: TENANT };
const ARMS = [
    { id: 'A', label: 'Warm', weight: 50, opening: 'Open with one short question.', cta: '' },
    { id: 'B', label: 'Direct', weight: 50, opening: '', cta: 'Offer the link in one plain sentence.' },
];

let restoreSink: (() => void) | undefined;
let originalQuery: typeof pool.query;
let saved: Record<string, string>;
let writes: Array<{ key: string; value: string | null }>;
let audits: Array<{ action: string; target: unknown; detail: any }>;

beforeEach(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    originalQuery = pool.query;
    saved = {};
    writes = [];
    audits = [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        if (/^\s*SELECT\b[\s\S]*FROM app_settings WHERE key = \$1/.test(sql)) {
            const key = String(params[0]);
            return key in saved ? { rows: [{ value: saved[key], is_secret: false }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (/INSERT INTO app_settings/.test(sql)) {
            saved[String(params[0])] = String(params[1]);
            writes.push({ key: String(params[0]), value: String(params[1]) });
            return { rows: [], rowCount: 1 };
        }
        if (/DELETE FROM app_settings WHERE key = \$1/.test(sql)) {
            delete saved[String(params[0])];
            writes.push({ key: String(params[0]), value: null });
            return { rows: [], rowCount: 1 };
        }
        if (/FROM users WHERE id = \$1/.test(sql)) return { rows: [{ email: 'owner@example.test' }], rowCount: 1 };
        if (/INSERT INTO audit_log/.test(sql)) {
            audits.push({ action: String(params[2]), target: params[4], detail: JSON.parse(String(params[5])) });
            return { rows: [], rowCount: 1 };
        }
        throw new Error(`no result arranged for SQL: ${sql}`);
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink?.();
});

describe('GET /settings/sales-variants', () => {
    it('is an empty, switched-off editor when nothing is saved, with the limits the screen shows', async () => {
        const res = await run('get', OWNER, 'viewer');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.config, { enabled: false, variants: [] });
        assert.equal(res.body.saved, false);
        assert.equal(res.body.running, false);
        assert.deepEqual(res.body.slots, ['A', 'B', 'C']);
        assert.deepEqual(res.body.limits, { min: 2, max: 3, label: 40, text: 300, weight: 100, minSample: 30 });
        assert.equal(res.headers['cache-control'], 'no-store');
    });

    it('reads the SESSION\'s tenant row and no other, and answers what is saved', async () => {
        saved[`dm.variants.${OTHER}`] = JSON.stringify({ v: 1, config: { enabled: true, variants: ARMS } });
        assert.equal((await run('get', OWNER, 'viewer')).body.saved, false, 'another tenant\'s experiment is not this one\'s');
        saved[KEY] = JSON.stringify({ v: 1, config: { enabled: true, variants: ARMS } });
        const res = await run('get', OWNER, 'viewer');
        assert.equal(res.body.saved, true);
        assert.equal(res.body.running, true);
        assert.deepEqual(res.body.config.variants.map((v: { id: string }) => v.id), ['A', 'B']);
    });

    it('answers a value it cannot read as an empty editor, so the screen opens and a save writes over it', async () => {
        saved[KEY] = '{not json';
        const res = await run('get', OWNER, 'viewer');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.saved, false);
        assert.equal(res.body.running, false);
    });
});

describe('POST /settings/sales-variants', () => {
    it('saves a valid experiment under the session\'s tenant key, as `{ v, config }`, and answers the new state', async () => {
        const res = await run('post', OWNER, 'operator', { enabled: true, variants: ARMS });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(writes.length, 1);
        assert.equal(writes[0]!.key, KEY);
        assert.deepEqual(JSON.parse(writes[0]!.value!), { v: 1, config: { enabled: true, variants: ARMS } });
        assert.equal(res.body.running, true);
        assert.equal(res.body.saved, true);
        assert.equal((await run('get', OWNER, 'viewer')).body.config.variants[1].cta, 'Offer the link in one plain sentence.', 'read back');
    });

    it('keeps a draft that is switched off, and answers that it is not running', async () => {
        const res = await run('post', OWNER, 'operator', { enabled: false, variants: [ARMS[0]] });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.running, false);
        assert.equal(res.body.config.variants.length, 1);
    });

    it('may be written by an operator and an owner and read by a viewer, who cannot write: a 403 and nothing written', async () => {
        assert.equal((await run('post', OWNER, 'operator', { enabled: false, variants: [] })).statusCode, 200);
        assert.equal((await run('post', OWNER, 'owner', { enabled: false, variants: [] })).statusCode, 200);
        writes.length = 0;
        const res = await run('post', OWNER, 'viewer', { enabled: true, variants: ARMS });
        assert.equal(res.statusCode, 403);
        assert.deepEqual(writes, []);
        assert.equal((await run('get', OWNER, 'viewer')).statusCode, 200);
    });

    it('is the SESSION\'s tenant that is written, whatever the body says', async () => {
        await run('post', OWNER, 'operator', { enabled: true, variants: ARMS, creator_id: OTHER, tenantId: OTHER, key: `dm.variants.${OTHER}` });
        assert.deepEqual(writes.map((w) => w.key), [KEY]);
        assert.ok(!writes[0]!.value!.includes(OTHER), 'nothing from the body but the config reaches the row');
    });

    it('refuses an invalid body with a 400 that names every problem and its field, writing nothing', async () => {
        const res = await run('post', OWNER, 'operator', {
            enabled: true,
            variants: [
                { id: 'A', label: 'Warm', weight: 50, cta: 'Send https://shop.example/x' },
                { id: 'B', label: '', weight: 500, opening: 'Say 50% off' },
            ],
        });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'VARIANTS_INVALID');
        assert.deepEqual(res.body.problems.map((p: { field: string; code: string }) => `${p.field}:${p.code}`).sort(), [
            'variants[0].cta:text_link', 'variants[1].label:label_missing', 'variants[1].opening:text_number', 'variants[1].weight:weight_invalid',
        ]);
        assert.equal(res.body.error, res.body.problems[0].message, 'the first problem is the message');
        assert.deepEqual(writes, []);
    });

    it('refuses a running experiment that has nothing to compare, and more than three arms', async () => {
        const one = await run('post', OWNER, 'operator', { enabled: true, variants: [ARMS[0]] });
        assert.equal(one.statusCode, 400);
        assert.equal(one.body.problems[0].code, 'too_few');
        const four = await run('post', OWNER, 'operator', { enabled: false, variants: [1, 2, 3, 4].map((n) => ({ id: 'A', label: `L${n}`, weight: 1 })) });
        assert.equal(four.statusCode, 400);
        assert.ok(four.body.problems.some((p: { code: string }) => p.code === 'too_many'));
        assert.deepEqual(writes, []);
    });

    it('writes the ledger: the arms\' ids, shares and the LENGTH of their texts, never the texts', async () => {
        await run('post', OWNER, 'operator', { enabled: true, variants: ARMS });
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, 'dm.variants_write');
        assert.equal(audits[0]!.target, TENANT);
        assert.deepEqual(audits[0]!.detail, {
            enabled: true,
            variants: [{ id: 'A', weight: 50, opening_chars: 'Open with one short question.'.length, cta_chars: 0 }, { id: 'B', weight: 50, opening_chars: 0, cta_chars: 'Offer the link in one plain sentence.'.length }],
        });
        assert.ok(!JSON.stringify(audits[0]!.detail).includes('Offer the link'), 'no wording in the ledger');
    });

    it('is a 500 with no detail when the settings table fails, and never a stored half-write', async () => {
        const failing = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
            if (/INSERT INTO app_settings/.test(sql)) throw new Error('connection to db.internal.example failed, password=hunter2');
            return (failing as unknown as (s: string, p: unknown[]) => Promise<unknown>)(sql, params);
        };
        const res = await run('post', OWNER, 'operator', { enabled: true, variants: ARMS });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to save the wording experiment.' });
    });
});
