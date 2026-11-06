/**
 * Settings → Media storage, the Cloudflare R2 half (src/routes/admin.ts): choosing where new uploads go, saving R2's keys (checked live first), the owner's lower
 * limits, the copy request, removing the keys. In-memory database and R2 (r2TestKit.ts); the router is driven directly, as admin.test.ts does.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it, mock } from 'node:test';
import type { Request, Response } from 'express';
import { setLogSink } from '../utils/log.js';
import { R2UsageGuard, setR2Guard, type R2Guard } from '../services/r2Usage.js';
import { ACCOUNT, CREATOR, FakeDb, FakeStores, R2_BUCKET, R2_KEY_ID, R2_SECRET } from '../services/r2TestKit.js';
import adminRouter from './admin.js';

interface Reply { status: number; body: any }
const ADMIN = { userId: null, role: 'platform_admin', tenantId: 't-1', tokenVersion: 0 };
const NOT_ADMIN = { userId: 'u-1', role: 'user', tenantId: 't-1', tokenVersion: 1 };
const ORIGIN = 'https://msg-response-auto.vercel.app';
const NOV = new Date('2026-11-06T10:00:00Z');

function call(method: string, url: string, opts: { session?: unknown; body?: unknown } = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method, url, originalUrl: url, body: opts.body ?? {}, query: {}, params: {}, headers: { host: 'msg-response-auto.vercel.app', 'x-forwarded-proto': 'https' },
            session: opts.session === undefined ? ADMIN : opts.session,
        } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        adminRouter(req, res, () => resolve({ status: 0, body: null }));
    });
}

let db: FakeDb;
let stores: FakeStores;
let restoreDb: () => void;
let restoreFetch: () => void;
let restoreSink: (() => void) | undefined;
let previousGuard: R2Guard | null;

before(() => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

beforeEach(() => {
    db = new FakeDb();
    stores = new FakeStores();
    restoreDb = db.install();
    restoreFetch = stores.install();
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mock.timers.enable({ apis: ['Date'], now: NOV });
    previousGuard = setR2Guard(new R2UsageGuard());
    db.set('app.public_base_url', ORIGIN);
});
afterEach(() => {
    mock.timers.reset();
    setR2Guard(previousGuard);
    restoreFetch();
    restoreDb();
});

const KEYS = { accountId: ACCOUNT, bucket: R2_BUCKET, accessKeyId: R2_KEY_ID, secretAccessKey: R2_SECRET };
const everything = (reply: Reply) => JSON.stringify(reply.body);

describe('who may', () => {
    it('is the platform admin\'s: everyone else gets a 404, on every new route', async () => {
        for (const [method, url] of [
            ['PUT', '/media-storage/backend'], ['PUT', '/media-storage/r2'], ['DELETE', '/media-storage/r2'], ['PUT', '/media-storage/r2-limits'], ['POST', '/media-storage/r2-copy'],
        ] as const) {
            assert.equal((await call(method, url, { session: NOT_ADMIN, body: KEYS })).status, 404, `${method} ${url}`);
        }
        assert.equal((await call('GET', '/media-storage', { session: NOT_ADMIN })).status, 404);
    });
});

describe('PUT /media-storage/r2: saving the keys', () => {
    it('checks Cloudflare first, saves encrypted, audits the fact and never the value, and never returns the secret', async () => {
        const reply = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(reply.status, 200);
        assert.equal(db.settings.get('storage.r2_account_id')!.value, ACCOUNT);
        assert.equal(db.settings.get('storage.r2_bucket')!.value, R2_BUCKET);
        assert.equal(db.settings.get('storage.r2_access_key_id')!.value, R2_KEY_ID);
        const secretRow = db.settings.get('storage.r2_secret_access_key')!;
        assert.equal(secretRow.is_secret, true);
        assert.notEqual(secretRow.value, R2_SECRET, 'encrypted at rest');
        assert.ok(!everything(reply).includes(R2_SECRET), 'the secret is never in the answer');
        assert.equal(reply.body.r2.configured, true);
        assert.equal(reply.body.r2.secretAccessKey.set, true);
        assert.match(reply.body.r2.secretAccessKey.preview, /•/);
        const audit = db.audits.find((a) => a.action === 'settings.media_storage_write')!;
        assert.equal(audit.detail.change, 'r2_saved');
        assert.ok(!JSON.stringify(audit).includes(R2_SECRET));
        assert.ok(stores.r2Calls().length > 0, 'Cloudflare was asked');
    });

    it('refuses a key Cloudflare refuses, and saves nothing', async () => {
        stores.r2Mode = 'signature';
        const reply = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Cloudflare R2 refused/);
        assert.equal(db.settings.has('storage.r2_secret_access_key'), false);
        assert.equal(db.settings.has('storage.r2_account_id'), false);
    });

    it('a missing bucket fails the check with "Create the bucket in Cloudflare first", and nothing is created or saved', async () => {
        stores.r2BucketExists = false;
        const reply = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Create the bucket 'media' in Cloudflare first/);
        assert.deepEqual(stores.r2Calls().map((c) => c.method), ['HEAD'], 'no CreateBucket');
        assert.equal(db.settings.has('storage.r2_account_id'), false);
    });

    it('a token that may not set CORS still saves; the card is told to set the policy by hand, with the policy', async () => {
        stores.corsDenied = true;
        const reply = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(reply.status, 200);
        assert.equal(db.settings.get('storage.r2_secret_access_key')!.is_secret, true, 'saved');
        assert.equal(reply.body.r2.cors.status, 'refused');
        assert.equal(reply.body.r2.cors.origin, ORIGIN);
        assert.deepEqual(JSON.parse(reply.body.r2.cors.policy), [{
            AllowedOrigins: [ORIGIN], AllowedMethods: ['GET', 'PUT', 'HEAD'], AllowedHeaders: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600,
        }]);
        assert.equal(db.audits.find((a) => a.action === 'settings.media_storage_write')!.detail.cors, 'refused');
    });

    it('sets the CORS rule for the app\'s origin when the token may', async () => {
        const reply = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(reply.body.r2.cors.status, 'set');
        assert.match(stores.cors!, new RegExp(`<AllowedOrigin>${ORIGIN}</AllowedOrigin>`));
    });

    it('a blank key keeps the saved one, so the bucket can be changed without pasting the secret again', async () => {
        await call('PUT', '/media-storage/r2', { body: KEYS });
        const before = db.settings.get('storage.r2_secret_access_key')!.value;
        const reply = await call('PUT', '/media-storage/r2', { body: { accountId: ACCOUNT, bucket: R2_BUCKET } });
        assert.equal(reply.status, 200);
        assert.equal(db.settings.get('storage.r2_secret_access_key')!.value, before);
    });

    it('refuses an incomplete or malformed config before asking Cloudflare anything', async () => {
        for (const [body, field] of [
            [{ ...KEYS, accountId: 'nope' }, 'accountId'], [{ ...KEYS, bucket: 'Bad Bucket!' }, 'bucket'],
            [{ ...KEYS, accessKeyId: 'x' }, 'accessKeyId'], [{ ...KEYS, secretAccessKey: '' }, 'secretAccessKey'],
        ] as const) {
            const reply = await call('PUT', '/media-storage/r2', { body });
            assert.equal(reply.status, 400, field);
            assert.equal(reply.body.field, field);
        }
        assert.equal(stores.seen.length, 0);
        assert.equal(db.settings.size === 1, true, 'only the public base URL is there');
    });

    it('answers 409 when saving would itself pass a free-tier limit, and 502 when Cloudflare is unreachable', async () => {
        db.setCounters('2026-11', 0, 9_000_000);
        const limited = await call('PUT', '/media-storage/r2', { body: KEYS });
        assert.equal(limited.status, 409);
        assert.match(limited.body.error, /used up/);
        db.setCounters('2026-11', 0, 0);
        stores.r2Mode = 'down';
        assert.equal((await call('PUT', '/media-storage/r2', { body: KEYS })).status, 502);
    });
});

describe('PUT /media-storage/backend: where new uploads go', () => {
    it('refuses R2 without a complete R2 config, and Supabase without its own', async () => {
        const r2 = await call('PUT', '/media-storage/backend', { body: { backend: 'r2' } });
        assert.equal(r2.status, 400);
        assert.match(r2.body.error, /Cloudflare R2 is not set up/);
        const supa = await call('PUT', '/media-storage/backend', { body: { backend: 'supabase' } });
        assert.equal(supa.status, 400);
        assert.equal((await call('PUT', '/media-storage/backend', { body: { backend: 'ftp' } })).status, 400);
        assert.equal(db.settings.has('storage.backend'), false);
    });

    it('saves the choice once R2 is set up, audits it, and the card says where uploads go', async () => {
        db.configureR2();
        const reply = await call('PUT', '/media-storage/backend', { body: { backend: 'r2' } });
        assert.equal(reply.status, 200);
        assert.equal(db.settings.get('storage.backend')!.value, 'r2');
        assert.equal(reply.body.backend, 'r2');
        assert.equal(reply.body.choice, 'r2');
        assert.equal(db.audits.find((a) => a.detail.change === 'backend')!.detail.backend, 'r2');
        db.configureSupabase();
        const back = await call('PUT', '/media-storage/backend', { body: { backend: 'supabase' } });
        assert.equal(back.body.backend, 'supabase');
    });
});

describe('PUT /media-storage/r2-limits', () => {
    it('saves limits at or below Cloudflare\'s free tier', async () => {
        const reply = await call('PUT', '/media-storage/r2-limits', { body: { storage_bytes: 5e9, class_a: 500_000, class_b: 5_000_000 } });
        assert.equal(reply.status, 200);
        assert.deepEqual(JSON.parse(db.settings.get('storage.r2_limits')!.value), { storage_bytes: 5e9, class_a: 500_000, class_b: 5_000_000 });
        assert.equal((await call('PUT', '/media-storage/r2-limits', { body: { storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 } })).status, 200);
    });

    it('refuses a value above a ceiling, whichever it is, and keeps what was saved', async () => {
        await call('PUT', '/media-storage/r2-limits', { body: { storage_bytes: 5e9, class_a: 500_000, class_b: 5_000_000 } });
        for (const [field, value] of [['storage_bytes', 10_000_000_001], ['class_a', 1_000_001], ['class_b', 10_000_001]] as const) {
            const reply = await call('PUT', '/media-storage/r2-limits', { body: { storage_bytes: 5e9, class_a: 500_000, class_b: 5_000_000, [field]: value } });
            assert.equal(reply.status, 400, field);
            assert.equal(reply.body.field, field);
            assert.match(reply.body.error, /cannot be above Cloudflare's free tier/);
        }
        assert.equal(JSON.parse(db.settings.get('storage.r2_limits')!.value).class_a, 500_000);
    });
});

describe('POST /media-storage/r2-copy and DELETE /media-storage/r2', () => {
    it('the copy needs both stores, then records the request for the drain', async () => {
        assert.equal((await call('POST', '/media-storage/r2-copy')).status, 400);
        db.configureSupabase();
        db.configureR2();
        const reply = await call('POST', '/media-storage/r2-copy');
        assert.equal(reply.status, 202);
        assert.ok(JSON.parse(db.settings.get('storage.r2_copy')!.value).requested_at);
        assert.equal(reply.body.r2.copy.active, true);
    });

    it('removing the keys is refused while files are in R2, and otherwise forgets them and a choice of R2', async () => {
        db.configureR2();
        db.set('storage.backend', 'r2');
        db.addMedia({ id: '00000000-0000-4000-8000-000000000001', storage_path: `r2:${CREATOR}/x.mp4`, size_bytes: '10' });
        const refused = await call('DELETE', '/media-storage/r2');
        assert.equal(refused.status, 409);
        assert.match(refused.body.error, /1 file\(s\) are in Cloudflare R2/);
        assert.equal(db.settings.has('storage.r2_secret_access_key'), true);

        db.media.clear();
        const ok = await call('DELETE', '/media-storage/r2');
        assert.equal(ok.status, 200);
        for (const key of ['storage.r2_account_id', 'storage.r2_secret_access_key', 'storage.r2_access_key_id', 'storage.backend']) assert.equal(db.settings.has(key), false, key);
    });
});

describe('GET /media-storage', () => {
    it('shows this month\'s use against each limit and the reset date, and never a key', async () => {
        db.configureSupabase();
        db.configureR2();
        db.setCounters('2026-11', 12, 345);
        db.addMedia({ id: '00000000-0000-4000-8000-000000000001', storage_path: `r2:${CREATOR}/x.mp4`, size_bytes: '1000' });
        const reply = await call('GET', '/media-storage');
        assert.equal(reply.status, 200);
        const { summary } = reply.body.r2;
        assert.deepEqual(summary.items.map((i: any) => [i.kind, i.used, i.limit]), [['storage', 1000, 9 * 1024 ** 3], ['class_a', 12, 900_000], ['class_b', 345, 9_000_000]]);
        assert.equal(summary.resetsAt, '2026-12-01T00:00:00.000Z');
        assert.equal(summary.level, 'ok');
        assert.deepEqual(summary.ceilings, { storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 });
        assert.equal(reply.body.usage.r2.files, 1);
        assert.ok(!everything(reply).includes(R2_SECRET));
        assert.ok(!everything(reply).includes('sb_secret_0123456789'));
        assert.equal(reply.body.r2.connection.ok, true);
    });

    it('is quiet about R2 until it is set up', async () => {
        const reply = await call('GET', '/media-storage');
        assert.equal(reply.body.r2.configured, false);
        assert.equal(reply.body.r2.summary, null);
        assert.equal(reply.body.r2.connection, null);
        assert.equal(stores.seen.length, 0);
    });
});
