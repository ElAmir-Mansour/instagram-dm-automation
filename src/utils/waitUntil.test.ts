/**
 * The `waitUntil` seam (src/utils/waitUntil.ts): what it hands to the platform, what it never
 * lets reach the request, and the one line it logs when the platform is not there to take it.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { waitUntil as platformWaitUntil } from '@vercel/functions';
import { setLogSink } from './log.js';
import { setWaitUntil, waitUntil } from './waitUntil.js';

const REQUEST_CONTEXT = Symbol.for('@vercel/request-context');

let lines: Array<{ event: string; level: string }>;
let restoreSink: (() => void) | undefined;
const savedVercel = process.env['VERCEL'];

beforeEach(() => {
    lines = [];
    const previous = setLogSink((level, line) => { lines.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
    // The real package, with the "already warned" flag cleared.
    setWaitUntil(platformWaitUntil);
    delete process.env['VERCEL'];
});

afterEach(() => {
    restoreSink?.();
    setWaitUntil(platformWaitUntil);
    delete (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT];
    if (savedVercel === undefined) delete process.env['VERCEL'];
    else process.env['VERCEL'] = savedVercel;
});

const events = () => lines.map((l) => l.event);

describe('waitUntil seam', () => {
    it('hands the promise to the installed handoff, and setWaitUntil returns the one it replaced', () => {
        const received: Promise<unknown>[] = [];
        const previous = setWaitUntil((p) => { received.push(p); });
        assert.equal(previous, platformWaitUntil);

        const work = Promise.resolve();
        waitUntil(work);
        assert.deepEqual(received, [work]);
    });

    it('never throws into the request: a failing handoff is logged', () => {
        setWaitUntil(() => { throw new Error('boom'); });
        assert.doesNotThrow(() => waitUntil(Promise.resolve()));
        assert.deepEqual(events(), ['runtime.wait_until_failed']);
    });

    it('is a silent no-op with no request context outside Vercel', () => {
        assert.doesNotThrow(() => waitUntil(Promise.resolve()));
        assert.deepEqual(events(), []);
    });

    it('passes the work to the platform when the request has a context', () => {
        const received: Promise<unknown>[] = [];
        (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => { received.push(p); } }) };
        process.env['VERCEL'] = '1';

        const work = Promise.resolve();
        waitUntil(work);

        assert.deepEqual(received, [work]);
        assert.deepEqual(events(), [], 'nothing to warn about');
    });

    it('on Vercel with no waitUntil from the platform, says so once per instance', () => {
        process.env['VERCEL'] = '1';

        waitUntil(Promise.resolve());
        waitUntil(Promise.resolve());

        assert.deepEqual(events(), ['runtime.wait_until_unavailable']);
        assert.equal(lines[0]!.level, 'warn');
    });

    it('a context whose get() throws counts as no context and still never throws', () => {
        (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] = { get: () => { throw new Error('no store'); } };
        process.env['VERCEL'] = '1';
        // The package itself would throw reading it; the seam contains that.
        assert.doesNotThrow(() => waitUntil(Promise.resolve()));
        assert.ok(events().includes('runtime.wait_until_unavailable'));
        assert.ok(events().includes('runtime.wait_until_failed'));
    });

    it('refuses a non-promise inside the seam (the package throws a TypeError), without reaching the caller', () => {
        assert.doesNotThrow(() => waitUntil(undefined as unknown as Promise<unknown>));
        assert.deepEqual(events(), ['runtime.wait_until_failed']);
    });
});
