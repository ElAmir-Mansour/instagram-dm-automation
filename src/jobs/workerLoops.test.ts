/**
 * The Heroku worker's two loops (P24): the queue drain it always ran, and the profile-draft sweep beside it. The real `heroku-worker/worker.mjs` is
 * run in a child process against a stand-in server on the loopback address, so what is tested is what Heroku would run: which address each loop
 * calls, with what method and secret, and that neither waits for the other.
 *
 * Why independent matters: a draft takes minutes, and the sweep's response is held open that long. A worker that called the sweep inside the drain's
 * loop would let a model's latency hold the comment-reply queue back (03 §4: "It never runs inside /api/jobs/drain").
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('../../heroku-worker/worker.mjs', import.meta.url));
const SECRET = 'worker-test-secret';

interface Hit { method: string; path: string; authorization: string | undefined; at: number }

type Behaviour = 'ok' | 'quiet' | 'hang' | 'fail' | 'missing';

interface Harness {
    hits: Hit[];
    stdout: string[];
    child: ChildProcess;
    stop(): Promise<void>;
}

const running: Harness[] = [];
afterEach(async () => {
    while (running.length) await running.pop()!.stop();
});

/**
 * A stand-in for the app and the worker running against it. `drain` and `sweep` say what each endpoint does: answer, never answer, answer 500,
 * or answer 404 (a deployment that does not have the route yet).
 */
async function start(behaviour: { drain?: Behaviour; sweep?: Behaviour }, env: Record<string, string> = {}): Promise<Harness> {
    const hits: Hit[] = [];
    const sockets = new Set<import('node:net').Socket>();
    const server = http.createServer((req, res) => {
        const path = req.url ?? '';
        hits.push({ method: req.method ?? '', path, authorization: req.headers.authorization, at: Date.now() });
        const mode = path.startsWith('/api/jobs/drain') ? behaviour.drain ?? 'ok' : path.startsWith('/api/onboarding/drafts/sweep') ? behaviour.sweep ?? 'ok' : 'missing';
        if (mode === 'hang') return;
        if (mode === 'fail') { res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"boom"}'); return; }
        if (mode === 'missing') { res.writeHead(404).end('not found'); return; }
        const body = path.startsWith('/api/jobs/drain') ? { processed: 0, publish: null }
            : mode === 'quiet' ? { considered: 0, advanced: 0, skipped: 0, finished: 0, outcomes: {}, elapsed_ms: 1 }
                : { considered: 2, advanced: 1, skipped: 0, finished: 1, outcomes: { worked: 1 }, elapsed_ms: 5 };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    const stdout: string[] = [];
    const child = spawn(process.execPath, [WORKER], {
        env: { ...process.env, DRAIN_BASE_URL: `http://127.0.0.1:${port}`, CRON_SECRET: SECRET, POLL_INTERVAL_MS: '30', DRAFT_SWEEP_INTERVAL_MS: '30', REQUEST_TIMEOUT_MS: '60000', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (d: Buffer) => stdout.push(...d.toString().split('\n').filter(Boolean)));
    child.stderr!.on('data', (d: Buffer) => stdout.push(...d.toString().split('\n').filter(Boolean)));

    const harness: Harness = {
        hits, stdout, child,
        async stop() {
            child.kill('SIGTERM');
            await new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
    running.push(harness);
    return harness;
}

async function until(condition: () => boolean, what: string, ms = 8_000): Promise<void> {
    const t0 = Date.now();
    while (!condition()) {
        if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 15));
    }
}

const drains = (h: Harness): Hit[] => h.hits.filter((x) => x.path.startsWith('/api/jobs/drain'));
const sweeps = (h: Harness): Hit[] => h.hits.filter((x) => x.path.startsWith('/api/onboarding/drafts/sweep'));

describe('heroku-worker/worker.mjs: two loops', () => {
    it('drains the queue as it always did (GET /api/jobs/drain with the bearer secret) and ALSO sweeps the drafts (POST /api/onboarding/drafts/sweep, the same secret)', async () => {
        const h = await start({});
        await until(() => drains(h).length >= 2 && sweeps(h).length >= 2, 'both loops to call twice');
        for (const hit of drains(h)) assert.deepEqual([hit.method, hit.authorization], ['GET', `Bearer ${SECRET}`]);
        for (const hit of sweeps(h)) assert.deepEqual([hit.method, hit.authorization], ['POST', `Bearer ${SECRET}`]);
        assert.ok(h.stdout.some((l) => l.includes('worker.started')), 'the existing start-up line is still written');
        assert.ok(h.stdout.some((l) => l.includes('worker.drain_ok')));
        assert.ok(h.stdout.some((l) => l.includes('worker.sweep_ok')), 'a sweep that did something is logged');
    });

    it('a drain that never answers does not hold the sweep back', async () => {
        const h = await start({ drain: 'hang' });
        await until(() => sweeps(h).length >= 4, 'four sweeps while the drain hangs');
        assert.equal(drains(h).length, 1, 'the drain loop is waiting on its one request, as it always did');
    });

    it('a sweep that never answers (a draft being made takes minutes) does not hold the drain back: the queue keeps its pace', async () => {
        const h = await start({ sweep: 'hang' });
        await until(() => drains(h).length >= 4, 'four drains while the sweep hangs');
        assert.equal(sweeps(h).length, 1);
    });

    it('a sweep that fails, or that a deployment does not have yet, is logged and the loop goes on; and the drain is unaffected', async () => {
        const failing = await start({ sweep: 'fail' });
        await until(() => sweeps(failing).length >= 3 && drains(failing).length >= 3, 'three of each');
        assert.ok(failing.stdout.some((l) => l.includes('worker.sweep_bad_status') && l.includes('"status":500')));
        assert.ok(failing.stdout.some((l) => l.includes('worker.drain_ok')));
        assert.equal(failing.child.exitCode, null, 'the worker is still running');

        const missing = await start({ sweep: 'missing' });
        await until(() => sweeps(missing).length >= 3, 'three sweeps against a 404');
        assert.ok(missing.stdout.some((l) => l.includes('worker.sweep_bad_status') && l.includes('"status":404')));
        assert.equal(missing.child.exitCode, null);
    });

    it('a sweep that finds nothing is not logged every minute, so the log stays readable', async () => {
        const h = await start({ sweep: 'quiet' });
        await until(() => sweeps(h).length >= 4, 'four quiet sweeps');
        assert.equal(h.stdout.some((l) => l.includes('worker.sweep_ok')), false);
        assert.equal(h.stdout.some((l) => l.includes('worker.sweep_bad_status') || l.includes('worker.sweep_failed')), false);
    });

    it('the sweep\'s interval is its own setting, and the drain\'s is unchanged', async () => {
        const h = await start({}, { POLL_INTERVAL_MS: '30', DRAFT_SWEEP_INTERVAL_MS: '400' });
        await until(() => drains(h).length >= 8, 'eight drains');
        assert.ok(sweeps(h).length <= 3, `the sweep waits its own 400 ms: ${sweeps(h).length} sweeps against ${drains(h).length} drains`);
    });

    it('refuses to start without the secret, as it always did', async () => {
        const child = spawn(process.execPath, [WORKER], { env: { ...process.env, DRAIN_BASE_URL: 'http://127.0.0.1:9', CRON_SECRET: '' }, stdio: 'ignore' });
        const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
        assert.equal(code, 1);
    });
});
