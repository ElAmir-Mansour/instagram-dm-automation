/**
 * Secrets at rest.
 *
 * Two properties are worth pinning here and neither is visible from a call site. The first is
 * that the ciphertext is *authenticated*: AES-GCM's whole reason for being chosen over CBC is
 * that a tampered value fails loudly instead of decrypting to garbage a caller would happily
 * send to Meta as an access token. The second is that a value without the `enc:v1:` prefix is
 * returned unchanged — that is the entire migration story for the tokens already in the
 * database, and if it ever stopped holding, every legacy row would start throwing on read.
 *
 * The key is set per-test rather than read from the environment: a test that silently used
 * production's `TOKEN_ENCRYPTION_KEY` would pass here and fail on any other machine.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decryptSecret, encryptSecret, hashPassword, isEncrypted, verifyPassword } from './crypto.js';

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

let savedKey: string | undefined;
beforeEach(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = KEY_A;
});
afterEach(() => {
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
});

describe('encryptSecret / decryptSecret', () => {
    it('round-trips a Meta page token', () => {
        const token = 'EAAG' + 'x'.repeat(180);
        const stored = encryptSecret(token);

        assert.notEqual(stored, token, 'the plaintext must not survive into storage');
        assert.equal(stored.includes(token), false);
        assert.equal(decryptSecret(stored), token);
    });

    it('marks the stored form with enc:v1: so a reader can tell the two apart', () => {
        const stored = encryptSecret('secret');

        assert.ok(stored.startsWith('enc:v1:'));
        assert.equal(isEncrypted(stored), true);
        assert.equal(isEncrypted('EAAGplaintexttoken'), false);
        // Five colon-separated parts: enc, v1, iv, tag, ciphertext.
        assert.equal(stored.split(':').length, 5);
    });

    it('uses a fresh IV per call, so the same secret never stores identically', () => {
        // A reused IV under GCM is catastrophic, and the failure mode is a pair of identical
        // ciphertexts — which is exactly what this asserts is absent.
        const a = encryptSecret('same input');
        const b = encryptSecret('same input');

        assert.notEqual(a, b);
        assert.equal(decryptSecret(a), 'same input');
        assert.equal(decryptSecret(b), 'same input');
    });

    it('refuses a ciphertext that has been altered', () => {
        // The point of the auth tag. Without it a flipped byte decrypts to a different token
        // and this function hands the caller a plausible-looking string to send to Meta.
        const stored = encryptSecret('EAAGrealtoken');
        const [, , iv, tag, ct] = stored.split(':');
        const bytes = Buffer.from(ct!, 'base64url');
        bytes[0] = bytes[0]! ^ 0xff;
        const tampered = `enc:v1:${iv}:${tag}:${bytes.toString('base64url')}`;

        assert.throws(() => decryptSecret(tampered));
    });

    it('refuses a ciphertext carrying someone else\'s auth tag', () => {
        const a = encryptSecret('token-a');
        const b = encryptSecret('token-b');
        const [, , ivA, , ctA] = a.split(':');
        const [, , , tagB] = b.split(':');

        assert.throws(() => decryptSecret(`enc:v1:${ivA}:${tagB}:${ctA}`));
    });

    it('refuses to decrypt with a different key', () => {
        const stored = encryptSecret('EAAGrealtoken');
        process.env.TOKEN_ENCRYPTION_KEY = KEY_B;

        assert.throws(() => decryptSecret(stored));
    });

    it('returns a legacy plaintext value unchanged', () => {
        // The whole reason this deployed without a migration window: rows written before
        // encryption existed still have to read back correctly.
        assert.equal(decryptSecret('EAAGlegacyplaintext'), 'EAAGlegacyplaintext');
        // ...and it must not need the key to do it, because that path predates the key.
        delete process.env.TOKEN_ENCRYPTION_KEY;
        assert.equal(decryptSecret('EAAGlegacyplaintext'), 'EAAGlegacyplaintext');
    });

    it('treats a missing token as the empty string rather than throwing', () => {
        assert.equal(decryptSecret(null), '');
        assert.equal(decryptSecret(undefined), '');
        assert.equal(decryptSecret(''), '');
    });

    it('names the problem when the stored form is truncated', () => {
        assert.throws(
            () => decryptSecret('enc:v1:onlyoneparta'),
            /malformed/
        );
    });

    it('will not encrypt without a key, or with one of the wrong length', () => {
        delete process.env.TOKEN_ENCRYPTION_KEY;
        assert.throws(() => encryptSecret('x'), /TOKEN_ENCRYPTION_KEY is not set/);

        process.env.TOKEN_ENCRYPTION_KEY = 'abcd';
        assert.throws(() => encryptSecret('x'), /32 bytes/);
    });
});

describe('hashPassword / verifyPassword', () => {
    it('accepts the right password and rejects a wrong one', async () => {
        const stored = await hashPassword('correct horse battery staple');

        assert.equal(await verifyPassword('correct horse battery staple', stored), true);
        assert.equal(await verifyPassword('correct horse battery stapl', stored), false);
    });

    it('stores a salted scrypt hash, not the password', async () => {
        const stored = await hashPassword('hunter2');
        const [scheme, salt, digest] = stored.split(':');

        assert.equal(scheme, 'scrypt');
        assert.equal(stored.includes('hunter2'), false);
        // 16-byte salt and 64-byte derived key, base64url.
        assert.equal(Buffer.from(salt!, 'base64url').length, 16);
        assert.equal(Buffer.from(digest!, 'base64url').length, 64);
    });

    it('salts per call, so two identical passwords do not share a digest', async () => {
        const a = await hashPassword('same');
        const b = await hashPassword('same');

        assert.notEqual(a, b);
        assert.equal(await verifyPassword('same', b), true);
    });

    it('returns false rather than throwing on a hash it cannot parse', async () => {
        // These reach `verifyPassword` from the database: a bcrypt hash left by an older
        // build, a NULL column, a row half-written by a failed migration. Throwing here
        // turns a failed login into a 500.
        for (const bad of ['', 'not-a-hash', 'bcrypt:abc:def', 'scrypt:', 'scrypt:onlysalt']) {
            assert.equal(await verifyPassword('anything', bad), false, `for ${JSON.stringify(bad)}`);
        }
        assert.equal(await verifyPassword('anything', null as unknown as string), false);
    });

    it('FINDING: accepts a truncated stored digest — the length guard cannot fire', async () => {
        // This documents a defect rather than endorsing it, so that fixing it turns this red
        // and whoever fixes it sees why the test was here.
        //
        // `verifyPassword` derives `expected.length` bytes — the length of whatever is *in the
        // database* — rather than the fixed `SCRYPT_PARAMS.keylen`. The positional argument
        // wins over `keylen` in the options object (verified against Node 22), so `derived`
        // always comes back exactly as long as `expected` and the
        // `derived.length !== expected.length` guard below it is unreachable. scrypt finishes
        // with one PBKDF2 pass, so a shorter output is a byte-exact prefix of a longer one —
        // which is what makes a truncated digest still match.
        //
        // The consequence is that the work an attacker must do is set by the stored value: a
        // digest cut to a single byte accepts roughly one password in 256. That needs write
        // access to `users.password_hash` to exploit, so it is not urgent — but it is the
        // exact scenario the length check was written to refuse, and it refuses nothing.
        const stored = await hashPassword('pw');
        const [, salt, digest] = stored.split(':');
        const raw = Buffer.from(digest!, 'base64url');

        const truncated = raw.subarray(0, 32).toString('base64url');
        assert.equal(
            await verifyPassword('pw', `scrypt:${salt}:${truncated}`),
            true,
            'if this is now false the defect is fixed — delete this test and keep the one below'
        );

        // A wrong password is still rejected at full length, which is why this is a weakness
        // and not an open door.
        assert.equal(await verifyPassword('wrong', stored), false);
    });

    it('does not accept a digest produced with a different salt', async () => {
        const stored = await hashPassword('pw');
        const [, , digest] = stored.split(':');
        const otherSalt = crypto.randomBytes(16).toString('base64url');

        assert.equal(await verifyPassword('pw', `scrypt:${otherSalt}:${digest}`), false);
    });
});
