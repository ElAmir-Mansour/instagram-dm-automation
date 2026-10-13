/**
 * A `fetch` that answers from a script, for the tests of everything that calls a model: no
 * network, every request recorded. Not a test file itself, so `npm test` does not run it.
 */
import type { FetchLike } from './types.js';

export type Recorded = {
    url: string;
    method: string | undefined;
    /** Header names lower-cased. */
    headers: Record<string, string>;
    /** The body exactly as it went out, so a test can ask whether a secret is anywhere in it. */
    raw: string;
    body: any;
    signal: AbortSignal | null | undefined;
};

export type Scripted = Response | Error | (() => Response | Promise<Response>);

/** Answers each call with the next item; a call past the end is a test failure, not a hang. */
export function stubFetch(...script: Scripted[]): { fetchImpl: FetchLike; calls: Recorded[] } {
    const calls: Recorded[] = [];
    const queue = [...script];
    const fetchImpl: FetchLike = async (url, init) => {
        const raw = String(init.body ?? '');
        calls.push({
            url,
            method: init.method,
            headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])),
            raw,
            body: raw ? JSON.parse(raw) : undefined,
            signal: init.signal,
        });
        const next = queue.shift();
        if (!next) throw new Error('unexpected extra fetch');
        if (next instanceof Error) throw next;
        return typeof next === 'function' ? next() : next;
    };
    return { fetchImpl, calls };
}

export const jsonResponse = (status: number, body: unknown): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A server that never answers: settles only when the request's own signal aborts, as a real fetch
 * does. A real socket keeps the process alive while it waits, and `AbortSignal.timeout`'s timer
 * does not, so without a handle of our own the test runner would see an idle event loop and give
 * up on the pending promise instead of letting the deadline fire.
 */
export const hangingFetch: FetchLike = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const socket = setInterval(() => {}, 1000);
        const abort = () => {
            clearInterval(socket);
            reject(signal.reason ?? new DOMException('This operation was aborted', 'AbortError'));
        };
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
    });
