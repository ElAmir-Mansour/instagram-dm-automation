/**
 * Dashboard session and download tokens.
 *
 * These are stateless HMACs, so the only thing standing between an attacker and the dashboard
 * is that the signature cannot be produced without the secret and that an old token stops
 * working. Both are asserted here without re-deriving the signing formula, so these tests do
 * not quietly become a copy of the implementation.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { consumeDownloadToken, createDownloadToken, createSession, requireAuth, verifySession } from './auth.js';

/** A representative session. Every test that needs a token starts from this. */
const SESSION = { userId: 'u-1', role: 'platform_admin' as const, tenantId: 't-1', tokenVersion: 1 };
const newToken = () => createSession(SESSION);

const PASSWORD = 'dashboard-password';
const APP_SECRET = 'meta-app-secret';

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

function fakeReq(authorization?: string): Request {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    return { headers } as unknown as Request;
}

function runAuth(authorization?: string): { status: number | null; nextCalls: number } {
    const result = { status: null as number | null, nextCalls: 0 };
    const res = {
        status(code: number) {
            result.status = code;
            return this;
        },
        json() {
            return this;
        },
    } as unknown as Response;

    requireAuth(fakeReq(authorization), res, () => {
        result.nextCalls += 1;
    });
    return result;
}

describe('session tokens', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = PASSWORD;
        process.env.META_APP_SECRET = APP_SECRET;
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('accepts a freshly signed token', () => {
        const result = runAuth(`Bearer ${newToken()}`);

        assert.equal(result.nextCalls, 1);
        assert.equal(result.status, null);
    });

    it('rejects a tampered signature', () => {
        const [body, signature] = newToken().split('.') as [string, string];
        const flipped = signature.startsWith('a') ? `b${signature.slice(1)}` : `a${signature.slice(1)}`;

        const result = runAuth(`Bearer ${body}.${flipped}`);
        assert.equal(result.status, 401);
        assert.equal(result.nextCalls, 0);
    });

    it('rejects a signature lifted onto a different body', () => {
        const [body, signature] = newToken().split('.') as [string, string];
        const other = (Number(body) - 1000).toString();

        assert.equal(runAuth(`Bearer ${other}.${signature}`).status, 401);
    });

    it('rejects a token older than the 24h TTL', () => {
        // Expiry is checked before the signature, so an out-of-date body reaches the TTL
        // guard regardless of what the signature says.
        const [body, signature] = newToken().split('.') as [string, string];
        const stale = (Number(body) - 25 * 60 * 60 * 1000).toString();

        assert.equal(runAuth(`Bearer ${stale}.${signature}`).status, 401);
    });

    it('rejects a token signed under a different secret', () => {
        const token = newToken();
        process.env.DASHBOARD_PASSWORD = 'a-different-password';

        assert.equal(runAuth(`Bearer ${token}`).status, 401);
    });

    it('rejects a token signed before META_APP_SECRET was rotated', () => {
        const token = newToken();
        process.env.META_APP_SECRET = 'rotated-app-secret';

        assert.equal(runAuth(`Bearer ${token}`).status, 401);
    });

    it('requires a real Bearer prefix', () => {
        const token = newToken();

        assert.equal(runAuth().status, 401, 'no header at all');
        assert.equal(runAuth(token).status, 401, 'bare token');
        assert.equal(runAuth(`bearer ${token}`).status, 401, 'lowercase scheme');
        assert.equal(runAuth(`Bearer${token}`).status, 401, 'no separating space');
        assert.equal(runAuth('Bearer ').status, 401, 'empty token');
    });

    it('rejects malformed tokens without throwing', () => {
        for (const token of ['abc', 'a.b.c', '.', 'notanumber.deadbeef', '123.nothex', '123.']) {
            let status: number | null = null;
            assert.doesNotThrow(() => {
                status = runAuth(`Bearer ${token}`).status;
            }, `token ${JSON.stringify(token)}`);
            assert.equal(status, 401, `token ${JSON.stringify(token)}`);
        }
    });

    it('refuses to sign anything when the secrets are missing', () => {
        // The old `|| 'admin'` / `|| 'salt'` fallbacks meant a deployment missing either
        // variable signed every session with a key published in this repo.
        delete process.env.DASHBOARD_PASSWORD;
        assert.throws(() => createSession(SESSION), /DASHBOARD_PASSWORD and META_APP_SECRET/);

        process.env.DASHBOARD_PASSWORD = PASSWORD;
        delete process.env.META_APP_SECRET;
        assert.throws(() => createSession(SESSION), /DASHBOARD_PASSWORD and META_APP_SECRET/);
    });
});

