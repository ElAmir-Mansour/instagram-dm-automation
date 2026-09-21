/**
 * The diagnostic probe tag.
 *
 * Two properties matter, and they pull in opposite directions:
 *   - it must correctly recognise our own probe, so the logs stop lying;
 *   - it must be unforgeable, so an attacker cannot label their own probing as our benign
 *     self-test and use a detection signal as cover.
 *
 * What it must NOT do is gate anything. That is a structural property — `isDiagnosticProbe`
 * is called only when building a log payload, after the request has already been rejected —
 * so it cannot be asserted from here. What is asserted here is that every failure mode
 * returns `false` rather than throwing, because a logging helper that throws would turn a
 * cleanly handled 403 into an unhandled 500.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request } from 'express';
import { PROBE_HEADER, isDiagnosticProbe, signProbeTag } from './probe.js';

const SECRET = 'meta-app-secret-for-tests';

function req(header?: string): Request {
    const headers: Record<string, string> = {};
    if (header !== undefined) headers[PROBE_HEADER] = header;
    return { headers } as unknown as Request;
}

/** A tag as the diagnostic would build it. */
const tagAt = (ts: number, secret = SECRET): string => `${ts}.${signProbeTag(ts, secret)}`;

describe('diagnostic probe tag', () => {
    let saved: string | undefined;

    beforeEach(() => {
        saved = process.env.META_APP_SECRET;
        process.env.META_APP_SECRET = SECRET;
    });

    afterEach(() => {
        if (saved === undefined) delete process.env.META_APP_SECRET;
        else process.env.META_APP_SECRET = saved;
    });

    it('recognises a freshly signed tag', () => {
        assert.equal(isDiagnosticProbe(req(tagAt(Date.now()))), true);
    });

    it('rejects a tag signed with a different secret', () => {
        // The whole point: an attacker without META_APP_SECRET cannot mint one.
        assert.equal(isDiagnosticProbe(req(tagAt(Date.now(), 'not-the-secret'))), false);
    });

    it('rejects a tampered signature', () => {
        const ts = Date.now();
        const sig = signProbeTag(ts, SECRET);
        const flipped = sig.startsWith('a') ? `b${sig.slice(1)}` : `a${sig.slice(1)}`;
        assert.equal(isDiagnosticProbe(req(`${ts}.${flipped}`)), false);
    });

    it('rejects a signature lifted onto a different timestamp', () => {
        const ts = Date.now();
        const sig = signProbeTag(ts, SECRET);
        assert.equal(isDiagnosticProbe(req(`${ts - 1000}.${sig}`)), false);
    });

    it('expires, so a captured tag cannot be replayed indefinitely', () => {
        assert.equal(isDiagnosticProbe(req(tagAt(Date.now() - 6 * 60 * 1000))), false);
        assert.equal(isDiagnosticProbe(req(tagAt(Date.now() - 4 * 60 * 1000))), true, 'still inside the window');
    });

    it('rejects a future-dated tag', () => {
        assert.equal(isDiagnosticProbe(req(tagAt(Date.now() + 6 * 60 * 1000))), false);
    });

    it('returns false when the secret is unavailable rather than treating it as a match', () => {
        const tag = tagAt(Date.now());
        delete process.env.META_APP_SECRET;
        assert.equal(isDiagnosticProbe(req(tag)), false);
    });

    it('returns false for every malformed shape, without throwing', () => {
        const ts = Date.now();
        for (const header of [
            undefined, '', '.', 'abc', `${ts}`, `${ts}.`, `.${signProbeTag(ts, SECRET)}`,
            `${ts}.nothex`, `${ts}.dead`, `${ts}.${signProbeTag(ts, SECRET)}.extra`,
            `notanumber.${signProbeTag(ts, SECRET)}`, `NaN.${signProbeTag(ts, SECRET)}`,
            `Infinity.${signProbeTag(ts, SECRET)}`,
        ]) {
            let out: boolean | undefined;
            assert.doesNotThrow(() => { out = isDiagnosticProbe(req(header)); }, `header ${JSON.stringify(header)}`);
            assert.equal(out, false, `header ${JSON.stringify(header)}`);
        }
    });

    it('does not throw when headers are missing entirely', () => {
        let out: boolean | undefined;
        assert.doesNotThrow(() => { out = isDiagnosticProbe({ headers: {} } as unknown as Request); });
        assert.equal(out, false);
    });

    it('signProbeTag is a plain HMAC over the timestamp, so the diagnostic can derive it', () => {
        const ts = 1_700_000_000_000;
        assert.equal(
            signProbeTag(ts, SECRET),
            createHmac('sha256', SECRET).update(`probe:${ts}`).digest('hex'),
        );
    });
});
