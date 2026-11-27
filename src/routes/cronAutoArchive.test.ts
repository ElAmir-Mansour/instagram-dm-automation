/**
 * The daily cron's call for the 30-day clean-up (`runAutoArchiveSweep`, called from GET /api/cron/publish, U2): that it is made once per run, that what it puts
 * away is logged and audited, that a quiet day leaves no log line, and that nothing it does can turn a publish sweep that already ran into a 500. The sweep
 * itself is `src/services/autoArchive.test.ts`. The handler is pulled off the router's own stack and run against a stubbed pool, like cronMuseReels.test.ts.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Rows = { rows: any[]; rowCount?: number };
const TENANT = '55555555-5555-4555-8555-555555555555';

let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows | Error][] = [];
let logs: { level: string; event: string }[] = [];
const original = { query: pool.query, connect: pool.connect, get: metaHttp.get };
const saved = { cron: process.env.CRON_SECRET };
let restoreSink: (() => void) | undefined;

before(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const previous = setLogSink((level, line) => {
        try { logs.push({ level, event: JSON.parse(line).event }); } catch { /* not a structured line */ }
    });
    restoreSink = () => setLogSink(previous);
});
after(() => {
    restoreSink?.();
    if (saved.cron === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = saved.cron;
});
beforeEach(() => {
    statements = [];
    routes = [];
    logs = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        if (r instanceof Error) throw r;
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).get = async () => ({ data: { data: [] }, headers: {} });
});
afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).get = original.get;
});

function cronHandler(): Function {
    const layer = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] } }> })
        .stack.find((l) => l.route?.path === '/cron/publish' && l.route.methods['get']);
    assert.ok(layer, 'GET /cron/publish must be mounted');
    return layer!.route!.stack.at(-1)!.handle;
}
async function cron() {
    const res = {
        statusCode: 200, body: null as any,
        status(code: number) { this.statusCode = code; return this; }, json(payload: unknown) { this.body = payload; return this; }, setHeader() {}, end() { return this; },
    };
    await cronHandler()({ params: {}, query: {}, headers: { authorization: 'Bearer test-cron-secret' }, body: {} }, res, () => {});
    return res;
}
const CREATORS = /^SELECT id FROM creators$/;
const POSTS = /^UPDATE scheduled_posts SET archived_at = NOW\(\)/;

describe('GET /cron/publish: the 30-day clean-up', () => {
    it('runs the sweep once, after the publish sweep, and a quiet day leaves no log line and no audit row', async () => {
        routes.push([CREATORS, () => ({ rows: [{ id: TENANT }] })]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        assert.equal(statements.filter((s) => CREATORS.test(s.sql)).length, 1);
        const publish = statements.findIndex((s) => /^SELECT s\.\*, c\.page_access_token/.test(s.sql));
        const sweep = statements.findIndex((s) => CREATORS.test(s.sql));
        assert.ok(publish >= 0 && sweep > publish, 'the publish sweep ran first');
        assert.equal(logs.filter((l) => l.event === 'cron.auto_archive').length, 0);
        assert.equal(statements.filter((s) => /INSERT INTO audit_log/.test(s.sql)).length, 0);
    });

    it('puts old failures away for a tenant at the default 30 days, logs the run and audits the tenant once', async () => {
        routes.push([CREATORS, () => ({ rows: [{ id: TENANT }] })], [POSTS, () => ({ rows: [{ id: 'p1' }, { id: 'p2' }] })]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const update = statements.find((s) => POSTS.test(s.sql))!;
        assert.deepEqual(update.params, [TENANT, 30]);
        assert.equal(logs.filter((l) => l.event === 'cron.auto_archive').length, 1);
        const audits = statements.filter((s) => /INSERT INTO audit_log/.test(s.sql));
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.params[2], 'cleanup.auto_archive');
        assert.equal(audits[0]!.params[1], 'system:auto-archive');
    });

    it('a sweep that breaks is logged and never turns the publish run into a 500', async () => {
        routes.push([CREATORS, () => new Error('db is down')]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        assert.equal(logs.filter((l) => l.event === 'cron.auto_archive_failed').length, 1);
    });
});
