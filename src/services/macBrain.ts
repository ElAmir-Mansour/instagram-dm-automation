/**
 * The Mac-brain guard (G1, docs/TENANT_ONBOARDING_PLAN.md D4).
 *
 * Two kinds of Studio work are answered by Claude Code on the OWNER's Mac, on his personal Claude plan:
 *
 *   - `monteur_think`, the Monteur's pick, copy, edit and Analyst calls (`monteur.brain: 'claude_mac'`,
 *     src/services/monteur/think.ts);
 *   - `render_infographic` jobs that carry `write`: Claude writes the infographic and its caption first
 *     (src/services/studio/infographics.ts).
 *
 * Anthropic's terms forbid routing other people's work through a personal Pro or Max plan. So before a second
 * tenant exists, the server refuses that work for everyone but the owner and those the operator added, in code, not by
 * convention. A refused tenant gets the AI providers layer instead (docs/onboarding/06-ai-providers.md, P32): `monteur.brain: 'api'`,
 * infographics written on the server, the Studio writer's `callModel`. The guard has two halves: the Mac refuses a tenant it is not for
 * (everything below), and the layer refuses the owner and the tenants on the list (`assertNotMacBrainTenant`; `MacBrainTenantRefused`).
 *
 * **The owner is always allowed; the list adds tenants.** The owner is the platform's own tenant: the first creator
 * ever made (`getPlatformOwnerId`), active or not, so deactivating it can never hand the Mac to tenant #2 and no
 * setting can lock it out. The app setting `studio.mac_brain_tenants` lists the tenants allowed besides the owner:
 * unset, `null` and `[]` all mean "the owner only", so today's single owner works with no configuration and a tenant
 * created tomorrow is refused by default. With no creators at all, nobody is allowed.
 *
 * Where it is enforced, and why in each place:
 *
 *   - `think()` (monteur/think.ts): the one function that queues a `monteur_think`;
 *   - `createInfographic`, `rerenderInfographic` (studio/infographics.ts): before anything is written, so the
 *     operator gets the 409 and no row is left `writing`;
 *   - `enqueueJob` (studio/jobs.ts): the net under every other caller, present or future;
 *   - `claimJob` (studio/jobs.ts): a job already queued (before this guard, or for a tenant since taken off
 *     the list) is failed with the same reason instead of being handed to the worker. If the list cannot be read
 *     after the job was claimed, the claim is released before the error goes on;
 *   - `applyStudioPatch` (studio/settings.ts): a tenant the Mac is not for cannot switch `monteur.brain` to
 *     `claude_mac`.
 *
 * A failed read of the list is a thrown error, never a yes: the work is refused until the database answers.
 */
import type { StudioJobKind } from '../db/rows.js';
import { log } from '../utils/log.js';
import { APP_SETTING_KEYS, getSetting, setSetting } from './appSettings.js';
import { isPlainObject, StudioError, UUID_PATTERN } from './studio/common.js';
import { getPlatformOwnerId } from './tenant.js';

/** The `code` a route sends beside the 409. */
export const NEEDS_API_BRAIN = 'NEEDS_API_BRAIN';

/** What the operator reads, in a 409, a 400 on the settings, a failed job's error and a failed lessons run. */
export const NEEDS_API_BRAIN_MESSAGE =
    'This tenant\'s AI work can\'t run on the operator\'s Mac; it needs the AI providers layer (coming).';

/** More than this is a paste gone wrong: the list is a handful of the operator's own tenants. */
export const MAX_MAC_BRAIN_TENANTS = 50;

/**
 * The other half of the guard (P32): the AI providers layer is for the tenants the Mac is NOT for. The owner's Monteur and infographics
 * stay on his Mac and his own plan, so a tenant the Mac works for cannot switch `monteur.brain` to `api`, and the layer refuses the
 * Mac's purposes for one (`MacBrainTenantRefused`, aiProviders/route.ts).
 */
export const MAC_BRAIN_TENANT = 'MAC_BRAIN_TENANT';
export const MAC_BRAIN_TENANT_MESSAGE =
    'This tenant\'s AI work runs on the operator\'s Mac, so it does not use the AI providers layer.';

/**
 * The refusal. 409 for work that was asked for; 400 where the tenant is trying to set `monteur.brain`.
 * A `StudioError`, so the Studio routes answer it as-is, with its `code`.
 */
export class MacBrainRefused extends StudioError {
    constructor(readonly creatorId: string, status = 409) {
        super(status, NEEDS_API_BRAIN_MESSAGE, undefined, NEEDS_API_BRAIN);
        this.name = 'MacBrainRefused';
    }
}

