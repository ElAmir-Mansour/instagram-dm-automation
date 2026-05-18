/**
 * Rate Limiter
 * 
 * Tracks outgoing DM count per hour to stay within Meta's limits.
 * Instagram Graph API allows ~200 automated DMs per hour per account.
 * 
 * This is a simple in-memory rate limiter suitable for single-instance
 * serverless deployments (like Vercel). For multi-instance setups,
 * consider using Redis or a database-backed counter.
 */

class RateLimiter {
    public readonly limit: number;
    private readonly windowMs: number;
    private count: number = 0;
    private windowStart: number = Date.now();

    constructor(limit: number = 180, windowMs: number = 60 * 60 * 1000) {
        // Default: 180/hr (conservative buffer under Meta's 200/hr limit)
        this.limit = limit;
        this.windowMs = windowMs;
    }

    /** Check if we can send another message */
    canSend(): boolean {
        this.resetIfExpired();
        return this.count < this.limit;
    }

    /** Record a sent message */
    record(): void {
        this.resetIfExpired();
        this.count++;
    }

    /** Get current count in this window */
    getCount(): number {
        this.resetIfExpired();
        return this.count;
    }

    private resetIfExpired(): void {
        if (Date.now() - this.windowStart > this.windowMs) {
            this.count = 0;
            this.windowStart = Date.now();
        }
    }
}

export const rateLimiter = new RateLimiter();
