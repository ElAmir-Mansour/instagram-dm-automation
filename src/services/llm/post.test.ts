/**
 * `postJson`, the one place a model request leaves the process: that it never follows a redirect
 * (against the real `fetch` and a server on the loopback interface, not only a stub), and that it
 * hands a provider's `retry-after` on.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { postJson } from './adapters/post.js';
import { isAiError } from './errors.js';
import { jsonResponse, stubFetch } from './testFetch.js';

const KEY = 'sk-ant-api03-Zk3x9QvR7mT2pL8wNd5yHc1bVf4gJa6sUe0oIiXtKrMq';

const post = (over: Partial<Parameters<typeof postJson>[0]> = {}) =>
    postJson({ provider: 'anthropic', model: 'claude-opus-5-5', url: 'https://api.anthropic.com/v1/messages', headers: { 'x-api-key': KEY }, body: { hello: 'world' }, key: KEY, ...over });

async function failure(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (err) {
        assert.ok(isAiError(err), String(err));
        return err;
    }
    return assert.fail('expected the call to fail');
}

describe('postJson redirects', () => {
    it('asks fetch to refuse them, on every request', async () => {
        const { fetchImpl, calls } = stubFetch(jsonResponse(200, { ok: true }));
        await post({ fetchImpl });
        assert.equal(calls[0]!.redirect, 'error');
    });

    it('turns the refusal fetch throws into a final bad_request that says why, with nothing of the key', async () => {
        // What Node's fetch really throws for `redirect: 'error'`: see the real-server test below.
        const refused = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
        const { fetchImpl, calls } = stubFetch(refused, jsonResponse(200, { ok: true }));
        const err = await failure(post({ fetchImpl }));
        assert.equal(err.kind, 'bad_request');
        assert.equal(err.retryable, false);
        assert.match(err.message, /redirect/);
        assert.match(err.message, /never sent to another address/);
        assert.equal(calls.length, 1);
        assert.ok(!JSON.stringify(err).includes(KEY));
    });

    it('is not mistaken for a network failure, which is retryable', async () => {
        const network = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
        const err = await failure(post({ fetchImpl: stubFetch(network).fetchImpl }));
        assert.equal(err.kind, 'timeout');
        assert.equal(err.retryable, true);
    });

    it('also refuses a 3xx answer that a stand-in for fetch hands back instead of throwing', async () => {
        for (const status of [301, 302, 307, 308]) {
            const err = await failure(post({ fetchImpl: stubFetch(new Response('', { status, headers: { location: 'https://evil.example.com/' } })).fetchImpl }));
            assert.equal(err.kind, 'bad_request', String(status));
            assert.equal(err.status, status);
            assert.match(err.message, /redirect/);
        }
    });

    describe('against the real fetch', () => {
        // One server plays the provider and answers 307; a second, on another port and so another
        // origin, plays wherever the 307 points, and records every header it is sent.
        const landed: Array<Record<string, string | string[] | undefined>> = [];
        let provider: http.Server;
        let elsewhere: http.Server;
        let providerUrl: string;

        const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

        before(async () => {
            elsewhere = http.createServer((req, res) => {
                req.resume();
                landed.push(req.headers);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end('{"landed":true}');
            });
            const elsewherePort = await listen(elsewhere);
            provider = http.createServer((req, res) => {
                req.resume();
                res.writeHead(307, { location: `http://127.0.0.1:${elsewherePort}/stolen` });
                res.end();
            });
            providerUrl = `http://127.0.0.1:${await listen(provider)}/v1/messages`;
        });

        after(() => {
            for (const server of [provider, elsewhere]) {
                server.closeAllConnections();
                server.close();
            }
        });

        it('does not follow a 307 to another origin, so the key\'s header never arrives there', async () => {
            landed.length = 0;
            const err = await failure(post({ url: providerUrl, headers: { 'x-api-key': KEY, 'x-goog-api-key': KEY } }));
            assert.equal(err.kind, 'bad_request');
            assert.equal(err.retryable, false);
            assert.match(err.message, /redirect/);
            assert.equal(landed.length, 0, 'the redirect target must never be contacted');
            assert.ok(!JSON.stringify(err).includes(KEY));
        });
    });
});

describe('postJson retry-after', () => {
    it('hands a rate limit\'s retry-after on, as milliseconds', async () => {
        const body = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
        const err = await failure(post({ fetchImpl: stubFetch(jsonResponse(429, body, { 'retry-after': '12' })).fetchImpl }));
        assert.equal(err.kind, 'rate');
        assert.equal(err.retryAfterMs, 12_000);
    });

    it('has none when the provider sent none', async () => {
        const body = { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } };
        const err = await failure(post({ fetchImpl: stubFetch(jsonResponse(429, body)).fetchImpl }));
        assert.equal(err.retryAfterMs, undefined);
    });

    it('reads it off an overload as well', async () => {
        const err = await failure(post({ fetchImpl: stubFetch(jsonResponse(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after': '3' })).fetchImpl }));
        assert.equal(err.kind, 'server');
        assert.equal(err.retryAfterMs, 3000);
    });
});
