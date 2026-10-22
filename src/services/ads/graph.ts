/**
 * The Marketing API client (research R1, R5; contracts/meta-graph.md). Every ads call goes through here, also v1's (`metaAds.ts` delegates
 * its four I/O helpers to it), so that:
 *
 *   - the version is the ads module's own, `ads.api_version` (default v26.0, never below v25.0), not the publisher's `META_API_VERSION`;
 *     every answer's `facebook-api-version` is compared with it, and a difference is logged as `ads.version_mismatch` (Meta answers on an
 *     older version silently once ours expires; the daily health check turns it into an alert);
 *   - each call spends from the ad account's budget in the pacer first (a read 1 point, a write 3), and Meta's usage headers are fed back;
 *   - Meta's errors come out as `AdsGraphError` with a class the callers act on. A throttle blocks the account in the pacer until the time
 *     Meta named and is thrown at once: `withRetry({ ads: true })` never retries a rate or edit limit.
 *
 * The tenant and the ad account are taken from the options, else from an `act_<id>` path, else from `withAdsContext` (the ads router sets
 * it for each request; the guard and the health check set it per tenant). A call with no tenant is still made, just not paced.
 *
 * The pacer is bookkeeping, not the limit itself: if its table cannot be reached the call goes ahead (Meta still enforces its own limit),
 * which also keeps the ads screens working for the minutes between a deploy and a late migration.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AxiosResponse } from 'axios';
import { describeError, log } from '../../utils/log.js';
import { APP_SETTING_KEYS, getSetting } from '../appSettings.js';
import { metaErrorCode, metaErrorSubcode, metaHttp, withRetry } from '../http.js';
import { MetaApiError } from '../instagram.js';
import { headerValue, readUsage } from './metaUsage.js';
import { block, blockUntilFor, observe, POINTS, reserve } from './pacer.js';

// ─── The version ────────────────────────────────────────────────────────────────────────────

export const ADS_DEFAULT_VERSION = 'v26.0';
/** The lowest major version accepted: v24 ends on 2026-11-10. */
export const ADS_VERSION_FLOOR = 25;

/** `vNN.N` at or above the floor, or null. */
export function normaliseApiVersion(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const m = value.trim().match(/^v(\d{2})\.(\d)$/);
    if (!m || Number(m[1]) < ADS_VERSION_FLOOR) return null;
    return `v${m[1]}.${m[2]}`;
}

const VERSION_TTL_MS = 60_000;
let versionCache: { value: string; at: number } | null = null;

export function resetAdsApiVersionCache(): void {
    versionCache = null;
}

/** The pinned version: the platform setting when it is a valid one, else the default. Read at most once a minute per instance. */
export async function adsApiVersion(): Promise<string> {
    if (versionCache && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.value;
    let value = ADS_DEFAULT_VERSION;
    try {
        const stored = await getSetting(APP_SETTING_KEYS.adsApiVersion);
        if (stored) {
            const v = normaliseApiVersion(stored);
            if (v) value = v;
            else log('warn', 'ads.api_version_refused', { stored: stored.slice(0, 20), using: ADS_DEFAULT_VERSION });
        }
    } catch (err) {
        log('warn', 'ads.api_version_unreadable', describeError(err));
    }
    versionCache = { value, at: Date.now() };
    return value;
}

// ─── The errors ─────────────────────────────────────────────────────────────────────────────

/**
 *   throttle         the ad account (or app) is rate limited: stop calling until `retryAt`
 *   budget_limit     613/1487632: this ad set's budget was changed 4 times this hour
 *   object_busy      613/4841018: the same object was edited less than 30 s ago
 *   spend_cap_limit  17/1885172: the account's spending limit was changed 10 times today
 *   token_dead       190 or 102: the token no longer works
 *   terms            200/1870090: the Custom Audience terms are not accepted
 *   page_assignment  10/1341012: the system user has no role on the Page
 */
export type AdsErrorClass = 'throttle' | 'budget_limit' | 'object_busy' | 'spend_cap_limit' | 'token_dead' | 'terms' | 'page_assignment' | 'other';

export function classifyAdsError(code: number | undefined, subcode: number | undefined): AdsErrorClass {
    if (code === undefined) return 'other';
    if (code === 613 && subcode === 1487632) return 'budget_limit';
    if (code === 613 && subcode === 4841018) return 'object_busy';
    if (code === 17 && subcode === 1885172) return 'spend_cap_limit';
    if (code === 190 || code === 102) return 'token_dead';
    if (code === 200 && subcode === 1870090) return 'terms';
    if (code === 10 && subcode === 1341012) return 'page_assignment';
    // 17/2446079, 613/*, 4/1504022, 4/1504039 and the 80000-series by name; the bare app/user/page limits (4, 17, 32) are throttles too.
    if (code === 4 || code === 17 || code === 32 || code === 613 || (code >= 80000 && code <= 80099)) return 'throttle';
    return 'other';
}

/** A Marketing API failure. `metaCode` / `metaSubcode` as `MetaApiError` has them; `retryAt` when waiting is the answer. Never the token. */
export class AdsGraphError extends MetaApiError {
    constructor(
        message: string,
        source: unknown,
        readonly klass: AdsErrorClass,
        readonly retryAt: Date | null,
        readonly fbtraceId: string | null,
        readonly status: number | null,
    ) {
        super(message, source);
        this.name = 'AdsGraphError';
    }
}

// ─── The context ────────────────────────────────────────────────────────────────────────────

export interface AdsContext {
    creatorId: string;
    adAccountId: string | null;
}

const contextStorage = new AsyncLocalStorage<AdsContext>();

/** Run `fn` with the tenant and ad account every Graph call inside it is paced against. */
export function withAdsContext<T>(ctx: AdsContext, fn: () => T): T {
    return contextStorage.run(ctx, fn);
}

export function currentAdsContext(): AdsContext | undefined {
    return contextStorage.getStore();
}

function accountFromPath(path: string): string | null {
    return path.match(/^act_(\d{5,25})(?:\/|$)/)?.[1] ?? null;
}

// ─── The calls ──────────────────────────────────────────────────────────────────────────────

export type GraphParams = Record<string, string | number | boolean | object>;

export interface AdsCallOptions {
    label: string;
    /** A POST that creates something: resent only when the connection never went out (http.ts `creates`). */
    creates?: boolean;
    /** Points this call costs; a GET is 1 and anything else 3 by default. */
    points?: number;
    /** The guard pausing campaigns: skips our own estimate, never Meta's block. */
    priority?: boolean;
    creatorId?: string;
    adAccountId?: string;
}

/** Bookkeeping that must never stop a call. */
async function quietly<T>(what: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
        return await fn();
    } catch (err) {
        log('warn', 'ads.pacer_unavailable', { what, ...describeError(err) });
        return undefined;
    }
}

