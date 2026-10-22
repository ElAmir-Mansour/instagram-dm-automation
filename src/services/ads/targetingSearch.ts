/**
 * What the builder asks Meta about before anything is created (A5; contracts/meta-graph.md): targeting search (interests, places, languages)
 * and the reach estimate for a targeting. (Meta's minimum budget is `drafts.ts` `minimumDailyBudget`: one floor, the one the server enforces.)
 *
 * Searches are cached in this instance's memory for 24 hours (Vercel keeps an instance warm for a while, so a repeat query in a session is
 * free; a cold instance simply asks again). Search is one point on a miss.
 */
import { describeError, log } from '../../utils/log.js';
import { AdsError } from '../adBoosts.js';
import { actPath, type AdsCallContext, type AdsGraph } from './graphPort.js';

export type TargetingType = 'adinterest' | 'adgeolocation' | 'adlocale';

const TARGETING_TYPES: readonly TargetingType[] = ['adinterest', 'adgeolocation', 'adlocale'];
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CACHED_SEARCHES = 500;
const MIN_QUERY = 2;
const MAX_QUERY = 80;

export interface TargetingItem {
    id: string;
    name: string;
    type: TargetingType;
    /** Interests only: Meta's audience size bounds. */
    sizeLower?: number;
    sizeUpper?: number;
    /** Places only. */
    countryCode?: string;
    region?: string;
}

const searches = new Map<string, { at: number; items: TargetingItem[] }>();

/** Forget every cached answer — tests only. */
export function clearTargetingCache(): void {
    searches.clear();
}

function idOf(value: unknown): string | null {
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

function toItem(type: TargetingType, row: any): TargetingItem | null {
    // Places and languages are identified by `key`; interests by `id`.
    const id = idOf(type === 'adinterest' ? row?.id : row?.key);
    const name = typeof row?.name === 'string' ? row.name : null;
    if (!id || !name) return null;
    const item: TargetingItem = { id, name, type };
    if (type === 'adinterest') {
        if (typeof row.audience_size_lower_bound === 'number') item.sizeLower = row.audience_size_lower_bound;
        if (typeof row.audience_size_upper_bound === 'number') item.sizeUpper = row.audience_size_upper_bound;
    } else if (type === 'adgeolocation') {
        if (typeof row.country_code === 'string') item.countryCode = row.country_code;
        if (typeof row.region === 'string') item.region = row.region;
    }
    return item;
}

/** Search Meta's targeting catalogue. A miss costs one point; a repeat within 24 hours (any case) costs none. */
export async function searchTargeting(ctx: AdsCallContext, graph: AdsGraph, type: TargetingType, q: string): Promise<{ items: TargetingItem[] }> {
    if (!TARGETING_TYPES.includes(type)) throw new AdsError(400, 'INVALID', 'type must be adinterest, adgeolocation or adlocale.', 'type');
    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length < MIN_QUERY || query.length > MAX_QUERY) {
        throw new AdsError(400, 'INVALID', `Type ${MIN_QUERY} to ${MAX_QUERY} characters to search.`, 'q');
    }
    const key = `${type}:${query.toLowerCase()}`;
    const hit = searches.get(key);
    if (hit && Date.now() - hit.at < DAY_MS) return { items: hit.items };

    const params: Record<string, string> = { type, q: query, limit: '25' };
    if (type === 'adgeolocation') params['location_types'] = '["country","city","region"]';
    const answer = await graph.get('search', params, `ads.targeting_search.${type}`);
    const items = (Array.isArray(answer?.data) ? answer.data : []).flatMap((row: unknown) => {
        const item = toItem(type, row);
        return item ? [item] : [];
    });
    searches.delete(key);
    searches.set(key, { at: Date.now(), items });
    // A Map iterates in insertion order, so the first key is the oldest.
    while (searches.size > MAX_CACHED_SEARCHES) searches.delete(searches.keys().next().value as string);
    return { items };
}

// ─── Reach estimate ───────────────────────────────────────────────────────────────────────

/** How many people a targeting reaches, as Meta's bounds, or null when Meta cannot say. Never throws: an estimate is a hint, not a gate. */
export async function reachEstimate(ctx: AdsCallContext, graph: AdsGraph, targeting: object): Promise<{ lower: number; upper: number } | null> {
    try {
        const answer = await graph.get(`${actPath(ctx.adAccountId)}/reachestimate`, { targeting_spec: JSON.stringify(targeting) }, 'ads.reach_estimate');
        const data = Array.isArray(answer?.data) ? answer.data[0] : answer?.data;
        const lower = Number(data?.users_lower_bound);
        const upper = Number(data?.users_upper_bound);
        if (data?.users_lower_bound === undefined || data?.users_upper_bound === undefined || !Number.isFinite(lower) || !Number.isFinite(upper)) return null;
        return { lower, upper };
    } catch (err) {
        log('warn', 'ads.reach_estimate_failed', { tenant_id: ctx.tenantId, ...describeError(err) });
        return null;
    }
}
