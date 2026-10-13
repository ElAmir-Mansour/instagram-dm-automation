/**
 * `GET` and `PATCH /api/admin/tenants/:id/profile`: a platform admin fills a tenant's Creator Profile in on their behalf (P19).
 *
 * What is pinned, because each is a way for one person's profile to be changed by someone it should not be, or without a trace:
 *
 *   - **the gate**: a non-admin (a tenant's own owner included) is answered 404, as on every route of this router, and no query runs;
 *   - **the lock**: a PATCH names the version it read, and loses with 409 (and `currentVersion`) when the profile has moved on, before
 *     anything is merged, written or audited. This is `patchProfile`, the very function `PATCH /api/profile` is: nothing here is a fork;
 *   - **the record**: the history row says `admin`, the audit entry is `profile.write` with `{ paths, version, on_behalf: true }` and
 *     never a value, and a patch that changes nothing writes and audits nothing;
 *   - **`onboarding.filled_by`**: set to `admin` in the save's own transaction while the tenant's onboarding is not completed, and left
 *     alone once it is;
 *   - **the owner's rule**: removing `no_women_imagery` from the platform owner's profile is 409 `OWNER_RULE_LOCKED` unless confirmed;
 *     another tenant's is nobody's lock.
 *
 * Driven through the router with a plain request object, against the in-memory stand-in for the profile tables
 * (`services/profile/testDb.ts`) plus the three tables the routes themselves touch (`creators`, `onboarding`, `audit_log`).
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { defaultProfile } from '../services/profile/defaults.js';
import { resetProfileTableWarning } from '../services/profile/store.js';
import { installProfileDb, OWNER, PLATFORM_OWNER_SQL, type ProfileDb, seededState, setPlatformOwner, type State, USER } from '../services/profile/testDb.js';
import { richProfile, throughJsonb } from '../services/profile/testSupport.js';
import type { CreatorProfile } from '../services/profile/types.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';

const NEW = '55555555-5555-4555-8555-555555555555';
const GONE = '66666666-6666-4666-8666-666666666666';
const ADMIN = { userId: USER, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };
const TENANT_OWNER = { userId: '44444444-4444-4444-8444-444444444444', role: 'user', tenantId: NEW, tokenVersion: 0 };

interface Reply { status: number; body: any; fellThrough?: boolean }

/** Call the router as Express would, with nothing mounted above it. */
function call(method: 'GET' | 'PATCH', url: string, body: unknown = {}, session: Record<string, unknown> | null = ADMIN): Promise<Reply> {
    return new Promise((resolve) => {
        const req = { method, url, originalUrl: url, body, query: {}, params: {}, headers: {}, session: session ?? undefined } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        adminRouter(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

const read = (id: string, session: Record<string, unknown> | null = ADMIN) => call('GET', `/tenants/${id}/profile`, {}, session);
const patch = (id: string, body: unknown, session: Record<string, unknown> | null = ADMIN) => call('PATCH', `/tenants/${id}/profile`, body, session);

// ─── The stand-in ────────────────────────────────────────────────────────────────────────────

let state: State;
let db: ProfileDb;
let creators: Set<string>;
let onboarding: Map<string, { status: string; filled_by: string | null }>;
let audits: { action: string; targetType: string | null; targetId: string | null; detail: Record<string, unknown> }[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    resetProfileTableWarning();
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    state = seededState();
    db = installProfileDb(state);
    setPlatformOwner(db, OWNER);
    creators = new Set([OWNER, NEW]);
    onboarding = new Map();
    audits = [];

    // What the routes write besides the profile tables: rolled back with the transaction, as the database would.
    let snapshot: typeof onboarding | null = null;
    db.onStatement = (flat) => {
        if (flat === 'BEGIN') snapshot = structuredClone(onboarding);
        else if (flat === 'ROLLBACK' && snapshot) { onboarding = snapshot; snapshot = null; }
        else if (flat === 'COMMIT') snapshot = null;
    };
    db.routes.push(
        [/^SELECT id FROM creators WHERE id = \$1$/, ([id]) => ({ rows: creators.has(id) ? [{ id }] : [] })],
        [/^SELECT status, filled_by FROM onboarding WHERE creator_id = \$1$/, ([id]) => ({ rows: onboarding.has(id) ? [{ ...onboarding.get(id)! }] : [] })],
        [/^UPDATE onboarding SET filled_by = 'admin' WHERE creator_id = \$1 AND status <> 'completed'$/, ([id]) => {
            const row = onboarding.get(id);
            if (row && row.status !== 'completed') row.filled_by = 'admin';
            return { rows: [] };
        }],
        [/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'operator@example.com' }] })],
        [/^INSERT INTO audit_log /, ([, , action, targetType, targetId, detail]) => {
            audits.push({ action, targetType, targetId, detail: JSON.parse(detail) });
            return { rows: [{ id: 'audit-1' }] };
        }],
    );
});
afterEach(() => {
    db.restore();
    restoreSink?.();
});

