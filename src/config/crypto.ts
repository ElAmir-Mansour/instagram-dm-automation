/**
 * Secret handling: Meta token encryption at rest, and password hashing.
 *
 * Why application-layer AES-GCM rather than Supabase Vault / pgsodium: the threat this
 * defends against is database access — which is exactly the threat that materialised when the
 * connection string was committed to a public repo. A key stored in the same database as the
 * data does not help there. An env-held key lives in a different trust domain. (pgsodium is
 * also pending deprecation.)
 *
 * Encrypting now rather than later is deliberate: migrating plaintext secrets after tenants
 * exist means rotating every tenant's Meta token simultaneously.
 */
import crypto from 'crypto';

const ENC_PREFIX = 'enc:v1:';

/**
 * 32 bytes, hex-encoded. Generate with: openssl rand -hex 32
 *
 * Resolved lazily rather than at module load, because this module is imported by code paths
 * that must still work before the key is configured — reads of legacy plaintext tokens.
 */
function getKey(): Buffer {
    const raw = process.env.TOKEN_ENCRYPTION_KEY;
    if (!raw) {
        throw new Error(
            'TOKEN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32` ' +
            'and add it to the environment before storing Meta tokens.'
        );
    }
    const key = Buffer.from(raw, 'hex');
    if (key.length !== 32) {
        throw new Error(`TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars); got ${key.length}.`);
    }
    return key;
}

export function isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** Encrypt a secret for storage. Format: enc:v1:<iv>:<tag>:<ciphertext>, all base64url. */
export function encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Decrypt a stored secret.
 *
 * A value without the prefix is returned unchanged. That is what makes this deployable
 * without a migration window: existing plaintext tokens keep working, and each one becomes
 * encrypted the next time it is written.
 */
export function decryptSecret(stored: string | null | undefined): string {
    if (!stored) return '';
    if (!isEncrypted(stored)) return stored;

    const [, , ivB64, tagB64, ctB64] = stored.split(':');
    if (!ivB64 || !tagB64 || !ctB64) {
        throw new Error('Stored secret is malformed — expected enc:v1:<iv>:<tag>:<ciphertext>.');
    }

    const decipher = crypto.createDecipheriv(
        'aes-256-gcm', getKey(), Buffer.from(ivB64, 'base64url')
    );
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([
        decipher.update(Buffer.from(ctB64, 'base64url')),
        decipher.final()
    ]).toString('utf8');
}

// ─── Personal data at rest (lead ads, A10) ──────────────────────────────────────────────
// The same key and cipher as the tokens above, for a different kind of secret: what a person typed into a lead form. Stored as raw bytes
// (`ads_leads.answers_enc BYTEA`) rather than the `enc:v1:` text form, because nothing ever needs to tell an encrypted answer from a plain
// one (there never was a plain one) and BYTEA keeps the column from being read as text by anything that lists rows.

/** AES-256-GCM: `iv (12) | tag (16) | ciphertext`. A fresh IV every call, so the same answers never encrypt to the same bytes. */
export function encryptBytes(plaintext: string): Buffer {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

/** The inverse of `encryptBytes`. Throws on a wrong key or a tampered value (the tag does not verify): never returns garbage. */
export function decryptBytes(stored: Buffer): string {
    if (!Buffer.isBuffer(stored) || stored.length < 28) throw new Error('Encrypted value is malformed: expected iv | tag | ciphertext.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), stored.subarray(0, 12));
    decipher.setAuthTag(stored.subarray(12, 28));
    return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString('utf8');
}

/**
 * A keyed hash of one normalised identifier (an email, a phone number's digits), so a person's rows can be FOUND without being readable:
 * the data-erasure flow asks "which leads did this email give?" and gets an answer without decrypting every lead (`ads_leads.person_keys`).
 *
 * HMAC-SHA256 under a key DERIVED from TOKEN_ENCRYPTION_KEY (HKDF, its own `info`), not the key itself and not a bare SHA-256: a bare hash
 * of an email is reversible by guessing (emails are a small space); without the env-held key these are not. The caller normalises first
 * (ads/hashing.ts `normaliseEmail` / `normalisePhone`), so `A@B.com` and `a@b.com` give one key.
 */
export function personKey(normalised: string): string {
    const derived = Buffer.from(crypto.hkdfSync('sha256', getKey(), Buffer.alloc(0), Buffer.from('ads-leads:person:v1'), 32));
    return crypto.createHmac('sha256', derived).update(normalised, 'utf8').digest('hex');
}

// ─── Passwords ──────────────────────────────────────────────────────────────────────────
// scrypt from Node's stdlib rather than bcrypt: it is memory-hard, it is already available,
// and this project has four production dependencies — worth keeping it that way.

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16);
        crypto.scrypt(password, salt, SCRYPT_PARAMS.keylen, SCRYPT_PARAMS, (err, derived) => {
            if (err) return reject(err);
            resolve(`scrypt:${salt.toString('base64url')}:${derived.toString('base64url')}`);
        });
    });
}

/** Constant-time verification. Returns false rather than throwing on a malformed hash. */
export function verifyPassword(password: string, stored: string): Promise<boolean> {
    return new Promise((resolve) => {
        const [scheme, saltB64, hashB64] = (stored || '').split(':');
        if (scheme !== 'scrypt' || !saltB64 || !hashB64) return resolve(false);

        const expected = Buffer.from(hashB64, 'base64url');
        crypto.scrypt(
            // Derive a FIXED length, never `expected.length`. scrypt's positional keylen wins
            // over the one in the options object, so deriving `expected.length` made `derived`
            // always match and left the guard below unreachable — and because scrypt ends in a
            // single PBKDF2 pass, a short output is a byte-exact prefix of a long one, so a
            // truncated stored digest still verified. The work factor was set by the database.
            password, Buffer.from(saltB64, 'base64url'), SCRYPT_PARAMS.keylen, SCRYPT_PARAMS,
            (err, derived) => {
                if (err || derived.length !== expected.length) return resolve(false);
                resolve(crypto.timingSafeEqual(derived, expected));
            }
        );
    });
}
