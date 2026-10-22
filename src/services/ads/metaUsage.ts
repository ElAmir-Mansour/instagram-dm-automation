/**
 * Meta's usage headers, read into numbers (research R5). Shared by the ads pacer and the Growth sync (`growth/graph.ts`).
 *
 *   X-Ad-Account-Usage          { acc_id_util_pct, reset_time_duration (s), ads_api_access_tier }: the ad account's own budget
 *   X-Business-Use-Case-Usage   { <business id>: [{ type, call_count, total_cputime, total_time, estimated_time_to_regain_access (min),
 *   X-Business-Use-Case           ads_api_access_tier }] }; the second spelling is what some Marketing API answers send
 *   X-FB-Ads-Insights-Throttle  { app_id_util_pct, acc_id_util_pct, ads_api_access_tier }: the insights endpoints
 *   facebook-api-version        the version that actually served the call (Meta answers on an older one, silently, once ours expires)
 *
 * A header that is absent, empty or unreadable is `null`, never 0%: "Meta did not say" must not read as "nothing used".
 */

/** One header from axios headers (`get`) or a plain object, in any letter case. Undefined when absent or empty. */
export function headerValue(headers: unknown, name: string): string | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const h = headers as Record<string, unknown> & { get?: (n: string) => unknown };
    let raw: unknown = typeof h.get === 'function' ? h.get(name) : undefined;
    if (raw === undefined || raw === null) {
        const lower = name.toLowerCase();
        const key = Object.keys(h).find((k) => k.toLowerCase() === lower);
        raw = key === undefined ? undefined : h[key];
    }
    if (Array.isArray(raw)) raw = raw[0];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function json(headers: unknown, name: string): unknown {
    const raw = headerValue(headers, name);
    if (!raw) return undefined;
    try {
        return JSON.parse(raw);
    } catch {
        return undefined;
    }
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

export interface AdAccountUsage {
    /** Percent of the ad account's budget used in the current window. */
    utilPct: number | null;
    /** Seconds until the window resets (when throttled: until calls are accepted again). */
    resetSeconds: number | null;
    tier: string | null;
}

export function parseAdAccountUsage(headers: unknown): AdAccountUsage | null {
    const v = json(headers, 'x-ad-account-usage');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return { utilPct: numOrNull(o['acc_id_util_pct']), resetSeconds: numOrNull(o['reset_time_duration']), tier: strOrNull(o['ads_api_access_tier']) };
}

export interface BusinessUseCaseEntry {
    businessId: string;
    type: string | null;
    callCount: number | null;
    totalCputime: number | null;
    totalTime: number | null;
    /** Minutes until access returns, when Meta is throttling this use case. */
    regainMinutes: number | null;
    tier: string | null;
}

/** Both spellings, merged in that order. Null when neither header is there (or readable). */
export function parseBusinessUseCase(headers: unknown): BusinessUseCaseEntry[] | null {
    let found = false;
    const out: BusinessUseCaseEntry[] = [];
    for (const name of ['x-business-use-case-usage', 'x-business-use-case']) {
        const v = json(headers, name);
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        found = true;
        for (const [businessId, entries] of Object.entries(v as Record<string, unknown>)) {
            for (const e of Array.isArray(entries) ? entries : [entries]) {
                if (!e || typeof e !== 'object') continue;
                const o = e as Record<string, unknown>;
                out.push({
                    businessId,
                    type: strOrNull(o['type']),
                    callCount: numOrNull(o['call_count']),
                    totalCputime: numOrNull(o['total_cputime']),
                    totalTime: numOrNull(o['total_time']),
                    regainMinutes: numOrNull(o['estimated_time_to_regain_access']),
                    tier: strOrNull(o['ads_api_access_tier']),
                });
            }
        }
    }
    return found ? out : null;
}

export interface InsightsThrottle {
    appUtilPct: number | null;
    accUtilPct: number | null;
    tier: string | null;
}

export function parseInsightsThrottle(headers: unknown): InsightsThrottle | null {
    const v = json(headers, 'x-fb-ads-insights-throttle');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const o = v as Record<string, unknown>;
    return { appUtilPct: numOrNull(o['app_id_util_pct']), accUtilPct: numOrNull(o['acc_id_util_pct']), tier: strOrNull(o['ads_api_access_tier']) };
}

export interface Usage {
    adAccount: AdAccountUsage | null;
    buc: BusinessUseCaseEntry[] | null;
    insights: InsightsThrottle | null;
    /** The access tier, from whichever header named it first (`development_access` is the Limited tier, `standard_access` Standard). */
    tier: string | null;
    servedVersion: string | null;
    /** The longest `estimated_time_to_regain_access` any business entry named, in minutes. */
    regainMinutes: number | null;
}

export function readUsage(headers: unknown): Usage {
    const adAccount = parseAdAccountUsage(headers);
    const buc = parseBusinessUseCase(headers);
    const insights = parseInsightsThrottle(headers);
    const regains = (buc ?? []).map((e) => e.regainMinutes).filter((m): m is number => m !== null);
    return {
        adAccount,
        buc,
        insights,
        tier: adAccount?.tier ?? buc?.find((e) => e.tier)?.tier ?? insights?.tier ?? null,
        servedVersion: headerValue(headers, 'facebook-api-version') ?? null,
        regainMinutes: regains.length ? Math.max(...regains) : null,
    };
}

/**
 * The highest usage percentage in `X-App-Usage` / `X-Business-Use-Case-Usage`, or 0 (the Growth sync's headroom check; moved here from
 * growth/graph.ts unchanged). The first is `{ call_count, total_cputime, total_time }`; the second is keyed by business object id, each an
 * array of those objects plus `type` and `estimated_time_to_regain_access`.
 */
export function usagePercent(headers: unknown): number {
    let max = 0;
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) { value.forEach(visit); return; }
        if (!value || typeof value !== 'object') return;
        for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
            if ((key === 'call_count' || key === 'total_cputime' || key === 'total_time') && typeof v === 'number') {
                max = Math.max(max, v);
            } else if (typeof v === 'object') {
                visit(v);
            }
        }
    };
    for (const name of ['x-app-usage', 'x-business-use-case-usage']) {
        // An unreadable header is no headroom information, not a failure.
        const parsed = json(headers, name);
        if (parsed !== undefined) visit(parsed);
    }
    return max;
}
