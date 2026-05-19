import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Dashboard Authentication Middleware (Stateless)
 * 
 * Uses HMAC-signed tokens instead of in-memory sessions so that
 * any Vercel serverless instance can independently verify the token
 * without needing shared state.
 * 
 * Token format: <timestamp>.<hmac_signature>
 * - timestamp: when the token was created (unix ms)
 * - hmac_signature: HMAC-SHA256 of the timestamp, signed with DASHBOARD_PASSWORD
 */

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** Get the signing secret (derived from dashboard password + app secret for extra entropy) */
function getSecret(): string {
    return (process.env.DASHBOARD_PASSWORD || 'admin') + ':' + (process.env.META_APP_SECRET || 'salt');
}

/** Create a stateless signed token */
export function createSession(): string {
    const timestamp = Date.now().toString();
    const signature = crypto
        .createHmac('sha256', getSecret())
        .update(timestamp)
        .digest('hex');
    return `${timestamp}.${signature}`;
}

/** Verify a stateless signed token */
function verifyToken(token: string): boolean {
    const parts = token.split('.');
    if (parts.length !== 2) return false;

    const timestamp = parts[0]!;
    const signature = parts[1]!;
    const ts = parseInt(timestamp, 10);
    if (isNaN(ts)) return false;

    // Check expiry
    if (Date.now() - ts > SESSION_TTL) return false;

    // Verify signature
    const expectedSignature = crypto
        .createHmac('sha256', getSecret())
        .update(timestamp)
        .digest('hex');

    try {
        return crypto.timingSafeEqual(
            Buffer.from(signature, 'hex'),
            Buffer.from(expectedSignature, 'hex')
        );
    } catch {
        return false;
    }
}

/** Auth middleware — verifies the stateless token */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    if (!token) {
        res.status(401).json({ error: 'Unauthorized — please login first.' });
        return;
    }

    if (!verifyToken(token)) {
        res.status(401).json({ error: 'Session expired or invalid — please login again.' });
        return;
    }

    next();
}
