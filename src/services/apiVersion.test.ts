/**
 * The Graph API version resolver.
 *
 * Why this is tested at all: Meta's versioning policy does not fail loudly. Once a version
 * stops being usable, calls are "defaulted to the next oldest, usable version" — nothing
 * 404s, nothing logs, the semantics just change underneath you. The project sat on v21.0
 * (expiring ~2027-01-21) precisely because nothing made that visible.
 *
 * So the resolver's job is narrow but load-bearing: a valid override wins, an invalid one is
 * loud rather than silently building a URL Meta will reject, and the default is a real
 * version rather than whatever a typo left behind.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { API_VERSION, DEFAULT_API_VERSION, resolveApiVersion } from './instagram.js';

describe('Graph API version', () => {
    let saved: string | undefined;

    beforeEach(() => { saved = process.env.META_API_VERSION; });
    afterEach(() => {
        if (saved === undefined) delete process.env.META_API_VERSION;
        else process.env.META_API_VERSION = saved;
    });

    it('defaults to a well-formed, current version', () => {
        delete process.env.META_API_VERSION;
        assert.equal(resolveApiVersion(), DEFAULT_API_VERSION);
        assert.match(DEFAULT_API_VERSION, /^v\d+\.\d+$/);
        // Guards against a rollback that silently reinstates the version this bump moved off.
        assert.notEqual(DEFAULT_API_VERSION, 'v21.0');
    });

    it('honours a valid override, so rollback is an env change not a deploy', () => {
        process.env.META_API_VERSION = 'v25.0';
        assert.equal(resolveApiVersion(), 'v25.0');
    });

    it('trims surrounding whitespace, which a pasted env value carries', () => {
        process.env.META_API_VERSION = '  v24.0  ';
        assert.equal(resolveApiVersion(), 'v24.0');
    });

    it('falls back to the default for anything malformed', () => {
        // Each of these would otherwise build a URL Meta rejects, turning every Meta call
        // into an opaque failure.
        for (const bad of ['26.0', 'v26', 'latest', 'v26.0.1', 'v-1.0', '', '   ', 'vX.0', '../v26.0', 'v26.0/x']) {
            process.env.META_API_VERSION = bad;
            assert.equal(resolveApiVersion(), DEFAULT_API_VERSION, `input ${JSON.stringify(bad)}`);
        }
    });

    it('exports a usable API_VERSION at module load', () => {
        assert.match(API_VERSION, /^v\d+\.\d+$/);
    });
});
