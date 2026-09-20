/**
 * Shared HTTP client for Meta Graph API calls.
 *
 * Two problems this fixes:
 *   1. No call had a timeout, so a hung socket burned the whole function budget.
 *   2. Only `media_publish` retried. sendPrivateReply / sendPublicReply / sendDirectMessage /
 *      likeComment had none, so a single transient 500 marked the interaction FAILED
 *      permanently with no second attempt.
 */
import axios from 'axios';

export const metaHttp = axios.create({ timeout: 10_000 });

/** Meta error codes that are transient — worth retrying. */
const TRANSIENT_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);

/**
 * Codes that are permanent. Retrying these is worse than useless: hammering Meta with a
 * dead token is how an app attracts enforcement attention.
 *   10903 — recipient has blocked DMs from businesses
 *   190   — invalid / expired access token
 *   200   — insufficient permission
 */
const PERMANENT_CODES = new Set([190, 200, 10903]);

export function isPermanentMetaError(err: any): boolean {
    const code = err?.response?.data?.error?.code;
    return typeof code === 'number' && PERMANENT_CODES.has(code);
}

function isRetryable(err: any): boolean {
    if (isPermanentMetaError(err)) return false;

    const status = err?.response?.status;
    if (typeof status === 'number' && status >= 500) return true;
    if (status === 429) return true;

    const code = err?.response?.data?.error?.code;
    if (typeof code === 'number' && TRANSIENT_CODES.has(code)) return true;

    // Network-level failures carry no HTTP response at all.
    return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(err?.code);
}

export interface RetryOptions {
    retries?: number;
    baseMs?: number;
    label?: string;
}

/** Exponential backoff with jitter. Gives up immediately on permanent errors. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const { retries = 3, baseMs = 500, label = 'meta-call' } = opts;
    let lastErr: any;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            if (attempt === retries || !isRetryable(err)) throw err;

            const delay = Math.round(baseMs * 2 ** attempt * (0.5 + Math.random()));
            console.warn(
                `[retry] ${label} attempt ${attempt + 1}/${retries} failed ` +
                `(${err?.response?.data?.error?.code ?? err?.code ?? err?.response?.status}); ` +
                `retrying in ${delay}ms`
            );
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