async function call(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, opts: AdsCallOptions, send: (url: string, headers: Record<string, string>) => Promise<AxiosResponse>): Promise<AxiosResponse> {
    const version = await adsApiVersion();
    const ctx = contextStorage.getStore();
    const account = opts.adAccountId ?? accountFromPath(path) ?? ctx?.adAccountId ?? null;
    const creatorId = opts.creatorId ?? ctx?.creatorId ?? null;
    const paced = account !== null && creatorId !== null;
    const points = opts.points ?? (method === 'GET' ? POINTS.read : POINTS.write);

    if (paced) {
        const r = await quietly('reserve', () => reserve(account, creatorId, points, { priority: opts.priority }));
        if (r && !r.ok) {
            log('warn', 'ads.paced', { label: opts.label, ad_account_id: account, retry_at: r.retryAt.toISOString(), blocked: r.blocked });
            throw new AdsGraphError(`Meta's limit for this ad account is reached; try again after ${r.retryAt.toISOString()}.`, null, 'throttle', r.retryAt, null, null);
        }
    }

    const afterAnswer = async (headers: unknown) => {
        const served = headerValue(headers, 'facebook-api-version');
        if (served && served !== version) log('warn', 'ads.version_mismatch', { label: opts.label, pinned: version, served, ad_account_id: account });
        if (paced && headers) await quietly('observe', () => observe(account, creatorId, headers));
    };

    const url = `https://graph.facebook.com/${version}/${path}`;
    const headers = { Authorization: `Bearer ${token}` };
    try {
        const res = await withRetry(() => send(url, headers), { label: opts.label, ads: true, creates: opts.creates });
        await afterAnswer(res.headers);
        return res;
    } catch (err: any) {
        const answerHeaders = err?.response?.headers;
        await afterAnswer(answerHeaders);
        const code = metaErrorCode(err);
        const subcode = metaErrorSubcode(err);
        const klass = classifyAdsError(code, subcode);
        const now = new Date();
        let retryAt: Date | null = null;
        if (klass === 'throttle') {
            retryAt = blockUntilFor(readUsage(answerHeaders), now);
            if (paced) await quietly('block', () => block(account, creatorId, retryAt!, { now }));
            log('warn', 'ads.throttled', { label: opts.label, ad_account_id: account, meta_code: code ?? null, meta_subcode: subcode ?? null, retry_at: retryAt.toISOString() });
        } else if (klass === 'budget_limit') {
            retryAt = new Date(now.getTime() + 3_600_000);
        } else if (klass === 'object_busy') {
            retryAt = new Date(now.getTime() + 30_000);
        }
        const metaError = err?.response?.data?.error;
        const message = `Meta ads (${opts.label}): ${metaError?.message || err?.message || 'request failed'} (Code: ${code ?? 'N/A'})`;
        throw new AdsGraphError(message, err, klass, retryAt, typeof metaError?.fbtrace_id === 'string' ? metaError.fbtrace_id : null,
            typeof err?.response?.status === 'number' ? err.response.status : null);
    }
}

function form(params: GraphParams): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    return body;
}

export function adsGet(path: string, params: Record<string, string>, token: string, opts: AdsCallOptions): Promise<AxiosResponse> {
    return call('GET', path, token, opts, (url, headers) => metaHttp.get(url, { params, headers }));
}

export function adsPost(path: string, params: GraphParams, token: string, opts: AdsCallOptions): Promise<AxiosResponse> {
    return call('POST', path, token, opts, (url, headers) => metaHttp.post(url, form(params), { headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' } }));
}

export function adsDelete(path: string, token: string, opts: AdsCallOptions): Promise<AxiosResponse> {
    return call('DELETE', path, token, opts, (url, headers) => metaHttp.delete(url, { headers }));
}
