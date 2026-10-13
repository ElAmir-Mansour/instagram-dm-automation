/**
 * `GET` and `PATCH /api/profile` (docs/onboarding/01 §4; P5), through the router's own handlers against the profile
 * tables' in-memory stand-in (`services/profile/testDb.ts`), the way growth.test.ts runs its routes.
 *
 * Pinned: who may read (an operator or an owner, like the Studio's and Growth's settings) and who may write (an owner), that the router is mounted below `resolveTenant`,
 * the shape of every answer (success, 409 with the current version, 400 with every problem, 503), and that a change is
 * audited as `profile.write` with the names of the sections it changed and never a value.
 *
 * `GET /api/profile/campaign-seeds` (P13) is operator-level like the profile itself; it answers the session's tenant's seeds, the owner's
 * nine only for the platform owner while his offers carry none, and never to anyone else.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { AUDIT_ACTIONS, isAuditAction } from '../services/audit.js';
import { campaignSeeds, legacyCampaignFallback, legacyCampaignSeeds, neutralCampaignFallback } from '../services/profile/campaignSeeds.js';
import { resetProfileTableWarning } from '../services/profile/store.js';
import { installProfileDb, OTHER, OWNER, type ProfileDb, seededState, setPlatformOwner, type State, USER } from '../services/profile/testDb.js';
import { assertNoOwnerMarkers, richProfile, throughJsonb } from '../services/profile/testSupport.js';
import { invalidateTenantCache, resolveTenant, type TenantRole } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';
import { profileRouter } from './profile.js';

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: { handle: any }[] }; handle: any }

const layerFor = (method: string, path: string): Layer => {
    const layer = (profileRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!;
};

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

/** The route's own handler (the last in its stack: the guard, when it has one, is tested by itself below). */
async function call(method: 'get' | 'patch', body: unknown = {}, session: Record<string, unknown> = {}) {
    const res = fakeRes();
    const handler = layerFor(method, '/').route!.stack.at(-1)!.handle;
    await handler({ params: {}, query: {}, headers: {}, body, session: { userId: USER, role: 'user', tenantId: OWNER, ...session }, tenantRole: 'owner' }, res, () => {});
    return res;
}

let state: State;
let db: ProfileDb;
let logs: { level: string; event: string; fields: any }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    resetProfileTableWarning();
    logs = [];
    const previous = setLogSink((level, line) => {
        try { const fields = JSON.parse(line); logs.push({ level, event: fields.event, fields }); } catch { /* not structured */ }
    });
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
    db.routes.push([/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'owner@example.com' }] })]);
    db.routes.push([/^INSERT INTO audit_log/, () => ({ rows: [{ id: 'audit-1' }] })]);
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const store = (profile: unknown = richProfile(), version = 3): void => {
    state.profiles.set(OWNER, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
};
const audits = () => db.ran(/^INSERT INTO audit_log/);
const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql) && !/audit_log/.test(sql));

