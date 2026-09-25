/**
 * Reading the Graph API for the Growth sync: single GETs, batches of up to 50, and the
 * rate-limit headroom Meta reports as it goes (README.md §1 "Rate limits and batching").
 *
 * Every call goes through `metaHttp` (10s timeout) and `withRetry`, with the token in the
 * Authorization header rather than the query string, like src/services/instagram.ts. One
 * `GraphSession` is one sync: once a usage header passes `maxUsagePct`, or Meta answers with a
 * throttling code, `throttled` is set and the caller stops making the calls it can live without.
 */
import { metaErrorCode, metaErrorSubcode, metaHttp, withRetry } from '../http.js';
import { GRAPH_BASE } from '../instagram.js';

/** Meta's throttling codes: app, user, Pages, custom, Pages BUC, Instagram BUC. */
export const THROTTLE_CODES: ReadonlySet<number> = new Set([4, 17, 32, 613, 80001, 80002]);
/** Codes that mean "this token may not read this", as opposed to "this request is wrong". */
export const PERMISSION_CODES: ReadonlySet<number> = new Set([10, 200]);
/** Meta's batch maximum. */
export const BATCH_LIMIT = 50;

export interface GraphFailure {
    code: number | null;
    subcode: number | null;
    message: string;
    status: number | null;
}

export type BatchOutcome = { ok: true; body: any } | { ok: false; error: GraphFailure };

/** A failed call, reduced to what the sync decides on. Never carries the token. */
export function graphFailure(err: any): GraphFailure {
    const metaError = err?.response?.data?.error;
    return {
        code: metaErrorCode(err) ?? null,
        subcode: metaErrorSubcode(err) ?? null,
        message: String(metaError?.message || err?.message || 'Meta request failed').slice(0, 300),
        status: typeof err?.response?.status === 'number' ? err.response.status : null,
    };
}

export const isPermissionFailure = (f: GraphFailure): boolean => f.code !== null && PERMISSION_CODES.has(f.code);
export const isThrottleFailure = (f: GraphFailure): boolean => f.code !== null && THROTTLE_CODES.has(f.code);

/**
 * The highest usage percentage in `X-App-Usage` / `X-Business-Use-Case-Usage`, or 0.
 *
 * The first is `{ call_count, total_cputime, total_time }`; the second is keyed by business
 * object id, each an array of those objects plus `type` and `estimated_time_to_regain_access`.
 */
export function usagePercent(headers: unknown): number {
    const h = headers as Record<string, unknown> | undefined;
    if (!h || typeof h !== 'object') return 0;
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
        const raw = typeof (h as any).get === 'function' ? (h as any).get(name) : h[name];
        if (typeof raw !== 'string' || !raw) continue;
        try {
            visit(JSON.parse(raw));
        } catch {
            // An unreadable header is no headroom information, not a failure.
        }
    }
    return max;
}

export interface BatchItem {
    /** Relative to the versioned Graph base, e.g. `123/insights?metric=reach`. */
    relative_url: string;
}

export class GraphSession {
    /** A usage header passed the threshold, or Meta throttled a call. */
    throttled = false;
    /** HTTP round trips made. */
    requests = 0;
    private readonly headers: Record<string, string>;

    constructor(token: string, private readonly maxUsagePct = 80) {
        this.headers = { Authorization: `Bearer ${token}` };
    }

    private note(response: any): void {
        if (usagePercent(response?.headers) >= this.maxUsagePct) this.throttled = true;
    }

    /** One GET. Throws the axios error; a throttling code also sets `throttled`. */
    async get<T = any>(path: string, params: Record<string, string | number> = {}): Promise<T> {
        this.requests++;
        try {
            const res = await withRetry(
                () => metaHttp.get(`${GRAPH_BASE}/${path}`, { params, headers: this.headers }),
                { retries: 1, label: `growth-get[${path.split('?')[0]!.split('/').slice(-1)[0]}]` }
            );
            this.note(res);
            return res.data as T;
        } catch (err) {
            if (isThrottleFailure(graphFailure(err))) this.throttled = true;
            throw err;
        }
    }

    /**
     * GETs in batches of 50, one outcome per item, in order. A batch that fails as a whole gives
     * every item in it that failure; an item Meta timed out (`null`) is a failure too, so the
     * caller never mistakes a missing answer for an empty one.
     */
    async batch(items: readonly BatchItem[]): Promise<BatchOutcome[]> {
        const out: BatchOutcome[] = [];
        for (let i = 0; i < items.length; i += BATCH_LIMIT) {
            const chunk = items.slice(i, i + BATCH_LIMIT);
            if (this.throttled) {
                const skipped: GraphFailure = { code: null, subcode: null, message: 'Skipped: the rate limit is nearly used up.', status: null };
                out.push(...chunk.map((): BatchOutcome => ({ ok: false, error: skipped })));
                continue;
            }
            this.requests++;
            try {
                const form = new URLSearchParams({
                    batch: JSON.stringify(chunk.map((item) => ({ method: 'GET', relative_url: item.relative_url }))),
                    include_headers: 'false',
                });
                const res = await withRetry(
                    () => metaHttp.post(`${GRAPH_BASE}/`, form, { headers: this.headers }),
                    { retries: 1, label: `growth-batch[${chunk.length}]` }
                );
                this.note(res);
                const answers: unknown[] = Array.isArray(res.data) ? res.data : [];
                chunk.forEach((_, j) => out.push(parseBatchAnswer(answers[j])));
            } catch (err) {
                const failure = graphFailure(err);
                if (isThrottleFailure(failure)) this.throttled = true;
                out.push(...chunk.map((): BatchOutcome => ({ ok: false, error: failure })));
            }
        }
        for (const o of out) if (!o.ok && isThrottleFailure(o.error)) this.throttled = true;
        return out;
    }
}

