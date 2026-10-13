/**
 * The throttle every credential-shaped endpoint shares: the login, and the two public invite routes (peek, accept).
 *
 * Per-instance, so it is a speed bump and not a guarantee: Vercel keeps as many warm lambdas
 * as it likes and each one starts this Map empty, so an attacker spreading attempts across
 * instances multiplies the limit by however many are running. A shared store is the real fix
 * — the same one `rate_limit_counters` would be if it did not require a creator FK. For the invite routes that is
 * acceptable, and said so in docs/onboarding/02 §5: the token's 256 bits are the defence, this only slows a flood.
 *
 * It lived in `routes/api.ts` until the invite routes needed it too; the router that mounts them cannot import from
 * `api.ts` (which imports it), so it moved here, unchanged.
 */
import type { Request } from 'express';

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_FREE_ATTEMPTS = 5;
export const LOGIN_MAX_DELAY_MS = 5 * 60 * 1000;
const loginAttempts = new Map<string, { count: number; windowStart: number; last: number }>();

export function clientIp(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    return (first || req.socket?.remoteAddress || 'unknown').trim();
}

/** Seconds this IP must still wait, or 0 when it may try now. */
export function loginRetryAfter(ip: string): number {
    const record = loginAttempts.get(ip);
    if (!record) return 0;

    const now = Date.now();
    if (now - record.windowStart > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
        return 0;
    }
    if (record.count <= LOGIN_FREE_ATTEMPTS) return 0;

    const delay = Math.min(2 ** (record.count - LOGIN_FREE_ATTEMPTS) * 1000, LOGIN_MAX_DELAY_MS);
    const remaining = record.last + delay - now;
    return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

export function recordLoginFailure(ip: string): void {
    const now = Date.now();
    const record = loginAttempts.get(ip);

    if (record && now - record.windowStart <= LOGIN_WINDOW_MS) {
        record.count += 1;
        record.last = now;
    } else {
        loginAttempts.set(ip, { count: 1, windowStart: now, last: now });
    }

    // Sweep stale entries occasionally so a spray across many IPs cannot grow the map forever.
    if (loginAttempts.size > 1000) {
        for (const [seen, entry] of loginAttempts) {
            if (now - entry.windowStart > LOGIN_WINDOW_MS) loginAttempts.delete(seen);
        }
    }
}

/** A successful login forgets the address's failures. */
export function clearLoginFailures(ip: string): void {
    loginAttempts.delete(ip);
}

/** Forget everything. For tests: the Map is module state, and one test's failures must not throttle the next. */
export function resetLoginThrottle(): void {
    loginAttempts.clear();
}
