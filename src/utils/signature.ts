import crypto from 'crypto';
import type { Request } from 'express';
import { log } from './log.js';
import { isDiagnosticProbe } from './probe.js';

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
    // body-parser's `verify` hook only fires for the content types it handles, so a request
    // that is not JSON never captures a raw body. Feeding that undefined to hmac.update()
    // throws a TypeError, which surfaces to Meta as a 500 and earns a delivery retry storm
    // instead of the flat 403 a bogus request deserves.
    if (!Buffer.isBuffer(rawBody)) return false;

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

/**
 * Log that a webhook delivery failed its signature check: the `webhook.signature_rejected` line.
 *
 * The 403 happens before anything touches the database, so a rejected delivery and "nobody sent
 * anything" are otherwise byte-identical, and this line is the only evidence there is. It is the
 * first thing RUNBOOK §2.3 sends you to read, so it is loud (`error`) and its fields have to
 * survive the logger.
 *
 * They are a count and two yes/no answers, never a value, and they are named to stay clear of the
 * redactor (`REDACT_KEY` in log.ts), which blanks any field whose NAME contains `secret`, `token`,
 * `password`, `signature` and a few more. They used to be `secrets_tried`
 * and `instagram_secret_set`, and both printed `"[redacted]"`: the one line meant to say how many
 * secrets were tried said nothing. `signature.test.ts` sends this through the real `log`, so a name
 * the redactor would catch fails there instead of in production. (`meta.deauthorize_rejected` hit
 * the same trap and counts the same list as `app_keys_tried`.)
 *
 *   app_keys_tried            how many app secrets the signature was checked against; 0 means none is configured
 *   instagram_app_configured  whether INSTAGRAM_APP_SECRET is set, i.e. whether the Instagram app is one of them
 *   probe                     whether the request was this project's own diagnostic probe rather than a real delivery
 *
 * `probe` is a label and nothing else: `diagnose.mjs --probe-signature` proves this guard still
 * holds by sending an unsigned body, and its rejection used to be byte-identical to a real one,
 * which is a trap in an app whose documented worst failure is an invisible signature rejection.
 * It is called here, after the request has already been refused, and a forged tag changes nothing
 * (src/utils/probe.ts).
 */
export function logSignatureRejection(req: Request): void {
    log('error', 'webhook.signature_rejected', {
        app_keys_tried: appSecrets().length,
        instagram_app_configured: Boolean(process.env.INSTAGRAM_APP_SECRET),
        probe: isDiagnosticProbe(req),
    });
}
