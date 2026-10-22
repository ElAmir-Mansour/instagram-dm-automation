/**
 * Boost's store, the pure parts: the Settings card's input, the stored settings read back, the month the cap counts, and the status a
 * Meta answer implies. The token family is encrypted at rest (isSecretSetting).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSecretSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from './appSettings.js';
import { nextStatus } from './adBoosts.js';
import { parseSettingsInput, parseStoredSettings, type AdsSettings } from './ads/settings.js';

const TENANT = '0b6f3c2e-1111-4222-8333-944445555666';
const EMPTY: AdsSettings = { adAccountId: null, maxDailyBudget: null, monthlyCap: null, tokenSource: null, tokenExpiresAt: null, businessId: null, defaultCountries: [], leadRetentionDays: 90 };
const LIMITS = { adAccountId: '509787248064459', maxDailyBudget: 10, monthlyCap: 100 };
const SET: AdsSettings = { ...LIMITS, tokenSource: null, tokenExpiresAt: null, businessId: null, defaultCountries: [], leadRetentionDays: 90 };

describe('ads settings storage', () => {
    it('encrypts the ads token, and only the token', () => {
        assert.equal(isSecretSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, TENANT)), true);
        assert.equal(isSecretSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, TENANT)), false);
    });

    it('reads what it wrote, and treats anything unreadable as not set (which refuses boosts)', () => {
        assert.deepEqual(parseStoredSettings(JSON.stringify(SET)), SET);
        assert.deepEqual(parseStoredSettings(null), EMPTY);
        assert.deepEqual(parseStoredSettings('{not json'), EMPTY);
        assert.deepEqual(parseStoredSettings(JSON.stringify({ adAccountId: 'x', maxDailyBudget: -1, monthlyCap: '100' })), EMPTY);
    });

    it('keeps where the token came from, and drops a source or date it does not know', () => {
        const connected = { ...SET, tokenSource: 'connect', tokenExpiresAt: '2026-12-21T10:00:00.000Z' } as const;
        assert.deepEqual(parseStoredSettings(JSON.stringify(connected)), connected);
        const odd = parseStoredSettings(JSON.stringify({ ...SET, tokenSource: 'stolen', tokenExpiresAt: 'soon' }));
        assert.equal(odd.tokenSource, null);
        assert.equal(odd.tokenExpiresAt, null);
    });
});

describe('parseSettingsInput', () => {
    it('accepts a full card, with act_ and amounts as strings', () => {
        const parsed = parseSettingsInput({ adAccountId: 'act_509787248064459', token: 'EAAB' + 'x'.repeat(40), maxDailyBudget: '10', monthlyCap: 100 }, EMPTY);
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.ok && parsed.value.settings, LIMITS);
        assert.equal(parsed.ok && parsed.value.token, 'EAAB' + 'x'.repeat(40));
    });

    it('leaves what is absent, and clears with an empty string', () => {
        const parsed = parseSettingsInput({ token: '' }, SET);
        assert.equal(parsed.ok, true);
        assert.deepEqual(parsed.ok && parsed.value, { settings: {}, token: null });
        const cleared = parseSettingsInput({ adAccountId: '' }, SET);
        assert.deepEqual(cleared.ok && cleared.value.settings, { adAccountId: null });
    });

    it('refuses a daily max above the monthly cap, against the saved values too', () => {
        const parsed = parseSettingsInput({ maxDailyBudget: 150 }, SET);
        assert.equal(!parsed.ok && parsed.field, 'maxDailyBudget');
        const capDown = parseSettingsInput({ monthlyCap: 5 }, SET);
        assert.equal(capDown.ok, false);
    });

    it('refuses nonsense, naming the field', () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{ adAccountId: 'my account' }, 'adAccountId'],
            [{ token: 'short' }, 'token'],
            [{ token: 'has spaces in it and is long enough' }, 'token'],
            [{ maxDailyBudget: 0 }, 'maxDailyBudget'],
            [{ monthlyCap: 'lots' }, 'monthlyCap'],
            [{ monthlyCap: 10_000_000 }, 'monthlyCap'],
        ];
        for (const [body, field] of cases) {
            const parsed = parseSettingsInput(body, EMPTY);
            assert.equal(!parsed.ok && parsed.field, field, JSON.stringify(body));
        }
        assert.equal(parseSettingsInput({}, SET).ok, false, 'nothing to save');
    });
});

describe('nextStatus', () => {
    const now = new Date('2026-10-22T10:00:00Z');
    const past = new Date('2026-10-21T10:00:00Z');
    const future = new Date('2026-10-25T10:00:00Z');

    it('completes an activated boost once its end passes', () => {
        assert.equal(nextStatus('active', 'ACTIVE', past, true, now), 'completed');
        assert.equal(nextStatus('paused', 'PAUSED', past, false, now), 'paused', 'a boost never activated does not complete');
    });

    it("believes Meta's ACTIVE (an activation that timed out but landed) and a pause made in Ads Manager", () => {
        assert.equal(nextStatus('paused', 'ACTIVE', future, true, now), 'active');
        assert.equal(nextStatus('active', 'CAMPAIGN_PAUSED', future, true, now), 'paused');
    });

    it('marks a deleted or archived ad deleted, and never revives a failed or deleted row', () => {
        assert.equal(nextStatus('paused', 'DELETED', future, false, now), 'deleted');
        assert.equal(nextStatus('failed', 'ACTIVE', future, false, now), 'failed');
        assert.equal(nextStatus('deleted', 'ACTIVE', future, true, now), 'deleted');
    });
});
