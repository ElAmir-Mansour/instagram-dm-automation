/**
 * Plumbing the Growth services share: the refusal they throw, the permissions they need, and
 * the small readers every route input goes through. GROWTH.md is the contract; README.md beside
 * this file is where each permission and metric name comes from.
 */

/**
 * A refusal the route answers as-is: `status` and `{ error, ...extra }`. Thrown from the services,
 * like `StudioError`, so a route stays a thin wrapper.
 */
export class GrowthError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly extra?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'GrowthError';
    }
}

/** Said when a v22 table is missing, instead of an opaque 500. */
export const GROWTH_MIGRATION_HINT =
    'The database is missing migration v22 (src/config/migration_v22_growth.sql). '
    + 'Apply it with `npm run migrate`, then reload.';

/** The permission each platform's insights need beyond what publishing already has. */
export const INSIGHTS_SCOPE = {
    instagram: 'instagram_manage_insights',
    facebook: 'read_insights',
} as const;

/** Business Discovery's permissions (README.md §1). The token already needs the other two to publish. */
export const BUSINESS_DISCOVERY_SCOPES = ['instagram_basic', 'instagram_manage_insights', 'pages_read_engagement'] as const;

/** What TikTok analytics would need. Not requested by the app yet, so TikTok stays `unavailable`. */
export const TIKTOK_ANALYTICS_SCOPES = ['video.list', 'user.info.stats'] as const;

/** POST /api/growth/sync is allowed once per this many minutes per tenant. */
export const SYNC_INTERVAL_MINUTES = 10;

/** The sentence the permission banner shows, naming exactly what to add. */
export function permissionFix(missing: readonly string[]): string | null {
    if (!missing.length) return null;
    const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0]!;
    return `Regenerate the Meta Page access token with ${list} added to its permissions `
        + '(docs/TOKEN_GUIDE.md), then paste it in Settings → Access token.';
}

/** An integer query parameter, clamped; the fallback when absent or not a number. */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : Number.NaN;
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

/** A finite number, or undefined. Meta sends some counts as strings. */
export function num(value: unknown): number | undefined {
    const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
    return Number.isFinite(n) ? n : undefined;
}

/** Trimmed text on one line, cut to `max` UTF-16 units, or '' when absent. */
export function clip(value: unknown, max: number): string {
    if (typeof value !== 'string') return '';
    const text = value.replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