describe('one-shot download tokens', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = PASSWORD;
        process.env.META_APP_SECRET = APP_SECRET;
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('accepts a fresh token for the path it was minted for', () => {
        assert.equal(consumeDownloadToken(createDownloadToken('interactions.csv'), 'interactions.csv'), true);
    });

    it('burns the token so a leaked URL is worthless the second time', () => {
        const token = createDownloadToken('interactions.csv');

        assert.equal(consumeDownloadToken(token, 'interactions.csv'), true);
        assert.equal(consumeDownloadToken(token, 'interactions.csv'), false);
    });

    it('is bound to one path', () => {
        const token = createDownloadToken('interactions.csv');

        assert.equal(consumeDownloadToken(token, 'messages.csv'), false);
        // Rejecting it for the wrong path must not also burn it for the right one.
        assert.equal(consumeDownloadToken(token, 'interactions.csv'), true);
    });

    it('rejects an expired token', () => {
        // Expiry is checked before the signature, so rewinding the expiry component is enough
        // to reach the guard.
        const parts = createDownloadToken('interactions.csv').split('.') as [string, string, string];
        const expired = `${Date.now() - 1000}.${parts[1]}.${parts[2]}`;

        assert.equal(consumeDownloadToken(expired, 'interactions.csv'), false);
    });

    it('rejects a tampered signature', () => {
        const parts = createDownloadToken('interactions.csv').split('.') as [string, string, string];
        const flipped = parts[2].startsWith('a') ? `b${parts[2].slice(1)}` : `a${parts[2].slice(1)}`;

        assert.equal(consumeDownloadToken(`${parts[0]}.${parts[1]}.${flipped}`, 'interactions.csv'), false);
    });

    it('rejects a token minted under a different secret', () => {
        const token = createDownloadToken('interactions.csv');
        process.env.DASHBOARD_PASSWORD = 'a-different-password';

        assert.equal(consumeDownloadToken(token, 'interactions.csv'), false);
    });

    it('rejects non-strings and malformed tokens without throwing', () => {
        for (const token of [undefined, null, 42, {}, '', 'a.b', 'a.b.c.d', 'x.y.zz']) {
            let accepted: boolean | undefined;
            assert.doesNotThrow(() => {
                accepted = consumeDownloadToken(token, 'interactions.csv');
            }, `token ${JSON.stringify(token)}`);
            assert.equal(accepted, false, `token ${JSON.stringify(token)}`);
        }
    });
});

describe('session payload', () => {
    // This suite sits outside the file's other describe blocks, so it needs its own env
    // setup — signing throws without both secrets, by design.
    let savedPassword: string | undefined;
    let savedSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedSecret = process.env.META_APP_SECRET;
        setEnv('DASHBOARD_PASSWORD', PASSWORD);
        setEnv('META_APP_SECRET', APP_SECRET);
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedSecret);
    });

    it('round-trips identity, role and tenant', () => {
        const payload = verifySession(newToken());
        assert.ok(payload);
        assert.equal(payload.userId, 'u-1');
        assert.equal(payload.role, 'platform_admin');
        assert.equal(payload.tenantId, 't-1');
        assert.equal(payload.tokenVersion, 1);
    });

    it('rejects a token whose payload was edited to escalate role', () => {
        // The whole point of signing the payload: swapping 'user' for 'platform_admin'
        // must not survive verification.
        const token = createSession({ ...SESSION, role: 'user' });
        const [body, signature] = token.split('.') as [string, string];
        const tampered = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        tampered.role = 'platform_admin';
        const forged = Buffer.from(JSON.stringify(tampered)).toString('base64url');
        assert.equal(verifySession(`${forged}.${signature}`), null);
    });

    it('rejects a token dated in the future', () => {
        // Not forgeable, but a clock-skew bug must not mint something outliving the TTL.
        const body = Buffer.from(JSON.stringify({ ...SESSION, iat: Date.now() + 10 * 60_000 }))
            .toString('base64url');
        const sig = createHmac('sha256', `${PASSWORD}:${APP_SECRET}`).update(body).digest('hex');
        assert.equal(verifySession(`${body}.${sig}`), null);
    });

    it('returns null rather than throwing when the payload is not JSON', () => {
        assert.equal(verifySession('not-base64-json.deadbeef'), null);
    });
});
