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
import { log } from '../utils/log.js';

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

/**
 * `error_subcode` values that mean the token itself is dead rather than the request being
 * wrong. Meta reports all of them under code 190, so the code alone cannot tell "expired"
 * from "the user changed their password" from "the app was uninstalled" — and those need
 * different words in front of the operator.
 *
 *   458 — the app was uninstalled / user has not authorised it
 *   459 — the user must log in again (checkpointed)
 *   460 — the password was changed
 *   463 — the token expired
 *   467 — the token is invalid (logged out)
 *   492 — the user is not an admin of the page the token was issued for
 *
 * @see https://developers.facebook.com/docs/graph-api/guides/error-handling/
 */
export const TOKEN_DEATH_SUBCODES = new Set([458, 459, 460, 463, 467, 492]);

/**
 * The Meta error code, wherever it is.
 *
 * `src/services/instagram.ts` rewraps axios failures into plain `Error`s so the caller gets a
 * readable message, which used to throw away `response.data.error` entirely — so
 * `isPermanentMetaError` returned false for *every* error that came out of that module,
 * including a dead token. The rewrapped errors now carry `metaCode` / `metaSubcode`, and this
 * reads either shape.
 */
export function metaErrorCode(err: any): number | undefined {
    const structured = err?.response?.data?.error?.code;
    if (typeof structured === 'number') return structured;
    return typeof err?.metaCode === 'number' ? err.metaCode : undefined;
}

export function metaErrorSubcode(err: any): number | undefined {
    const structured = err?.response?.data?.error?.error_subcode;
    if (typeof structured === 'number') return structured;
    return typeof err?.metaSubcode === 'number' ? err.metaSubcode : undefined;
}

/**
 * True when Meta is saying the access token no longer works.
 *
 * This is the one Meta failure that stops the entire product rather than one send, and until
 * now nothing detected it at a call site: `creators.token_status` only changed when a token
 * was saved or when someone opened the dashboard's token page. A dead token on a Friday was
 * invisible until Monday.
 */
export function isTokenDeathError(err: any): boolean {
    if (metaErrorCode(err) !== 190) return false;
    const subcode = metaErrorSubcode(err);
    // A bare 190 with no subcode is still a dead token — subcodes narrow the reason, they do
    // not gate the conclusion.
    return subcode === undefined || TOKEN_DEATH_SUBCODES.has(subcode);
}

export function isPermanentMetaError(err: any): boolean {
    const code = metaErrorCode(err);
    return typeof code === 'number' && PERMANENT_CODES.has(code);
}

function isRetryable(err: any): boolean {
    if (isPermanentMetaError(err)) return false;

    const status = err?.response?.status;
    if (typeof status === 'number' && status >= 500) return true;
    if (status === 429) return true;

    const code = metaErrorCode(err);
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
            log('warn', 'meta.retrying', {
                label,
                attempt: attempt + 1,
                retries,
                reason: err?.response?.data?.error?.code ?? err?.code ?? err?.response?.status,
                delay_ms: delay,
            });
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}