/** One batch answer: `{ code, body }`, body a JSON string, or null when Meta timed it out. */
export function parseBatchAnswer(answer: unknown): BatchOutcome {
    if (!answer || typeof answer !== 'object') {
        return { ok: false, error: { code: null, subcode: null, message: 'Meta timed out on this request.', status: null } };
    }
    const a = answer as { code?: unknown; body?: unknown };
    let body: any = null;
    if (typeof a.body === 'string') {
        try {
            body = JSON.parse(a.body);
        } catch {
            body = null;
        }
    } else if (a.body && typeof a.body === 'object') {
        body = a.body;
    }
    const code = typeof a.code === 'number' ? a.code : null;
    if (code === 200 && body && !body.error) return { ok: true, body };
    const e = body?.error;
    return {
        ok: false,
        error: {
            code: typeof e?.code === 'number' ? e.code : null,
            subcode: typeof e?.error_subcode === 'number' ? e.error_subcode : null,
            message: String(e?.message || `HTTP ${code ?? 'error'}`).slice(0, 300),
            status: code,
        },
    };
}

// ─── Insights, resilient to a retired metric name ───────────────────────────────────────

export interface InsightTarget {
    /** The object whose `/insights` edge is read. */
    id: string;
    metrics: readonly string[];
    /** Extra query string, e.g. `period=day&since=…` — without a leading `&`. */
    params?: string;
}

export type InsightOutcome = { ok: true; data: any[] } | { ok: false; error: GraphFailure };

const insightsUrl = (id: string, metrics: readonly string[], params?: string): string =>
    `${id}/insights?metric=${metrics.join(',')}${params ? `&${params}` : ''}`;

export interface InsightsResult {
    outcomes: InsightOutcome[];
    /**
     * Metrics Meta refused on their own (#100) while another metric on the same object answered,
     * so the name, not the object, is the problem. The caller remembers these and stops asking.
     */
    unsupported: string[];
}

/**
 * Insights for many objects, one combined request each, batched.
 *
 * ONE invalid metric fails a whole request with (#100) "The value must be a valid insights
 * metric" — which is how a retired name shows up (`impressions`, `plays`, `page_fans`). So when a
 * combined request fails with #100, the first failed object of that metric set is asked for each
 * metric on its own; every failed object is then asked again with the names that answered, and the
 * refused names are reported so the next run doesn't ask for them. A retired metric costs its own
 * null, not the whole post.
 */
export async function fetchInsights(graph: GraphSession, targets: readonly InsightTarget[]): Promise<InsightsResult> {
    const first = await graph.batch(targets.map((t) => ({ relative_url: insightsUrl(t.id, t.metrics, t.params) })));
    const outcomes: InsightOutcome[] = first.map((o) => (o.ok ? { ok: true, data: Array.isArray(o.body?.data) ? o.body.data : [] } : o));
    const unsupported = new Set<string>();

    // Grouped by metric set and parameters, but not by the time window: 28 account days that
    // fail on the same name need one probe, not 28.
    const groups = new Map<string, number[]>();
    outcomes.forEach((o, i) => {
        if (o.ok || o.error.code !== 100) return;
        const params = (targets[i]!.params ?? '').replace(/(^|&)(since|until)=[^&]*/g, '');
        const key = `${targets[i]!.metrics.join(',')}|${params}`;
        groups.set(key, [...(groups.get(key) ?? []), i]);
    });

    for (const indexes of groups.values()) {
        if (graph.throttled) break;
        const probe = targets[indexes[0]!]!;
        if (probe.metrics.length < 2) continue;
        const probed = await graph.batch(probe.metrics.map((m) => ({ relative_url: insightsUrl(probe.id, [m], probe.params) })));
        const working = probe.metrics.filter((_, j) => probed[j]!.ok);
        if (!working.length) continue;
        probe.metrics.forEach((m, j) => {
            const o = probed[j]!;
            if (!o.ok && o.error.code === 100) unsupported.add(m);
        });
        const again = await graph.batch(indexes.map((i) => ({ relative_url: insightsUrl(targets[i]!.id, working, targets[i]!.params) })));
        indexes.forEach((i, j) => {
            const o = again[j]!;
            if (o.ok) outcomes[i] = { ok: true, data: Array.isArray(o.body?.data) ? o.body.data : [] };
        });
    }
    return { outcomes, unsupported: [...unsupported] };
}
