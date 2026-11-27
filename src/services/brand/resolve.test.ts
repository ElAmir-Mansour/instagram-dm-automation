import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contrastRatio } from '../onboarding/colour.js';
import { defaultProfile, newTenantProfile, upgradeProfile } from '../profile/defaults.js';
import { profileFromLegacy } from '../profile/legacy.js';
import { throughJsonb } from '../profile/testSupport.js';
import type { CreatorProfile, LogoAsset } from '../profile/types.js';
import { ELAMIR_GROWTH, ELAMIR_SETTINGS } from '../studio/testFixtures.js';
import { brandColours, mix, NO_BRAND, readableOn, renderBrandOf } from './resolve.js';

const LOGO: LogoAsset = {
    url: 'https://msg-response-auto.vercel.app/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23',
    width: 1200, height: 400, alpha: true, tone: 'dark', colour: '#0E3B5C', added_at: '2026-12-01T09:30:00.000Z',
};

const withBrand = (extra: Partial<CreatorProfile['brand']>): CreatorProfile => {
    const p = defaultProfile();
    p.brand = { ...p.brand, ...extra };
    return p;
};

describe('renderBrandOf: the owner and every profile without the keys are NO_BRAND (I1)', () => {
    it('profileFromLegacy(ELAMIR_SETTINGS)', () => {
        assert.equal(renderBrandOf(profileFromLegacy(ELAMIR_SETTINGS, ELAMIR_GROWTH)), NO_BRAND);
    });

    it('its stored trip through JSONB and the reader', () => {
        const { profile, repaired } = upgradeProfile(throughJsonb(profileFromLegacy(ELAMIR_SETTINGS, ELAMIR_GROWTH)));
        assert.deepEqual(repaired, []);
        assert.equal(renderBrandOf(profile), NO_BRAND);
    });

    it('a stored profile without the keys', () => {
        const { profile } = upgradeProfile(throughJsonb(defaultProfile()));
        assert.equal('use_brand_colours' in profile.brand, false);
        assert.equal('logos' in profile.brand, false);
        assert.equal(renderBrandOf(profile), NO_BRAND);
    });

    it('use_brand_colours: false, and defaultProfile()', () => {
        assert.equal(renderBrandOf(withBrand({ use_brand_colours: false })), NO_BRAND);
        assert.equal(renderBrandOf(defaultProfile()), NO_BRAND);
    });

    it('a guard: the switch is not in defaultProfile() (a true there would switch every stored profile on)', () => {
        assert.equal('use_brand_colours' in defaultProfile().brand, false);
        assert.equal('logos' in defaultProfile().brand, false);
        assert.equal('use_brand_colours' in defaultProfile({ lang: 'en' }).brand, false);
    });
});

describe('renderBrandOf: a new tenant, a logo, the switch', () => {
    it('newTenantProfile() has colours and no logo', () => {
        const brand = renderBrandOf(newTenantProfile());
        assert.equal(brand.logo, null);
        assert.notEqual(brand.colours, null);
        assert.deepEqual(brand.colours, brandColours(defaultProfile().brand.primary, defaultProfile().brand.accent));
    });

    it('newTenantProfile() is defaultProfile() with only the switch added', () => {
        const expected = defaultProfile({ lang: 'en', rules: ['no_women_imagery'] });
        expected.brand.use_brand_colours = true;
        assert.deepEqual(newTenantProfile({ lang: 'en', rules: ['no_women_imagery'] }), expected);
    });

    it('a logo alone: its six keys in the worker\'s order, without added_at, and no colours', () => {
        const brand = renderBrandOf(withBrand({ logos: { main: LOGO }, logo_url: LOGO.url }));
        assert.equal(brand.colours, null);
        assert.equal(JSON.stringify(brand.logo), '{"url":"https://msg-response-auto.vercel.app/api/uploads/6f1c2a90-3b7e-4d21-9a55-0c8e7d4b1f23","width":1200,"height":400,"alpha":true,"tone":"dark","colour":"#0E3B5C"}');
    });

    it('reads logos.main only, never the logo_url copy', () => {
        assert.equal(renderBrandOf(withBrand({ logo_url: LOGO.url })), NO_BRAND);
    });

    it('the switch only when it is exactly true', () => {
        assert.notEqual(renderBrandOf(withBrand({ use_brand_colours: true })).colours, null);
        assert.equal(renderBrandOf(withBrand({ use_brand_colours: 'true' as unknown as boolean })).colours, null);
    });
});

describe('brandColours, mix, readableOn', () => {
    it('the neutral defaults are the contract\'s example: the accent already reads, so it is unchanged', () => {
        assert.deepEqual(brandColours('#0E3B5C', '#F2A33A'), { carouselInk: '#030B11', carouselAccent: '#F2A33A', reelAccent: '#F2A33A', explainerTitle: '#F2A33A' });
    });

    it('mix is per channel round(a + (b - a) * k), upper case', () => {
        assert.equal(mix('#0E3B5C', '#000000', 0.82), '#030B11');
        assert.equal(mix('#000000', '#FFFFFF', 0.5), '#808080');
        assert.equal(mix('#abcdef', '#000000', 0), '#ABCDEF');
    });

    it('readableOn reaches the minimum, the step before it did not, and white is the last resort', () => {
        const bg = '#08080A';
        const out = readableOn('#222233', bg);
        assert.ok(contrastRatio(out, bg) >= 4.5);
        // The step before the first that reads: find its index and check it did not.
        let i = 0;
        while (mix('#222233', '#FFFFFF', i * 0.025) !== out) i++;
        assert.ok(i > 0, 'a dark colour had to be lightened');
        assert.ok(contrastRatio(mix('#222233', '#FFFFFF', (i - 1) * 0.025), bg) < 4.5);
        // Nothing reads on white at 4.5 when the background is white itself: white is returned.
        assert.equal(readableOn('#EEEEEE', '#FFFFFF', 21), '#FFFFFF');
        // A colour that already reads is returned as it is.
        assert.equal(readableOn('#F2A33A', '#000000'), '#F2A33A');
    });

    it('a dark accent is lightened on each surface it is drawn on', () => {
        const c = brandColours('#0E3B5C', '#1B2A41');
        assert.ok(contrastRatio(c.carouselAccent, c.carouselInk) >= 4.5);
        assert.ok(contrastRatio(c.reelAccent, '#08080A') >= 4.5);
        assert.ok(contrastRatio(c.explainerTitle, '#000000') >= 4.5);
        assert.notEqual(c.reelAccent, '#1B2A41');
    });

    it('an invalid colour reads as the worker\'s fallback for it', () => {
        assert.deepEqual(brandColours('nope', 'also nope'), brandColours('#0E3B5C', '#F2A33A'));
    });
});