const store = (id: string, profile: unknown, version: number): void => {
    state.profiles.set(id, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
};
const stored = (id: string): CreatorProfile => state.profiles.get(id)!.profile as CreatorProfile;
const newTenant = (): CreatorProfile => defaultProfile({ lang: 'ar', rules: ['no_women_imagery'] });
const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql) && !/audit_log/.test(sql));

// ─── The gate ────────────────────────────────────────────────────────────────────────────────

describe('the platform_admin gate on the profile routes', () => {
    const body = { version: 1, patch: { identity: { niche: 'x' } } };

    it('answers a non-admin 404, never 403, on both routes, and a tenant\'s own owner is a non-admin here', async () => {
        store(NEW, newTenant(), 1);
        for (const session of [TENANT_OWNER, { ...TENANT_OWNER, role: 'viewer' }, null]) {
            for (const reply of [await read(NEW, session), await patch(NEW, body, session)]) {
                assert.equal(reply.status, 404);
                assert.deepEqual(reply.body, { error: 'Not found.' });
            }
        }
        assert.deepEqual(db.statements, [], 'no query ran for any of them');
        assert.equal(stored(NEW).identity.niche, '', 'and nothing changed');
    });

    it('gives a non-admin the same answer for a route that does not exist, so the difference maps nothing', async () => {
        const real = await read(NEW, TENANT_OWNER);
        const invented = await call('GET', `/tenants/${NEW}/there-is-no-such-thing`, {}, TENANT_OWNER);
        assert.deepEqual(real, invented);
    });

    it('lets an admin through to both', async () => {
        store(NEW, newTenant(), 1);
        assert.equal((await read(NEW)).status, 200);
        assert.equal((await patch(NEW, body)).status, 200);
    });
});

// ─── GET ─────────────────────────────────────────────────────────────────────────────────────

