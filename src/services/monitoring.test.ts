/**
 * The external-monitor surface: the `/health` body and its 503 rule, the drain heartbeat's throttle, the dead-man ping, and the setting's routes.
 * `pool.query` is stubbed, and the clock is pinned with `mock.timers` wherever a duration decides the answer.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { pool } from '../config/db.js';
import apiRouter from '../routes/api.js';
import { setLogSink } from '../utils/log.js';
import {
    composeHealth, DRAIN_STALE_AFTER_S, healthResponse, isQueueStuck, isValidPingUrl, pingDeadMan, QUEUE_STUCK_AFTER_S, recordDrainHeartbeat,
    resetHeartbeatThrottle,
} from './monitoring.js';

const NOW = Date.parse('2026-11-27T10:00:00.000Z');
const PING_URL = 'https://hc-ping.com/0a1b2c3d-4e5f-6789-abcd-0123456789ab';

let originalQuery: typeof pool.query;
let sql: Array<{ text: string; params: unknown[] }>;
let answers: { main: Record<string, unknown> | 'throw'; hooks: Record<string, unknown> | 'throw'; claim: number; setting: { value: string; is_secret: boolean } | null };
let lines: string[];
let restoreSink: () => void;

beforeEach(() => {
    mock.timers.enable({ apis: ['Date'], now: NOW });
    resetHeartbeatThrottle();
    sql = [];
    lines = [];
    const previous = setLogSink((_l, line) => { lines.push(line); });
    restoreSink = () => setLogSink(previous);
    answers = { main: { oldest_pending_s: null, drain_last_s: '30.4' }, hooks: { instagram: true, facebook: false, whatsapp: false }, claim: 1, setting: null };
    originalQuery = pool.query;
    (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
        sql.push({ text, params });
        if (text.includes('oldest_pending_s')) {
            if (answers.main === 'throw') throw new Error('connection refused');
            return { rows: [answers.main], rowCount: 1 };
        }
        if (text.includes('WITH recent')) {
            if (answers.hooks === 'throw') throw new Error('relation does not exist');
            return { rows: [answers.hooks], rowCount: 1 };
        }
        if (text.startsWith('SELECT value, is_secret')) return { rows: answers.setting ? [answers.setting] : [], rowCount: answers.setting ? 1 : 0 };
        return { rows: [], rowCount: answers.claim };
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink();
    mock.timers.reset();
});

describe('GET /health body', () => {
    it('has exactly the documented shape and nothing that identifies a business', async () => {
        const { status, body } = await healthResponse();
        assert.equal(status, 200);
        assert.deepEqual(Object.keys(body).sort(), [
            'database', 'db', 'drain_last_s', 'ok', 'queue_oldest_pending_s', 'serverTime', 'status', 'webhook_fresh',
        ]);
        assert.equal(body.ok, true);
        assert.equal(body.db, true);
        assert.equal(body.queue_oldest_pending_s, null);
        assert.equal(body.drain_last_s, 30);
        assert.deepEqual(body.webhook_fresh, { instagram: true, facebook: false, whatsapp: false });
        assert.equal(body.serverTime, '2026-11-27T10:00:00.000Z');
        // Only ages, booleans and the database's answer: no id, name or count can be in it.
        assert.doesNotMatch(JSON.stringify(body), /[0-9a-f]{8}-[0-9a-f]{4}|@|creator|tenant/i);
    });

    it('stays cheap: two statements', async () => {
        await healthResponse();
        assert.equal(sql.length, 2);
    });

    it('answers 503 and db:false when the database does not answer', async () => {
        answers.main = 'throw';
        const { status, body } = await healthResponse();
        assert.equal(status, 503);
        assert.equal(body.ok, false);
        assert.equal(body.db, false);
        assert.equal(body.webhook_fresh, null);
    });

    it('survives an unreadable webhook query: booleans become null and the status is untouched', async () => {
        answers.hooks = 'throw';
        const { status, body } = await healthResponse();
        assert.equal(status, 200);
        assert.equal(body.webhook_fresh, null);
    });
});

describe('the 503 rule: oldest due job > 10 min AND the drain is stale', () => {
    it('is stuck only when both hold', () => {
        const old = QUEUE_STUCK_AFTER_S + 1;
        const stale = DRAIN_STALE_AFTER_S + 1;
        assert.equal(isQueueStuck(old, stale), true);
        assert.equal(isQueueStuck(old, null), true, 'a drain never seen is stale');
        assert.equal(isQueueStuck(old, 20), false, 'an old job with a live drain is slow work, not a dead worker');
        assert.equal(isQueueStuck(QUEUE_STUCK_AFTER_S, stale), false, 'exactly 10 minutes is not yet stuck');
        assert.equal(isQueueStuck(5, stale), false, 'a quiet queue with an idle worker is healthy');
        assert.equal(isQueueStuck(null, null), false, 'nothing pending is never stuck');
    });

    it('turns the response into a 503 through healthResponse, with the clock pinned', async () => {
        answers.main = { oldest_pending_s: '901', drain_last_s: '1200' };
        const stuck = await healthResponse();
        assert.equal(stuck.status, 503);
        assert.equal(stuck.body.ok, false);
        assert.equal(stuck.body.db, true);
        assert.equal(stuck.body.queue_oldest_pending_s, 901);
        assert.equal(stuck.body.drain_last_s, 1200);

        answers.main = { oldest_pending_s: '901', drain_last_s: '40' };
        assert.equal((await healthResponse()).status, 200);
    });

    it('never lets the webhook booleans move the status', () => {
        const quiet = composeHealth({ oldestPendingS: null, drainLastS: 10, webhooks: { instagram: false, facebook: false, whatsapp: false } }, new Date(NOW));
        assert.equal(quiet.status, 200);
    });
});

describe('the drain heartbeat', () => {
    it('writes once, then skips inside a minute, then writes again after it', async () => {
        assert.equal(await recordDrainHeartbeat(), true);
        assert.equal(await recordDrainHeartbeat(), false);
        mock.timers.tick(59_000);
        assert.equal(await recordDrainHeartbeat(), false);
        assert.equal(sql.length, 1, 'inside the minute no statement is sent');
        mock.timers.tick(2_000);
        assert.equal(await recordDrainHeartbeat(), true);
        assert.equal(sql.length, 2);
    });

    it('carries the throttle in the statement too, so two instances cannot both write', async () => {
        await recordDrainHeartbeat();
        assert.match(sql[0]!.text, /WHERE app_settings\.updated_at < NOW\(\) - make_interval/);
        assert.equal(sql[0]!.params[0], 'ops.drain_heartbeat');
        assert.equal(sql[0]!.params[2], 60);
    });

    it('reports false when another instance wrote inside the minute', async () => {
        answers.claim = 0;
        assert.equal(await recordDrainHeartbeat(), false);
    });

    it('never throws, and retries at the next drain instead of in a minute', async () => {
        (pool as unknown as { query: unknown }).query = async () => { throw new Error('boom'); };
        assert.equal(await recordDrainHeartbeat(), false);
        (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => { sql.push({ text, params }); return { rows: [], rowCount: 1 }; };
        assert.equal(await recordDrainHeartbeat(), true);
    });
});

describe('the dead-man ping', () => {
    it('is skipped, with no request and no claim, when no URL is set', async () => {
        let calls = 0;
        assert.equal(await pingDeadMan(async () => { calls++; }), 'skipped_no_url');
        assert.equal(calls, 0);
        assert.equal(sql.length, 1, 'one settings read, no write');
    });

    it('pings the saved URL once the 5-minute claim is won', async () => {
        answers.setting = { value: PING_URL, is_secret: false };
        const urls: string[] = [];
        assert.equal(await pingDeadMan(async (u) => { urls.push(u); }), 'pinged');
        assert.deepEqual(urls, [PING_URL]);
        const claim = sql.find((s) => s.text.includes('INSERT INTO app_settings'))!;
        assert.equal(claim.params[0], 'ops.ping_last');
        assert.equal(claim.params[1], 300);
    });

    it('sends nothing when another run pinged within 5 minutes', async () => {
        answers.setting = { value: PING_URL, is_secret: false };
        answers.claim = 0;
        let calls = 0;
        assert.equal(await pingDeadMan(async () => { calls++; }), 'throttled');
        assert.equal(calls, 0);
    });

    it('never throws when the ping fails, and never logs the URL', async () => {
        answers.setting = { value: PING_URL, is_secret: false };
        const outcome = await pingDeadMan(async () => {
            const err: any = new Error(`timeout of 5000ms exceeded for ${PING_URL}`);
            err.code = 'ECONNABORTED';
            err.config = { url: PING_URL };
            throw err;
        });
        assert.equal(outcome, 'failed');
        assert.ok(lines.some((l) => l.includes('health.ping_failed')));
        assert.ok(!lines.join('\n').includes('hc-ping.com'));
    });

    it('never throws when the database read itself fails', async () => {
        (pool as unknown as { query: unknown }).query = async () => { throw new Error('db down'); };
        assert.equal(await pingDeadMan(async () => { throw new Error('unreachable'); }), 'failed');
    });

    it('accepts only a full https URL that is not this machine', () => {
        assert.equal(isValidPingUrl(PING_URL), true);
        assert.equal(isValidPingUrl('http://hc-ping.com/abc'), false);
        assert.equal(isValidPingUrl('https://localhost/x'), false);
        assert.equal(isValidPingUrl('https://169.254.169.254/latest'), false);
        assert.equal(isValidPingUrl('https://user:pw@hc-ping.com/x'), false);
        assert.equal(isValidPingUrl('not a url'), false);
    });
});

describe('POST /api/settings/monitoring', () => {
    type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
    const stackFor = (method: string, path: string): Handle[] => {
        const stack = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }).stack;
        const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
        assert.ok(layer, `${method} ${path} must be mounted`);
        return layer!.route!.stack.map((l) => l.handle);
    };
    async function run(method: 'get' | 'post', session: Record<string, unknown>, body: unknown = {}) {
        const res = { statusCode: 200, body: null as any, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
        const req = { session, body, params: {}, query: {}, headers: {}, tenantRole: session['role'] === 'platform_admin' ? 'owner' : 'operator' };
        for (const handle of stackFor(method, '/settings/monitoring')) {
            let passed = false;
            await handle(req, res, () => { passed = true; });
            if (!passed) break;
        }
        return res;
    }
    let originalKey: string | undefined;
    beforeEach(() => { originalKey = process.env.TOKEN_ENCRYPTION_KEY; process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32); });
    afterEach(() => { if (originalKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = originalKey; });

    it('answers 404 to anyone but a platform admin', async () => {
        assert.equal((await run('get', { userId: 'u', role: 'user' })).statusCode, 404);
        assert.equal((await run('post', { userId: 'u', role: 'user' }, { pingUrl: PING_URL })).statusCode, 404);
    });

    it('refuses an http URL and writes nothing', async () => {
        const res = await run('post', { userId: 'u', role: 'platform_admin' }, { pingUrl: 'http://hc-ping.com/x' });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.field, 'pingUrl');
        assert.equal(sql.filter((s) => s.text.includes('INSERT INTO app_settings')).length, 0);
    });

    it('stores the URL encrypted and answers { set, last4 } only', async () => {
        const res = await run('post', { userId: 'u', role: 'platform_admin' }, { pingUrl: PING_URL });
        assert.equal(res.statusCode, 200);
        const write = sql.find((s) => s.text.includes('INSERT INTO app_settings'))!;
        assert.equal(write.params[0], 'monitoring.ping_url');
        assert.notEqual(write.params[1], PING_URL);
        assert.equal(write.params[2], true);
        assert.ok(!JSON.stringify(res.body).includes('hc-ping'));
        assert.ok(!lines.join('\n').includes('hc-ping'));
    });
});

describe('the wiring', () => {
    const api = readFileSync(new URL('../routes/api.ts', import.meta.url), 'utf8');
    const drain = api.slice(api.indexOf("router.get('/jobs/drain'"), api.indexOf("router.post('/onboarding/drafts/sweep'"));
    it('records the heartbeat first in the drain route and pings only after a 200', () => {
        assert.ok(drain.indexOf('recordDrainHeartbeat') > 0, 'the drain records its heartbeat');
        assert.ok(drain.indexOf('recordDrainHeartbeat') < drain.indexOf('drainWorker()'), 'before any work');
        assert.match(drain, /if \(status === 200\) startDeadManPing\(\);/);
        assert.doesNotMatch(drain, /await pingDeadMan|await startDeadManPing/, 'the ping is never awaited');
    });
    it('keeps the health route free of authentication and of any count', () => {
        const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
        const health = index.slice(index.indexOf("app.get('/health'"), index.indexOf("// ─── Webhook Verification"));
        assert.match(health, /healthResponse\(\)/);
        assert.doesNotMatch(health, /requireAuth|resolveTenant|session/);
    });
});
