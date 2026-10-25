/**
 * The usage headers Meta sends with every Marketing API answer (research R5), read into numbers the pacer can act on. A header that is not
 * there is "Meta did not say" (`null`), never 0%: a pacer that read a missing header as "nothing used" would spend the whole budget blind.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { headerValue, parseAdAccountUsage, parseBusinessUseCase, parseInsightsThrottle, readUsage, usagePercent } from './metaUsage.js';

describe('parseAdAccountUsage (X-Ad-Account-Usage)', () => {
    it('reads the percentage, the reset in seconds and the access tier', () => {
        const u = parseAdAccountUsage({ 'x-ad-account-usage': JSON.stringify({ acc_id_util_pct: 9.67, reset_time_duration: 120, ads_api_access_tier: 'development_access' }) });
        assert.deepEqual(u, { utilPct: 9.67, resetSeconds: 120, tier: 'development_access' });
    });

    it('is null when the header is missing, empty or not JSON', () => {
        assert.equal(parseAdAccountUsage({}), null);
        assert.equal(parseAdAccountUsage({ 'x-ad-account-usage': '' }), null);
        assert.equal(parseAdAccountUsage({ 'x-ad-account-usage': 'nope' }), null);
        assert.equal(parseAdAccountUsage(undefined), null);
    });

    it('keeps a missing field null instead of making it 0', () => {
        assert.deepEqual(parseAdAccountUsage({ 'x-ad-account-usage': JSON.stringify({ ads_api_access_tier: 'standard_access' }) }), { utilPct: null, resetSeconds: null, tier: 'standard_access' });
    });

    it('reads the header in any case, and from axios headers with get()', () => {
        assert.equal(parseAdAccountUsage({ 'X-Ad-Account-Usage': JSON.stringify({ acc_id_util_pct: 3 }) })?.utilPct, 3);
        const axiosLike = { get: (n: string) => (n.toLowerCase() === 'x-ad-account-usage' ? JSON.stringify({ acc_id_util_pct: 4 }) : undefined) };
        assert.equal(parseAdAccountUsage(axiosLike)?.utilPct, 4);
        assert.equal(headerValue({ 'Facebook-API-Version': 'v26.0' }, 'facebook-api-version'), 'v26.0');
    });
});

describe('parseBusinessUseCase (X-Business-Use-Case-Usage and X-Business-Use-Case)', () => {
    const body = { '123456': [{ type: 'ads_management', call_count: 28, total_cputime: 25, total_time: 25, estimated_time_to_regain_access: 7, ads_api_access_tier: 'development_access' }] };

    it('reads each business entry, with the minutes until access returns', () => {
        assert.deepEqual(parseBusinessUseCase({ 'x-business-use-case-usage': JSON.stringify(body) }), [
            { businessId: '123456', type: 'ads_management', callCount: 28, totalCputime: 25, totalTime: 25, regainMinutes: 7, tier: 'development_access' },
        ]);
    });

    it('reads the X-Business-Use-Case spelling too, and both at once', () => {
        assert.equal(parseBusinessUseCase({ 'x-business-use-case': JSON.stringify(body) })?.[0]?.regainMinutes, 7);
        const both = parseBusinessUseCase({ 'x-business-use-case-usage': JSON.stringify(body), 'x-business-use-case': JSON.stringify({ '9': [{ type: 'ads_insights', call_count: 1 }] }) });
        assert.equal(both?.length, 2);
        assert.equal(both?.[1]?.regainMinutes, null);
    });

    it('is null when neither header is there', () => {
        assert.equal(parseBusinessUseCase({}), null);
        assert.equal(parseBusinessUseCase({ 'x-business-use-case-usage': '{bad' }), null);
    });
});

describe('parseInsightsThrottle (X-FB-Ads-Insights-Throttle)', () => {
    it('reads both percentages and the tier', () => {
        assert.deepEqual(parseInsightsThrottle({ 'x-fb-ads-insights-throttle': JSON.stringify({ app_id_util_pct: 1.5, acc_id_util_pct: 20, ads_api_access_tier: 'standard_access' }) }), { appUtilPct: 1.5, accUtilPct: 20, tier: 'standard_access' });
    });
    it('is null when missing', () => {
        assert.equal(parseInsightsThrottle({}), null);
    });
});

describe('readUsage', () => {
    it('gathers everything, with the tier from whichever header said it and the served version', () => {
        const u = readUsage({
            'x-business-use-case-usage': JSON.stringify({ '1': [{ type: 'ads_management', call_count: 2, ads_api_access_tier: 'development_access' }] }),
            'facebook-api-version': 'v26.0',
        });
        assert.equal(u.adAccount, null);
        assert.equal(u.tier, 'development_access');
        assert.equal(u.servedVersion, 'v26.0');
        assert.equal(u.regainMinutes, null);
    });

    it('says nothing at all for an answer with no usage headers', () => {
        assert.deepEqual(readUsage({}), { adAccount: null, buc: null, insights: null, tier: null, servedVersion: null, regainMinutes: null });
    });

    it('takes the longest wait any business entry names', () => {
        const u = readUsage({ 'x-business-use-case-usage': JSON.stringify({ '1': [{ estimated_time_to_regain_access: 3 }, { estimated_time_to_regain_access: 11 }] }) });
        assert.equal(u.regainMinutes, 11);
    });
});

describe('usagePercent (shared with the Growth sync)', () => {
    it('is the highest call_count / cputime / time over X-App-Usage and X-Business-Use-Case-Usage, or 0', () => {
        assert.equal(usagePercent({ 'x-app-usage': JSON.stringify({ call_count: 12, total_cputime: 40, total_time: 5 }) }), 40);
        assert.equal(usagePercent({ 'x-business-use-case-usage': JSON.stringify({ '1': [{ call_count: 81 }] }) }), 81);
        assert.equal(usagePercent({}), 0);
    });
});
