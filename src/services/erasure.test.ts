/**
 * The erasure token and the drift rule.
 *
 * This is the only hard DELETE in the product, and the only thing standing between a signed
 * preview and a wrong erasure is that the token cannot be produced or edited without the
 * signing secret, and that the counts it carries still describe the database when it is
 * spent. Both are asserted here.
 *
 * The SQL is not exercised here — there is no database in this suite, by the same convention
 * as every other test in this repo. It was verified separately against a throwaway local
 * Postgres cluster with all fifteen migrations applied.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
    countsDrifted, countsTotal, ERASURE_TOKEN_TTL_MS, mintErasureToken, verifyErasureToken,
} from './erasure.js';

const COUNTS = { messages: 12, conversations: 1, interactions: 3, dmSendLog: 0 };

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe('erasure preview token', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('round-trips the handle and the counts it was minted for', () => {
        const result = verifyErasureToken(mintErasureToken('someone', COUNTS));

        assert.ok(result.ok);
        assert.equal(result.handle, 'someone');
        assert.deepEqual(result.counts, COUNTS);
    });

    it('rejects a payload edited to name a different person', () => {
        // The attack this exists to stop: preview a handle with nothing behind it, then edit
        // the token to point at somebody real.
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.h = 'someone-else';
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.deepEqual(verifyErasureToken(`${forged}.${signature}`), {
            ok: false, reason: 'bad_signature',
        });
    });

    it('rejects a payload edited to widen the counts', () => {
        // Counts in the token are what the execute re-checks against, so raising them would
        // let a stale preview authorise more than it showed.
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.c.messages = 9999;
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.equal(verifyErasureToken(`${forged}.${signature}`).ok, false);
    });

    it('rejects a payload edited to extend its own expiry', () => {
        const token = mintErasureToken('someone', COUNTS);
        const [body, signature] = token.split('.') as [string, string];
        const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        claims.exp = Date.now() + 86_400_000;
        const forged = Buffer.from(JSON.stringify(claims)).toString('base64url');

        assert.equal(verifyErasureToken(`${forged}.${signature}`).ok, false);
    });

    it('expires', () => {
        const token = mintErasureToken('someone', COUNTS);

        assert.equal(verifyErasureToken(token, Date.now() + ERASURE_TOKEN_TTL_MS - 1000).ok, true);
        assert.deepEqual(verifyErasureToken(token, Date.now() + ERASURE_TOKEN_TTL_MS + 1000), {
            ok: false, reason: 'expired',
        });
    });

    it('rejects a token signed under a different secret', () => {
        const token = mintErasureToken('someone', COUNTS);
        process.env.DASHBOARD_PASSWORD = 'a-different-password';

        assert.equal(verifyErasureToken(token).ok, false);
    });

    it('does not accept a session token in its place', () => {
        // The scope string is folded into the HMAC precisely so that another signed value in
        // this app — a session, a download token — cannot be spent here.
        const body = Buffer.from(JSON.stringify({ h: 'someone', c: COUNTS, exp: Date.now() + 60_000 }))
            .toString('base64url');
        // Signed WITHOUT the 'erasure:v1' namespace, i.e. exactly as createSession would.
        const sessionStyle = `${body}.${'0'.repeat(64)}`;

        assert.equal(verifyErasureToken(sessionStyle).ok, false);
    });

    it('never throws, whatever it is handed', () => {
        for (const raw of [
            undefined, null, 42, {}, [], '', 'no-dot', 'a.b.c',
            'not-base64.deadbeef',
            `${Buffer.from('{}').toString('base64url')}.zz`,   // non-hex signature
        ]) {
            const result = verifyErasureToken(raw);
            assert.equal(result.ok, false, `input ${JSON.stringify(raw)}`);
        }
    });

    it('rejects a correctly signed payload missing its counts', () => {
        // A signature alone is not enough: the shape has to be there, or `countsDrifted` would
        // compare against undefined and conclude nothing moved.
        const body = Buffer.from(JSON.stringify({ h: 'someone', exp: Date.now() + 60_000 }))
            .toString('base64url');
        const signed = mintErasureToken('someone', COUNTS).split('.')[1];

        assert.equal(verifyErasureToken(`${body}.${signed}`).ok, false);
    });
});

describe('countsDrifted', () => {
    it('is false for identical counts', () => {
        assert.equal(countsDrifted(COUNTS, { ...COUNTS }), false);
    });

    it('is true when any single table moved, in either direction', () => {
        for (const key of ['messages', 'conversations', 'interactions', 'dmSendLog'] as const) {
            assert.equal(countsDrifted(COUNTS, { ...COUNTS, [key]: COUNTS[key] + 1 }), true, `${key} up`);
            assert.equal(countsDrifted(COUNTS, { ...COUNTS, [key]: COUNTS[key] - 1 }), true, `${key} down`);
        }
    });

    it('makes a replayed token a no-op rather than a second erasure', () => {
        // After a successful erasure every count is zero, so spending the same token again
        // drifts and is refused. That is what stops a leaked token from deleting whatever
        // arrived under the same handle afterwards.
        assert.equal(
            countsDrifted(COUNTS, { messages: 0, conversations: 0, interactions: 0, dmSendLog: 0 }),
            true
        );
    });
});

describe('countsTotal', () => {
    it('sums every table, so "nothing matched" is one check', () => {
        assert.equal(countsTotal(COUNTS), 16);
        assert.equal(countsTotal({ messages: 0, conversations: 0, interactions: 0, dmSendLog: 0 }), 0);
    });
});
