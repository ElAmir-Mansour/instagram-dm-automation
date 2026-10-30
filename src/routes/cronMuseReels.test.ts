/**
 * The daily cron's call for the video memory (`queueNewReelsForMemoryTenants`, called from GET /api/cron/publish, docs/specs/005-muse-sees T054): for every tenant with the
 * `memory` switch on, queue the reels that have no analysis yet.
 *
 * What is pinned is the cron's side of it: that the call is made once, that a tenant with the switch off (every tenant's default) costs a settings read and no Instagram call,
 * that a tenant with it on gets its new reels queued as jobs that carry ids only, and that nothing the call does can turn a publish sweep that already ran into a 500 or stop
 * the sweeps after it. The queueing itself is tested in perception/reelLibrary.test.ts. The handler is pulled off the router's own stack and run against a stubbed pool,
 * like cronExplainers.test.ts.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Rows = { rows: any[]; rowCount?: number };
const TENANT = '44444444-4444-4444-8444-444444444444';
const TENANTS = /^SELECT id FROM creators WHERE is_active = TRUE AND page_access_token IS NOT NULL ORDER BY created_at$/;
const SWITCHES = /^SELECT value, is_secret FROM app_settings WHERE key = \$1$/;

let statements: { sql: string; params: any[] }[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let logs: { level: string; event: string; fields: any }[] = [];
let graphCalls: string[] = [];
const original = { query: pool.query, connect: pool.connect, get: metaHttp.get };
const saved = { cron: process.env.CRON_SECRET, baseten: process.env.BASETEN_API_KEY };

let restoreSink: (() => void) | undefined;
before(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    const previous = setLogSink((level, line) => {
        try {
            const parsed = JSON.parse(line);
            logs.push({ level, event: parsed.event, fields: parsed });
        } catch {
            // not a structured line
        }
    });
    restoreSink = () => setLogSink(previous);
});
after(() => {
    restoreSink?.();
    for (const [name, value] of [['CRON_SECRET', saved.cron], ['BASETEN_API_KEY', saved.baseten]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
});

beforeEach(() => {
    statements = [];
    routes = [];
    logs = [];
    graphCalls = [];
    // The only key in the world is Baseten's, from the environment: it is the one provider that may answer `reel_index` with no route saved.
    process.env.BASETEN_API_KEY = 'b10_' + 'CronTest1' + '.' + 'x'.repeat(32);
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push({ sql: flat, params });
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
    (metaHttp as any).get = async (url: string) => {
        graphCalls.push(url);
        return { data: { data: [{ id: '9001', media_type: 'VIDEO', media_product_type: 'REELS', permalink: 'https://www.instagram.com/reel/9001/', timestamp: '2026-10-20T12:00:00+0000' }] }, headers: {} };
    };
});

afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
    (metaHttp as any).get = original.get;
});

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: Function }[] }; handle: any }

function cronHandler(): Function {
    const layer = (apiRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === '/cron/publish' && l.route.methods.get);
    assert.ok(layer, 'GET /cron/publish must be mounted');
    return layer!.route!.stack.at(-1)!.handle;
}

async function cron() {
    const res = {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        setHeader() {},
        end() { return this; },
    };
    await cronHandler()({ params: {}, query: {}, headers: { authorization: 'Bearer test-cron-secret' }, body: {} }, res, () => {});
    return res;
}

/** The tenant list answers once, to the video memory (it is asked first), and is empty for every sweep after it. */
const tenantOnce = () => {
    let asked = 0;
    routes.push([TENANTS, () => (asked++ === 0 ? { rows: [{ id: TENANT }] } : { rows: [] })]);
};
const switches = (value: object | null) => routes.push([SWITCHES, (params) => (String(params[0]) === `muse.switches.${TENANT}` && value ? { rows: [{ value: JSON.stringify(value), is_secret: false }] } : { rows: [] })]);

