import crypto from 'crypto';
import type { Request } from 'express';

const SIG_PREFIX = 'sha256=';
const DIGEST_BYTES = 32;

/**
 * Verifies the HMAC SHA-256 signature on incoming Meta webhook requests.
 *
 * Meta signs each payload with the App Secret of the app that sent it, and this
 * project receives events from two different apps:
 *
 *   - the Facebook app  → object 'page'      (feed, messages, messaging_postbacks)
 *   - the Instagram app → object 'instagram' (comments, messages)
 *
 * "Instagram API with Instagram Login" is a separate app with its own ID and
 * secret, so Instagram comment events do not validate against META_APP_SECRET.
 * A payload is genuine if it matches either secret.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyMetaSignature(req: Request, rawBody: Buffer): boolean {
    const header = req.headers['x-hub-signature-256'];
    if (typeof header !== 'string' || !header.startsWith(SIG_PREFIX)) return false;

    const provided = Buffer.from(header.slice(SIG_PREFIX.length), 'hex');
    // A malformed hex header decodes to the wrong length, which would make
    // timingSafeEqual throw rather than return false.
    if (provided.length !== DIGEST_BYTES) return false;

    return appSecrets().some((secret) => {
        const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
        return crypto.timingSafeEqual(expected, provided);
    });
}

/** Configured app secrets, in the order they are tried. */
export function appSecrets(): string[] {
    return [process.env.META_APP_SECRET, process.env.INSTAGRAM_APP_SECRET].filter(
        (s): s is string => Boolean(s),
    );
}
