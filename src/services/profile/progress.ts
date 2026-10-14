/**
 * What `GET /api/profile/progress` answers, for the Overview card (plan P30): how complete the profile is and the next three things
 * to do, for the session's tenant.
 *
 * It only gathers: who the tenant is (`readGateFacts`: the owner, or a tenant that predates onboarding, is counted on what its
 * setup can hold and is never told to fill in a profile field it never had a place for, see `completeness.ts`), the profile, what
 * is connected and whether the DM bot is on. The numbers and the ordering are `completeness.ts`, which has no database.
 *
 * Reading only. Nothing here writes, and nothing here can stop a tenant from working: a failure is a 500 the dashboard answers by
 * leaving the card out.
 */
import { queryOne } from '../../db/query.js';
import { completeness, nextBestActions, type Connections, type MissingField, type NextAction } from './completeness.js';
import { isGrandfathered, readGateFacts } from './agentGate.js';
import { loadProfile } from './store.js';

/** One query for the three things that are not in the profile: Meta, TikTok and YouTube, and whether the DM bot is switched on. */
export const CONNECTIONS_SQL = `SELECT (c.page_access_token IS NOT NULL AND (c.instagram_page_id IS NOT NULL OR c.facebook_page_id IS NOT NULL)) AS meta,
       EXISTS (SELECT 1 FROM platform_connections p WHERE p.creator_id = c.id AND p.platform = 'tiktok' AND p.status = 'active' AND p.refresh_token IS NOT NULL) AS tiktok,
       EXISTS (SELECT 1 FROM platform_connections p WHERE p.creator_id = c.id AND p.platform = 'youtube' AND p.status = 'active' AND p.refresh_token IS NOT NULL) AS youtube,
       COALESCE((SELECT a.is_active FROM ai_agents a WHERE a.creator_id = c.id), false) AS dm
  FROM creators c WHERE c.id = $1`;

export interface Progress {
    /** 0 to 100; 100 only when nothing is missing. */
    percent: number;
    complete: boolean;
    /** The tenant predates onboarding (the owner included): counted on what its setup can hold. */
    legacy: boolean;
    /** The DM bot is on, so its hand-off rule counted. */
    dm: boolean;
    connections: Connections;
    /** At most three, most valuable first. */
    actions: NextAction[];
    /** What is not there yet (ids and paths only), heaviest first. */
    missing: Array<Pick<MissingField, 'field' | 'paths' | 'weight' | 'filled'>>;
}

interface ConnectionRow { meta: boolean | null; tiktok: boolean | null; youtube: boolean | null; dm: boolean | null }

export async function describeProgress(creatorId: string): Promise<Progress> {
    const facts = await readGateFacts(creatorId);
    const legacy = isGrandfathered(facts);
    const [loaded, row] = await Promise.all([loadProfile(creatorId), queryOne<ConnectionRow>(CONNECTIONS_SQL, [creatorId])]);
    const connections: Connections = { meta: row?.meta === true, tiktok: row?.tiktok === true, youtube: row?.youtube === true };
    const dm = row?.dm === true;
    const opts = { legacy, dm };
    const score = completeness(loaded.profile, opts);
    return {
        percent: score.percent,
        complete: score.missing.length === 0,
        legacy,
        dm,
        connections,
        actions: nextBestActions(loaded.profile, connections, opts),
        missing: score.missing.map(({ field, paths, weight, filled }) => ({ field, paths, weight, filled })),
    };
}
