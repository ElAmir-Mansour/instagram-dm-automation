/**
 * The daily cron's look at the explainers that are writing (src/services/explainers/writing.ts `sweepWriting`): the backstop for the lazy check on
 * GET /explainers/:id, for a dashboard nobody opens.
 *
 * What is pinned here is the cron's side of it: that the sweep runs, and that nothing it does can turn a publish sweep that already ran into a 500. The
 * takeover itself is tested in writing.test.ts. The handler is pulled off the router's own stack and run against a stubbed pool, like growth.test.ts.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Rows = { rows: any[]; rowCount?: number };
let statements: string[] = [];
let routes: [RegExp, (params: any[]) => Rows][] = [];
let logs: { level: string; event: string; fields: any }[] = [];
const original = { query: pool.query, connect: pool.connect };
const previousSecret = process.env.CRON_SECRET;

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
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;
});

beforeEach(() => {
    statements = [];
    routes = [];
    logs = [];
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        statements.push(flat);
        const route = routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as any).query = run;
    (pool as any).connect = async () => ({ query: run, release() {} });
});

afterEach(() => {
    (pool as any).query = original.query;
    (pool as any).connect = original.connect;
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

const WRITING_SWEEP = /^SELECT id, creator_id FROM explainers WHERE status = 'writing' OR \(status = 'failed' AND failed_step = 'write'\) ORDER BY updated_at LIMIT \$1$/;

describe('GET /cron/publish — the explainers that are writing', () => {
    it('looks at every explainer that is writing or failed at the write, once, after the publish sweep', async () => {
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const looks = statements.filter((s) => WRITING_SWEEP.test(s));
        assert.equal(looks.length, 1, 'once a day, not once per tenant');
        // The publish sweep's own read: the one SELECT that joins the posts to the tenant that owns them.
        const publish = statements.findIndex((s) => /^SELECT s\.\*, c\.page_access_token, c\.instagram_page_id, c\.facebook_page_id, c\.is_active FROM scheduled_posts s/.test(s));
        assert.ok(publish >= 0, 'the publish sweep ran');
        assert.ok(statements.findIndex((s) => WRITING_SWEEP.test(s)) > publish, 'a look at the explainers never stands in front of a publish');
    });

    it('says what it did only when it started a takeover', async () => {
        await cron();
        assert.equal(logs.filter((l) => l.event === 'cron.explainers_writing').length, 0, 'a quiet day is not a log line');
    });

    it('never fails the cron: a sweep that breaks is a log line, and the cron still answers 200', async () => {
        routes.push([WRITING_SWEEP, () => { throw new Error('pool exhausted'); }]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        const failed = logs.filter((l) => l.event === 'cron.explainers_writing_failed');
        assert.equal(failed.length, 1);
        assert.equal(failed[0]!.level, 'error');
    });

    it('a database behind v59 has no explainers to look at, and that is not an error', async () => {
        routes.push([WRITING_SWEEP, () => { throw Object.assign(new Error('relation "explainers" does not exist'), { code: '42P01' }); }]);
        const res = await cron();
        assert.equal(res.statusCode, 200);
        assert.equal(logs.filter((l) => l.event === 'cron.explainers_writing_failed').length, 0);
    });

    it('a failure of another table is still an error: only the missing explainers table is read as nothing to do', async () => {
        routes.push([WRITING_SWEEP, () => { throw Object.assign(new Error('relation "studio_jobs" does not exist'), { code: '42P01' }); }]);
        await cron();
        assert.equal(logs.filter((l) => l.event === 'cron.explainers_writing_failed').length, 1);
    });
});
