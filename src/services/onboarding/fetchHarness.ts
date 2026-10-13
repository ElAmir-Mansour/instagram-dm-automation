/**
 * A network that exists only in memory, for the tests of everything that fetches: a DNS table and a set of
 * routes, behind the same two seams `safeFetch` takes (`resolve`, `transport`). Every request is recorded.
 * Not a test file, so `npm test` does not run it.
 */
import net from 'node:net';
import type { ResolvedAddress, Resolver } from './netGuard.js';
import type { Transport, TransportRequest, TransportResponse } from './safeFetch.js';

export interface Reply {
    status?: number;
    headers?: Record<string, string | string[]>;
    /** A string or bytes (one chunk, or `chunk` bytes at a time), or a generator for a body that misbehaves. */
    body?: string | Uint8Array | ((req: TransportRequest) => AsyncIterable<Uint8Array>);
    /** Split a plain body into chunks of this many bytes. */
    chunk?: number;
}

export type Route = Reply | Error | ((req: TransportRequest) => Reply | Error | Promise<Reply | Error>);

export interface FakeNet {
    resolve: Resolver;
    transport: Transport;
    /** Every name asked of DNS, in order. */
    resolveCalls: string[];
    /** Every request that reached a socket, in order. */
    calls: TransportRequest[];
    /** How many connections were closed by the reader. */
    closed: { count: number };
}

export interface FakeNetOptions {
    /** Host to its addresses, or a function (called once per lookup) for an answer that changes. */
    dns?: Record<string, string[] | ((nth: number) => string[])>;
    /** `https://example.com/path?q` to what it answers. */
    routes?: Record<string, Route>;
}

const family = (address: string): 4 | 6 => (address.includes(':') ? 6 : 4);
const enc = new TextEncoder();

export function fakeNet({ dns = {}, routes = {} }: FakeNetOptions = {}): FakeNet {
    const resolveCalls: string[] = [];
    const calls: TransportRequest[] = [];
    const closed = { count: 0 };
    const asked: Record<string, number> = {};

    const resolve: Resolver = async (host) => {
        resolveCalls.push(host);
        const nth = (asked[host] = (asked[host] ?? 0) + 1);
        const entry = dns[host];
        // A name that is an address answers with itself, as the system resolver does.
        if (entry === undefined) {
            if (net.isIP(host) !== 0) return [{ address: host, family: family(host) }];
            throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
        }
        const addresses = typeof entry === 'function' ? entry(nth) : entry;
        return addresses.map((address): ResolvedAddress => ({ address, family: family(address) }));
    };

    const transport: Transport = async (req) => {
        calls.push(req);
        const key = `${req.url.protocol}//${req.url.host}${req.url.pathname}${req.url.search}`;
        const route = routes[key];
        if (route === undefined) throw Object.assign(new Error(`connect ECONNREFUSED ${req.address}:${req.port}`), { code: 'ECONNREFUSED' });
        const reply = typeof route === 'function' ? await route(req) : route;
        if (reply instanceof Error) throw reply;
        const headers: Record<string, string | string[] | undefined> = {};
        for (const [name, value] of Object.entries(reply.headers ?? {})) headers[name.toLowerCase()] = value;
        const source = reply.body;
        const chunkSize = reply.chunk;
        async function* body(): AsyncGenerator<Uint8Array> {
            if (typeof source === 'function') {
                yield* source(req);
                return;
            }
            const bytes = typeof source === 'string' ? enc.encode(source) : (source ?? new Uint8Array());
            const size = chunkSize ?? Math.max(bytes.byteLength, 1);
            for (let at = 0; at < bytes.byteLength; at += size) yield bytes.subarray(at, at + size);
        }
        const response: TransportResponse = {
            status: reply.status ?? 200,
            headers,
            body: body(),
            close: () => {
                closed.count++;
            },
        };
        return response;
    };

    return { resolve, transport, resolveCalls, calls, closed };
}

/** A generator that yields `total` bytes in `chunk`-byte pieces and counts how many it was asked for. */
export function countedBody(total: number, chunk: number, fill = 0x61): { body: () => AsyncIterable<Uint8Array>; pulled: { chunks: number } } {
    const pulled = { chunks: 0 };
    const body = async function* (): AsyncGenerator<Uint8Array> {
        for (let sent = 0; sent < total; sent += chunk) {
            pulled.chunks++;
            yield new Uint8Array(Math.min(chunk, total - sent)).fill(fill);
        }
    };
    return { body, pulled };
}

/** A body that ends only when the request is aborted: a server that sends a little and then stalls. */
export const stallingBody = (first = 'x') =>
    async function* (req: TransportRequest): AsyncGenerator<Uint8Array> {
        yield enc.encode(first);
        await new Promise<void>((resolveWait) => {
            if (req.signal.aborted) return resolveWait();
            req.signal.addEventListener('abort', () => resolveWait(), { once: true });
        });
    };

export const html = (title = 'Hi', body = '<p>Hello</p>'): Reply => ({ headers: { 'content-type': 'text/html; charset=utf-8' }, body: `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>` });
