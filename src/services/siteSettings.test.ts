/**
 * Settings → Public site: which value the public pages print, and what the operator's typing
 * is normalised to. A wrong answer here is silent — the landing page simply shows the old
 * email, or a WhatsApp link to a number with a `+` in it that wa.me refuses.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import {
    DEFAULT_CONTACT_EMAIL, describeSiteSettings, getSiteSettings, normaliseContactEmail, normaliseIsoDay,
    normaliseWhatsappNumber, siteSettingsFromEnv,
} from './appSettings.js';

const ENV_KEYS = ['SITE_WHATSAPP_NUMBER', 'SITE_CONTACT_EMAIL', 'SITE_EID_COUPONS_EXPIRE'] as const;
let savedEnv: Record<string, string | undefined>;
let originalQuery: typeof pool.query;

/** app_settings holding exactly these keys (none are secrets). */
function settingsHold(rows: Record<string, string>): string[] {
    const asked: string[] = [];
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        assert.match(sql, /FROM app_settings WHERE key = \$1/);
        const key = String(params[0]);
        asked.push(key);
        if (!(key in rows)) return { rows: [], rowCount: 0 };
        return { rows: [{ value: rows[key], is_secret: false }], rowCount: 1 };
    };
    return asked;
}

beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
    originalQuery = pool.query;
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
});

describe('normaliseWhatsappNumber', () => {
    it('keeps E.164 digits and strips the + / 00 prefix, spaces, dashes and brackets', () => {
        for (const input of [
            '966501234567', '+966501234567', '00966501234567', '+966 50 123 4567', '(966) 50-123-4567',
            // An Arabic keyboard types Arabic-Indic digits; a Persian one, Extended Arabic-Indic.
            '٩٦٦٥٠١٢٣٤٥٦٧', '+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧', '۹۶۶۵۰۱۲۳۴۵۶۷',
        ]) {
            assert.equal(normaliseWhatsappNumber(input), '966501234567', input);
        }
    });

    it('refuses what wa.me would refuse', () => {
        for (const input of ['', '0501234567', '966-50-abc', '12345', '1'.repeat(16), '+', 'wa.me/966501234567']) {
            assert.equal(normaliseWhatsappNumber(input), null, JSON.stringify(input));
        }
    });
});

describe('normaliseContactEmail / normaliseIsoDay', () => {
    it('accepts an ordinary address, trimmed, and refuses the rest', () => {
        assert.equal(normaliseContactEmail('  hello@example.com \n'), 'hello@example.com');
        for (const bad of ['', 'hello', 'hello@', '@example.com', 'a b@example.com', 'hello@example']) {
            assert.equal(normaliseContactEmail(bad), null, JSON.stringify(bad));
        }
    });

    it('accepts a real calendar day only', () => {
        assert.equal(normaliseIsoDay('2026-04-05'), '2026-04-05');
        assert.equal(normaliseIsoDay(' 2026-12-31 '), '2026-12-31');
        for (const bad of ['', '2026-4-5', '05/04/2026', '2026-02-30', '2026-13-01', '2026-04-05T00:00', 'tomorrow']) {
            assert.equal(normaliseIsoDay(bad), null, JSON.stringify(bad));
        }
    });
});

describe('getSiteSettings', () => {
    it('answers with what Settings saved, over the environment', async () => {
        process.env.SITE_WHATSAPP_NUMBER = '966500000000';
        process.env.SITE_CONTACT_EMAIL = 'env@example.com';
        process.env.SITE_EID_COUPONS_EXPIRE = '2026-01-01';
        const asked = settingsHold({
            'site.whatsapp_number': '966501234567',
            'site.contact_email': 'saved@example.com',
            'site.eid_coupons_expire': '2026-04-05',
        });

        assert.deepEqual(await getSiteSettings(), {
            whatsappNumber: '966501234567', contactEmail: 'saved@example.com', eidCouponsExpire: '2026-04-05',
        });
        assert.deepEqual([...asked].sort(), ['site.contact_email', 'site.eid_coupons_expire', 'site.whatsapp_number']);
    });

    it('falls back to the environment, normalised, while nothing is saved', async () => {
        process.env.SITE_WHATSAPP_NUMBER = ' +966 50 000 0000 ';
        process.env.SITE_CONTACT_EMAIL = ' env@example.com ';
        process.env.SITE_EID_COUPONS_EXPIRE = '2026-01-01';
        settingsHold({});

        assert.deepEqual(await getSiteSettings(), {
            whatsappNumber: '966500000000', contactEmail: 'env@example.com', eidCouponsExpire: '2026-01-01',
        });
    });

    it('takes each value from wherever it is set, and reports the source of each', async () => {
        process.env.SITE_CONTACT_EMAIL = 'env@example.com';
        settingsHold({ 'site.whatsapp_number': '966501234567' });

        const status = await describeSiteSettings();
        assert.deepEqual(status, {
            whatsappNumber: '966501234567', contactEmail: 'env@example.com', eidCouponsExpire: null,
            source: { whatsappNumber: 'database', contactEmail: 'env', eidCouponsExpire: null },
        });
    });

    it('is null with nothing set, except the email, which falls back to the default — a blank or malformed env var is not a value', async () => {
        // Behaviour changed on purpose: no page may end up with zero contact channels, so the
        // contact email is never null. The default lives in appSettings, not in the HTML.
        process.env.SITE_WHATSAPP_NUMBER = '   ';
        process.env.SITE_CONTACT_EMAIL = 'not-an-email';
        process.env.SITE_EID_COUPONS_EXPIRE = '2026-02-30';
        settingsHold({});

        const none = { whatsappNumber: null, contactEmail: DEFAULT_CONTACT_EMAIL, eidCouponsExpire: null };
        assert.deepEqual(await getSiteSettings(), none);
        assert.deepEqual(siteSettingsFromEnv(), none);
        assert.deepEqual((await describeSiteSettings()).source, { whatsappNumber: null, contactEmail: 'default', eidCouponsExpire: null });
    });

    it('lets a saved or env email outrank the default', async () => {
        process.env.SITE_CONTACT_EMAIL = 'env@example.com';
        settingsHold({});
        assert.equal((await getSiteSettings()).contactEmail, 'env@example.com');
        settingsHold({ 'site.contact_email': 'saved@example.com' });
        assert.equal((await getSiteSettings()).contactEmail, 'saved@example.com');
    });
});
