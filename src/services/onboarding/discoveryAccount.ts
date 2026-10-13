/**
 * Which Instagram account the platform reads OTHER people's public profiles with (docs/onboarding/03 §1): the connected
 * account of the tenant named by `onboarding.discovery_creator_id`, which defaults to the owner's tenant. Not pure: it reads
 * the settings and the creator row (the token is decrypted in `getTenant`, the one place that does it). The rule for which
 * tenant is in `discoveryProbe.ts`, where the probe script, which must not open the application's database pool, can reach it.
 *
 * With no such account connected, or a token that is gone, the result is `not_configured`, which the draft records as
 * "Instagram unavailable by handle" and falls back on the website and what the tenant types.
 */
import { APP_SETTING_KEYS, getSetting } from '../appSettings.js';
import { getPlatformOwnerId, getTenant } from '../tenant.js';
import { pickDiscoveryCreatorId } from './discoveryProbe.js';
import type { GraphCredentials } from './igDiscovery.js';
import { sourceFail, sourceOk, type SourceResult } from './sourceError.js';

export interface DiscoveryAccount extends GraphCredentials {
    creatorId: string;
}

export async function resolveDiscoveryAccount(): Promise<SourceResult<DiscoveryAccount>> {
    const [setting, owner] = await Promise.all([getSetting(APP_SETTING_KEYS.onboardingDiscoveryCreatorId), getPlatformOwnerId()]);
    const creatorId = pickDiscoveryCreatorId(setting, owner);
    if (!creatorId) return sourceFail('instagram_discovery', 'not_configured', 'There is no tenant for the platform to read Instagram with.');
    const creator = await getTenant(creatorId, ['id', 'instagram_page_id', 'page_access_token']);
    const igUserId = creator?.instagram_page_id;
    const token = creator?.page_access_token;
    if (!igUserId || !token) {
        return sourceFail('instagram_discovery', 'not_configured', 'The tenant the platform reads Instagram with has no Instagram account and token connected.');
    }
    return sourceOk({ creatorId, igUserId: String(igUserId), token });
}
