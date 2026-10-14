/**
 * Meta's Deauthorize Callback, over real HTTP (P33): `POST /api/meta/deauthorize`.
 *
 * Meta POSTs a form with `signed_request` and no session, so the signature is the only credential, and these tests run the real router
 * in a real Express app on an ephemeral port (a form body, a status code and a response body are what a hand-built fake `req` gets subtly
 * wrong), with a database and a Graph that exist only in memory (metaLoginHarness.ts): nothing here can reach Postgres or Meta. The app is
 * mounted the way src/index.ts mounts it, with the JSON parser ahead of the router: the route must read a FORM body itself.
 *
 * What is pinned, in order: a valid request disconnects exactly the tenants that person connected; a bad signature, a garbled request, a
 * stale one and an unknown person each change nothing and answer with the status that tells Meta whether to retry; the owner's pasted-token
 * connection is safe from every id but his own, exactly; and no secret, signature or id is in a response, a log line or an audit row.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { APP_SETTING_KEYS } from '../services/appSettings.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { DEAUTHORIZE_PATH, META_DEAUTHORIZE_ACTOR_EMAIL } from '../services/metaDeauth.js';
import { FakeDb, FakeGraph } from '../services/metaLoginHarness.js';
import { setLogSink } from '../utils/log.js';
import { metaPublicRouter, metaRouter } from './meta.js';

const SECRET = 'the-app-secret-0123456789-never-in-a-log';
const INSTAGRAM_SECRET = 'the-instagram-app-secret-9876543210-never-in-a-log';
const PERSON = '9000100020003000';
const OTHER_PERSON = '9000100020009999';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OWNER = '99999999-9999-4999-8999-999999999999';
const OWNER_TOKEN_PLAIN = 'OWNER-PAGE-TOKEN-never-touched-0123456789abcdef';
const TENANT_TOKEN_PLAIN = 'EAATenantPageToken0123456789abcdefghijklmnopqrstuvwxyz1';
const BASE = 'https://autoreply.example';

let server: Server;
let origin: string;
let db: FakeDb;
let graph: FakeGraph;
let logs: string[];
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/meta', metaPublicRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'INSTAGRAM_APP_SECRET', 'PUBLIC_BASE_URL']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ef'.repeat(32);
    process.env.META_APP_ID = '111222333444555';
    process.env.META_APP_SECRET = SECRET;
    delete process.env.INSTAGRAM_APP_SECRET;
    delete process.env.PUBLIC_BASE_URL;
    db = new FakeDb().install();
    graph = new FakeGraph().install();
    db.settings.set(APP_SETTING_KEYS.publicBaseUrl, BASE);
    db.addCreator(TENANT, {
        name: 'New Tenant', instagram_page_id: '17841400000000001', facebook_page_id: '200000000000001',
        page_access_token: encryptSecret(TENANT_TOKEN_PLAIN), token_status: 'valid', meta_user_id: PERSON,
        meta_page_name: 'Page 1', meta_connected_at: new Date(), meta_webhook_subscribed_at: new Date(),
    });
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink?.();
    graph.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

// ─── Helpers ────────────────────────────────────────────────────────────────────────────

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function signedRequest(payload: Record<string, unknown>, secret = SECRET): string {
    const encoded = b64(JSON.stringify(payload));
    return `${b64(crypto.createHmac('sha256', secret).update(encoded).digest())}.${encoded}`;
}

const payload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    algorithm: 'HMAC-SHA256', issued_at: Math.floor(Date.now() / 1000), user: { country: 'sa', locale: 'ar_AR' }, user_id: PERSON, ...over,
});

/** What Meta sends: a form POST of one field. */
async function deauthorize(signed: string | null, over: { json?: boolean; contentType?: string; body?: string } = {}) {
    const body = over.body ?? (over.json ? JSON.stringify({ signed_request: signed }) : signed === null ? '' : new URLSearchParams({ signed_request: signed }).toString());
    const res = await fetch(`${origin}/api/meta/deauthorize`, {
        method: 'POST',
        headers: { 'content-type': over.contentType ?? (over.json ? 'application/json' : 'application/x-www-form-urlencoded') },
        body,
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

function legacyOwner(): void {
    db.addCreator(OWNER, {
        name: 'owner', instagram_page_id: '17841499999999991', facebook_page_id: '100000000000001',
        page_access_token: encryptSecret(OWNER_TOKEN_PLAIN), token_status: 'valid',
    });
}

const tenantIsConnected = (id = TENANT): boolean => db.creators.get(id)!.page_access_token !== null;

/** Everything a secret could hide in after a request. */
const everywhere = (extra: string[] = []): string => [logs.join('\n'), db.audit.map((a) => JSON.stringify(a)).join('\n'), ...extra].join('\n');

// ─── A valid request ────────────────────────────────────────────────────────────────────

describe('POST /api/meta/deauthorize: a valid request', () => {
    it('answers 200 and disconnects the tenant the person connected: the token deleted, the webhook unsubscribed, the ids cleared', async () => {
        graph.subscribed.set('200000000000001', ['feed']);
        const r = await deauthorize(signedRequest(payload()));
        assert.equal(r.status, 200);
        assert.deepEqual(r.json, { received: true });
        assert.equal(tenantIsConnected(), false);
        const row = db.creators.get(TENANT)!;
        assert.equal(row.facebook_page_id, null);
        assert.equal(row.instagram_page_id, null);
        assert.equal(row.meta_user_id, null);
        assert.equal(graph.called(/DELETE \/200000000000001\/subscribed_apps/).length, 1);
        assert.equal(graph.subscribed.has('200000000000001'), false);
    });

    it('audits it: meta.deauthorize, by the system actor, naming the Pages and not the person', async () => {
        await deauthorize(signedRequest(payload()));
        const rows = db.audit.filter((a) => a.action === AUDIT_ACTIONS.metaDeauthorize);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.target_id, TENANT);
        assert.equal(rows[0]!.actor_email, META_DEAUTHORIZE_ACTOR_EMAIL);
        assert.equal(JSON.parse(rows[0]!.detail).facebook_page_id, '200000000000001');
        assert.ok(!JSON.stringify(db.audit).includes(PERSON));
    });

    it('works with the login switch off and no configuration id: a person can remove the app whatever is switched on here', async () => {
        db.settings.delete(APP_SETTING_KEYS.metaLoginEnabled);
        assert.equal((await deauthorize(signedRequest(payload()))).status, 200);
        assert.equal(tenantIsConnected(), false);
    });

    it('verifies against the Instagram app\'s secret too, like the webhook', async () => {
        process.env.INSTAGRAM_APP_SECRET = INSTAGRAM_SECRET;
        assert.equal((await deauthorize(signedRequest(payload(), INSTAGRAM_SECRET))).status, 200);
        assert.equal(tenantIsConnected(), false);
    });

    it('reads the field from a JSON body as well as a form, in case a delivery is sent that way', async () => {
        assert.equal((await deauthorize(signedRequest(payload()), { json: true })).status, 200);
        assert.equal(tenantIsConnected(), false);
    });

    it('is idempotent: Meta delivering it twice is two 200s and one disconnection', async () => {
        const signed = signedRequest(payload());
        assert.equal((await deauthorize(signed)).status, 200);
        const calls = graph.calls.length;
        const audits = db.audit.length;
        assert.equal((await deauthorize(signed)).status, 200);
        assert.equal(graph.calls.length, calls, 'nothing more asked of Meta');
        assert.equal(db.audit.length, audits, 'nothing more recorded');
    });

    it('says nothing about what it found: not a count, not a Page, not a tenant', async () => {
        const r = await deauthorize(signedRequest(payload()));
        assert.deepEqual(Object.keys(r.json), ['received']);
        assert.ok(!r.text.includes(TENANT) && !r.text.includes('Page 1') && !r.text.includes('200000000000001'));
    });
});

// ─── Requests that are refused ──────────────────────────────────────────────────────────

describe('POST /api/meta/deauthorize: a request that is refused changes nothing', () => {
    const untouched = (): void => {
        assert.equal(tenantIsConnected(), true, 'the tenant is still connected');
        assert.equal(db.creators.get(TENANT)!.meta_user_id, PERSON);
        assert.equal(graph.calls.length, 0, 'nothing asked of Meta');
        assert.equal(db.audit.length, 0, 'nothing recorded as done');
        assert.equal(db.statements.some((s) => /^UPDATE creators/.test(s.sql)), false);
    };

    it('403 for a signature made with a secret that is not ours', async () => {
        const r = await deauthorize(signedRequest(payload(), 'an-attackers-own-secret'));
        assert.equal(r.status, 403);
        assert.deepEqual(r.json, { error: 'Invalid signed request.' });
        untouched();
    });

    it('403 for a real signature on a payload that was changed to name somebody else', async () => {
        const [signature] = signedRequest(payload({ user_id: OTHER_PERSON })).split('.') as [string];
        const forged = `${signature}.${b64(JSON.stringify(payload({ user_id: PERSON })))}`;
        assert.equal((await deauthorize(forged)).status, 403);
        untouched();
    });

    it('400 for a body that is not a signed request: no field, an empty one, garbage, a truncated one, the wrong content type', async () => {
        const good = signedRequest(payload());
        for (const attempt of [
            () => deauthorize(null),
            () => deauthorize(''),
            () => deauthorize('garbage'),
            () => deauthorize('not.base64!'),
            () => deauthorize(good.slice(0, good.length - 20)),
            () => deauthorize(`${good}.extra`),
            () => deauthorize(good, { contentType: 'text/plain', body: good }),
            () => deauthorize(null, { json: true }),
            () => deauthorize(null, { body: 'other_field=1' }),
        ]) {
            const r = await attempt();
            assert.ok(r.status === 400 || r.status === 403, `status ${r.status}`);
            assert.notEqual(r.status, 200);
        }
        untouched();
    });

    it('400 for a request that is stale: issued a day and more ago, or from the future', async () => {
        assert.equal((await deauthorize(signedRequest(payload({ issued_at: Math.floor(Date.now() / 1000) - 3 * 86_400 })))).status, 400);
        assert.equal((await deauthorize(signedRequest(payload({ issued_at: Math.floor(Date.now() / 1000) + 7200 })))).status, 400);
        assert.equal((await deauthorize(signedRequest(payload({ expires: Math.floor(Date.now() / 1000) - 10 })))).status, 400);
        untouched();
    });

    it('400 for a signed request that names nobody usable', async () => {
        for (const user_id of ['', null, 9000100020003000, { id: PERSON }]) {
            assert.equal((await deauthorize(signedRequest(payload({ user_id })))).status, 400, JSON.stringify(user_id));
        }
        untouched();
    });

    it('503, not trust, when no app secret is configured to check with', async () => {
        delete process.env.META_APP_SECRET;
        delete process.env.INSTAGRAM_APP_SECRET;
        const r = await deauthorize(signedRequest(payload()));
        assert.equal(r.status, 503);
        untouched();
    });

    it('logs the reason and how many secrets were tried, so a wrong secret is not mistaken for no deliveries; and nothing the request held', async () => {
        process.env.INSTAGRAM_APP_SECRET = INSTAGRAM_SECRET;
        const signed = signedRequest(payload(), 'an-attackers-own-secret');
        await deauthorize(signed);
        const line = logs.find((l) => l.includes('meta.deauthorize_rejected'));
        assert.ok(line, 'a rejection is logged');
        assert.match(line!, /bad_signature/);
        assert.match(line!, /"app_keys_tried":2/);
        const [signature, encoded] = signed.split('.') as [string, string];
        for (const secret of [signature, encoded, SECRET, INSTAGRAM_SECRET, PERSON]) assert.ok(!everywhere().includes(secret), secret.slice(0, 12));
    });
});

// ─── Whose tenant ───────────────────────────────────────────────────────────────────────

describe('POST /api/meta/deauthorize: only the tenant of the person who removed the app', () => {
    it('200 and nothing done for a person no tenant was connected by', async () => {
        const before = db.snapshotCreators();
        const r = await deauthorize(signedRequest(payload({ user_id: '1234567890' })));
        assert.equal(r.status, 200, 'a request there is nothing to do for is not a failure, and Meta is not asked to retry it');
        assert.equal(db.snapshotCreators(), before);
        assert.equal(graph.calls.length, 0);
        assert.equal(db.audit.length, 0);
    });

    it('leaves a tenant somebody else connected exactly as it is', async () => {
        db.addCreator(OTHER_TENANT, {
            name: 'Other', instagram_page_id: '17841400000000002', facebook_page_id: '200000000000002',
            page_access_token: encryptSecret('EAAOtherTenantToken0123456789'), meta_user_id: OTHER_PERSON, meta_connected_at: new Date(),
        });
        const before = JSON.stringify(db.creators.get(OTHER_TENANT));
        assert.equal((await deauthorize(signedRequest(payload()))).status, 200);
        assert.equal(tenantIsConnected(), false);
        assert.equal(JSON.stringify(db.creators.get(OTHER_TENANT)), before);
    });

    it('never touches the owner\'s pasted-token connection, whoever the request is about', async () => {
        legacyOwner();
        const before = JSON.stringify(db.creators.get(OWNER));
        for (const user_id of [PERSON, OTHER_PERSON, '100000000000001', '1', '0', 'null']) {
            assert.equal((await deauthorize(signedRequest(payload({ user_id })))).status, 200, user_id);
        }
        assert.equal(JSON.stringify(db.creators.get(OWNER)), before, 'byte for byte, token included');
        assert.equal(decryptSecret(db.creators.get(OWNER)!.page_access_token!), OWNER_TOKEN_PLAIN);
        assert.equal(graph.calls.some((c) => /\/100000000000001\//.test(c.path)), false, 'nothing asked of Meta about his Page');
        assert.equal(db.audit.some((a) => a.target_id === OWNER), false);
    });

    it('disconnects the owner only for the id on HIS row, exactly, and then as any other person', async () => {
        legacyOwner();
        db.creators.get(OWNER)!.meta_user_id = '1000000000000001';
        assert.equal((await deauthorize(signedRequest(payload({ user_id: '1000000000000002' })))).status, 200);
        assert.equal(tenantIsConnected(OWNER), true, 'a neighbouring id is not his');
        assert.equal((await deauthorize(signedRequest(payload({ user_id: '100000000000000' })))).status, 200);
        assert.equal(tenantIsConnected(OWNER), true, 'a prefix of his id is not his');
        assert.equal(tenantIsConnected(TENANT), true, 'and neither request touched the other tenant');

        assert.equal((await deauthorize(signedRequest(payload({ user_id: '1000000000000001' })))).status, 200);
        assert.equal(tenantIsConnected(OWNER), false, 'his own id, for his own tenant');
        assert.equal(tenantIsConnected(TENANT), true, 'and still not the other tenant');
        assert.equal(db.audit.filter((a) => a.action === AUDIT_ACTIONS.metaDeauthorize).length, 1);
    });

    it('answers 500 when a tenant could not be cleared, so Meta retries, and the retry then succeeds', async () => {
        db.failOn = /^SELECT facebook_page_id, instagram_page_id, \(page_access_token IS NOT NULL\) AS connected FROM creators WHERE id = \$1$/;
        const signed = signedRequest(payload());
        assert.equal((await deauthorize(signed)).status, 500);
        assert.equal(tenantIsConnected(), true);
        db.failOn = null;
        assert.equal((await deauthorize(signed)).status, 200);
        assert.equal(tenantIsConnected(), false);
    });
});

// ─── Where it is mounted ────────────────────────────────────────────────────────────────

describe('where the Deauthorize Callback lives', () => {
    const routesOf = (router: unknown): string[] =>
        (router as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack
            .filter((l) => l.route)
            .map((l) => `${Object.keys(l.route!.methods).join(',').toUpperCase()} ${l.route!.path}`);

    it('is a POST on the public router, which api.ts mounts above requireAuth (meta.test.ts pins that mount), and on no session router', () => {
        assert.ok(routesOf(metaPublicRouter).includes('POST /deauthorize'));
        assert.ok(!routesOf(metaRouter).some((r) => r.includes('deauthorize')));
        assert.equal(DEAUTHORIZE_PATH, '/api/meta/deauthorize');
    });
});