describe('the profile router', () => {
    it('is mounted below resolveTenant, so every route acts as the session\'s tenant', () => {
        const stack = (apiRouter as unknown as { stack: Layer[] }).stack;
        const tenantAt = stack.findIndex((l) => !l.route && l.handle === resolveTenant);
        const profileAt = stack.findIndex((l) => !l.route && l.handle === profileRouter);
        assert.ok(tenantAt >= 0 && profileAt >= 0, 'both are mounted');
        assert.ok(profileAt > tenantAt, 'the profile router comes after resolveTenant');
    });

    it('GET is operator-level, the campaign seeds too, and PATCH is owner-only, and there is no other route', () => {
        const guardOf = (layer: Layer): string | null => layer.route!.stack.map((s) => s.handle?.minimumRole).find((m): m is string => typeof m === 'string') ?? null;
        assert.equal(guardOf(layerFor('get', '/')), 'operator');
        assert.equal(guardOf(layerFor('get', '/campaign-seeds')), 'operator');
        assert.equal(guardOf(layerFor('patch', '/')), 'owner');
        assert.deepEqual(
            (profileRouter as unknown as { stack: Layer[] }).stack.flatMap((l) => (l.route ? Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route!.path}`) : [])).sort(),
            ['GET /', 'GET /campaign-seeds', 'PATCH /'],
            'no other route: nothing mutating hides without a guard',
        );
    });

    it('the GET guard refuses a viewer with a 403 (the profile is configuration, not numbers) and lets an operator and an owner through', async () => {
        const guard = layerFor('get', '/').route!.stack[0]!.handle;
        const viewer = fakeRes();
        let passed = false;
        await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: 'viewer', originalUrl: '/api/profile' }, viewer, () => { passed = true; });
        assert.equal(passed, false);
        assert.equal(viewer.statusCode, 403);
        assert.equal(viewer.body.code, 'INSUFFICIENT_TENANT_ROLE');
        assert.equal(viewer.body.requiredRole, 'operator');
        for (const role of ['operator', 'owner'] as TenantRole[]) {
            let ok = false;
            await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: role, originalUrl: '/api/profile' }, fakeRes(), () => { ok = true; });
            assert.equal(ok, true, role);
        }
    });

    it('the PATCH guard refuses an operator and a viewer with a 403 and lets an owner through', async () => {
        const guard = layerFor('patch', '/').route!.stack[0]!.handle;
        for (const role of ['viewer', 'operator'] as TenantRole[]) {
            const res = fakeRes();
            let passed = false;
            await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: role, originalUrl: '/api/profile' }, res, () => { passed = true; });
            assert.equal(passed, false, role);
            assert.equal(res.statusCode, 403, role);
            assert.equal(res.body.code, 'INSUFFICIENT_TENANT_ROLE');
        }
        let passed = false;
        await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: 'owner', originalUrl: '/api/profile' }, fakeRes(), () => { passed = true; });
        assert.equal(passed, true);
    });

    it('profile.write is a known audit action', () => {
        assert.equal(AUDIT_ACTIONS.profileWrite, 'profile.write');
        assert.ok(isAuditAction('profile.write'));
    });
});

describe('GET /api/profile', () => {
    it('answers the stored profile with its version, stored: true and what activation still misses', async () => {
        store(richProfile(), 3);
        const res = await call('get', undefined, { role: 'user' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ['activationMissing', 'profile', 'stored', 'version']);
        assert.equal(res.body.version, 3);
        assert.equal(res.body.stored, true);
        assert.deepEqual(res.body.profile, richProfile());
        assert.deepEqual(res.body.activationMissing, []);
    });

    it('answers the virtual profile of a tenant with none stored: version null, stored: false', async () => {
        const res = await call('get');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.version, null);
        assert.equal(res.body.stored, false);
        assert.equal(res.body.profile.identity.role, 'tech educator', 'what his settings describe');
        assert.ok(Array.isArray(res.body.activationMissing));
        assert.deepEqual(writes(), [], 'a read writes nothing: the virtual profile is not stored by being looked at');
    });

    it('says what is missing for a profile that is not finished', async () => {
        store({ ...richProfile(), identity: { ...richProfile().identity, kind: null, niche: '' } }, 1);
        assert.deepEqual((await call('get')).body.activationMissing, ['identity.kind', 'identity.niche']);
    });

    it('is a 500 that leaks nothing when the database fails', async () => {
        db.failOn = /creator_profiles/;
        db.failWith = new Error('password authentication failed for user "postgres"');
        const res = await call('get');
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to read the profile.' });
        assert.ok(logs.some((l) => l.event === 'profile.read_failed'));
    });
});

describe('PATCH /api/profile', () => {
    it('saves the change as the next version and answers the profile in the shape GET does', async () => {
        store(richProfile(), 3);
        const res = await call('patch', { version: 3, patch: { identity: { niche: 'Strength for beginners' } } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body).sort(), ['activationMissing', 'profile', 'stored', 'version']);
        assert.equal(res.body.version, 4);
        assert.equal(res.body.stored, true);
        assert.equal(res.body.profile.identity.niche, 'Strength for beginners');
        assert.equal(res.body.profile.identity.role, 'fitness coach');
        assert.deepEqual(res.body.activationMissing, []);
        assert.equal((state.profiles.get(OWNER)!.profile as any).identity.niche, 'Strength for beginners');
        assert.equal(state.profiles.get(OWNER)!.updated_by, USER, 'req.session.userId is the version\'s updated_by');
        assert.deepEqual(state.versions.map((v) => [v.version, v.source, v.updated_by]), [[4, 'user', USER]]);
    });

    it('the shared-password session has no user: updated_by is null', async () => {
        store(richProfile(), 3);
        const res = await call('patch', { version: 3, patch: { goals: { views: 9 } } }, { userId: null, role: 'platform_admin' });
        assert.equal(res.statusCode, 200);
        assert.equal(state.profiles.get(OWNER)!.updated_by, null);
    });

    it('audits profile.write with the names of the sections changed and the new version, never a value', async () => {
        store(richProfile(), 3);
        const SENTINEL = 'ZXQ-private-niche-8841';
        const NAME = 'ZXQ-private-name-1177';
        const res = await call('patch', { version: 3, patch: { identity: { niche: SENTINEL, display_name: { en: NAME } }, voice: { emoji: 'none' } } });
        assert.equal(res.statusCode, 200);
        const [audit] = audits();
        assert.ok(audit, 'one audit row');
        assert.equal(audits().length, 1);
        const [actorId, actorEmail, action, targetType, targetId, detail] = audit!.params;
        assert.equal(actorId, USER);
        assert.equal(actorEmail, 'owner@example.com');
        assert.equal(action, 'profile.write');
        assert.equal(targetType, 'creator');
        assert.equal(targetId, OWNER);
        assert.deepEqual(JSON.parse(detail), { paths: ['identity', 'voice'], version: 4 });
        for (const secret of [SENTINEL, NAME, 'none']) assert.ok(!String(detail).includes(secret), `the audit detail never holds "${secret}"`);
        assert.ok(!JSON.stringify(audit!.params).includes(SENTINEL), 'nor does any other parameter of the audit insert');
        assert.ok(!logs.some((l) => JSON.stringify(l.fields).includes(SENTINEL)), 'nor any log line the request wrote');
    });

    it('a stale version is a 409 that says which version to reload: nothing written, nothing audited', async () => {
        store(richProfile(), 5);
        const res = await call('patch', { version: 4, patch: { identity: { niche: 'x' } } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'PROFILE_VERSION_CONFLICT');
        assert.equal(res.body.currentVersion, 5);
        assert.match(res.body.error, /changed since you opened it/);
        assert.deepEqual(writes(), []);
        assert.equal(audits().length, 0);
        assert.equal(state.profiles.get(OWNER)!.version, 5);
    });

    it('a conflict with no stored profile says currentVersion: null', async () => {
        const res = await call('patch', { version: 2, patch: { identity: { niche: 'x' } } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'PROFILE_VERSION_CONFLICT');
        assert.equal(res.body.currentVersion, null);
    });

    describe('the platform owner\'s no_women_imagery rule (P19: the same guard as an admin\'s fill on his behalf)', () => {
        beforeEach(() => {
            setPlatformOwner(db, OWNER);
            store(richProfile(), 3);
        });

        it('removing it from the owner\'s own profile is 409 OWNER_RULE_LOCKED: nothing written, nothing audited', async () => {
            const res = await call('patch', { version: 3, patch: { content: { rules: [] } } });
            assert.equal(res.statusCode, 409);
            assert.equal(res.body.code, 'OWNER_RULE_LOCKED');
            assert.match(res.body.error, /confirm_remove_owner_rule/);
            assert.ok(!('currentVersion' in res.body), 'it is not a version conflict');
            assert.deepEqual(writes(), []);
            assert.equal(audits().length, 0);
            assert.deepEqual((state.profiles.get(OWNER)!.profile as { content: { rules: string[] } }).content.rules, ['no_women_imagery']);
        });

        it('goes through when the body confirms it, and is audited as any change is: the section, never the value', async () => {
            const res = await call('patch', { version: 3, patch: { content: { rules: [] } }, confirm_remove_owner_rule: true });
            assert.equal(res.statusCode, 200);
            assert.equal(res.body.version, 4);
            assert.deepEqual(res.body.profile.content.rules, []);
            assert.deepEqual(audits().map((a) => JSON.parse(a.params[5])), [{ paths: ['content'], version: 4 }]);
        });

        it('is nobody else\'s lock: a tenant that is not the owner removes it freely', async () => {
            state.profiles.set(OTHER, { profile: throughJsonb(richProfile()), version: 3, activated_at: null, updated_by: null });
            const res = await call('patch', { version: 3, patch: { content: { rules: [] } } }, { tenantId: OTHER });
            assert.equal(res.statusCode, 200);
            assert.deepEqual(res.body.profile.content.rules, []);
        });
    });

    it('an invalid result is a 400 with every problem: nothing written, nothing audited', async () => {
        store(richProfile(), 3);
        const res = await call('patch', { version: 3, patch: { identity: { role: 'x'.repeat(41), timezone: 'Mars/Olympus' }, voice: { emoji: 'confetti' } } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'PROFILE_INVALID');
        assert.equal(res.body.problems.length, 3);
        assert.equal(res.body.error, '3 problems with this profile.');
        assert.ok(!('currentVersion' in res.body));
        assert.equal(state.profiles.get(OWNER)!.version, 3);
        assert.equal(state.versions.length, 0);
        assert.equal(audits().length, 0);
    });

    it('a patch that sets schema to 2 is a 400, and the stored profile is untouched', async () => {
        store(richProfile(), 3);
        const res = await call('patch', { version: 3, patch: { schema: 2 } });
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'PROFILE_INVALID');
        assert.ok(res.body.problems.some((p: string) => /schema/.test(p)), res.body.problems.join(' | '));
        assert.equal((state.profiles.get(OWNER)!.profile as any).schema, 1);
        assert.equal(state.profiles.get(OWNER)!.version, 3);
        assert.equal(audits().length, 0);
    });

    it('a body that is not { version, patch } is a 400 with the one problem', async () => {
        store(richProfile(), 3);
        for (const body of [undefined, {}, { version: 3 }, { version: 'three', patch: { goals: { views: 1 } } }, { version: 3, patch: [] }]) {
            const res = await call('patch', body);
            assert.equal(res.statusCode, 400);
            assert.equal(res.body.code, 'PROFILE_INVALID');
            assert.equal(res.body.problems.length, 1);
            assert.equal(res.body.problems[0], res.body.error);
        }
        assert.equal(audits().length, 0);
    });

    it('a profile from a newer release is a 409 PROFILE_NEWER_SCHEMA with its version', async () => {
        store({ ...richProfile(), schema: 2, future: { x: 1 } }, 6);
        const res = await call('patch', { version: 6, patch: { identity: { niche: 'x' } } });
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'PROFILE_NEWER_SCHEMA');
        assert.equal(res.body.currentVersion, 6);
        assert.deepEqual(writes(), []);
    });

    it('a patch that changes nothing answers the profile as it is: no version, no history, no audit entry', async () => {
        store(richProfile(), 3);
        const res = await call('patch', { version: 3, patch: { identity: { niche: richProfile().identity.niche } } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.version, 3);
        assert.deepEqual(writes(), []);
        assert.equal(audits().length, 0);
    });

    it('the first patch of a tenant with none stored (version null) creates it', async () => {
        const read = await call('get');
        assert.equal(read.body.version, null);
        const res = await call('patch', { version: read.body.version, patch: { identity: { niche: 'Home workouts' } } });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.version, 2);
        assert.equal(res.body.stored, true);
        assert.deepEqual(state.versions.map((v) => [v.version, v.source]), [[1, 'backfill'], [2, 'user']]);
        assert.deepEqual(JSON.parse(audits()[0]!.params[5]), { paths: ['identity'], version: 2 });
    });

    it('is a 503 naming the migration when v33 is missing', async () => {
        db.v33 = false;
        const res = await call('patch', { version: null, patch: { identity: { niche: 'x' } } });
        assert.equal(res.statusCode, 503);
        assert.equal(res.body.code, 'PROFILE_STORAGE_MISSING');
        assert.match(res.body.error, /migration v33/);
    });

    it('is a 500 that leaks nothing when the database fails, and the save rolls back', async () => {
        store(richProfile(), 3);
        db.failOn = /^INSERT INTO creator_profile_versions/;
        db.failWith = new Error('connection to 10.0.0.1 refused');
        const res = await call('patch', { version: 3, patch: { identity: { niche: 'x' } } });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to save the profile.' });
        assert.ok(logs.some((l) => l.event === 'profile.save_failed'));
        assert.equal(state.profiles.get(OWNER)!.version, 3, 'the version bump rolled back with the failed history row');
        assert.equal(audits().length, 0);
    });

    it('a failed audit write never fails the save it records', async () => {
        store(richProfile(), 3);
        db.routes.unshift([/^INSERT INTO audit_log/, () => { throw new Error('relation "audit_log" does not exist'); }]);
        const res = await call('patch', { version: 3, patch: { identity: { niche: 'kept' } } });
        assert.equal(res.statusCode, 200);
        assert.equal((state.profiles.get(OWNER)!.profile as any).identity.niche, 'kept');
    });
});

// ─── GET /api/profile/campaign-seeds (P13) ───────────────────────────────────────────────────

describe('GET /api/profile/campaign-seeds', () => {
    /** `richProfile()` carries a campaign on its program: this is the same tenant with none. */
    const plainProfile = () => {
        const p = richProfile();
        p.offers = p.offers.map(({ campaign: _campaign, ...offer }) => offer);
        return p;
    };
    const seedsLayer = (): Layer => layerFor('get', '/campaign-seeds');

    async function callSeeds(session: Record<string, unknown> = {}) {
        const res = fakeRes();
        const handler = seedsLayer().route!.stack.at(-1)!.handle;
        await handler({ params: {}, query: {}, headers: {}, body: {}, session: { userId: USER, role: 'user', tenantId: OWNER, ...session }, tenantRole: 'operator' }, res, () => {});
        return res;
    }

    /** The owner's tenant is the platform owner; the other one is a second tenant. */
    beforeEach(() => {
        invalidateTenantCache();
        setPlatformOwner(db, OWNER);
    });

    const campaignOffer = (name: string) => ({
        id: 'plan', kind: 'program' as const, name: 'Plan', order_via: 'dm' as const, url: '', price: '', facts: [], bullets: [], keyword: '', primary: true,
        campaign: { name_match: name, match: 'substring' as const, keywords: ['plan', 'program'], dm_template: 'Hi {username}: {url}', public_replies: ['Sent!', 'Check your DMs'] },
    });
    const storeFor = (creator: string, profile: unknown, version = 1): void => {
        state.profiles.set(creator, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
    };

    it('the guard refuses a viewer with a 403 and lets an operator and an owner through', async () => {
        const guard = seedsLayer().route!.stack[0]!.handle;
        const viewer = fakeRes();
        let passed = false;
        await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: 'viewer', originalUrl: '/api/profile/campaign-seeds' }, viewer, () => { passed = true; });
        assert.equal(passed, false);
        assert.equal(viewer.statusCode, 403);
        assert.equal(viewer.body.code, 'INSUFFICIENT_TENANT_ROLE');
        assert.equal(viewer.body.requiredRole, 'operator');
        for (const role of ['operator', 'owner'] as TenantRole[]) {
            let ok = false;
            await guard({ session: { userId: USER, tenantId: OWNER }, tenantRole: role, originalUrl: '/api/profile/campaign-seeds' }, fakeRes(), () => { ok = true; });
            assert.equal(ok, true, role);
        }
    });

    it('is mounted below resolveTenant with the rest of the profile router: it acts as the session\'s tenant', () => {
        const stack = (apiRouter as unknown as { stack: Layer[] }).stack;
        assert.ok(stack.findIndex((l) => !l.route && l.handle === profileRouter) > stack.findIndex((l) => !l.route && l.handle === resolveTenant));
    });

    it('answers { seeds, source, fallback } with the session\'s tenant\'s own seeds, in its offers\' order', async () => {
        storeFor(OTHER, { ...richProfile(), offers: [campaignOffer('first'), { ...campaignOffer('second'), id: 'two', primary: false }] });
        const res = await callSeeds({ tenantId: OTHER });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body), ['seeds', 'source', 'fallback']);
        assert.deepEqual(Object.keys(res.body.fallback), ['dm_template', 'public_reply_template']);
        assert.equal(res.body.source, 'profile');
        assert.deepEqual(res.body.seeds.map((s: { name_match: string }) => s.name_match), ['first', 'second']);
        assert.deepEqual(res.body.seeds[0], {
            name_match: 'first', match: 'substring', trigger_keyword: 'plan, program', dm_template: 'Hi {username}: {url}', public_reply_template: 'Sent! | Check your DMs',
        });
    });

    it('the platform owner, while his offers carry no campaign, is answered his nine: `source: legacy`', async () => {
        storeFor(OWNER, plainProfile());
        const res = await callSeeds({ tenantId: OWNER });
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.source, 'legacy');
        assert.deepEqual(res.body.seeds, legacyCampaignSeeds());
        assert.equal(res.body.seeds.length, 9);
        assert.deepEqual(res.body.fallback, legacyCampaignFallback(), 'and his own wording for the rows no seed names');
    });

    it('the platform owner whose offers carry campaigns is answered those, and not the built-in nine', async () => {
        storeFor(OWNER, { ...richProfile(), offers: [campaignOffer('mine')] });
        const res = await callSeeds({ tenantId: OWNER });
        assert.equal(res.body.source, 'profile');
        assert.deepEqual(res.body.seeds, campaignSeeds({ offers: [campaignOffer('mine')] }));
        assert.deepEqual(res.body.fallback, legacyCampaignFallback(), 'his fallback is his, whatever his seeds came from');
    });

    it('ANOTHER tenant with no campaigns is answered none: never the owner\'s nine, nor any word of them', async () => {
        storeFor(OTHER, plainProfile());
        const res = await callSeeds({ tenantId: OTHER });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.seeds, []);
        assert.equal(res.body.source, 'profile');
        assert.deepEqual(res.body.fallback, neutralCampaignFallback({ code: 'ar', register: 'egyptian' }), 'the neutral text of the language its comment replies speak (richProfile is Egyptian Arabic)');
        assertNoOwnerMarkers(JSON.stringify(res.body), 'another tenant\'s answer');
    });

    it('a tenant with no stored profile and no settings of its own is answered no seeds too, and never his fallback', async () => {
        const res = await callSeeds({ tenantId: OTHER });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.seeds, []);
        assert.equal(res.body.source, 'profile');
        assert.notDeepEqual(res.body.fallback, legacyCampaignFallback());
        assertNoOwnerMarkers(JSON.stringify(res.body), 'a tenant with nothing stored');
    });

    it('a read writes nothing and audits nothing', async () => {
        storeFor(OWNER, plainProfile());
        await callSeeds({ tenantId: OWNER });
        assert.deepEqual(writes(), []);
        assert.equal(audits().length, 0);
    });

    it('is a 500 that leaks nothing when the database fails', async () => {
        db.failOn = /creator_profiles/;
        db.failWith = new Error('password authentication failed for user "postgres"');
        const res = await callSeeds({ tenantId: OTHER });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to read the campaign seeds.' });
        assert.ok(logs.some((l) => l.event === 'profile.campaign_seeds_failed'));
    });

    it('is a 500, and nothing in his name, when it cannot be told who the owner is', async () => {
        setPlatformOwner(db, new Error('connection to 10.0.0.1 refused'));
        storeFor(OTHER, plainProfile());
        const res = await callSeeds({ tenantId: OTHER });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to read the campaign seeds.' });
    });
});