describe('GET /cron/publish: the video memory', () => {
    it('looks at the tenants once for it, after the publish sweep and before the growth sync, and costs a tenant with the switch off one settings read and no Instagram call', async () => {
        tenantOnce();
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const reads = statements.filter((s) => SWITCHES.test(s.sql) && String(s.params[0]) === `muse.switches.${TENANT}`);
        assert.equal(reads.length, 1, 'one read of the tenant\'s switches');
        assert.equal(graphCalls.length, 0, 'the default is off: Instagram was not asked');
        assert.equal(statements.filter((s) => /jobs/.test(s.sql) && /^INSERT/.test(s.sql)).length, 0, 'no job');
        const publish = statements.findIndex((s) => /^SELECT s\.\*, c\.page_access_token, c\.instagram_page_id, c\.facebook_page_id, c\.is_active FROM scheduled_posts s/.test(s.sql));
        const memory = statements.findIndex((s) => SWITCHES.test(s.sql) && String(s.params[0]).startsWith('muse.switches.'));
        assert.ok(publish >= 0 && memory > publish, 'the publish sweep ran first');
        assert.equal(logs.filter((l) => l.event === 'cron.muse_reels').length, 0, 'a quiet day is not a log line');
    });

    it('queues a job for each new reel of a tenant whose memory switch is on: ids only, the day\'s dedupe key, three attempts, and the credential and the link in none of it', async () => {
        tenantOnce();
        switches({ dm_media: false, voice: false, memory: true });
        routes.push([/^SELECT id, instagram_page_id, page_access_token FROM creators WHERE id = \$1$/, () => ({ rows: [{ id: TENANT, instagram_page_id: '17841400000000009', page_access_token: 'PAGE-TOKEN-SENTINEL' }] })]);
        routes.push([/^INSERT INTO reel_analyses .* jsonb_to_recordset/, () => ({ rows: [], rowCount: 1 })]);
        routes.push([/^INSERT INTO jobs /, () => ({ rows: [{ id: 'job-1' }] })]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        assert.deepEqual(graphCalls.map((u) => new URL(u).pathname.split('/').slice(2).join('/')), ['17841400000000009/media']);
        const jobs = statements.filter((s) => /^INSERT INTO jobs /.test(s.sql));
        assert.equal(jobs.length, 1);
        const [kind, payload, creator, dedupe, , maxAttempts] = jobs[0]!.params;
        assert.equal(kind, 'muse.reel_index');
        assert.deepEqual(JSON.parse(String(payload)), { creatorId: TENANT, igMediaId: '9001' });
        assert.equal(creator, TENANT);
        assert.equal(dedupe, `reel:9001:${new Date().toISOString().slice(0, 10)}`);
        assert.equal(maxAttempts, 3);
        assert.ok(!JSON.stringify(jobs[0]!.params).includes('PAGE-TOKEN-SENTINEL'));
        const said = logs.filter((l) => l.event === 'cron.muse_reels');
        assert.equal(said.length, 1);
        assert.deepEqual([said[0]!.fields.tenants, said[0]!.fields.memoryOn, said[0]!.fields.queued], [1, 1, 1]);
    });

    it('never fails the cron and never stops the sweeps after it: a call that breaks is a log line, and the growth sync that follows still runs', async () => {
        let asked = 0;
        routes.push([TENANTS, () => { if (asked++ === 0) throw new Error('pool exhausted'); return { rows: [] }; }]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const failed = logs.filter((l) => l.event === 'cron.muse_reels_failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.level, 'error');
        assert.equal(asked, 2, 'the growth sync, which asks for the same list next, still ran');
        assert.equal(logs.filter((l) => l.event === 'cron.publish_error').length, 0);
    });

    it('does not fail the cron for one tenant whose Instagram does not answer: it is counted, and the log says so', async () => {
        tenantOnce();
        switches({ memory: true });
        routes.push([/^SELECT id, instagram_page_id, page_access_token FROM creators WHERE id = \$1$/, () => ({ rows: [{ id: TENANT, instagram_page_id: '17841400000000009', page_access_token: 'PAGE-TOKEN-SENTINEL' }] })]);
        (metaHttp as any).get = async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); };
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const said = logs.find((l) => l.event === 'cron.muse_reels');
        assert.deepEqual([said?.fields.memoryOn, said?.fields.queued, said?.fields.skipped], [1, 0, 1]);
    });
});