describe('GET /api/admin/tenants/:id/profile', () => {
    it('answers the stored profile with the version a PATCH must send back, what activation still misses, whether he is the owner, and where onboarding stands', async () => {
        store(NEW, newTenant(), 1);
        onboarding.set(NEW, { status: 'invited', filled_by: null });
        const reply = await read(NEW);
        assert.equal(reply.status, 200);
        assert.deepEqual(Object.keys(reply.body).sort(), ['activationMissing', 'isPlatformOwner', 'onboarding', 'profile', 'stored', 'version']);
        assert.equal(reply.body.version, 1);
        assert.equal(reply.body.stored, true);
        assert.deepEqual(reply.body.profile, throughJsonb(newTenant()));
        assert.deepEqual(reply.body.activationMissing, ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name']);
        assert.equal(reply.body.isPlatformOwner, false);
        assert.deepEqual(reply.body.onboarding, { status: 'invited', filledBy: null });
    });

    it('says the platform owner is the platform owner, in whatever case the id came', async () => {
        store(OWNER, richProfile(), 3);
        assert.equal((await read(OWNER)).body.isPlatformOwner, true);
        assert.equal((await read(OWNER.toUpperCase())).body.isPlatformOwner, true);
    });

    it('a tenant with no stored profile reads as the virtual one its settings describe: version null, stored false', async () => {
        const reply = await read(OWNER);
        assert.equal(reply.status, 200);
        assert.equal(reply.body.version, null);
        assert.equal(reply.body.stored, false);
        assert.deepEqual(reply.body.profile.content.rules, ['no_women_imagery'], 'described from his settings: the legacy profile holds the rule');
    });

    it('reads a tenant with no onboarding row as completed (D14), and so does a database without v34', async () => {
        store(NEW, newTenant(), 1);
        assert.deepEqual((await read(NEW)).body.onboarding, { status: 'completed', filledBy: null });
        db.failOn = /FROM onboarding/;
        db.failWith = Object.assign(new Error('relation "onboarding" does not exist'), { code: '42P01' });
        assert.deepEqual((await read(NEW)).body.onboarding, { status: 'completed', filledBy: null });
    });

    it('is 404 for a tenant that does not exist and for an id that is not a uuid, and reads no profile for either', async () => {
        for (const id of [GONE, 'not-a-uuid', '12345']) {
            const reply = await read(id);
            assert.equal(reply.status, 404, id);
            assert.deepEqual(reply.body, { error: 'Tenant not found.' });
        }
        assert.equal(db.ran(/creator_profiles/).length, 0);
    });

    it('changes nothing and audits nothing', async () => {
        store(NEW, newTenant(), 1);
        await read(NEW);
        assert.deepEqual(writes(), []);
        assert.deepEqual(audits, []);
    });
});

// ─── PATCH ───────────────────────────────────────────────────────────────────────────────────

describe('PATCH /api/admin/tenants/:id/profile', () => {
    beforeEach(() => {
        store(NEW, newTenant(), 1);
        onboarding.set(NEW, { status: 'invited', filled_by: null });
    });

    it('merges the patch like the tenant\'s own PATCH does, stores the next version as the admin\'s, and answers what GET answers', async () => {
        const reply = await patch(NEW, { version: 1, patch: { identity: { niche: 'Home workouts', kind: 'coach', display_name: { en: 'Sami' } }, content: { pillars: ['Mobility'] } } });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.version, 2);
        assert.equal(reply.body.stored, true);
        assert.equal(reply.body.profile.identity.niche, 'Home workouts');
        assert.deepEqual(reply.body.profile.identity.display_name, { ar: '', en: 'Sami' }, 'an object merges: the Arabic name the patch did not name is kept');
        assert.deepEqual(reply.body.profile.content.pillars, ['Mobility']);
        assert.deepEqual(Object.keys(reply.body).sort(), ['activationMissing', 'isPlatformOwner', 'onboarding', 'profile', 'stored', 'version']);
        assert.deepEqual(reply.body, (await read(NEW)).body, 'and it is exactly what a GET answers next');
        assert.equal(state.profiles.get(NEW)!.version, 2);
        assert.equal(state.profiles.get(NEW)!.updated_by, USER);
        assert.deepEqual(state.versions.filter((v) => v.creator_id === NEW).map((v) => [v.version, v.source, v.updated_by]), [[2, 'admin', USER]]);
    });

    it('mirrors the settings rows like any save, and touches no other tenant\'s: the owner\'s profile and settings are as they were', async () => {
        store(OWNER, richProfile(), 3);
        const owner = JSON.stringify([state.profiles.get(OWNER), state.studio.get(OWNER), state.growth.get(OWNER)]);
        await patch(NEW, { version: 1, patch: { identity: { timezone: 'Asia/Dubai' } } });
        assert.equal((state.studio.get(NEW)!.schedule as { timezone: string }).timezone, 'Asia/Dubai', 'the mirror carries it into the Studio row');
        assert.equal(JSON.stringify([state.profiles.get(OWNER), state.studio.get(OWNER), state.growth.get(OWNER)]), owner);
    });

    describe('the version lock', () => {
        it('a stale version is 409 PROFILE_VERSION_CONFLICT with the version to reload, before anything is merged, locked, written or audited', async () => {
            store(NEW, newTenant(), 5);
            const reply = await patch(NEW, { version: 4, patch: { identity: { niche: 'lost' } } });
            assert.equal(reply.status, 409);
            assert.equal(reply.body.code, 'PROFILE_VERSION_CONFLICT');
            assert.equal(reply.body.currentVersion, 5);
            assert.match(reply.body.error, /changed since you opened it/);
            assert.deepEqual(writes(), [], 'not a single write');
            assert.equal(db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length, 0, 'not even a lock: the check is made on the read');
            assert.deepEqual(audits, []);
            assert.equal(stored(NEW).identity.niche, '');
            assert.deepEqual(onboarding.get(NEW), { status: 'invited', filled_by: null }, 'and the wizard is not told an admin filled anything in');
        });

        it('is what stops two admins, or an admin and the tenant, overwriting each other: the second save of the same version loses', async () => {
            const first = await patch(NEW, { version: 1, patch: { identity: { niche: 'first' } } });
            const second = await patch(NEW, { version: 1, patch: { identity: { niche: 'second' } } });
            assert.equal(first.status, 200);
            assert.equal(second.status, 409);
            assert.equal(second.body.currentVersion, 2);
            assert.equal(stored(NEW).identity.niche, 'first');
        });

        it('a version of null (the virtual profile) loses to a profile that has been stored since, and one that read a stored version loses when none is stored now', async () => {
            const stale = await patch(NEW, { version: null, patch: { identity: { niche: 'x' } } });
            assert.equal(stale.status, 409);
            assert.equal(stale.body.currentVersion, 1);
            state.profiles.delete(NEW);
            const none = await patch(NEW, { version: 1, patch: { identity: { niche: 'x' } } });
            assert.equal(none.status, 409);
            assert.equal(none.body.currentVersion, null, 'null: nothing is stored, reload the virtual profile');
        });

        it('a write that lands between the read and the save is still a conflict, caught inside the transaction, and rolls the onboarding mark back with it', async () => {
            const hook = db.onStatement;
            db.onStatement = (sql) => {
                hook?.(sql);
                if (sql === 'BEGIN') state.profiles.get(NEW)!.version = 2;
            };
            const reply = await patch(NEW, { version: 1, patch: { identity: { niche: 'x' } } });
            assert.equal(reply.status, 409);
            assert.equal(reply.body.currentVersion, 2);
            assert.deepEqual(audits, []);
            assert.deepEqual(onboarding.get(NEW), { status: 'invited', filled_by: null });
            assert.deepEqual(state.versions, []);
        });

        it('requires the version: a body without one is a 400, and a profile is never patched blind', async () => {
            const reply = await patch(NEW, { patch: { identity: { niche: 'x' } } });
            assert.equal(reply.status, 400);
            assert.equal(reply.body.code, 'PROFILE_INVALID');
            assert.match(reply.body.error, /version is required/);
            assert.deepEqual(writes(), []);
        });
    });

    describe('the audit entry', () => {
        it('is profile.write on the creator with { paths, version, on_behalf: true }: the sections that changed and nothing else', async () => {
            await patch(NEW, { version: 1, patch: { voice: { emoji: 'none' }, identity: { niche: 'Home workouts' }, offers: [] } });
            assert.equal(audits.length, 1);
            const [entry] = audits;
            assert.equal(entry!.action, AUDIT_ACTIONS.profileWrite);
            assert.equal(entry!.action, 'profile.write');
            assert.equal(entry!.targetType, 'creator');
            assert.equal(entry!.targetId, NEW);
            assert.deepEqual(entry!.detail, { paths: ['identity', 'voice'], version: 2, on_behalf: true });
        });

        it('never holds a value the admin wrote: not in the detail, not anywhere in the row', async () => {
            const secrets = ['Zq-niche-7731', 'Zq-guide-7732', 'Zq-offer-7733', 'Zq-handle-7734', 'https://zq-7735.example/buy'];
            await patch(NEW, {
                version: 1,
                patch: {
                    identity: { niche: secrets[0] },
                    voice: { guide: secrets[1] },
                    offers: [{ id: 'main', kind: 'program', name: secrets[2], order_via: 'url', url: secrets[4], price: '', facts: [], bullets: [], keyword: '', primary: true }],
                    socials: { handle: secrets[3] },
                },
            });
            assert.equal(stored(NEW).identity.niche, secrets[0], 'the write itself happened');
            assert.equal(audits.length, 1);
            const row = JSON.stringify(audits[0]);
            for (const secret of secrets) assert.ok(!row.includes(secret), `the audit row holds ${secret}`);
            assert.deepEqual(Object.keys(audits[0]!.detail).sort(), ['on_behalf', 'paths', 'version']);
        });

        it('is written once per change, and not at all for a patch that changes nothing', async () => {
            const noop = await patch(NEW, { version: 1, patch: { identity: { niche: '' } } });
            assert.equal(noop.status, 200);
            assert.equal(noop.body.version, 1, 'no new version');
            assert.deepEqual(audits, []);
            assert.deepEqual(writes(), []);
            assert.deepEqual(state.versions, []);
        });

        it('is not written for a refusal', async () => {
            await patch(NEW, { version: 1, patch: { identity: { role: 'x'.repeat(41) } } });
            await patch(NEW, { version: 9, patch: { identity: { niche: 'x' } } });
            await patch(GONE, { version: 1, patch: { identity: { niche: 'x' } } });
            assert.deepEqual(audits, []);
        });
    });

    describe('onboarding.filled_by', () => {
        it('becomes admin when the tenant\'s onboarding is invited, and when it is in progress', async () => {
            const first = await patch(NEW, { version: 1, patch: { identity: { niche: 'a' } } });
            assert.deepEqual(first.body.onboarding, { status: 'invited', filledBy: 'admin' });
            assert.deepEqual(onboarding.get(NEW), { status: 'invited', filled_by: 'admin' });
            onboarding.set(NEW, { status: 'in_progress', filled_by: 'tenant' });
            const second = await patch(NEW, { version: 2, patch: { identity: { niche: 'b' } } });
            assert.deepEqual(second.body.onboarding, { status: 'in_progress', filledBy: 'admin' });
        });

        it('is set in the save\'s own transaction: between the history row and the commit', async () => {
            await patch(NEW, { version: 1, patch: { identity: { niche: 'a' } } });
            const sql = db.statements.map((s) => s.sql);
            const at = (pattern: RegExp): number => sql.findIndex((x) => pattern.test(x));
            assert.ok(at(/^BEGIN$/) < at(/^INSERT INTO creator_profile_versions /));
            assert.ok(at(/^INSERT INTO creator_profile_versions /) < at(/^UPDATE onboarding SET filled_by/));
            assert.ok(at(/^UPDATE onboarding SET filled_by/) < at(/^COMMIT$/));
        });

        it('is left alone once onboarding is completed: the profile is the tenant\'s own then, and an admin edit is not "prepared this for you"', async () => {
            onboarding.set(NEW, { status: 'completed', filled_by: 'tenant' });
            const reply = await patch(NEW, { version: 1, patch: { identity: { niche: 'a' } } });
            assert.equal(reply.status, 200);
            assert.deepEqual(onboarding.get(NEW), { status: 'completed', filled_by: 'tenant' });
            assert.deepEqual(reply.body.onboarding, { status: 'completed', filledBy: 'tenant' });
        });

        it('is not touched by a patch that changes nothing, nor by one that is refused', async () => {
            await patch(NEW, { version: 1, patch: { identity: { niche: '' } } });
            await patch(NEW, { version: 1, patch: { identity: { role: 'x'.repeat(41) } } });
            await patch(NEW, { version: 7, patch: { identity: { niche: 'x' } } });
            assert.deepEqual(onboarding.get(NEW), { status: 'invited', filled_by: null });
            assert.equal(db.ran(/^UPDATE onboarding /).length, 0);
        });

        it('a tenant with no onboarding row (D14: completed) saves fine, and no row is invented', async () => {
            onboarding.delete(NEW);
            const reply = await patch(NEW, { version: 1, patch: { identity: { niche: 'a' } } });
            assert.equal(reply.status, 200);
            assert.equal(onboarding.size, 0);
        });

        it('if marking it fails, the whole save does: a profile never changes without the wizard being told', async () => {
            db.failOn = /^UPDATE onboarding /;
            const reply = await patch(NEW, { version: 1, patch: { identity: { niche: 'a' } } });
            assert.equal(reply.status, 500);
            assert.equal(state.profiles.get(NEW)!.version, 1);
            assert.equal(stored(NEW).identity.niche, '');
            assert.deepEqual(state.versions, []);
            assert.deepEqual(audits, []);
        });
    });

    describe('the platform owner\'s no_women_imagery rule', () => {
        beforeEach(() => {
            store(OWNER, richProfile(), 3);
            creators.add(OWNER);
        });

        it('removing it from the owner\'s profile is 409 OWNER_RULE_LOCKED, and nothing is written, locked or audited', async () => {
            const reply = await patch(OWNER, { version: 3, patch: { content: { rules: [] } } });
            assert.equal(reply.status, 409);
            assert.equal(reply.body.code, 'OWNER_RULE_LOCKED');
            assert.match(reply.body.error, /confirm_remove_owner_rule/);
            assert.deepEqual(stored(OWNER).content.rules, ['no_women_imagery']);
            assert.deepEqual(writes(), []);
            assert.equal(db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length, 0);
            assert.deepEqual(audits, []);
        });

        it('goes through with confirm_remove_owner_rule: true, and is audited like any change: the section, never the value', async () => {
            const reply = await patch(OWNER, { version: 3, patch: { content: { rules: [] } }, confirm_remove_owner_rule: true });
            assert.equal(reply.status, 200);
            assert.equal(reply.body.version, 4);
            assert.deepEqual(reply.body.profile.content.rules, []);
            assert.equal(reply.body.isPlatformOwner, true);
            assert.deepEqual(audits.map((a) => a.detail), [{ paths: ['content'], version: 4, on_behalf: true }]);
            const sql = db.statements.map((s) => s.sql);
            assert.ok(sql.findIndex((x) => PLATFORM_OWNER_SQL.test(x)) > sql.indexOf('COMMIT'), 'who the owner is is asked only to answer, after the write: the check itself was skipped');
        });

        it('a confirmation that is not a boolean is a 400', async () => {
            const reply = await patch(OWNER, { version: 3, patch: { content: { rules: [] } }, confirm_remove_owner_rule: 'true' });
            assert.equal(reply.status, 400);
            assert.match(reply.body.error, /must be true or false/);
        });

        it('is nobody else\'s lock: the same removal on another tenant just happens, with no confirmation', async () => {
            const reply = await patch(NEW, { version: 1, patch: { content: { rules: [] } } });
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body.profile.content.rules, []);
        });

        it('every other change to the owner\'s profile is free, and leaves the rule where it was', async () => {
            const reply = await patch(OWNER, { version: 3, patch: { content: { custom_rules: ['No flash'] }, identity: { niche: 'n' } } });
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body.profile.content.rules, ['no_women_imagery']);
        });
    });

    describe('what it refuses', () => {
        it('is a 404 for a tenant that does not exist and for an id that is not a uuid, with nothing read or written for either', async () => {
            for (const id of [GONE, 'not-a-uuid']) {
                const reply = await patch(id, { version: 1, patch: { identity: { niche: 'x' } } });
                assert.equal(reply.status, 404, id);
                assert.deepEqual(reply.body, { error: 'Tenant not found.' });
            }
            assert.equal(db.ran(/creator_profile/).length, 0);
            assert.deepEqual(writes(), []);
        });

        it('is a 400 with every problem for a merge that is not a valid profile, and writes nothing', async () => {
            const reply = await patch(NEW, { version: 1, patch: { identity: { role: 'x'.repeat(41), timezone: 'Mars/Olympus' }, voice: { emoji: 'confetti' } } });
            assert.equal(reply.status, 400);
            assert.equal(reply.body.code, 'PROFILE_INVALID');
            assert.equal(reply.body.problems.length, 3, reply.body.problems.join(' | '));
            assert.deepEqual(writes(), []);
            assert.deepEqual(onboarding.get(NEW), { status: 'invited', filled_by: null });
        });

        it('is a 400 for a field the profile has no place for, and for a body that is not { version, patch }', async () => {
            for (const body of [{ version: 1, patch: { nonsense: 1 } }, { version: 1, patch: { identity: { nonsense: 1 } } }]) {
                assert.equal((await patch(NEW, body)).status, 400);
            }
            for (const body of [undefined, null, 'x', [], { version: 1 }, { version: 1, patch: {} }, { version: 1, patch: [] }, { version: '1', patch: { identity: { niche: 'x' } } }]) {
                const reply = await patch(NEW, body);
                assert.equal(reply.status, 400, JSON.stringify(body));
                assert.equal(reply.body.code, 'PROFILE_INVALID');
            }
            assert.deepEqual(writes(), []);
        });

        it('is a 503 with the migration to apply for a database without v33', async () => {
            db.v33 = false;
            const reply = await patch(NEW, { version: null, patch: { identity: { niche: 'x' } } });
            assert.equal(reply.status, 503);
            assert.equal(reply.body.code, 'PROFILE_STORAGE_MISSING');
        });
    });
});
