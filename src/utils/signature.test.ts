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
import { appSecrets, verifyMetaSignature } from './signature.js';

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
