/**
 * What the operator gives the draft engine, on Settings → Onboarding (P24): the YouTube Data API key and the tenant whose Instagram account
 * reads other people's public profiles. Driven through the real admin router and the pure validator, against the in-memory tables of the
 * invite tests (`services/invites/testDb.ts`) with two routes added for the secret's `is_secret` column and the tenant list.
 *
 * What is pinned, because each is a way a secret leaks or a setting is lost:
 *   - the key is encrypted in the settings table, and the answer carries `{set, source, last4}` and nothing else of it, however the card is read;
 *   - a key of the wrong shape, or a tenant id that is not a tenant, is refused with the field named, and nothing else in the same request is saved;
 *   - sending nothing leaves a saved key alone; sending `null` or "" removes it and the environment's answers again;
 *   - the audit row names the fields that changed and never their values.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { installInviteWorld, uuid, type InviteWorld } from '../services/invites/testDb.js';
import { describeDraftSources, validateOnboardingPatch } from '../services/onboardingSettings.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';

interface Reply { status: number; body: any }

function call(method: string, url: string, body?: unknown, session: Record<string, unknown> | undefined = ADMIN): Promise<Reply> {
    return new Promise((resolve) => {
        const req = { method, url, originalUrl: url, body, query: {}, params: {}, headers: { host: 'app.example.test' }, session, socket: { remoteAddress: '203.0.113.9' } } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        (adminRouter as unknown as (r: Request, s: Response, n: () => void) => void)(req, res, () => resolve({ status: 0, body: { fellThrough: true } }));
    });
}

const ADMIN = { userId: uuid(1), role: 'platform_admin', tenantId: uuid(100), tokenVersion: 1 };
const MEMBER = { userId: uuid(2), role: 'user', tenantId: uuid(100), tokenVersion: 1 };
const KEY = 'AIzaSyD-platform-api-key-0123456789abcdefghij';
const OTHER_KEY = 'AIzaSyB-another-platform-key-9876543210zyxwvut';
const OWNER = uuid(100);
const SECOND = uuid(101);

let world: InviteWorld;
let secrets: Map<string, boolean>;
const saved: Record<string, string | undefined> = {};

before(() => {
    for (const key of ['TOKEN_ENCRYPTION_KEY', 'YOUTUBE_API_KEY']) saved[key] = process.env[key];
    process.env.TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    delete process.env.YOUTUBE_API_KEY;
});
after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

beforeEach(() => {
    world = installInviteWorld();
    // `getPlatformOwnerId` remembers its answer for 30 s: one test's owner must not answer for the next.
    invalidateTenantCache();
    setLogSink(() => {});
    secrets = new Map();
    delete process.env.YOUTUBE_API_KEY;
    world.addCreator(100, 'Owner Shop');
    world.addCreator(101, 'Second Tenant');
    world.addCreator(102, 'Dormant', { is_active: false });
    // `is_secret` is stored and read back, as the table does; the invite stand-in always says false, which would hand a ciphertext to the caller.
    world.db.routes.unshift([/^INSERT INTO app_settings /, ([key, value, secret]) => { world.settings[key] = value; secrets.set(key, secret === true); return { rows: [], rowCount: 1 }; }]);
    world.db.routes.unshift([/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (world.settings[key] === undefined ? { rows: [] } : { rows: [{ value: world.settings[key], is_secret: secrets.get(key) === true }] })]);
    world.db.routes.unshift([/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => ({ rows: [{ id: OWNER }] })]);
    world.db.routes.unshift([/^SELECT id, name, \(instagram_page_id IS NOT NULL AND page_access_token IS NOT NULL\) AS connected FROM creators WHERE is_active = true/, () => ({
        rows: [...world.creators.values()].filter((c) => c.is_active).map((c) => ({ id: c.id, name: c.name, connected: c.id === OWNER })),
    })]);
});

afterEach(() => { world.restore(); invalidateTenantCache(); });

const get = () => call('GET', '/onboarding-settings');
const put = (body: unknown, session = ADMIN) => call('PUT', '/onboarding-settings', body, session);

describe('validateOnboardingPatch: the two new fields', () => {
    it('a key is trimmed and saved as a write of the YouTube key; a tenant id is lower-cased', () => {
        const r = validateOnboardingPatch({ youtubeApiKey: `  ${KEY}  `, discoveryCreatorId: SECOND.toUpperCase() });
        assert.ok(r.ok);
        if (r.ok) assert.deepEqual(r.writes.map((w) => [w.field, w.key, w.value]), [['youtubeApiKey', 'youtube.api_key', KEY], ['discoveryCreatorId', 'onboarding.discovery_creator_id', SECOND]]);
    });

    it('null and an empty string clear them (back to the environment, back to the owner\'s tenant); absent leaves them alone', () => {
        const r = validateOnboardingPatch({ youtubeApiKey: null, discoveryCreatorId: '  ' });
        assert.ok(r.ok);
        if (r.ok) assert.deepEqual(r.writes.map((w) => [w.field, w.value]), [['youtubeApiKey', null], ['discoveryCreatorId', null]]);
        const none = validateOnboardingPatch({});
        assert.ok(none.ok);
        if (none.ok) assert.deepEqual(none.writes, []);
    });

    it('refuses a key that cannot be Google\'s, naming the field', () => {
        for (const bad of ['short', 'has spaces in the middle of it 123456', 'AIza?key=abc012345678901234567', 'x'.repeat(257), 'ключ-api-key-0123456789abcdefghij', 42, {}, ['AIza']]) {
            const r = validateOnboardingPatch({ youtubeApiKey: bad });
            assert.equal(r.ok, false, JSON.stringify(bad));
            if (!r.ok) assert.equal(r.field, 'youtubeApiKey');
        }
    });

    it('refuses a tenant id that is not an id, naming the field', () => {
        for (const bad of ['not-a-uuid', '12345', `${SECOND}x`, 7, {}]) {
            const r = validateOnboardingPatch({ discoveryCreatorId: bad });
            assert.equal(r.ok, false, JSON.stringify(bad));
            if (!r.ok) assert.equal(r.field, 'discoveryCreatorId');
        }
    });

    it('one bad field saves none of the others in the same request', () => {
        const r = validateOnboardingPatch({ inviteTtlDays: 5, youtubeApiKey: KEY, discoveryCreatorId: 'nope' });
        assert.equal(r.ok, false);
    });
});

describe('GET /onboarding-settings: what the card reads', () => {
    it('with nothing saved: no key, the owner\'s tenant as the reader, and the tenants to pick from', async () => {
        const r = await get();
        assert.equal(r.status, 200);
        const d = r.body.draftSources;
        assert.deepEqual(d.youtubeApiKey, { set: false, source: null, last4: null });
        assert.deepEqual(d.discovery, { creatorId: OWNER, source: 'owner', name: 'Owner Shop', connected: true });
        assert.deepEqual(d.tenants.map((t: any) => [t.id, t.name, t.connected]), [[OWNER, 'Owner Shop', true], [SECOND, 'Second Tenant', false]], 'active tenants only');
    });

    it('does not disturb what the card already reads', async () => {
        const r = await get();
        assert.equal(r.body.settings.inviteTtlDays, 7);
        assert.ok(Object.values(r.body.saved).every((s) => s === false), 'the new settings are not in `saved`: they are not one of the invite fields');
    });

    it('a key from the environment is described as such', async () => {
        process.env.YOUTUBE_API_KEY = OTHER_KEY;
        assert.deepEqual((await get()).body.draftSources.youtubeApiKey, { set: true, source: 'env', last4: OTHER_KEY.slice(-4) });
    });
});

describe('PUT /onboarding-settings: the key', () => {
    it('saves it encrypted, as a secret, and answers with the last four characters and no more', async () => {
        const r = await put({ youtubeApiKey: KEY });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.draftSources.youtubeApiKey, { set: true, source: 'database', last4: KEY.slice(-4) });
        assert.match(world.settings['youtube.api_key']!, /^enc:v1:/);
        assert.equal(world.settings['youtube.api_key']!.includes(KEY), false, 'the key is not stored in the clear');
        assert.equal(secrets.get('youtube.api_key'), true, 'and is marked secret');
    });

    it('the key is in no response, whatever is asked: not the save, not a read, not a refusal', async () => {
        const answers = [await put({ youtubeApiKey: KEY }), await get(), await put({ youtubeApiKey: KEY, discoveryCreatorId: 'nope' }), await put({ youtubeApiKey: `${KEY} with spaces` })];
        for (const a of answers) {
            const text = JSON.stringify(a.body);
            assert.equal(text.includes(KEY), false, JSON.stringify(a.body).slice(0, 120));
            assert.equal(text.includes(KEY.slice(0, 20)), false, 'nor most of it');
        }
    });

    it('a saved key is left alone by a request that does not mention it, and replaced by one that does', async () => {
        await put({ youtubeApiKey: KEY });
        await put({ inviteTtlDays: 9 });
        assert.equal((await get()).body.draftSources.youtubeApiKey.last4, KEY.slice(-4));
        await put({ youtubeApiKey: OTHER_KEY });
        assert.equal((await get()).body.draftSources.youtubeApiKey.last4, OTHER_KEY.slice(-4));
    });

    it('null removes it, and the environment\'s key answers again', async () => {
        process.env.YOUTUBE_API_KEY = OTHER_KEY;
        await put({ youtubeApiKey: KEY });
        assert.equal((await get()).body.draftSources.youtubeApiKey.source, 'database');
        const removed = await put({ youtubeApiKey: null });
        assert.deepEqual(removed.body.draftSources.youtubeApiKey, { set: true, source: 'env', last4: OTHER_KEY.slice(-4) });
        assert.equal(world.settings['youtube.api_key'], undefined);
        delete process.env.YOUTUBE_API_KEY;
        assert.deepEqual((await get()).body.draftSources.youtubeApiKey, { set: false, source: null, last4: null });
    });

    it('a key of the wrong shape is a 400 that names the field and saves nothing', async () => {
        const r = await put({ inviteTtlDays: 3, youtubeApiKey: 'short' });
        assert.equal(r.status, 400);
        assert.equal(r.body.field, 'youtubeApiKey');
        assert.deepEqual(world.settings, {});
        assert.equal(world.audits.length, 0);
    });
});

describe('PUT /onboarding-settings: the discovery tenant', () => {
    it('saves a tenant that exists and says who it is, and whether it can be used (Instagram connected)', async () => {
        const r = await put({ discoveryCreatorId: SECOND });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual(r.body.draftSources.discovery, { creatorId: SECOND, source: 'setting', name: 'Second Tenant', connected: false });
        assert.equal(world.settings['onboarding.discovery_creator_id'], SECOND);
    });

    it('refuses an id that is well formed but is no tenant', async () => {
        const r = await put({ discoveryCreatorId: uuid(404) });
        assert.deepEqual([r.status, r.body.field], [400, 'discoveryCreatorId']);
        assert.equal(world.settings['onboarding.discovery_creator_id'], undefined);
    });

    it('an empty value goes back to the owner\'s tenant', async () => {
        await put({ discoveryCreatorId: SECOND });
        const r = await put({ discoveryCreatorId: '' });
        assert.deepEqual(r.body.draftSources.discovery, { creatorId: OWNER, source: 'owner', name: 'Owner Shop', connected: true });
        assert.equal(world.settings['onboarding.discovery_creator_id'], undefined);
    });

    it('a saved value that is not usable (hand-edited) falls back to the owner\'s tenant instead of to nothing, and the card says so', async () => {
        world.settings['onboarding.discovery_creator_id'] = 'not-an-id';
        assert.deepEqual((await get()).body.draftSources.discovery, { creatorId: OWNER, source: 'owner', name: 'Owner Shop', connected: true });
    });

    it('with no tenant at all there is nothing to read with, and it says "none"', async () => {
        world.creators.clear();
        world.db.routes.shift();
        world.db.routes.unshift([/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => ({ rows: [] })]);
        const d = await describeDraftSources();
        assert.deepEqual(d.discovery, { creatorId: null, source: 'none', name: null, connected: false });
    });
});

describe('who may, and what is recorded', () => {
    it('only a platform admin: a member gets the same 404 as everything under /api/admin, and nothing is saved', async () => {
        for (const r of [await call('GET', '/onboarding-settings', undefined, MEMBER), await put({ youtubeApiKey: KEY }, MEMBER)]) assert.equal(r.status, 404);
        assert.deepEqual(world.settings, {});
    });

    it('the audit row names the fields that changed and which were reset, never a value', async () => {
        await put({ youtubeApiKey: KEY, discoveryCreatorId: SECOND, sessionDays: 12 });
        await put({ youtubeApiKey: null });
        const [first, second] = world.audits;
        assert.equal(first!.action, AUDIT_ACTIONS.settingsOnboardingWrite);
        assert.deepEqual(first!.detail, { changed: ['sessionDays', 'youtubeApiKey', 'discoveryCreatorId'], reset_to_default: [] });
        assert.deepEqual(second!.detail, { changed: [], reset_to_default: ['youtubeApiKey'] });
        const text = JSON.stringify(world.audits);
        assert.equal(text.includes(KEY), false);
        assert.equal(text.includes(SECOND), false, 'not even the tenant id: field names only');
    });
});
