/**
 * The per-tenant switch of illustrated explainers: `explainers.enabled.<tenant id>` in `app_settings` (data-model.md §6.2, spec FR-034). Off
 * unless the platform admin switched it on, and in this version only the platform owner can be: Explainers run on the owner's Mac and spend
 * the owner's image allowance, and the writer is his Claude plan. Every dashboard route of the feature asks `isExplainersEnabled` first and
 * answers 404 `EXPLAINERS_DISABLED` without it (E2).
 *
 * The owner-only rule is held where the switch is turned ON: `setExplainersEnabled` is the one writer of the key and refuses another tenant
 * with 409 `EXPLAINERS_OWNER_ONLY`. Turning a tenant OFF is never refused, so a stray row (written by hand, or by an older build) can always be
 * cleared. Nothing else may write the key.
 */
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { getPlatformOwnerId } from '../tenant.js';
import { ExplainerError } from './errors.js';

/** What the operator reads when a tenant other than the owner is switched on. */
export const OWNER_ONLY_MESSAGE =
    'Explainers are only for the platform owner in this version, so no other tenant can be switched on.';

/** The tenant's key, lower-cased so the writer and the reader of one tenant always mean one row. Throws for an id that is not the shape of one. */
function keyFor(creatorId: string) {
    return tenantSettingKey(TENANT_SETTING_PREFIXES.explainersEnabled, creatorId.toLowerCase());
}

/**
 * Whether Explainers are on for this tenant: the value `true` and nothing else. Off by default. A database that cannot be read is a thrown
 * error, not an answer: the route turns it into a failure, never into "not available".
 */
export async function isExplainersEnabled(creatorId: string): Promise<boolean> {
    return (await getSetting(keyFor(creatorId))) === 'true';
}

/**
 * Switch Explainers on or off for a tenant. Off removes the row, so "off" is the default again and not a stored value. On is refused with
 * `EXPLAINERS_OWNER_ONLY` for every tenant but the platform owner (`getPlatformOwnerId`: the first creator ever made), and for everyone when
 * there is no owner yet. `updatedBy` is the admin's user id, null for a script.
 */
export async function setExplainersEnabled(creatorId: string, enabled: boolean, updatedBy: string | null): Promise<void> {
    const key = keyFor(creatorId);
    if (enabled) {
        const owner = (await getPlatformOwnerId())?.toLowerCase() ?? null;
        if (owner === null || owner !== creatorId.toLowerCase()) throw new ExplainerError('EXPLAINERS_OWNER_ONLY', OWNER_ONLY_MESSAGE);
    }
    await setSetting(key, enabled ? 'true' : null, updatedBy);
}
