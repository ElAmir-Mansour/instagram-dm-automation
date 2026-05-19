import type { Request, Response, NextFunction } from 'express';

/**
 * Dashboard Authentication Middleware
 * 
 * Protects /api/* routes with a simple password-based session system.
 * The dashboard password is set via DASHBOARD_PASSWORD in .env.
 * 
 * Auth flow:
 * 1. User logs in via POST /api/auth/login with the password
 * 2. Server returns a session token (stored in-memory)
 * 3. All subsequent API calls include the token in Authorization header
 */

// In-memory session store (sufficient for single-instance Vercel)
const activeSessions = new Map<string, { createdAt: number }>();
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

/** Generate a random session token */
function generateToken(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 64; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/** Clean up expired sessions */
function cleanExpired(): void {
    const now = Date.now();
    for (const [token, session] of activeSessions) {
        if (now - session.createdAt > SESSION_TTL) {
            activeSessions.delete(token);
        }
    }
}

/** Create a new session and return the token */
export function createSession(): string {
    cleanExpired();
    const token = generateToken();
    activeSessions.set(token, { createdAt: Date.now() });
    return token;
}

/** Auth middleware — checks for valid session token */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;
    const token = authHeader?.replace('Bearer ', '');

    if (!token || !activeSessions.has(token)) {
        res.status(401).json({ error: 'Unauthorized — please login first.' });
        return;
    }

    const session = activeSessions.get(token)!;
    if (Date.now() - session.createdAt > SESSION_TTL) {
        activeSessions.delete(token);
        res.status(401).json({ error: 'Session expired — please login again.' });
        return;
    }

    next();
}
