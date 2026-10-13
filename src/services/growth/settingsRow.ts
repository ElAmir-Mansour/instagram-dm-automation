/**
 * The pure half of the Growth settings: the defaults and a stored row read defensively. Moved out of
 * `settings.ts` unchanged so that `profile/store.ts` can read the stored row without importing the module
 * that will import the store (P4 makes `getGrowthSettings` a view over the profile). `settings.ts`
 * re-exports `DEFAULT_GOALS` and `defaultGrowthSettings`, so every existing import keeps working.
 */
import type { GrowthAudience, GrowthSettings } from '../../db/rows.js';
import type { Exec } from '../studio/common.js';

/** What a tenant with no row is aiming at (docs/agents/BRIEF.md): 10k followers or 1M views. */
export const DEFAULT_GOALS = Object.freeze({ goal_followers: 10_000, goal_views: 1_000_000 });

export function defaultGrowthSettings(): GrowthSettings {
    return { keywords: [], hashtag_sets: [], competitors: [], audience: {}, ...DEFAULT_GOALS };
}

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A stored row, read defensively: the columns have defaults, but JSONB can hold anything. */
export function fromRow(row: Partial<GrowthSettings> | null): GrowthSettings {
    if (!row) return defaultGrowthSettings();
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
        keywords: strings(row.keywords),
        hashtag_sets: (Array.isArray(row.hashtag_sets) ? row.hashtag_sets : [])
            .filter(isObj)
            .map((s) => ({ name: typeof s.name === 'string' ? s.name : '', tags: strings(s.tags) })),
        competitors: strings(row.competitors),
        audience: isObj(row.audience) ? (row.audience as GrowthAudience) : {},
        goal_followers: storedGoal(row.goal_followers, DEFAULT_GOALS.goal_followers),
        goal_views: storedGoal(row.goal_views, DEFAULT_GOALS.goal_views),
    };
}

/** `pg` returns BIGINT as a string; a row written before v25 has neither column. */
function storedGoal(value: unknown, fallback: number): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * The tenant's stored settings (the defaults for a tenant with no row). `lock` reads the row `FOR UPDATE`, for a
 * writer that is about to change it, inside a transaction that holds `lockTenantSettings`. The v25 goal columns
 * are assumed: `getGrowthSettings` keeps its fallback for a database without them, and a failed statement inside a
 * transaction cannot be retried, which is where this is used.
 */
export async function readGrowthSettings(exec: Exec, creatorId: string, lock = false): Promise<GrowthSettings> {
    const { rows } = await exec.query<GrowthSettings>(
        `SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = $1${lock ? ' FOR UPDATE' : ''}`,
        [creatorId]
    );
    return fromRow(rows[0] ?? null);
}
