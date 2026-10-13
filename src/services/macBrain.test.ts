/**
 * The Mac-brain guard (G1): who the operator's Mac may work for. The pool answers by SQL; the list is an
 * in-memory `app_settings` row, and the owner is what `getPlatformOwnerId` finds: the first creator ever made,
 * active or not. The owner is always allowed; the list only adds tenants.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../utils/log.js';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import { APP_SETTING_KEYS } from './appSettings.js';
import {
    assertMacBrainAllowed, getMacBrainTenants, isMacBrainAllowed, isMacBrainJob, MacBrainRefused, MAX_MAC_BRAIN_TENANTS,
    NEEDS_API_BRAIN, NEEDS_API_BRAIN_MESSAGE, parseMacBrainTenants, saveMacBrainTenants,
} from './macBrain.js';
import { StudioError } from './studio/common.js';
import { invalidateTenantCache } from './tenant.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const NEW_TENANT = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const KEY = 'studio.mac_brain_tenants';

let logs: { level: string; event: string }[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    const previous = setLogSink((level, line) => { logs.push({ level, event: JSON.parse(line).event }); });
    restoreSink = () => setLogSink(previous);
});
after(() => restoreSink?.());

let db: FakeDb;
/** The raw value of `studio.mac_brain_tenants`; null is "not saved". */
let saved: string | null;
/** When true, reading `app_settings` fails as a database outage would. */
let settingFails: boolean;

beforeEach(() => {
    logs = [];
    saved = null;
    settingFails = false;
    db = installFakeDb({ platformTenant: OWNER });
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => {
            if (settingFails) throw new Error('connection terminated');
            return { rows: p[0] === KEY && saved !== null ? [{ value: saved, is_secret: false }] : [] };
        }],
        [/^INSERT INTO app_settings /, (p) => { if (p[0] === KEY) saved = p[1]; return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings /, (p) => { if (p[0] === KEY) saved = null; return { rows: [], rowCount: 1 }; }],
    );
});
afterEach(() => db.restore());

describe('the setting', () => {
    it('is a closed key, not a secret', () => {
        assert.equal(APP_SETTING_KEYS.studioMacBrainTenants, KEY);
    });
});

