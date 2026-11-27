/** The Brand Kit's profile keys (contract §1.2, §1.3): what the validator accepts, and how a stored profile with or without them is read. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultProfile, newTenantProfile, upgradeProfile } from './defaults.js';
import { richProfile, throughJsonb } from './testSupport.js';
import type { CreatorProfile, LogoAsset } from './types.js';
import { LOGO_URL, logoAssetProblems, PROFILE_LIMITS, validateProfile } from './validate.js';

const URL = 'https://msg-response-auto.vercel.app/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23';
const asset = (over: Partial<LogoAsset> = {}): LogoAsset => ({
    url: URL, width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', added_at: '2026-12-01T09:30:00.000Z', ...over,
});
const withLogo = (main: unknown, logoUrl: string | null = URL): CreatorProfile => {
    const p = defaultProfile();
    p.brand.logo_url = logoUrl;
    (p.brand as Record<string, unknown>).logos = { main };
    return p;
};
const problems = (profile: unknown): string[] => {
    const out = validateProfile(profile);
    return 'problems' in out ? out.problems : [];
};

describe('validateProfile: the logo', () => {
    it('a profile with a good logo and its logo_url copy is valid, with or without the switch', () => {
        assert.deepEqual(problems(withLogo(asset())), []);
        const p = withLogo(asset());
        p.brand.use_brand_colours = true;
        assert.deepEqual(problems(p), []);
        p.brand.use_brand_colours = false;
        assert.deepEqual(problems(p), []);
    });

    it('a profile with neither key is valid, and so is newTenantProfile()', () => {
        assert.deepEqual(problems(defaultProfile()), []);
        assert.deepEqual(problems(newTenantProfile()), []);
        assert.deepEqual(problems(newTenantProfile({ lang: 'en' })), []);
    });

    it('use_brand_colours must be true or false', () => {
        const p = defaultProfile();
        (p.brand as Record<string, unknown>).use_brand_colours = 'yes';
        assert.deepEqual(problems(p), ['brand.use_brand_colours must be true or false']);
    });

    it('logos holds only `main`', () => {
        const p = withLogo(asset());
        (p.brand.logos as Record<string, unknown>).icon = asset();
        assert.deepEqual(problems(p), ['brand.logos.icon is not a profile field']);
        const q = defaultProfile();
        (q.brand as Record<string, unknown>).logos = 'x';
        assert.deepEqual(problems(q), ['brand.logos must be an object']);
    });

    it('url must be one of the tenant\'s uploads, with no .jpg, over https', () => {
        for (const url of ['http://a.example/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23', `${URL}.jpg`, 'https://a.example/api/uploads/not-a-uuid', 'https://a.example/other', 5]) {
            assert.ok(logoAssetProblems(asset({ url: url as string }), 'p').some((m) => /p\.url must be one of your uploads/.test(m)), String(url));
        }
        assert.equal(LOGO_URL.test(URL), true);
        assert.equal(LOGO_URL.test(`${URL}.jpg`), false);
    });

    it('width and height: whole numbers from 1 to 4096, short side at least 200, aspect from 1:4 to 8:1', () => {
        const at = (over: Partial<LogoAsset>): string[] => logoAssetProblems(asset(over), 'p');
        assert.deepEqual(at({ width: 200, height: 200 }), []);
        assert.deepEqual(at({ width: 4096, height: 4096 }), []);
        assert.deepEqual(at({ width: 1600, height: 200 }), [], '8:1');
        assert.deepEqual(at({ width: 200, height: 800 }), [], '1:4');
        assert.match(at({ width: 1200, height: 199 })[0]!, /the logo is too small/);
        assert.match(at({ width: 1700, height: 200 })[0]!, /too long or too tall/);
        assert.match(at({ width: 200, height: 801 })[0]!, /too long or too tall/);
        assert.deepEqual(at({ width: 4097, height: 400 }), ['p.width must be a whole number from 1 to 4096']);
        assert.deepEqual(at({ width: 0 }), ['p.width must be a whole number from 1 to 4096']);
        assert.deepEqual(at({ height: 400.5 }), ['p.height must be a whole number from 1 to 4096']);
    });

    it('alpha is a boolean, tone is light or dark, colour is #RRGGBB, added_at reads as a date and is at most 40 characters', () => {
        const at = (over: Record<string, unknown>): string[] => logoAssetProblems({ ...asset(), ...over }, 'p');
        assert.deepEqual(at({ alpha: 1 }), ['p.alpha must be true or false']);
        assert.deepEqual(at({ tone: 'grey' }), ['p.tone must be one of light, dark']);
        assert.deepEqual(at({ colour: '#12345' }), ['p.colour must be a colour like #FFD60A']);
        assert.deepEqual(at({ added_at: 'yesterday' }), ['p.added_at must be a date']);
        assert.deepEqual(at({ added_at: '2026-12-01T09:30:00.000Z' + ' '.repeat(30) }), ['p.added_at must be a date']);
    });

    it('a claim has no added_at (the server sets it); a stored logo must', () => {
        const { added_at: _gone, ...claim } = asset();
        assert.deepEqual(logoAssetProblems(claim, 'p'), []);
        assert.deepEqual(logoAssetProblems(claim, 'p', { stored: true }), ['p.added_at is required']);
        assert.ok(problems(withLogo(claim)).includes('brand.logos.main.added_at is required'));
    });

    it('every field is required, and an unknown one is refused', () => {
        const { url: _u, tone: _t, ...rest } = asset();
        assert.deepEqual(logoAssetProblems(rest, 'p'), ['p.url is required', 'p.tone is required']);
        assert.deepEqual(logoAssetProblems({ ...asset(), extra: 1 }, 'p'), ['p.extra is not a profile field']);
        assert.deepEqual(logoAssetProblems('x', 'p'), ['p must be an object']);
        assert.deepEqual(logoAssetProblems(null, 'p'), ['p must be an object']);
    });

    it('logo_url must be logos.main.url when a main exists (the backstop)', () => {
        const other = 'https://msg-response-auto.vercel.app/api/uploads/0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
        assert.deepEqual(problems(withLogo(asset(), other)), ['brand.logo_url must be brand.logos.main.url']);
        assert.deepEqual(problems(withLogo(asset(), null)), ['brand.logo_url must be brand.logos.main.url']);
    });

    it('the limits are the contract\'s', () => {
        assert.equal(PROFILE_LIMITS.logoMinSide, 200);
        assert.equal(PROFILE_LIMITS.logoMaxSide, 4096);
        assert.equal(PROFILE_LIMITS.logoMinAspect, 0.25);
        assert.equal(PROFILE_LIMITS.logoMaxAspect, 8);
        assert.equal(PROFILE_LIMITS.logoBytes, 3_000_000);
    });
});

describe('upgradeProfile: reading a stored profile', () => {
    it('without the keys: nothing is repaired, and no key appears (absent means off, no logo)', () => {
        for (const stored of [defaultProfile(), richProfile()]) {
            const { profile, repaired } = upgradeProfile(throughJsonb(stored));
            assert.deepEqual(repaired, []);
            assert.equal('use_brand_colours' in profile.brand, false);
            assert.equal('logos' in profile.brand, false);
        }
    });

    it('with the keys: they survive the stored trip as they were', () => {
        const p = withLogo(asset());
        p.brand.use_brand_colours = true;
        const { profile, repaired } = upgradeProfile(throughJsonb(p));
        assert.deepEqual(repaired, []);
        assert.deepEqual(profile.brand.logos, { main: asset() });
        assert.equal(profile.brand.use_brand_colours, true);
        assert.deepEqual(upgradeProfile(throughJsonb(newTenantProfile())).profile.brand.use_brand_colours, true);
    });

    it('a stored logos of the wrong types is dropped and noted as brand.logos', () => {
        for (const logos of ['x', { main: 'x' }, { main: { ...asset(), width: '1200' } }, { main: { ...asset(), tone: 'grey' } }, [1]]) {
            const stored = throughJsonb(defaultProfile()) as { brand: Record<string, unknown> };
            stored.brand.logos = logos;
            const { profile, repaired } = upgradeProfile(stored);
            assert.deepEqual(repaired, ['brand.logos'], JSON.stringify(logos));
            assert.equal('logos' in profile.brand, false);
        }
    });

    it('a switch of the wrong type is dropped and noted', () => {
        const stored = throughJsonb(defaultProfile()) as { brand: Record<string, unknown> };
        stored.brand.use_brand_colours = 'true';
        const { profile, repaired } = upgradeProfile(stored);
        assert.deepEqual(repaired, ['brand.use_brand_colours']);
        assert.equal('use_brand_colours' in profile.brand, false);
    });

    it('another slot key is kept as stored, so a rollback from Phase 2 drops nothing', () => {
        const stored = throughJsonb(withLogo(asset())) as unknown as { brand: { logos: Record<string, unknown> } };
        stored.brand.logos.on_dark = { url: 'whatever' };
        const { profile, repaired } = upgradeProfile(stored);
        assert.deepEqual(repaired, []);
        assert.deepEqual((profile.brand.logos as Record<string, unknown>).on_dark, { url: 'whatever' });
    });
});
