/**
 * `GET /api/growth/competitors` (GROWTH.md §3): Instagram Business Discovery for each username in
 * `growth_settings.competitors`, one batched round trip.
 *
 * Business Discovery reads another professional account's public profile and recent media through
 * our own IG user: `GET /{our-ig-id}?fields=business_discovery.username(X){…}`. It needs
 * `instagram_basic`, `instagram_manage_insights` and `pages_read_engagement` (README.md §1), works
 * for Business and Creator accounts only, and returns no insights — so a competitor's engagement
 * can only be measured against followers: (likes + comments) / followers, averaged over the recent
 * posts whose likes aren't hidden.
 */
import { describeError, log } from '../../utils/log.js';
import { getTenant } from '../tenant.js';
import { inspectToken, type TokenInspection } from '../tokenHealth.js';
import { BUSINESS_DISCOVERY_SCOPES, clip, num } from './common.js';
import { GraphSession, isPermissionFailure, type BatchOutcome } from './graph.js';
import { getGrowthSettings, USERNAME } from './settings.js';

export const BD_MEDIA_LIMIT = 12;

/** The field expression for one username. Only fields the Business Discovery docs name. */
export function discoveryFields(username: string): string {
    return `business_discovery.username(${username}){username,followers_count,media_count,`
        + `media.limit(${BD_MEDIA_LIMIT}){permalink,like_count,comments_count,media_type,timestamp,caption,view_count}}`;
}

export interface CompetitorPost {
    permalink: string | null;
    like_count: number | null;
    comments_count: number | null;
    media_type: string | null;
    timestamp: string | null;
    caption: string | null;
    view_count: number | null;
}

export interface CompetitorCard {
    username: string;
    followers: number | null;
    media_count: number | null;
    recent: CompetitorPost[];
    /** Mean (likes + comments) / followers over the recent posts with visible likes, 0–1. */
    avg_engagement: number | null;
    /** Why this one couldn't be read, or null. */
    error: string | null;
}

export interface CompetitorsResponse {
    status: 'ok' | 'missing_permission' | 'not_connected';
    missing: string[];
    competitors: CompetitorCard[];
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

/** One Business Discovery answer (`{ business_discovery: {…}, id }`) as a card. */
export function mapBusinessDiscovery(username: string, body: any): CompetitorCard {
    const bd = body?.business_discovery;
    if (!bd || typeof bd !== 'object') {
        return { username, followers: null, media_count: null, recent: [], avg_engagement: null, error: 'Meta returned no profile for this username.' };
    }
    const followers = num(bd.followers_count) ?? null;
    const recent: CompetitorPost[] = (Array.isArray(bd.media?.data) ? bd.media.data : []).map((m: any) => ({
        permalink: text(m?.permalink),
        like_count: num(m?.like_count) ?? null,
        comments_count: num(m?.comments_count) ?? null,
        media_type: text(m?.media_type),
        timestamp: text(m?.timestamp),
        caption: m?.caption ? clip(m.caption, 300) : null,
        view_count: num(m?.view_count) ?? null,
    }));
    const rates = followers && followers > 0
        ? recent.filter((p) => p.like_count !== null).map((p) => ((p.like_count ?? 0) + (p.comments_count ?? 0)) / followers)
        : [];
    return {
        username: text(bd.username) ?? username,
        followers,
        media_count: num(bd.media_count) ?? null,
        recent,
        avg_engagement: rates.length ? Math.round((rates.reduce((a, b) => a + b, 0) / rates.length) * 10_000) / 10_000 : null,
        error: null,
    };
}

/** A failed lookup, in words: most often the account isn't professional, or doesn't exist. */
export function discoveryError(outcome: Extract<BatchOutcome, { ok: false }>): string {
    const { code, message } = outcome.error;
    if (code === 110 || /cannot find|invalid user/i.test(message)) {
        return 'Not found, or not a Business or Creator account (Business Discovery reads only those).';
    }
    return message;
}

export async function getCompetitors(
    creatorId: string,
    inspect: (token: string) => Promise<Pick<TokenInspection, 'isValid' | 'scopes'>> = inspectToken
): Promise<CompetitorsResponse> {
    const [creator, settings] = await Promise.all([
        getTenant(creatorId, ['id', 'instagram_page_id', 'page_access_token']),
        getGrowthSettings(creatorId),
    ]);
    const token = creator?.page_access_token || '';
    const igId = creator?.instagram_page_id;
    if (!token || !igId) return { status: 'not_connected', missing: [], competitors: [] };

    // Asked first, so a token without the permission costs one call rather than one per username.
    try {
        const inspection = await inspect(token);
        if (!inspection.isValid) return { status: 'not_connected', missing: [], competitors: [] };
        const missing = BUSINESS_DISCOVERY_SCOPES.filter((s) => !inspection.scopes.includes(s));
        if (missing.length) return { status: 'missing_permission', missing, competitors: [] };
    } catch (err) {
        log('warn', 'growth.competitors_scope_check_failed', { creator_id: creatorId, ...describeError(err) });
    }

    const usernames = settings.competitors.filter((u) => USERNAME.test(u));
    if (!usernames.length) return { status: 'ok', missing: [], competitors: [] };

    const graph = new GraphSession(token);
    const outcomes = await graph.batch(usernames.map((u) => ({
        relative_url: `${igId}?fields=${encodeURIComponent(discoveryFields(u))}`,
    })));
    if (outcomes.every((o) => !o.ok && isPermissionFailure(o.error))) {
        return { status: 'missing_permission', missing: ['instagram_manage_insights'], competitors: [] };
    }
    const competitors = usernames.map((u, i): CompetitorCard => {
        const o = outcomes[i]!;
        return o.ok
            ? mapBusinessDiscovery(u, o.body)
            : { username: u, followers: null, media_count: null, recent: [], avg_engagement: null, error: discoveryError(o) };
    });
    return { status: 'ok', missing: [], competitors };
}
