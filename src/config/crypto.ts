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
            password, Buffer.from(saltB64, 'base64url'), expected.length, SCRYPT_PARAMS,
            (err, derived) => {
                if (err || derived.length !== expected.length) return resolve(false);
                resolve(crypto.timingSafeEqual(derived, expected));
            }
        );
    });
}
