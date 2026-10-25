/**
 * The webhook signature check is the app's only authentication boundary — everything that
 * reaches the comment and DM pipelines got past this function first.
 *
 * The case that has actually cost hours is the dual-secret one: the Facebook app and
 * "Instagram API with Instagram Login" are two separate Meta apps with two separate secrets,
 * and dropping either one silently 403s half the traffic with no row written anywhere.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request } from 'express';
import { setLogSink, type LogLevel } from './log.js';
import { PROBE_HEADER, signProbeTag } from './probe.js';
import { appSecrets, logSignatureRejection, verifyMetaSignature } from './signature.js';

const FB_SECRET = 'facebook-app-secret';
const IG_SECRET = 'instagram-app-secret';

/** A `page` entry — what the Facebook app delivers, signed with META_APP_SECRET. */
const PAGE_BODY = Buffer.from(JSON.stringify({ object: 'page', entry: [{ id: '1' }] }));
/** An `instagram` entry — what the Instagram app delivers, signed with INSTAGRAM_APP_SECRET. */
const IG_BODY = Buffer.from(JSON.stringify({ object: 'instagram', entry: [{ id: '2' }] }));

function sign(body: Buffer, secret: string): string {
    return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function requestWith(signature?: string): Request {
    const headers: Record<string, string> = {};
    if (signature !== undefined) headers['x-hub-signature-256'] = signature;
    return { headers } as unknown as Request;
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe('verifyMetaSignature', () => {
    let savedMeta: string | undefined;
    let savedInstagram: string | undefined;

    beforeEach(() => {
        savedMeta = process.env.META_APP_SECRET;
        savedInstagram = process.env.INSTAGRAM_APP_SECRET;
        process.env.META_APP_SECRET = FB_SECRET;
        process.env.INSTAGRAM_APP_SECRET = IG_SECRET;
    });

    afterEach(() => {
        setEnv('META_APP_SECRET', savedMeta);
        setEnv('INSTAGRAM_APP_SECRET', savedInstagram);
    });

    it('accepts a payload signed with META_APP_SECRET (the Facebook app)', () => {
        const req = requestWith(sign(PAGE_BODY, FB_SECRET));
        assert.equal(verifyMetaSignature(req, PAGE_BODY), true);
    });

    it('accepts a payload signed with INSTAGRAM_APP_SECRET (the separate Instagram app)', () => {
        const req = requestWith(sign(IG_BODY, IG_SECRET));
        assert.equal(verifyMetaSignature(req, IG_BODY), true);
    });

    it('drops Instagram traffic when INSTAGRAM_APP_SECRET is unset, while Facebook keeps working', () => {
        delete process.env.INSTAGRAM_APP_SECRET;

        assert.equal(
            verifyMetaSignature(requestWith(sign(IG_BODY, IG_SECRET)), IG_BODY),
            false,
            'Instagram comments should stop validating — this is the half-the-traffic outage',
        );
        assert.equal(
            verifyMetaSignature(requestWith(sign(PAGE_BODY, FB_SECRET)), PAGE_BODY),
            true,
            'Facebook traffic keeps working, which is what makes the outage look like "no events"',
        );
    });

    it('drops Facebook traffic when only INSTAGRAM_APP_SECRET is configured', () => {
        delete process.env.META_APP_SECRET;

        assert.equal(verifyMetaSignature(requestWith(sign(PAGE_BODY, FB_SECRET)), PAGE_BODY), false);
        assert.equal(verifyMetaSignature(requestWith(sign(IG_BODY, IG_SECRET)), IG_BODY), true);
    });

    it('rejects a payload signed with an unrelated secret', () => {
        const req = requestWith(sign(PAGE_BODY, 'not-either-of-our-apps'));
        assert.equal(verifyMetaSignature(req, PAGE_BODY), false);
    });

    it('rejects a valid signature replayed over a different body', () => {
        const req = requestWith(sign(PAGE_BODY, FB_SECRET));
        assert.equal(verifyMetaSignature(req, IG_BODY), false);
    });

    it('rejects a request with no signature header', () => {
        assert.equal(verifyMetaSignature(requestWith(), PAGE_BODY), false);
    });

    it('rejects a header missing the sha256= prefix', () => {
        const hex = crypto.createHmac('sha256', FB_SECRET).update(PAGE_BODY).digest('hex');
        assert.equal(verifyMetaSignature(requestWith(hex), PAGE_BODY), false);
        assert.equal(verifyMetaSignature(requestWith(`sha1=${hex}`), PAGE_BODY), false);
    });

    it('rejects a truncated digest without throwing', () => {
        // timingSafeEqual throws on length mismatch, which would turn a bogus request into a
        // 500 and earn a Meta delivery retry storm instead of a flat 403. The explicit length
        // guard exists for exactly this input.
        const truncated = sign(PAGE_BODY, FB_SECRET).slice(0, 'sha256='.length + 32);
        let result: boolean | undefined;
        assert.doesNotThrow(() => {
            result = verifyMetaSignature(requestWith(truncated), PAGE_BODY);
        });
        assert.equal(result, false);
    });

    it('rejects an over-long digest without throwing', () => {
        const overlong = `${sign(PAGE_BODY, FB_SECRET)}00`;
        let result: boolean | undefined;
        assert.doesNotThrow(() => {
            result = verifyMetaSignature(requestWith(overlong), PAGE_BODY);
        });
        assert.equal(result, false);
    });

    it('rejects malformed hex without throwing', () => {
        // Buffer.from stops at the first non-hex character, so this decodes to zero bytes.
        let result: boolean | undefined;
        assert.doesNotThrow(() => {
            result = verifyMetaSignature(requestWith(`sha256=${'z'.repeat(64)}`), PAGE_BODY);
        });
        assert.equal(result, false);
        assert.equal(verifyMetaSignature(requestWith('sha256='), PAGE_BODY), false);
    });

    it('returns false when rawBody was never captured', () => {
        // body-parser's `verify` hook only fires for the content types it handles, so a POST
        // with a non-JSON Content-Type reaches here with no raw body at all.
        const req = requestWith(sign(PAGE_BODY, FB_SECRET));
        assert.doesNotThrow(() => {
            verifyMetaSignature(req, undefined as unknown as Buffer);
        });
        assert.equal(verifyMetaSignature(req, undefined as unknown as Buffer), false);
        assert.equal(verifyMetaSignature(req, PAGE_BODY.toString() as unknown as Buffer), false);
    });

    it('rejects everything when no secrets are configured at all', () => {
        delete process.env.META_APP_SECRET;
        delete process.env.INSTAGRAM_APP_SECRET;

        assert.equal(verifyMetaSignature(requestWith(sign(PAGE_BODY, FB_SECRET)), PAGE_BODY), false);
    });
});

describe('appSecrets', () => {
    let savedMeta: string | undefined;
    let savedInstagram: string | undefined;

    beforeEach(() => {
        savedMeta = process.env.META_APP_SECRET;
        savedInstagram = process.env.INSTAGRAM_APP_SECRET;
    });

    afterEach(() => {
        setEnv('META_APP_SECRET', savedMeta);
        setEnv('INSTAGRAM_APP_SECRET', savedInstagram);
    });

    it('reports both secrets, Facebook first', () => {
        process.env.META_APP_SECRET = FB_SECRET;
        process.env.INSTAGRAM_APP_SECRET = IG_SECRET;
        assert.deepEqual(appSecrets(), [FB_SECRET, IG_SECRET]);
    });

    it('treats an empty string as unset rather than signing with an empty key', () => {
        // Production has shipped `META_VERIFY_TOKEN=""` before; an empty app secret is the same
        // class of mistake, and an empty HMAC key is a key an attacker also has.
        process.env.META_APP_SECRET = '';
        process.env.INSTAGRAM_APP_SECRET = IG_SECRET;

        assert.deepEqual(appSecrets(), [IG_SECRET]);
        assert.equal(verifyMetaSignature(requestWith(sign(PAGE_BODY, '')), PAGE_BODY), false);
    });

    it('reports an empty list when nothing is configured', () => {
        delete process.env.META_APP_SECRET;
        delete process.env.INSTAGRAM_APP_SECRET;
        assert.deepEqual(appSecrets(), []);
    });
});

/**
 * The `webhook.signature_rejected` line is what RUNBOOK §2.3 sends you to read when events stop arriving, and its two diagnostic
 * fields once printed `"[redacted]"`: the logger blanks any field whose NAME looks like a secret (`secrets_tried`,
 * `instagram_secret_set`), and these carry a count and a yes/no. So every assertion here is on the line the REAL `log` emits,
 * parsed back, and never on what was handed to it: a name the redactor catches would pass the second and fail the first.
 */
describe('logSignatureRejection', () => {
    let savedMeta: string | undefined;
    let savedInstagram: string | undefined;

    beforeEach(() => {
        savedMeta = process.env.META_APP_SECRET;
        savedInstagram = process.env.INSTAGRAM_APP_SECRET;
        process.env.META_APP_SECRET = FB_SECRET;
        process.env.INSTAGRAM_APP_SECRET = IG_SECRET;
    });

    afterEach(() => {
        setEnv('META_APP_SECRET', savedMeta);
        setEnv('INSTAGRAM_APP_SECRET', savedInstagram);
    });

    /** Run the rejection once and hand back the single line it emitted: its level, the text as written, and the parsed fields. */
    function rejection(req: Request = requestWith()): { level: LogLevel; raw: string; line: Record<string, unknown> } {
        const emitted: Array<{ level: LogLevel; raw: string }> = [];
        const previous = setLogSink((level, raw) => { emitted.push({ level, raw }); });
        try {
            logSignatureRejection(req);
        } finally {
            setLogSink(previous);
        }
        assert.equal(emitted.length, 1, 'one rejection is one line');
        const { level, raw } = emitted[0]!;
        return { level, raw, line: JSON.parse(raw) as Record<string, unknown> };
    }

    it('is an error-level webhook.signature_rejected line', () => {
        const { level, line } = rejection();
        assert.equal(level, 'error');
        assert.equal(line['event'], 'webhook.signature_rejected');
    });

    it('prints how many secrets were tried and that the Instagram app is configured, as real values', () => {
        const { line } = rejection();

        assert.equal(line['app_keys_tried'], 2);
        assert.equal(line['instagram_app_configured'], true);
        assert.equal(line['probe'], false);
    });

    it('does not blank either diagnostic field', () => {
        // The bug itself: `secrets_tried` and `instagram_secret_set` both came out as "[redacted]".
        const { line } = rejection();

        for (const field of ['app_keys_tried', 'instagram_app_configured', 'probe']) {
            assert.notEqual(line[field], '[redacted]', `${field} must reach the log as its value`);
        }
        assert.equal(Object.values(line).includes('[redacted]'), false, 'nothing on this line is redacted');
    });

    it('counts one secret, and no Instagram app, when only META_APP_SECRET is set', () => {
        // The configuration production is documented to run: one app, so `instagram_app_configured` is the answer to "is the dual check live".
        delete process.env.INSTAGRAM_APP_SECRET;
        const { line } = rejection();

        assert.equal(line['app_keys_tried'], 1);
        assert.equal(line['instagram_app_configured'], false);
    });

    it('counts none when nothing is configured: the case that explains every rejection', () => {
        delete process.env.META_APP_SECRET;
        delete process.env.INSTAGRAM_APP_SECRET;
        const { line } = rejection();

        assert.equal(line['app_keys_tried'], 0);
        assert.equal(line['instagram_app_configured'], false);
    });

    it('treats an empty INSTAGRAM_APP_SECRET as not configured, as appSecrets does', () => {
        process.env.INSTAGRAM_APP_SECRET = '';
        const { line } = rejection();

        assert.equal(line['app_keys_tried'], 1);
        assert.equal(line['instagram_app_configured'], false);
    });

    it('never puts a secret on the line', () => {
        // The fields are renamed to get past the redactor, which is also what keeps a secret out of the log. A count and a yes/no
        // are all this line may carry: never a value, never part of one.
        const { raw } = rejection();

        assert.equal(raw.includes(FB_SECRET), false);
        assert.equal(raw.includes(IG_SECRET), false);
    });

    it('labels this project\'s own diagnostic probe, and only that', () => {
        // `diagnose.mjs --probe-signature` and a real rejection used to be byte-identical in the logs. The tag is a label and gates
        // nothing (src/utils/probe.ts); here it only has to reach the line.
        const ts = Date.now();
        const tagged = { headers: { [PROBE_HEADER]: `${ts}.${signProbeTag(ts, FB_SECRET)}` } } as unknown as Request;
        const forged = { headers: { [PROBE_HEADER]: `${ts}.${signProbeTag(ts, 'not-the-secret')}` } } as unknown as Request;

        assert.equal(rejection(tagged).line['probe'], true);
        assert.equal(rejection(forged).line['probe'], false);
        assert.equal(rejection(requestWith()).line['probe'], false);
    });
});
