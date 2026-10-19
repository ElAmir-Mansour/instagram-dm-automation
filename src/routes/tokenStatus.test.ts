/**
 * `GET /api/settings/token/status`: a check that could not run is `unknown`, never `invalid` (UX US1, T049, OV-08).
 *
 * The route used to call `debug_token` through a bare `axios` (no timeout) and store EVERY failure, a Meta timeout included, as
 * `invalid`: a working connection went red on the dashboard and in the admin tenant list until the next check. It now goes through
 * `metaHttp` (10 s) and answers `status: 'unknown'` when Meta did not answer, writing nothing.
 *
 * Each case runs against a stubbed pool and a stubbed `metaHttp.get`; the raw `axios.get` is stubbed to refuse, so a route that went
 * back to it would fail here. Nothing reaches Meta: there are live credentials in `.env`.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { metaHttp } from '../services/http.js';
import { TOKEN_CHECK_UNANSWERED_MESSAGE } from '../services/tokenHealth.js';
import apiRouter from './api.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONNECTED = { id: TENANT, instagram_page_id: 'ig-1', facebook_page_id: 'fb-1', page_access_token: 'plain-token', is_active: true };

interface Statement { sql: string; params: any[] }
let statements: Statement[] = [];
let metaCalls: Array<{ url: string; config: any }> = [];
let axiosCalls: string[] = [];
let metaAnswer: (() => unknown) | null = null;
const original = { query: pool.query, connect: pool.connect, get: metaHttp.get, axiosGet: axios.get };

let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    statements = [];
    metaCalls = [];
    axiosCalls = [];
    metaAnswer = null;
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        if (/FROM creators WHERE id/.test(flat)) return { rows: [{ ...CONNECTED }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).get = async (url: string, config: unknown) => {
        metaCalls.push({ url, config });
        if (!metaAnswer) throw new Error('metaHttp.get is not stubbed for this case');
        return metaAnswer();
    };
    (axios as any).get = async (url: string) => { axiosCalls.push(url); throw new Error('the token check must go through metaHttp, not raw axios'); };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = original.query;
    (pool as unknown as { connect: unknown }).connect = original.connect;
    (metaHttp as any).get = original.get;
    (axios as any).get = original.axiosGet;
});

function handlerFor(method: string, route: string) {
    const stack = (apiRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === route && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${route} must be mounted`);
    return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
}

async function checkStatus() {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader() {},
        send() { return this; },
    };
    await handlerFor('get', '/settings/token/status')({ params: {}, body: {}, session: { userId: 'u-1', role: 'user', tenantId: TENANT } }, res, () => {});
    return res;
}

const creatorWrites = () => statements.filter((s) => /^UPDATE creators\b/.test(s.sql));

/** The axios error shapes `metaHttp` throws. */
const timeout = () => Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' });
const offline = () => Object.assign(new Error('getaddrinfo ENOTFOUND graph.facebook.com'), { code: 'ENOTFOUND' });
const httpFailure = (status: number, code?: number) =>
    Object.assign(new Error(`Request failed with status code ${status}`), {
        response: { status, data: code === undefined ? {} : { error: { code, message: `Meta says ${code}` } } },
    });

const GOOD = { data: { data: { is_valid: true, type: 'PAGE', expires_at: 0, data_access_expires_at: 0, scopes: ['instagram_basic'] } } };

describe('GET /settings/token/status goes through metaHttp', () => {
    it('asks Meta once, through metaHttp (so it has the 10 s timeout), and never through raw axios', async () => {
        metaAnswer = () => GOOD;
        const res = await checkStatus();
        assert.equal(res.statusCode, 200);
        assert.equal(metaCalls.length, 1);
        assert.equal(metaCalls[0]!.url, 'https://graph.facebook.com/debug_token');
        assert.deepEqual(axiosCalls, []);
    });

    it('a valid answer is still `valid` and is still recorded', async () => {
        metaAnswer = () => GOOD;
        const res = await checkStatus();
        assert.equal(res.body.status, 'valid');
        assert.equal(creatorWrites().length, 1);
        assert.equal(creatorWrites()[0]!.params[0], 'valid');
    });
});

describe('GET /settings/token/status: Meta did not answer is `unknown`, and nothing is written', () => {
    const cases: Array<[string, () => unknown]> = [
        ['a timeout', () => { throw timeout(); }],
        ['no network', () => { throw offline(); }],
        ['a 500', () => { throw httpFailure(500); }],
        ['a 503', () => { throw httpFailure(503); }],
        ['a 429', () => { throw httpFailure(429); }],
        ['a Meta "try again" code (2, service unavailable) on a 400', () => { throw httpFailure(400, 2); }],
        ['a 200 whose body is not an inspection', () => ({ data: '<html>bad gateway</html>' })],
        ['a 200 with an empty data object', () => ({ data: { data: {} } })],
    ];

    for (const [name, answer] of cases) {
        it(name, async () => {
            metaAnswer = answer;
            const res = await checkStatus();
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.status, 'unknown');
            assert.equal(res.body.message, TOKEN_CHECK_UNANSWERED_MESSAGE);
            assert.equal(res.body.expiresAt, null);
            assert.equal(res.body.instagramPageId, 'ig-1', 'the page ids are still the tenant\'s, so Settings can show them');
            assert.equal(res.body.isActive, true);
            assert.deepEqual(creatorWrites(), [], 'a Meta hiccup is never stored as `invalid` (the whole point)');
            assert.deepEqual(axiosCalls, []);
        });
    }

    it('does not put the token in the answer', async () => {
        metaAnswer = () => { throw timeout(); };
        const res = await checkStatus();
        assert.equal(JSON.stringify(res.body).includes('plain-token'), false);
    });
});

describe('GET /settings/token/status: a definitive no is still `invalid`, and is still recorded', () => {
    it('code 190 on a 400: the token is dead', async () => {
        metaAnswer = () => { throw httpFailure(400, 190); };
        const res = await checkStatus();
        assert.equal(res.body.status, 'invalid');
        assert.equal(creatorWrites().length, 1);
        assert.equal(creatorWrites()[0]!.params[0], 'invalid');
        assert.equal(creatorWrites()[0]!.params[1], 'Meta says 190');
    });

    it('Meta answered `is_valid: false`: invalid', async () => {
        metaAnswer = () => ({ data: { data: { is_valid: false, error: { message: 'Session has expired' } } } });
        const res = await checkStatus();
        assert.equal(res.body.status, 'invalid');
        assert.equal(creatorWrites()[0]!.params[0], 'invalid');
    });

    it('a 400 that is not a "try again" code (100, a bad parameter) is an answer, so it is invalid as it always was', async () => {
        metaAnswer = () => { throw httpFailure(400, 100); };
        const res = await checkStatus();
        assert.equal(res.body.status, 'invalid');
        assert.equal(creatorWrites().length, 1);
    });
});
