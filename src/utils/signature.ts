import crypto from 'crypto';
import type { Request } from 'express';

/**
 * Verifies the HMAC SHA-256 signature on incoming Meta webhook requests.
 * 
 * Meta signs every webhook payload with your App Secret. This function
 * recomputes the signature and compares it to the one in the header
 * to ensure the request is genuinely from Meta, not a spoofed payload.
 * 
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyMetaSignature(req: Request, rawBody: Buffer): boolean {
    const signature = req.headers['x-hub-signature-256'] as string;
    if (!signature) return false;

    const expectedHash = crypto
        .createHmac('sha256', process.env.META_APP_SECRET || '')
        .update(rawBody)
        .digest('hex');

    return signature === `sha256=${expectedHash}`;
}