describe('parseMacBrainTenants', () => {
    it('reads a JSON list of creator ids, lower-cased and without repeats', () => {
        assert.deepEqual(parseMacBrainTenants(JSON.stringify([OWNER, NEW_TENANT.toUpperCase(), OWNER])), [OWNER, NEW_TENANT]);
        assert.deepEqual(parseMacBrainTenants('[]'), [], 'an empty list is a list: nobody besides the owner');
    });

    it('is null for anything else, so it is never half-read', () => {
        for (const raw of [
            'not json', '{}', '"11111111-1111-4111-8111-111111111111"', 'null', `[${JSON.stringify(OWNER)}, 42]`, '["abc"]',
            JSON.stringify([OWNER, 'ffffffff-ffff-ffff-ffff-fffffffffff']),
            JSON.stringify(Array.from({ length: MAX_MAC_BRAIN_TENANTS + 1 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)),
        ]) {
            assert.equal(parseMacBrainTenants(raw), null, raw.slice(0, 60));
        }
    });
});

describe('getMacBrainTenants — the owner is always allowed; the list adds tenants', () => {
    it('with nothing saved is the owner alone: he needs no configuration', async () => {
        assert.deepEqual(await getMacBrainTenants(), { owner: OWNER, extra: [], tenants: [OWNER], source: 'default' });
        assert.equal(await isMacBrainAllowed(OWNER), true);
    });

    it('with nothing saved refuses a tenant created later', async () => {
        assert.equal(await isMacBrainAllowed(NEW_TENANT), false);
    });

    it('answers the owner before reading the list, so a failing settings read never refuses him', async () => {
        assert.equal(await isMacBrainAllowed(OWNER), true, 'warms the owner lookup');
        settingFails = true;
        assert.equal(await isMacBrainAllowed(OWNER), true);
        await assertMacBrainAllowed(OWNER);
        await assert.rejects(isMacBrainAllowed(NEW_TENANT), /connection terminated/, 'anyone else: an error, never a yes');
    });

    it('with no creators at all nobody is allowed, a saved list or not', async () => {
        db.restore();
        db = installFakeDb();
        db.routes.push([/^SELECT value, is_secret FROM app_settings/, () => ({ rows: saved === null ? [] : [{ value: saved, is_secret: false }] })]);
        invalidateTenantCache();
        assert.deepEqual(await getMacBrainTenants(), { owner: null, extra: [], tenants: [], source: 'default' });
        assert.equal(await isMacBrainAllowed(OWNER), false);

        saved = JSON.stringify([NEW_TENANT]);
        assert.deepEqual((await getMacBrainTenants()).tenants, []);
        assert.equal(await isMacBrainAllowed(NEW_TENANT), false);
    });

    it('a saved [] is the owner alone: it only adds, so it can never lock him out', async () => {
        saved = '[]';
        assert.deepEqual(await getMacBrainTenants(), { owner: OWNER, extra: [], tenants: [OWNER], source: 'database' });
        assert.equal(await isMacBrainAllowed(OWNER), true);
        assert.equal(await isMacBrainAllowed(NEW_TENANT), false);
    });

    it('a saved list adds tenants to the owner: he and the listed one are allowed, a third is refused', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        assert.deepEqual(await getMacBrainTenants(), { owner: OWNER, extra: [NEW_TENANT], tenants: [OWNER, NEW_TENANT], source: 'database' });
        assert.equal(await isMacBrainAllowed(OWNER), true, 'a list that does not name him does not take him off');
        assert.equal(await isMacBrainAllowed(NEW_TENANT), true);
        assert.equal(await isMacBrainAllowed(THIRD), false);
    });

    it('naming the owner in the list changes nothing: he is listed once', async () => {
        saved = JSON.stringify([OWNER, NEW_TENANT]);
        const now = await getMacBrainTenants();
        assert.deepEqual(now.tenants, [OWNER, NEW_TENANT]);
        assert.deepEqual(now.extra, [OWNER, NEW_TENANT], 'the saved list, as saved');
    });

    it('matches an id whatever its case', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        assert.equal(await isMacBrainAllowed(NEW_TENANT.toUpperCase()), true);
        assert.equal(await isMacBrainAllowed(OWNER.toUpperCase()), true);
    });

    it('a saved value that is not a list is logged and ignored: the owner alone, the narrowest answer', async () => {
        for (const raw of ['garbage', '{"a":1}', `["${OWNER}","nope"]`]) {
            saved = raw;
            logs = [];
            assert.deepEqual(await getMacBrainTenants(), { owner: OWNER, extra: [], tenants: [OWNER], source: 'default' }, raw);
            assert.equal(await isMacBrainAllowed(OWNER), true, raw);
            assert.equal(await isMacBrainAllowed(NEW_TENANT), false, raw);
            assert.ok(logs.some((l) => l.level === 'warn' && l.event === 'studio.mac_brain_setting_unreadable'), raw);
        }
    });

    it('reads the setting on every call, so a list saved elsewhere reaches a warm instance', async () => {
        assert.equal(await isMacBrainAllowed(NEW_TENANT), false);
        saved = JSON.stringify([NEW_TENANT]);
        assert.equal(await isMacBrainAllowed(NEW_TENANT), true);
    });
});

describe('the owner is the first creator ever made, not the first active one', () => {
    const SECOND = NEW_TENANT;
    /** The creators table: the owner, deactivated, and a later tenant that is active. */
    const creators = [
        { id: OWNER, is_active: false, created_at: new Date('2026-05-18T00:00:00Z') },
        { id: SECOND, is_active: true, created_at: new Date('2026-10-13T00:00:00Z') },
    ];

    beforeEach(() => {
        db.restore();
        db = installFakeDb();
        invalidateTenantCache();
        db.routes.push(
            // What the real statements would answer: `getPlatformOwnerId` takes no filter, `getActiveCreatorId` takes is_active.
            [/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/, () => ({ rows: [{ id: [...creators].sort((a, b) => +a.created_at - +b.created_at || a.id.localeCompare(b.id))[0]!.id }] })],
            [/^SELECT id FROM creators WHERE is_active = true ORDER BY created_at LIMIT 1$/, () => ({ rows: [{ id: creators.find((c) => c.is_active)!.id }] })],
            [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, () => ({ rows: saved === null ? [] : [{ value: saved, is_secret: false }] })],
        );
    });

    it('owner deactivated, another tenant active: the owner is still allowed, the other refused', async () => {
        assert.equal(await isMacBrainAllowed(OWNER), true);
        assert.equal(await isMacBrainAllowed(SECOND), false);
        assert.deepEqual((await getMacBrainTenants()).owner, OWNER);
    });

    it('asks for no `is_active` anywhere: deactivating the owner cannot hand the Mac to tenant #2', async () => {
        await isMacBrainAllowed(SECOND);
        const [ownerQuery] = db.ran(/FROM creators/);
        assert.doesNotMatch(ownerQuery!.sql, /is_active/);
        assert.equal(db.ran(/is_active/).length, 0);
    });

    it('breaks a tie in creation time by id, so there is one owner, always the same', async () => {
        creators.push({ id: '00000000-0000-4000-8000-000000000001', is_active: true, created_at: creators[0]!.created_at });
        try {
            assert.equal((await getMacBrainTenants()).owner, '00000000-0000-4000-8000-000000000001');
        } finally {
            creators.pop();
        }
    });

    it('is cached for 30 seconds like the active creator, and a miss is not cached', async () => {
        await isMacBrainAllowed(OWNER);
        await isMacBrainAllowed(OWNER);
        assert.equal(db.ran(/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/).length, 1);
        invalidateTenantCache();
        await isMacBrainAllowed(OWNER);
        assert.equal(db.ran(/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/).length, 2, 'invalidated with the rest');
    });
});

