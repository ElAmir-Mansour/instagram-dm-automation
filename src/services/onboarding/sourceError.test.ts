/**
 * The vocabulary of a failed source (03 §1): every kind says whether trying again can help, and no message can carry a credential.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import { SOURCE_ERROR_KINDS, SOURCE_RETRYABLE, scrubSecrets, sourceError, sourceFail } from './sourceError.js';
import { OWN_TOKEN, PLATFORM_TOKEN, YT_KEY } from './fixtures/instagram.js';

describe('which kinds are retried (03 §4)', () => {
    it('retries only what the platform may get right on a second try: a rate limit, a 5xx, a timeout', () => {
        assert.deepEqual(SOURCE_ERROR_KINDS.filter((k) => SOURCE_RETRYABLE[k]).sort(), ['rate_limited', 'upstream']);
    });

    it('has an answer for every kind, and sourceError takes it from the kind', () => {
        for (const kind of SOURCE_ERROR_KINDS) {
            assert.equal(typeof SOURCE_RETRYABLE[kind], 'boolean', kind);
            assert.equal(sourceError('youtube', kind, 'x').retryable, SOURCE_RETRYABLE[kind], kind);
        }
    });

    it('does not retry the answers a retry cannot change: not found, private, no key, a refused request, a spent quota', () => {
        for (const kind of ['not_found', 'not_readable', 'age_gated', 'not_configured', 'bad_request', 'quota', 'no_access', 'invalid_handle'] as const) {
            assert.equal(SOURCE_RETRYABLE[kind], false, kind);
        }
    });
});

describe('sourceError', () => {
    it('keeps the code and the HTTP status the platform sent, and null when it sent none', () => {
        assert.deepEqual(sourceError('instagram_discovery', 'not_readable', 'nope', { code: 110, http_status: 400 }), {
            source: 'instagram_discovery', kind: 'not_readable', retryable: false, message: 'nope', code: 110, http_status: 400,
        });
        const bare = sourceError('youtube', 'upstream', 'down');
        assert.equal(bare.code, null);
        assert.equal(bare.http_status, null);
    });

    it('is JSON, so it can be stored in sources_status as it is', () => {
        const error = sourceError('youtube', 'quota', 'spent', { http_status: 403 });
        assert.deepEqual(JSON.parse(JSON.stringify(error)), error);
    });

    it('scrubs the message in the constructor, so no construction site can forget', () => {
        const error = sourceError('instagram_own', 'upstream', `Meta said: Invalid token ${OWN_TOKEN} for this call`, { secrets: [OWN_TOKEN] });
        assert.ok(!error.message.includes(OWN_TOKEN));
        assert.ok(!JSON.stringify(error).includes(OWN_TOKEN));
    });

    it('sourceFail is the same error in a failed result', () => {
        const result = sourceFail('youtube', 'not_configured', 'no key');
        assert.equal(result.ok, false);
        if (!result.ok) assert.equal(result.error.kind, 'not_configured');
    });
});

describe('scrubSecrets', () => {
    it('removes a secret as given, and URL-encoded, wherever it is', () => {
        const key = 'ab/cd+ef=gh1234';
        const out = scrubSecrets(`GET /x?key=${encodeURIComponent(key)} failed, key ${key} rejected`, [key]);
        assert.ok(!out.includes(key));
        assert.ok(!out.includes(encodeURIComponent(key)));
    });

    it('removes more than one secret, and ignores empty and missing ones', () => {
        const out = scrubSecrets(`first ${PLATFORM_TOKEN} then ${YT_KEY}`, [PLATFORM_TOKEN, null, undefined, '', YT_KEY]);
        assert.ok(!out.includes(PLATFORM_TOKEN) && !out.includes(YT_KEY));
        assert.ok(out.startsWith('first'));
    });

    it('removes what only LOOKS like a credential when the secret is not passed (a Bearer header, an access_token, a long run)', () => {
        const out = scrubSecrets(`Authorization: Bearer ${OWN_TOKEN} and ?access_token=${PLATFORM_TOKEN} and ${'q'.repeat(60)}`);
        assert.ok(!out.includes(OWN_TOKEN) && !out.includes(PLATFORM_TOKEN) && !out.includes('q'.repeat(60)));
    });

    it('cuts to 240 characters and leaves an ordinary sentence alone', () => {
        assert.equal(scrubSecrets('Invalid user id'), 'Invalid user id');
        assert.ok(scrubSecrets('word '.repeat(200)).length <= 240);
    });

    it('does not let a secret survive as a prefix at the cut', () => {
        const message = `${'x '.repeat(112)}${OWN_TOKEN}`;
        const out = scrubSecrets(message, [OWN_TOKEN]);
        assert.ok(!out.includes(OWN_TOKEN.slice(0, 12)), 'the start of the token is not left behind either');
        assert.ok(!inspect(out).includes(OWN_TOKEN.slice(0, 20)));
    });
});
