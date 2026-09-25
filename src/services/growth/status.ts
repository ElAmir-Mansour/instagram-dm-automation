/**
 * `GET /api/growth/status` (GROWTH.md §3): what each platform can give, what is missing, and the
 * exact fix. One `debug_token` call, so a freshly pasted token is reflected at once rather than
 * after the next sync; when Meta can't be asked, the last sync's findings stand in.
 */
import type { GrowthPlatformStatus, GrowthSyncState } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { getTenant } from '../tenant.js';
import { inspectToken, type TokenInspection } from '../tokenHealth.js';
import { getConnection as getTikTokConnection } from '../tiktokConnections.js';
import { INSIGHTS_SCOPE, permissionFix, TIKTOK_ANALYTICS_SCOPES } from './common.js';
import { readSyncState } from './sync.js';

export interface GrowthStatus {
    instagram: GrowthPlatformStatus;
    facebook: GrowthPlatformStatus;
    /** TikTok analytics need scopes the app doesn't request yet, so a connected account is `unavailable`. */
    tiktok: 'unavailable' | 'not_connected';
    /** Meta permissions to add to the token, e.g. ['instagram_manage_insights', 'read_insights']. */
    missing: string[];
    /** When the last sync finished, or null. */
    lastSync: string | null;
    /** The banner's one-screen fix, or null when nothing is missing. */
    fix: string | null;
    /** False when `debug_token` couldn't be asked; the states then come from the last sync. */
    checked: boolean;
    /** Why the token itself doesn't work, when it doesn't. */
    tokenError: string | null;
    /** TikTok scopes the analytics would need, when TikTok is connected. */
    tiktokMissing: string[];
    /** What the last sync did, per platform. */
    lastResult: GrowthSyncState | null;
}

export interface StatusInput {
    connected: { instagram: boolean; facebook: boolean };
    hasToken: boolean;
    /** null when `debug_token` couldn't be asked. */
    inspection: Pick<TokenInspection, 'isValid' | 'scopes' | 'error'> | null;
    state: GrowthSyncState | null;
    tiktokConnected: boolean;
}

/** Pure, so every permission state is testable without Meta. */
export function composeStatus(input: StatusInput): GrowthStatus {
    const { connected, hasToken, inspection, state } = input;
    let tokenError: string | null = null;
    if (!hasToken) tokenError = 'No access token is stored for this tenant.';
    else if (inspection && !inspection.isValid) tokenError = inspection.error ?? 'Meta reports the access token as not valid.';

    const scopes = inspection?.isValid ? inspection.scopes : inspection ? null : state?.scopes ?? null;
    const stateOf = (platform: 'instagram' | 'facebook'): GrowthPlatformStatus => {
        if (!connected[platform] || tokenError) return 'not_connected';
        if (scopes) return scopes.includes(INSIGHTS_SCOPE[platform]) ? 'ok' : 'missing_permission';
        return state?.[platform]?.status === 'missing_permission' ? 'missing_permission' : 'ok';
    };
    const instagram = stateOf('instagram');
    const facebook = stateOf('facebook');
    const missing = [
        ...(instagram === 'missing_permission' ? [INSIGHTS_SCOPE.instagram] : []),
        ...(facebook === 'missing_permission' ? [INSIGHTS_SCOPE.facebook] : []),
    ];

    return {
        instagram,
        facebook,
        tiktok: input.tiktokConnected ? 'unavailable' : 'not_connected',
        missing,
        lastSync: state?.finished_at ?? null,
        fix: permissionFix(missing),
        checked: inspection !== null,
        tokenError,
        tiktokMissing: input.tiktokConnected ? [...TIKTOK_ANALYTICS_SCOPES] : [],
        lastResult: state,
    };
}

export async function getGrowthStatus(
    creatorId: string,
    inspect: (token: string) => Promise<Pick<TokenInspection, 'isValid' | 'scopes' | 'error'>> = inspectToken
): Promise<GrowthStatus> {
    const creator = await getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id', 'page_access_token']);
    const state = await readSyncState(creatorId);

    let tiktokConnected = false;
    try {
        tiktokConnected = (await getTikTokConnection(creatorId))?.status === 'active';
    } catch (err) {
        // Without migration v18 there is no TikTok connection to have.
        log('debug', 'growth.status_tiktok_unreadable', describeError(err));
    }

    const token = creator?.page_access_token || '';
    let inspection: StatusInput['inspection'] = null;
    if (token) {
        try {
            inspection = await inspect(token);
        } catch (err) {
            log('warn', 'growth.status_scope_check_failed', { creator_id: creatorId, ...describeError(err) });
        }
    }

    return composeStatus({
        connected: { instagram: Boolean(creator?.instagram_page_id), facebook: Boolean(creator?.facebook_page_id) },
        hasToken: Boolean(token),
        inspection,
        state,
        tiktokConnected,
    });
}
