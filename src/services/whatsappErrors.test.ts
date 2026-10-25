/**
 * WhatsApp error classification: which codes stop a send, which back off, and that the Instagram policy is untouched.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isPermanentMetaError } from './http.js';
import {
    classifyWhatsAppError,
    WHATSAPP_PERMANENT_CODES,
    WHATSAPP_RETRYABLE_CODES,
    type WhatsAppErrorReason,
} from './whatsappErrors.js';

const PERMANENT: [number, WhatsAppErrorReason][] = [
    [131047, 'window_closed'],
    [131026, 'undeliverable'],
    [131050, 'marketing_opt_out'],
    [131051, 'unsupported'],
    [131052, 'media_too_big'],
    [131053, 'bad_mime'],
    [131042, 'payment_issue'],
    [190, 'token_or_permission'],
    [200, 'token_or_permission'],
    [10, 'token_or_permission'],
];

const RETRYABLE: [number, WhatsAppErrorReason][] = [
    [131056, 'pair_rate_limit'],
    [130429, 'throughput'],
];

describe('classifyWhatsAppError', () => {
    for (const [code, reason] of PERMANENT) {
        it(`${code} is permanent (${reason})`, () => {
            assert.deepEqual(classifyWhatsAppError(code), { kind: 'permanent', reason });
        });
    }

    for (const [code, reason] of RETRYABLE) {
        it(`${code} is retryable (${reason})`, () => {
            assert.deepEqual(classifyWhatsAppError(code), { kind: 'retryable', reason });
        });
    }

    it('says "unknown" with no reason for a code it has no opinion on', () => {
        // 131049 (per-user marketing limit) and 131060 (unavailable inbound message) are out of scope on purpose;
        // 131000 is Meta's own "unknown error"; 10903 is Instagram's.
        for (const code of [131049, 131060, 131000, 10903, 0, 1, 4, 100, 999999]) {
            assert.deepEqual(classifyWhatsAppError(code), { kind: 'unknown', reason: null }, `code ${code}`);
        }
    });

    it('says "unknown" for anything that is not an integer code', () => {
        for (const bad of [undefined, null, NaN, Infinity, 131047.5, '', 'abc', '131047x', {}, [], true]) {
            assert.deepEqual(classifyWhatsAppError(bad), { kind: 'unknown', reason: null }, `value ${String(bad)}`);
        }
    });

    it('reads a digit string as the code it spells (a code that went through a log line or a text column)', () => {
        assert.deepEqual(classifyWhatsAppError('131047'), { kind: 'permanent', reason: 'window_closed' });
        assert.deepEqual(classifyWhatsAppError(' 131056 '), { kind: 'retryable', reason: 'pair_rate_limit' });
    });

    it('never gives a reason for "unknown" and always gives one otherwise', () => {
        for (let code = 0; code <= 140000; code++) {
            const { kind, reason } = classifyWhatsAppError(code);
            assert.equal(reason === null, kind === 'unknown', `code ${code}`);
        }
    });
});

describe('WHATSAPP_PERMANENT_CODES / WHATSAPP_RETRYABLE_CODES', () => {
    it('are exactly the specified codes (T010)', () => {
        assert.deepEqual([...WHATSAPP_PERMANENT_CODES].sort((a, b) => a - b), [10, 190, 200, 131026, 131042, 131047, 131050, 131051, 131052, 131053]);
        assert.deepEqual([...WHATSAPP_RETRYABLE_CODES].sort((a, b) => a - b), [130429, 131056]);
    });

    it('do not overlap, and agree with the classifier', () => {
        for (const code of WHATSAPP_PERMANENT_CODES) {
            assert.equal(WHATSAPP_RETRYABLE_CODES.has(code), false);
            assert.equal(classifyWhatsAppError(code).kind, 'permanent');
        }
        for (const code of WHATSAPP_RETRYABLE_CODES) assert.equal(classifyWhatsAppError(code).kind, 'retryable');
    });
});

describe('the Instagram retry policy is unchanged by the WhatsApp codes', () => {
    // The exact-set pin on `PERMANENT_CODES` itself is in http.test.ts (T010). This is the cross-check from this side.
    it('none of the WhatsApp-only permanent codes (other than 190 and 200) is permanent for Instagram', () => {
        for (const code of WHATSAPP_PERMANENT_CODES) {
            const instagramPermanent = isPermanentMetaError({ response: { status: 400, data: { error: { code } } } });
            assert.equal(instagramPermanent, code === 190 || code === 200, `code ${code}`);
        }
    });
});
