/**
 * The TikTok profile scope switch, over real HTTP (P33).
 *
 * `user.info.profile` is requested only when a platform admin has said the TikTok portal approved it (`tiktok.profile_scope_enabled`),
 * because a scope the app does not have fails the WHOLE authorisation. So the thing to prove is not that the scope can be added: it is that
 * with the switch off, which is how every deployment starts, `POST /api/tiktok/connect` hands the browser the very URL it always did.
 * That URL is written out below as a literal, not rebuilt from the code under test.
 *
 * The real router, in a real Express app on an ephemeral port, with a database that exists only in memory (metaLoginHarness.ts).
 */
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { APP_SETTING_KEYS, getTikTokProfileScopeEnabled } from '../services/appSettings.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { FakeDb } from '../services/metaLoginHarness.js';
import { setLogSink } from '../utils/log.js';
import { tiktokRouter } from './tiktok.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const BASE = 'https://autoreply.example';

interface Session { userId?: string | null; role?: string; tenantId?: string; tenantRole?: 'owner' | 'operator' | 'viewer' }
const OWNER_SESSION: Session = { userId: USER, role: 'user', tenantId: TENANT, tenantRole: 'owner' };
const ADMIN_SESSION: Session = { userId: ADMIN, role: 'platform_admin', tenantId: TENANT, tenantRole: 'owner' };

/** What `POST /connect` returned before the profile scope existed, for these settings, with the state left to fill in. */
const authorizeUrlBefore = (state: string, scope: string): string =>
    `https://www.tiktok.com/v2/auth/authorize/?client_key=tt-client-key-123&response_type=code&scope=${scope}&redirect_uri=https%3A%2F%2Fautoreply.example%2Fapi%2Ftiktok%2Fcallback&state=${state}`;

let server: Server;
let origin: string;
let db: FakeDb;
let restoreSink: (() => void) | undefined;

before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const raw = req.get('x-test-session');
        if (raw) {
            const s = JSON.parse(raw) as Session;
            req.session = { userId: s.userId ?? null, role: s.role ?? 'user', tenantId: s.tenantId } as typeof req.session;
            req.tenantRole = s.tenantRole;
        }
        next();
    });
    app.use('/api/tiktok', tiktokRouter);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => resolve()); });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    db = new FakeDb().install();
    db.settings.set(APP_SETTING_KEYS.publicBaseUrl, BASE);
    db.settings.set(APP_SETTING_KEYS.tiktokClientKey, 'tt-client-key-123');
    db.settings.set(APP_SETTING_KEYS.tiktokClientSecret, 'tt-client-secret-1234567890');
    db.addCreator(TENANT, { name: 'Tenant' });
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink?.();
    db.restore();
});