/**
 * The list as stored: a JSON array of creator ids, lower-cased, without repeats. Null when it is not one:
 * not JSON, not an array, a member that is not a UUID, or past `MAX_MAC_BRAIN_TENANTS`.
 */
export function parseMacBrainTenants(raw: string): string[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_MAC_BRAIN_TENANTS) return null;
    if (!parsed.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))) return null;
    return [...new Set((parsed as string[]).map((id) => id.toLowerCase()))];
}

export interface MacBrainTenants {
    /** The owner: the first creator ever made. Always allowed. Null when there are no creators. */
    owner: string | null;
    /** The saved list: the tenants allowed besides the owner. Empty when nothing usable is saved. */
    extra: string[];
    /** Who may use the Mac: the owner, then the extra tenants. Empty when there is no owner. */
    tenants: string[];
    /** `default`: nothing usable is saved, so the owner alone. */
    source: 'database' | 'default';
}

/**
 * Who may use the Mac: the owner, plus what `studio.mac_brain_tenants` lists. A saved value that cannot be read as
 * a list is logged and ignored, which leaves the owner alone: the narrowest answer there is.
 *
 * Read on every call, not cached: a list saved from the admin route has to reach every warm instance, and the
 * read is one indexed row (the owner's lookup is cached for 30 s, as everywhere).
 */
export async function getMacBrainTenants(): Promise<MacBrainTenants> {
    const owner = (await getPlatformOwnerId())?.toLowerCase() ?? null;
    let extra: string[] = [];
    let source: MacBrainTenants['source'] = 'default';
    const raw = await getSetting(APP_SETTING_KEYS.studioMacBrainTenants);
    if (raw !== null) {
        const saved = parseMacBrainTenants(raw);
        if (saved) {
            extra = saved;
            source = 'database';
        } else {
            log('warn', 'studio.mac_brain_setting_unreadable', { setting: APP_SETTING_KEYS.studioMacBrainTenants });
        }
    }
    return { owner, extra, tenants: owner ? [...new Set([owner, ...extra])] : [], source };
}

/**
 * The owner, or a tenant on the saved list. Never false for the owner: the owner is answered before the list is
 * read, so an unreadable or failing `app_settings` read can only ever refuse other tenants.
 */
export async function isMacBrainAllowed(creatorId: string): Promise<boolean> {
    const id = creatorId.toLowerCase();
    const owner = (await getPlatformOwnerId())?.toLowerCase() ?? null;
    if (owner !== null && id === owner) return true;
    return (await getMacBrainTenants()).tenants.includes(id);
}

/** Throws `MacBrainRefused` (409 `NEEDS_API_BRAIN`) unless this tenant's Claude work may run on the Mac. */
export async function assertMacBrainAllowed(creatorId: string, status = 409): Promise<void> {
    if (await isMacBrainAllowed(creatorId)) return;
    log('warn', 'studio.mac_brain_refused', { creator_id: creatorId });
    throw new MacBrainRefused(creatorId, status);
}

/**
 * Throws a `StudioError` (400 where a tenant is trying to set `monteur.brain`, else 409, code `MAC_BRAIN_TENANT`) when the tenant is one the
 * Mac works for: the owner, or a tenant on `studio.mac_brain_tenants`. For them the layer is never the way.
 */
export async function assertNotMacBrainTenant(creatorId: string, status = 409): Promise<void> {
    if (!(await isMacBrainAllowed(creatorId))) return;
    log('warn', 'studio.mac_brain_tenant_on_api', { creator_id: creatorId });
    throw new StudioError(status, MAC_BRAIN_TENANT_MESSAGE, undefined, MAC_BRAIN_TENANT);
}

/**
 * Whether a Studio job is Claude work on the Mac: a think, or an infographic with `write` in its payload
 * (the key being there at all is enough: the worker's `write` is Claude's, whatever it holds).
 */
export function isMacBrainJob(kind: StudioJobKind, payload: unknown): boolean {
    if (kind === 'monteur_think') return true;
    return kind === 'render_infographic' && isPlainObject(payload) && 'write' in payload;
}

/**
 * Save the list of tenants allowed besides the owner: ids already checked by the caller to be creators. `[]` and
 * `null` both leave the owner alone (`null` forgets the saved value). Returns what is in force afterwards.
 */
export async function saveMacBrainTenants(ids: readonly string[] | null, updatedBy: string | null): Promise<MacBrainTenants> {
    const unique = ids === null ? null : [...new Set(ids.map((id) => id.toLowerCase()))];
    await setSetting(APP_SETTING_KEYS.studioMacBrainTenants, unique === null ? null : JSON.stringify(unique), updatedBy);
    return getMacBrainTenants();
}
