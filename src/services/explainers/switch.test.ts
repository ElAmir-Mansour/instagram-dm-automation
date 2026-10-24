/**
 * The per-tenant Explainers switch (`explainers.enabled.<tenant>`, data-model.md §6.2): off unless set, and in this version only the platform
 * owner can be switched on. The pool answers by SQL; `app_settings` is an in-memory map, and the owner is what `getPlatformOwnerId` finds.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { invalidateTenantCache } from '../tenant.js';
import { ExplainerError } from './errors.js';
import { isExplainersEnabled, setExplainersEnabled } from './switch.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const KEY = (tenant: string) => `explainers.enabled.${tenant}`;
const OWNER_SQL = /^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/;

let db: FakeDb;
/** `app_settings`, by key. */
let saved: Map<string, string>;
let writes: unknown[][];

beforeEach(() => {
    saved = new Map();
    writes = [];
    db = installFakeDb({ platformTenant: OWNER });
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, (p) => ({ rows: saved.has(p[0]) ? [{ value: saved.get(p[0]), is_secret: false }] : [] })],
        [/^INSERT INTO app_settings /, (p) => { writes.push(p); saved.set(p[0], p[1]); return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings /, (p) => { saved.delete(p[0]); return { rows: [], rowCount: 1 }; }],
    );
});
afterEach(() => db.restore());

const ownerOnly = (err: unknown) => err instanceof ExplainerError && err.code === 'EXPLAINERS_OWNER_ONLY' && err.status === 409;

describe('the setting', () => {
    it('is one key per tenant, `explainers.enabled.<tenant id>`', () => {
        assert.equal(TENANT_SETTING_PREFIXES.explainersEnabled, 'explainers.enabled.');
    });
});

describe('isExplainersEnabled', () => {
    it('is off by default: a tenant nobody has switched on does not see Explainers', async () => {
        assert.equal(await isExplainersEnabled(OWNER), false);
        assert.equal(await isExplainersEnabled(OTHER), false);
    });

    it('reads `explainers.enabled.<tenant>` from app_settings, for that tenant and no other', async () => {
        saved.set(KEY(OWNER), 'true');
        assert.equal(await isExplainersEnabled(OWNER), true);
        assert.equal(await isExplainersEnabled(OTHER), false, 'the owner’s row says nothing about another tenant');
        const [read] = db.ran(/FROM app_settings/);
        assert.deepEqual(read!.params, [KEY(OWNER)]);
    });

    it('is on only for the value "true": anything else is off, never a guess', async () => {
        for (const value of ['false', 'TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', '{"enabled":true}']) {
            saved.set(KEY(OWNER), value);
            assert.equal(await isExplainersEnabled(OWNER), false, JSON.stringify(value));
        }
    });

    it('is a thrown error, not an answer, when the settings cannot be read: a route turns that into a failure, not a "not available"', async () => {
        db.routes.unshift([/FROM app_settings/, () => { throw new Error('connection terminated'); }]);
        await assert.rejects(isExplainersEnabled(OWNER), /connection terminated/);
    });

    it('refuses a tenant id that is not the shape of one, so a request cannot choose another key', async () => {
        await assert.rejects(isExplainersEnabled('1/../../tiktok.client_secret'), /not a tenant id/);
        assert.equal(db.ran(/FROM app_settings/).length, 0);
    });
});

describe('setExplainersEnabled', () => {
    it('switches the owner on: "true", and who did it', async () => {
        await setExplainersEnabled(OWNER, true, ADMIN);
        assert.equal(saved.get(KEY(OWNER)), 'true');
        assert.deepEqual(writes[0], [KEY(OWNER), 'true', false, ADMIN]);
        assert.equal(await isExplainersEnabled(OWNER), true);
    });

    it('switches the owner off by removing the row, so "off" is the default again, not a stored value', async () => {
        saved.set(KEY(OWNER), 'true');
        await setExplainersEnabled(OWNER, false, ADMIN);
        assert.equal(saved.has(KEY(OWNER)), false);
        assert.equal(db.ran(/^DELETE FROM app_settings/).length, 1);
        assert.equal(await isExplainersEnabled(OWNER), false);
    });

    it('refuses to switch any other tenant on: EXPLAINERS_OWNER_ONLY, 409, and nothing is written', async () => {
        await assert.rejects(setExplainersEnabled(OTHER, true, ADMIN), ownerOnly);
        assert.equal(saved.size, 0);
        assert.equal(db.ran(/^INSERT INTO app_settings/).length, 0);
    });

    it('says why, in a sentence the operator can read', async () => {
        await assert.rejects(setExplainersEnabled(OTHER, true, ADMIN), /only for the platform owner/i);
    });

    it('takes the owner from getPlatformOwnerId: the first creator ever made', async () => {
        await setExplainersEnabled(OWNER, true, ADMIN);
        assert.equal(db.ran(OWNER_SQL).length, 1, 'the owner was looked up');
    });

    it('does not care what case the tenant id is written in: one key, the lower-case one, for the writer and the reader', async () => {
        // An id with letters in it (the other ids of this file are digits, which have no case).
        const LETTERS = 'abcdef12-3456-4789-8abc-def012345678';
        invalidateTenantCache();
        db.routes.unshift([OWNER_SQL, () => ({ rows: [{ id: LETTERS }] })]);
        await setExplainersEnabled(LETTERS.toUpperCase(), true, ADMIN);
        assert.deepEqual([...saved.keys()], [KEY(LETTERS)]);
        assert.equal(await isExplainersEnabled(LETTERS.toUpperCase()), true);
        assert.equal(await isExplainersEnabled(LETTERS), true);
        assert.equal(await isExplainersEnabled(OWNER), false, 'and it is that tenant’s key, not the owner’s');
    });

    it('refuses everyone when there is no owner yet (no creators at all)', async () => {
        invalidateTenantCache();
        db.routes.unshift([OWNER_SQL, () => ({ rows: [] })]);
        await assert.rejects(setExplainersEnabled(OWNER, true, ADMIN), ownerOnly);
        assert.equal(saved.size, 0);
    });

    it('leaves a switch alone when the owner cannot be looked up: the error goes up, nothing is written', async () => {
        invalidateTenantCache();
        db.routes.unshift([OWNER_SQL, () => { throw new Error('connection reset'); }]);
        await assert.rejects(setExplainersEnabled(OWNER, true, ADMIN), /connection reset/);
        assert.equal(saved.size, 0);
    });

    it('lets any tenant be switched OFF, so a stray row (hand-written SQL, an old build) can always be cleaned up', async () => {
        saved.set(KEY(OTHER), 'true');
        await setExplainersEnabled(OTHER, false, ADMIN);
        assert.equal(saved.has(KEY(OTHER)), false);
    });

    it('does not even look for the owner to switch a tenant off', async () => {
        await setExplainersEnabled(OTHER, false, ADMIN);
        assert.equal(db.ran(OWNER_SQL).length, 0);
    });

    it('records a change made by no operator (a script) with a null updated_by', async () => {
        await setExplainersEnabled(OWNER, true, null);
        assert.deepEqual(writes[0], [KEY(OWNER), 'true', false, null]);
    });
});
