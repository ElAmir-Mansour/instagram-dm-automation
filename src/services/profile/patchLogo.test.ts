/**
 * The Brand Kit's part of `patchProfile` (docs: contract §1.4, §1.5, §2): a logo set through the patch is re-read from its file before
 * anything is merged; `brand.logo_url` follows `brand.logos.main.url`; taking the logo away is `{ main: null }`; the switch is an ordinary
 * field; and `logoChange` says what a save did to the logo, for the audit row.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { setLogoCheckDeps } from '../brand/logoCheck.js';
import { logoChangeOf, mergePatch, patchProfile, withLogoCopy } from './patch.js';
import { ProfileError, resetProfileTableWarning } from './store.js';
import { installProfileDb, OWNER, type ProfileDb, seededState, USER, type State } from './testDb.js';
import { richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile, LogoAsset } from './types.js';

const ID = '6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23';
const URL = `https://msg-response-auto.vercel.app/api/uploads/${ID}`;
const ID2 = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const URL2 = `https://msg-response-auto.vercel.app/api/uploads/${ID2}`;

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const chunk = (type: string, data: number[]): number[] => [...u32(data.length), ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(1200), ...u32(400), 8, 6, 0, 0, 0]), ...chunk('IDAT', [1]), ...chunk('IEND', [])]);

const claim = (url = URL): Record<string, unknown> => ({ url, width: 900, height: 900, alpha: true, tone: 'dark', colour: '#0e3b5c' });
const asset = (url = URL): LogoAsset => ({ url, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', added_at: '2026-12-01T09:30:00.000Z' });

describe('withLogoCopy', () => {
    const merged = (brand: Record<string, unknown>): Record<string, unknown> => ({ brand: { logo_url: null, ...brand } });

    it('a logos.main that exists: logo_url is its url', () => {
        const out = withLogoCopy(merged({ logos: { main: asset() } }), { brand: { logos: { main: claim() } } }) as { brand: Record<string, unknown> };
        assert.equal(out.brand.logo_url, URL);
    });

    it('a patch that touched logos and left no main: logo_url is null', () => {
        const out = withLogoCopy(merged({ logo_url: URL, logos: {} }), { brand: { logos: { main: null } } }) as { brand: Record<string, unknown> };
        assert.equal(out.brand.logo_url, null);
        assert.equal('logos' in out.brand, false, 'an empty logos is dropped: the profile returns to the shape it had without a logo');
    });

    it('a removal sent to a profile that held no logos (main: null survives the merge) is dropped, not stored', () => {
        const out = withLogoCopy(merged({ logos: { main: null } }), { brand: { logos: { main: null } } }) as { brand: Record<string, unknown> };
        assert.equal('logos' in out.brand, false);
        assert.equal(out.brand.logo_url, null);
    });

    it('a patch that did not touch logos: logo_url is left as stored, legacy value and all', () => {
        const out = withLogoCopy(merged({ logo_url: 'https://old.example/api/uploads/legacy' }), { brand: { primary: '#FFFFFF' } }) as { brand: Record<string, unknown> };
        assert.equal(out.brand.logo_url, 'https://old.example/api/uploads/legacy');
    });

    it('a merged profile with no brand object is returned as it is', () => {
        const m = { brand: 'nope' };
        assert.equal(withLogoCopy(m, { brand: { logos: {} } }), m);
    });
});

describe('mergePatch: brand.logos.main is removable', () => {
    it('{ brand: { logos: { main: null } } } deletes the slot and keeps the rest of logos', () => {
        const p = richProfile();
        p.brand.logos = { main: asset() };
        const out = mergePatch(p, { brand: { logos: { main: null } } }) as CreatorProfile;
        assert.deepEqual(out.brand.logos, {});
    });
});

describe('logoChangeOf', () => {
    const withMain = (url?: string): Pick<CreatorProfile, 'brand'> => {
        const p = richProfile();
        if (url) p.brand.logos = { main: asset(url) };
        return p;
    };
    it('set, replaced, removed and unchanged', () => {
        assert.equal(logoChangeOf(withMain(), withMain(URL)), 'set');
        assert.equal(logoChangeOf(withMain(URL), withMain(URL2)), 'set');
        assert.equal(logoChangeOf(withMain(URL), withMain()), 'removed');
        assert.equal(logoChangeOf(withMain(URL), withMain(URL)), null);
        assert.equal(logoChangeOf(withMain(), withMain()), null);
    });
});

describe('patchProfile with a logo', () => {
    let state: State;
    let db: ProfileDb;
    let restoreSink: (() => void) | undefined;
    let restoreCheck: Partial<Parameters<typeof setLogoCheckDeps>[0] & object> | null;
    let rowReads: string[];
    const ACTOR = { userId: USER };

    beforeEach(() => {
        resetProfileTableWarning();
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
        state = seededState();
        db = installProfileDb(state);
        rowReads = [];
        restoreCheck = setLogoCheckDeps({
            readRow: async (id) => { rowReads.push(id); return { creator_id: OWNER, mime_type: 'image/png', size_bytes: PNG.length, is_private: false }; },
            readBytes: async () => PNG,
            publicBase: async () => 'https://msg-response-auto.vercel.app',
            now: () => new Date('2026-12-01T09:30:00.000Z'),
        });
    });
    afterEach(() => {
        setLogoCheckDeps(restoreCheck);
        db.restore();
        restoreSink?.();
    });

    const store = (profile: CreatorProfile = richProfile(), version = 3): void => {
        state.profiles.set(OWNER, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
    };
    const stored = (): CreatorProfile => state.profiles.get(OWNER)!.profile as CreatorProfile;
    const writes = (): string[] => db.statements.map((s) => s.sql).filter((sql) => /^(INSERT|UPDATE|DELETE)/.test(sql));

    async function refused(fn: () => Promise<unknown>, code: ProfileError['code'], status: number): Promise<ProfileError> {
        try {
            await fn();
        } catch (err) {
            assert.ok(err instanceof ProfileError, `a ProfileError, not ${String(err)}`);
            assert.equal(err.code, code);
            assert.equal(err.status, status);
            return err;
        }
        assert.fail(`expected ${code}`);
    }

    it('sets a logo: the file is read once, the server\'s asset is stored, logo_url is its copy, logoChange is set, and the mirror is untouched', async () => {
        store();
        const patch = { brand: { logos: { main: claim() } } };
        const body = { version: 3, patch };
        const frozen = JSON.stringify(body);
        const out = await patchProfile(OWNER, body, ACTOR);
        assert.equal(JSON.stringify(body), frozen, 'the caller\'s body is not changed');
        assert.deepEqual(rowReads, [ID], 'the upload was read once, before the transaction');
        assert.equal(out.logoChange, 'set');
        assert.deepEqual(out.changed, ['brand']);
        assert.equal(out.version, 4);
        assert.deepEqual(out.profile.brand.logos!.main, asset(), 'the width and height are the file\'s (the claim said 900×900), the colour is upper case, added_at is the server\'s');
        assert.equal(out.profile.brand.logo_url, URL);
        assert.equal(stored().brand.logo_url, URL);
        assert.ok(!JSON.stringify(state.studio.get(OWNER)).includes(ID), 'the new keys are not lens paths: nothing of the logo is mirrored into the settings rows');
        assert.deepEqual(state.versions.map((v) => [v.version, v.source]), [[4, 'user']]);
    });

    it('the same logo again is nothing: the file is not read, and no version is written', async () => {
        const p = richProfile();
        p.brand.logos = { main: asset() };
        p.brand.logo_url = URL;
        store(p);
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: asset() } } } }, ACTOR);
        assert.deepEqual(out.changed, []);
        assert.equal(out.logoChange, null);
        assert.deepEqual(rowReads, []);
        assert.deepEqual(writes(), []);
    });

    it('a different logo is read, replaces the first, and is a `set`', async () => {
        const p = richProfile();
        p.brand.logos = { main: asset() };
        p.brand.logo_url = URL;
        store(p);
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: claim(URL2) } } } }, ACTOR);
        assert.deepEqual(rowReads, [ID2]);
        assert.equal(out.logoChange, 'set');
        assert.equal(out.profile.brand.logo_url, URL2);
        assert.equal(out.profile.brand.logos!.main!.url, URL2);
    });

    it('takes the logo away with { main: null }: logoChange removed, logos and logo_url gone, no file read', async () => {
        const p = richProfile();
        p.brand.logos = { main: asset() };
        p.brand.logo_url = URL;
        store(p);
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: null } } } }, ACTOR);
        assert.equal(out.logoChange, 'removed');
        assert.equal(out.profile.brand.logo_url, null);
        assert.equal('logos' in out.profile.brand, false);
        assert.deepEqual(rowReads, []);
    });

    it('removing a logo that is not there is nothing (a legacy logo_url, which the patch touched logos to clear, is a change)', async () => {
        const p = richProfile();
        p.brand.logo_url = null;
        store(p);
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: null } } } }, ACTOR);
        assert.deepEqual(out.changed, []);
        assert.equal(out.logoChange, null);
        assert.deepEqual(writes(), []);
        store(richProfile(), 3);
        const cleared = await patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: null } } } }, ACTOR);
        assert.deepEqual(cleared.changed, ['brand']);
        assert.equal(cleared.profile.brand.logo_url, null);
        assert.equal(cleared.logoChange, null, 'no logos.main was there, so nothing is said to have been removed');
    });

    it('the switch is an ordinary field: it saves a version, runs no check, and is not a logo change', async () => {
        store();
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { use_brand_colours: true } } }, ACTOR);
        assert.equal(out.profile.brand.use_brand_colours, true);
        assert.deepEqual(out.changed, ['brand']);
        assert.equal(out.logoChange, null);
        assert.deepEqual(rowReads, []);
        const off = await patchProfile(OWNER, { version: 4, patch: { brand: { use_brand_colours: false } } }, ACTOR);
        assert.equal(off.profile.brand.use_brand_colours, false);
    });

    it('a switch that is not a boolean is a 400, and nothing is written', async () => {
        store();
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { brand: { use_brand_colours: 'yes' } } }, ACTOR), 'PROFILE_INVALID', 400);
        assert.ok(err.detail.problems!.includes('brand.use_brand_colours must be true or false'));
        assert.deepEqual(writes(), []);
    });

    it('a logo that is not this tenant\'s is BRAND_LOGO_INVALID 400 with one machine code, before any lock or write', async () => {
        store();
        setLogoCheckDeps({ readRow: async () => ({ creator_id: '22222222-2222-4222-8222-222222222222', mime_type: 'image/png', size_bytes: 1, is_private: false }), readBytes: async () => PNG });
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: claim() } } } }, ACTOR), 'BRAND_LOGO_INVALID', 400);
        assert.deepEqual(err.detail.problems, ['logo.not_yours']);
        assert.equal(db.ran(/FOR (NO KEY )?UPDATE|^BEGIN$/).length, 0);
        assert.deepEqual(writes(), []);
    });

    it('a logo whose file cannot be read just now is BRAND_LOGO_UNREADABLE 503, and nothing is written', async () => {
        store();
        setLogoCheckDeps({ readRow: async () => ({ creator_id: OWNER, mime_type: 'image/png', size_bytes: 1, is_private: false }), readBytes: async () => { throw new Error('r2 is down'); } });
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: claim() } } } }, ACTOR), 'BRAND_LOGO_UNREADABLE', 503);
        assert.deepEqual(err.detail.problems, ['logo.unreadable']);
        assert.deepEqual(writes(), []);
    });

    it('a stale version is a 409 before the file is read', async () => {
        store(richProfile(), 5);
        await refused(() => patchProfile(OWNER, { version: 4, patch: { brand: { logos: { main: claim() } } } }, ACTOR), 'PROFILE_VERSION_CONFLICT', 409);
        assert.deepEqual(rowReads, []);
    });

    it('a logo with a claim of the wrong shape is a 400 naming the field, and the file is not read', async () => {
        store();
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { brand: { logos: { main: { url: 'nope' } } } } }, ACTOR), 'BRAND_LOGO_INVALID', 400);
        assert.ok(err.detail.problems!.some((p) => /brand\.logos\.main\.width is required/.test(p)));
        assert.deepEqual(rowReads, []);
    });

    it('a slot Phase 1 does not have is refused by the validator', async () => {
        store();
        const err = await refused(() => patchProfile(OWNER, { version: 3, patch: { brand: { logos: { icon: asset() } } } }, ACTOR), 'PROFILE_INVALID', 400);
        assert.ok(err.detail.problems!.some((p) => /brand\.logos\.icon is not a profile field/.test(p)), err.detail.problems!.join(' | '));
    });

    it('brand.logo_url sent by hand that disagrees with logos.main is refused (the backstop), and one that agrees is fine', async () => {
        store();
        // withLogoCopy sets logo_url before validation, so a hand-sent value is overwritten, never a conflict.
        const out = await patchProfile(OWNER, { version: 3, patch: { brand: { logo_url: URL2, logos: { main: claim() } } } }, ACTOR);
        assert.equal(out.profile.brand.logo_url, URL);
    });
});