async function api(method: string, path: string, over: { session?: Session | null; body?: unknown } = {}) {
    const session = over.session === undefined ? OWNER_SESSION : over.session;
    const res = await fetch(`${origin}/api/tiktok${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(session ? { 'x-test-session': JSON.stringify(session) } : {}) },
        body: over.body === undefined ? undefined : JSON.stringify(over.body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
}

const connect = async () => {
    const r = await api('POST', '/connect', { body: {} });
    assert.equal(r.status, 200, r.text);
    const url = new URL(r.json.url);
    return { url: r.json.url as string, scope: url.searchParams.get('scope'), state: url.searchParams.get('state')! };
};

describe('POST /api/tiktok/connect: the profile scope switch', () => {
    it('is OFF by default, and then the authorise URL is the one it always was, byte for byte', async () => {
        assert.equal(db.settings.has(APP_SETTING_KEYS.tiktokProfileScopeEnabled), false);
        const { url, scope, state } = await connect();
        assert.equal(scope, 'user.info.basic,video.upload');
        assert.equal(url, authorizeUrlBefore(state, 'user.info.basic%2Cvideo.upload'));
        assert.ok(!url.includes('profile'));
    });

    it('stays the same with Direct Post on, unaudited and audited, while the profile switch is off', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokDirectPostEnabled, 'true');
        let r = await connect();
        assert.equal(r.url, authorizeUrlBefore(r.state, 'user.info.basic%2Cvideo.upload%2Cvideo.publish'));
        db.settings.set(APP_SETTING_KEYS.tiktokAudited, 'true');
        r = await connect();
        assert.equal(r.url, authorizeUrlBefore(r.state, 'user.info.basic%2Cvideo.publish'));
    });

    it('treats anything but the saved value "true" as off', async () => {
        for (const value of ['false', '1', 'on', 'TRUE', 'yes']) {
            db.settings.set(APP_SETTING_KEYS.tiktokProfileScopeEnabled, value);
            assert.equal((await connect()).scope, 'user.info.basic,video.upload', value);
        }
    });

    it('adds user.info.profile, and only that, once the operator has switched it on', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokProfileScopeEnabled, 'true');
        const r = await connect();
        assert.equal(r.scope, 'user.info.basic,user.info.profile,video.upload');
        assert.equal(r.url, authorizeUrlBefore(r.state, 'user.info.basic%2Cuser.info.profile%2Cvideo.upload'));
    });

    it('adds it to the Direct Post scopes too, without touching them', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokProfileScopeEnabled, 'true');
        db.settings.set(APP_SETTING_KEYS.tiktokDirectPostEnabled, 'true');
        assert.equal((await connect()).scope, 'user.info.basic,user.info.profile,video.upload,video.publish');
        db.settings.set(APP_SETTING_KEYS.tiktokAudited, 'true');
        assert.equal((await connect()).scope, 'user.info.basic,user.info.profile,video.publish');
    });

    it('goes back to the old request the moment it is switched off again', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokProfileScopeEnabled, 'true');
        assert.ok((await connect()).scope!.includes('user.info.profile'));
        db.settings.delete(APP_SETTING_KEYS.tiktokProfileScopeEnabled);
        const r = await connect();
        assert.equal(r.url, authorizeUrlBefore(r.state, 'user.info.basic%2Cvideo.upload'));
    });
});

describe('GET and POST /api/tiktok/app-settings: the switch', () => {
    it('is for a platform admin only: a tenant owner gets a 404, for the read and for the write', async () => {
        assert.equal((await api('GET', '/app-settings')).status, 404);
        assert.equal((await api('POST', '/app-settings', { body: { profileScopeEnabled: true } })).status, 404);
        assert.equal(db.settings.has(APP_SETTING_KEYS.tiktokProfileScopeEnabled), false);
    });

    it('reports it off, with the scopes the next Connect will ask for', async () => {
        const r = await api('GET', '/app-settings', { session: ADMIN_SESSION });
        assert.equal(r.status, 200);
        assert.equal(r.json.profileScopeEnabled, false);
        assert.deepEqual(r.json.scopes, ['user.info.basic', 'video.upload']);
    });

    it('saves it on and off, audits each change by field name, and the scopes follow', async () => {
        let r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { profileScopeEnabled: true } });
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.changed, ['profile_scope_enabled']);
        assert.equal(db.settings.get(APP_SETTING_KEYS.tiktokProfileScopeEnabled), 'true');
        r = await api('GET', '/app-settings', { session: ADMIN_SESSION });
        assert.equal(r.json.profileScopeEnabled, true);
        assert.deepEqual(r.json.scopes, ['user.info.basic', 'user.info.profile', 'video.upload']);

        r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { profileScopeEnabled: false } });
        assert.equal(r.status, 200);
        assert.equal(db.settings.has(APP_SETTING_KEYS.tiktokProfileScopeEnabled), false, 'off deletes the row: nothing is left that could read as on');
        assert.deepEqual((await api('GET', '/app-settings', { session: ADMIN_SESSION })).json.scopes, ['user.info.basic', 'video.upload']);

        const rows = db.audit.filter((a) => a.action === AUDIT_ACTIONS.settingsTikTokAppWrite);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((a) => JSON.parse(a.detail).fields), [['profile_scope_enabled'], ['profile_scope_enabled']]);
    });

    it('ignores a value that is not a boolean, and answers "nothing to save" instead of switching anything on', async () => {
        for (const profileScopeEnabled of ['true', 1, null, 'yes', {}]) {
            const r = await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { profileScopeEnabled } });
            assert.equal(r.status, 400, JSON.stringify(profileScopeEnabled));
        }
        assert.equal(db.settings.has(APP_SETTING_KEYS.tiktokProfileScopeEnabled), false);
    });

    it('does not move any other TikTok setting when it is the only field saved', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokDirectPostEnabled, 'true');
        db.settings.set(APP_SETTING_KEYS.tiktokAudited, 'true');
        await api('POST', '/app-settings', { session: ADMIN_SESSION, body: { profileScopeEnabled: true } });
        assert.equal(db.settings.get(APP_SETTING_KEYS.tiktokDirectPostEnabled), 'true');
        assert.equal(db.settings.get(APP_SETTING_KEYS.tiktokAudited), 'true');
        assert.equal(db.settings.get(APP_SETTING_KEYS.tiktokClientKey), 'tt-client-key-123');
    });
});

describe('getTikTokProfileScopeEnabled', () => {
    it('answers off when the settings table cannot be read: the safe answer is the request the portal has always accepted', async () => {
        db.settings.set(APP_SETTING_KEYS.tiktokProfileScopeEnabled, 'true');
        assert.equal(await getTikTokProfileScopeEnabled(), true);
        db.failOn = /FROM app_settings/;
        assert.equal(await getTikTokProfileScopeEnabled(), false);
    });
});
