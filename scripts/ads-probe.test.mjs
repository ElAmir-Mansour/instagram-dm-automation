/**
 * The pure helpers of scripts/ads-probe.mjs: header parsing, redaction, funding masking, Meta's error shape.
 *
 * The probe talks to production, so what is pinned here is what must never go wrong when it does: a token cannot reach the
 * output, a card display string is cut to its last four digits, and a header Meta did not send is "unknown", never zero.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
    DEFAULT_VERSION, makeRedactor, maskDisplayString, metaError, parseAdAccountUsage, parseJsonHeader, pickReels, pickVersion,
    servedVersion, summariseFunding,
} from './ads-probe.mjs';

describe('parseAdAccountUsage', () => {
    it('reads the tier, the utilisation and the reset time', () => {
        const u = parseAdAccountUsage({ 'x-ad-account-usage': '{"acc_id_util_pct":9.67,"reset_time_duration":100,"ads_api_access_tier":"standard_access"}' });
        assert.deepEqual(u, { tier: 'standard_access', accIdUtilPct: 9.67, resetTimeDuration: 100 });
    });
    it('returns null for a missing or unreadable header, never zero', () => {
        assert.equal(parseAdAccountUsage({}), null);
        assert.equal(parseAdAccountUsage(undefined), null);
        assert.equal(parseAdAccountUsage({ 'x-ad-account-usage': 'not json' }), null);
    });
    it('leaves a field Meta did not send as null', () => {
        const u = parseAdAccountUsage({ 'x-ad-account-usage': '{"acc_id_util_pct":"12"}' });
        assert.deepEqual(u, { tier: null, accIdUtilPct: 12, resetTimeDuration: null });
    });
});

describe('parseJsonHeader / servedVersion', () => {
    it('is null for empty values and for JSON that is not an object', () => {
        assert.equal(parseJsonHeader(''), null);
        assert.equal(parseJsonHeader('3'), null);
        assert.deepEqual(parseJsonHeader('{"a":1}'), { a: 1 });
    });
    it('reads the served version header, trimmed, or null', () => {
        assert.equal(servedVersion({ 'facebook-api-version': ' v26.0 ' }), 'v26.0');
        assert.equal(servedVersion({}), null);
    });
});

describe('maskDisplayString / summariseFunding', () => {
    it('keeps only the last four digits', () => {
        assert.equal(maskDisplayString('Visa ····4242 exp 12/27'), '••••1227');
        assert.equal(maskDisplayString('Visa *4242'), '••••4242');
    });
    it('never returns letters, a name or more than four digits', () => {
        for (const s of ['Visa *4242', 'Mastercard 5555 4444 3333 2222', 'Prepaid balance', 'PayPal: someone@example.com']) {
            const masked = maskDisplayString(s);
            assert.match(masked, /^••••\d{0,4}$/, s);
            assert.equal(masked.includes('@'), false);
        }
    });
    it('reports funding as type and presence only', () => {
        assert.deepEqual(summariseFunding(null), { present: false, type: null, display: null });
        const f = summariseFunding({ id: '123', type: 1, display_string: 'Visa *4242' });
        assert.deepEqual(f, { present: true, type: 1, display: '••••4242' });
        assert.equal('id' in f, false);
    });
});

describe('makeRedactor', () => {
    it('removes every secret wherever it appears, longest first', () => {
        const redact = makeRedactor(['EAAB1234567890', 'APPID|APPSECRET123', 'APPSECRET123']);
        assert.equal(redact('token EAAB1234567890 and APPID|APPSECRET123 and APPSECRET123'), 'token [redacted] and [redacted] and [redacted]');
        assert.equal(redact('{"a":"EAAB1234567890"}'), '{"a":"[redacted]"}');
    });
    it('ignores empty and very short values instead of shredding the output', () => {
        const redact = makeRedactor(['', 'abc', undefined, null]);
        assert.equal(redact('abc def'), 'abc def');
    });
});

describe('metaError', () => {
    it('reads code, subcode and message from a Graph error body', () => {
        const e = metaError({ status: 400, data: { error: { code: 190, error_subcode: 463, message: 'Error validating access token', type: 'OAuthException' } } });
        assert.deepEqual(e, { code: 190, subcode: 463, message: 'Error validating access token' });
    });
    it('falls back to the HTTP status, then to the exception message', () => {
        assert.deepEqual(metaError({ status: 502, data: '<html>' }), { code: null, subcode: null, message: 'HTTP 502 with no Graph error body' });
        assert.deepEqual(metaError(new Error('timeout of 20000ms exceeded')), { code: null, subcode: null, message: 'timeout of 20000ms exceeded' });
    });
});

describe('pickVersion / pickReels', () => {
    it('uses the stored version when it looks like one, else the default', () => {
        assert.equal(pickVersion('v25.0'), 'v25.0');
        assert.equal(pickVersion('26'), DEFAULT_VERSION);
        assert.equal(pickVersion(undefined), DEFAULT_VERSION);
        assert.equal(DEFAULT_VERSION, 'v26.0');
    });
    it('keeps the first five reels, in order, and drops everything else', () => {
        const media = Array.from({ length: 12 }, (_, i) => ({ id: String(i), media_product_type: i % 2 ? 'FEED' : 'REELS' }));
        assert.deepEqual(pickReels(media).map((m) => m.id), ['0', '2', '4', '6', '8']);
        assert.deepEqual(pickReels(undefined), []);
    });
});

describe('the probe stays read-only', () => {
    const source = readFileSync(new URL('./ads-probe.mjs', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    it('makes no write call to Meta and no write to the database', () => {
        assert.equal(/\b(?:http|axios)\.(?:post|put|patch|delete)\b/.test(code), false);
        assert.equal(/\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\s/.test(code), false);
    });
    it('sends the token in a header, never in a URL it builds', () => {
        assert.match(source, /Authorization: `Bearer \$\{token\}`/);
        assert.equal(/access_token/.test(code), false);
    });
});
