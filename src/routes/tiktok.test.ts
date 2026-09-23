/**
 * The TikTok OAuth callback's defences, over real HTTP.
 *
 * The callback is the one TikTok route a browser reaches with no session, so everything that
 * binds a returned code to a tenant happens here: the state must match the cookie set in the
 * browser that began the flow, and must be consumable exactly once. These tests run the public
 * router in a real Express app on an ephemeral port — a redirect, a Set-Cookie and a query
 * string are exactly the things a hand-built fake `res` gets subtly wrong — with the pool
 * stubbed so no database or TikTok call can happen.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import express from 'express';
import { pool } from '../config/db.js';
import { setLogSink } from '../utils/log.js';
import { readCookie, STATE_COOKIE, tiktokPublicRouter, VERIFICATION_FILENAME } from './tiktok.js';

let server: Server;
let base: string;
let statements: string[] = [];
let respond: (sql: string) => { rows: any[]; rowCount?: number };
const originalQuery = pool.query;
let restoreSink: (() => void) | undefined;

before(async () => {
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
    const app = express();
    app.use('/api/tiktok', tiktokPublicRouter);
    await new Promise<void>((resolve) => {
        server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    restoreSink?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    statements = [];
    respond = () => ({ rows: [] });
    (pool as unknown as { query: unknown }).query = async (sql: string) => {
        statements.push(sql);
        const r = respond(sql);
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
});

afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
});

async function callback(query: string, cookie?: string) {
    const res = await fetch(`${base}/api/tiktok/callback?${query}`, {
        redirect: 'manual',
        headers: cookie ? { cookie } : {},
    });
    const location = res.headers.get('location') ?? '';
    const params = new URL(location, base).searchParams;
    return { status: res.status, location, outcome: params.get('tiktok'), reason: params.get('reason'), setCookie: res.headers.get('set-cookie') ?? '' };
}

describe('GET /api/tiktok/callback', () => {
    it('sends a cancelled consent screen back to Settings, touching nothing', async () => {
        const r = await callback('error=access_denied&state=abc');
        assert.equal(r.status, 302);
        assert.match(r.location, /^\/dashboard\?/);
        assert.match(r.location, /#\/settings$/);
        assert.equal(r.outcome, 'error');
        assert.equal(r.reason, 'denied');
        assert.equal(statements.length, 0);
    });

    it('refuses a state with no matching cookie BEFORE spending it', async () => {
        // A state lifted from a log or a referrer and replayed in another browser. Spending it
        // here would let the attacker's attempt burn the victim's legitimate one.
        const r = await callback('code=c1&state=the-state');
        assert.equal(r.reason, 'state_mismatch');
        assert.equal(statements.length, 0, 'no database call at all');

        const r2 = await callback('code=c1&state=the-state', `${STATE_COOKIE}=a-different-state`);
        assert.equal(r2.reason, 'state_mismatch');
        assert.equal(statements.length, 0);
    });

    it('refuses a state that was already used or has expired', async () => {
        respond = (sql) => (/UPDATE oauth_states/.test(sql) ? { rows: [] } : { rows: [] });
        const r = await callback('code=c1&state=s1', `${STATE_COOKIE}=s1`);
        assert.equal(r.reason, 'state_expired');
        // The consume is the check: single-use, unexpired, in one UPDATE.
        assert.ok(statements.some((s) => /used_at IS NULL AND expires_at > NOW\(\)/.test(s)));
    });

    it('always clears the state cookie on the way out', async () => {
        const r = await callback('error=access_denied');
        assert.match(r.setCookie, new RegExp(`${STATE_COOKIE}=;`));
        assert.match(r.setCookie, /Max-Age=0/);
        assert.match(r.setCookie, /HttpOnly/);
    });
});

describe('readCookie', () => {
    it('finds one cookie among several, decoded', () => {
        assert.equal(readCookie('a=1; tiktok_oauth_state=x%2Fy; b=2', 'tiktok_oauth_state'), 'x/y');
        assert.equal(readCookie('a=1', 'tiktok_oauth_state'), null);
        assert.equal(readCookie(undefined, 'tiktok_oauth_state'), null);
    });
});

describe('VERIFICATION_FILENAME', () => {
    it('accepts TikTok’s file name and nothing that could be a path', () => {
        assert.ok(VERIFICATION_FILENAME.test('tiktokAbC123xyz.txt'));
        assert.ok(!VERIFICATION_FILENAME.test('tiktok../etc/passwd.txt'));
        assert.ok(!VERIFICATION_FILENAME.test('other.txt'));
        assert.ok(!VERIFICATION_FILENAME.test('tiktokAbC123.html'));
    });
});