describe('assertMacBrainAllowed', () => {
    it('lets the owner through with no configuration, and with any saved list', async () => {
        await assertMacBrainAllowed(OWNER);
        saved = '[]';
        await assertMacBrainAllowed(OWNER);
        saved = JSON.stringify([NEW_TENANT]);
        await assertMacBrainAllowed(OWNER);
    });

    it('refuses anyone else with a 409 NEEDS_API_BRAIN that says why, and logs it', async () => {
        await assert.rejects(assertMacBrainAllowed(NEW_TENANT), (err: unknown) => {
            assert.ok(err instanceof MacBrainRefused);
            assert.ok(err instanceof StudioError, 'the Studio routes answer it as they answer every refusal');
            assert.equal(err.status, 409);
            assert.equal(err.code, NEEDS_API_BRAIN);
            assert.equal(err.code, 'NEEDS_API_BRAIN');
            assert.equal(err.creatorId, NEW_TENANT);
            assert.equal(err.message, 'This tenant\'s AI work can\'t run on the operator\'s Mac; it needs the AI providers layer (coming).');
            assert.equal(err.message, NEEDS_API_BRAIN_MESSAGE);
            return true;
        });
        assert.ok(logs.some((l) => l.level === 'warn' && l.event === 'studio.mac_brain_refused'));
    });

    it('answers with the status asked for (the settings are a 400)', async () => {
        await assert.rejects(assertMacBrainAllowed(NEW_TENANT, 400), (err: unknown) => err instanceof MacBrainRefused && err.status === 400);
    });

    it('is a thrown error, never a yes, for anyone but the owner when the list cannot be read', async () => {
        db.routes.unshift([/FROM app_settings/, () => { throw new Error('connection reset'); }]);
        await assert.rejects(assertMacBrainAllowed(NEW_TENANT), /connection reset/);
        await assertMacBrainAllowed(OWNER);
    });
});

describe('isMacBrainJob', () => {
    it('is true for every think, and for an infographic with `write` in its payload', () => {
        assert.equal(isMacBrainJob('monteur_think', {}), true);
        assert.equal(isMacBrainJob('render_infographic', { infographicId: 'x', write: { model: 'm' } }), true);
        assert.equal(isMacBrainJob('render_infographic', { write: null }), true, 'the key being there is enough');
    });

    it('is false for a render alone, and for every other kind', () => {
        assert.equal(isMacBrainJob('render_infographic', { infographicId: 'x', spec: {} }), false);
        assert.equal(isMacBrainJob('render_infographic', null), false);
        for (const kind of ['scan_library', 'index_lesson', 'render_carousel', 'pick_folder', 'monteur_scan', 'monteur_transcribe', 'monteur_render'] as const) {
            assert.equal(isMacBrainJob(kind, { write: {} }), false, kind);
        }
    });
});

describe('saveMacBrainTenants', () => {
    it('saves the list as JSON, lower-cased and without repeats, and reports what is now in force', async () => {
        const now = await saveMacBrainTenants([NEW_TENANT.toUpperCase(), THIRD, NEW_TENANT], 'user-1');
        assert.deepEqual(now, { owner: OWNER, extra: [NEW_TENANT, THIRD], tenants: [OWNER, NEW_TENANT, THIRD], source: 'database' });
        assert.equal(saved, JSON.stringify([NEW_TENANT, THIRD]));
        const [write] = db.ran(/^INSERT INTO app_settings/);
        assert.deepEqual([write!.params[0], write!.params[2], write!.params[3]], [KEY, false, 'user-1'], 'not a secret');
    });

    it('saves an empty list as a list: nobody besides the owner', async () => {
        assert.deepEqual(await saveMacBrainTenants([], null), { owner: OWNER, extra: [], tenants: [OWNER], source: 'database' });
        assert.equal(saved, '[]');
    });

    it('null forgets the list: the owner alone, from the default', async () => {
        saved = JSON.stringify([NEW_TENANT]);
        assert.deepEqual(await saveMacBrainTenants(null, null), { owner: OWNER, extra: [], tenants: [OWNER], source: 'default' });
        assert.equal(saved, null);
    });
});
