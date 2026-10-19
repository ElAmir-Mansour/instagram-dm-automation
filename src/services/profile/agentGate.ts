/**
 * The agent gate: switching an agent on needs the facts that agent writes from (docs/onboarding/01 §1, 02 §4; plan P30).
 *
 * The dashboard asks for what an agent needs the first time the agent is switched on (`ProfileAsk`); this is the server
 * agreeing with it. An agent's own switch-on route calls `assertAgentReady(creatorId, agent)`, and a tenant that lacks a field the
 * agent needs gets
 *
 *     409 { code: 'PROFILE_INCOMPLETE', agent, missing: [paths], fixStep: 'about' | 'voice' | 'ask' }
 *
 * `missing` names the profile paths and `fixStep` where the first of them is fixed: `about` and `voice` are the wizard's steps,
 * `ask` is the one-field sheet the dashboard opens over the screen the tenant is on. The words are the dashboard's.
 *
 * What each agent needs, on top of the six activation fields (`activationMissing`):
 *
 *   studio    nothing more     the writer works from the voice guide and the offer
 *   monteur   presenter        the Editor writes he, she or they for the person on camera
 *   coach     audience         the Growth coach says who the content is for
 *   dm        dm.handoff       who takes over when the bot cannot answer
 *
 * ─── Who is never gated ───────────────────────────────────────────────────────────────────────
 *
 * **The owner, and every tenant that predates onboarding** (`isGrandfathered`):
 *
 *   - the platform owner, the first creator ever made, whatever its onboarding row says;
 *   - a tenant with no onboarding row (it reads as completed, D14);
 *   - a tenant whose row is `completed` and which nobody filled in: that is exactly what v34 inserted for every creator that existed
 *     then. A tenant that went through the wizard has `filled_by` set the moment it first saves a step, so it is never mistaken for one.
 *
 * His agents were switched on before a profile existed, so there is nothing to ask at a moment that already passed, and the
 * owner is decided FIRST, before the onboarding row or the profile is read: his path does not depend on either being readable.
 *
 * ─── What it does not do ──────────────────────────────────────────────────────────────────────
 *
 * It is a gate on a switch, never on a running path: a webhook, a drain, the daily cron and a reply already being written never
 * come here. And it is a convenience, not a security boundary, so a failed read (the database is unreachable, v34 is not applied)
 * lets the switch through and logs `profile.gate_unreadable`: a hiccup must never be the reason a tenant cannot work.
 */
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { errorBody, type ErrorBody } from '../errorCodes.js';
import { loadOnboarding, stepForMissingField, type OnboardingState } from '../onboardingWizard.js';
import { getPlatformOwnerId } from '../tenant.js';
import { loadProfile } from './store.js';
import type { CreatorProfile } from './types.js';
import { activationMissing } from './validate.js';

export const GATED_AGENTS = ['studio', 'monteur', 'coach', 'dm'] as const;
export type GatedAgent = (typeof GATED_AGENTS)[number];
export const isGatedAgent = (value: unknown): value is GatedAgent => typeof value === 'string' && (GATED_AGENTS as readonly string[]).includes(value);

/** What an agent needs besides activation. A path, as `activationMissing` writes them. */
export const AGENT_REQUIRES: Readonly<Record<GatedAgent, readonly string[]>> = Object.freeze({
    studio: [],
    monteur: ['presenter'],
    coach: ['audience.description'],
    dm: ['dm.handoff'],
});

/** Where a missing field is fixed: a wizard step, or the one-field sheet over the screen the tenant is on. */
export type FixStep = 'about' | 'voice' | 'ask';

/** The extra fields' own paths: not the wizard's, so they are asked for, not walked through. */
const ASKED = new Set<string>(Object.values(AGENT_REQUIRES).flat());

export function fixStepFor(path: string): FixStep {
    return ASKED.has(path) ? 'ask' : stepForMissingField(path) === 'voice' ? 'voice' : 'about';
}

/** Is this extra field there? Each is the same test `completeness.ts` uses for its meter. */
function extraMissing(profile: CreatorProfile, path: string): boolean {
    switch (path) {
        case 'presenter': return profile.presenter === null;
        case 'audience.description': return !profile.audience.description.trim();
        case 'dm.handoff': return profile.dm.handoff === null;
        default: return false;
    }
}

/** What `agent` still lacks, activation first: pure, so a test needs no database. */
export function agentMissing(profile: CreatorProfile, agent: GatedAgent): string[] {
    return [...activationMissing(profile), ...AGENT_REQUIRES[agent].filter((path) => extraMissing(profile, path))];
}

// ─── Who is exempt ─────────────────────────────────────────────────────────────────────────────

export interface GateFacts {
    creatorId: string;
    /** The platform owner (the first creator ever made), or null with no creators. */
    ownerId: string | null;
    /**
     * The tenant's onboarding row; null when it has none (it reads as completed, D14). Left out when it was not read: the owner is
     * decided before the row is, so for him it is not looked up at all, and nothing but the owner check can exempt him.
     */
    onboarding?: Pick<OnboardingState, 'status' | 'filled_by'> | null;
}

const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** Why a tenant is exempt: `owner`, or `legacy` (no row, or a row v34 inserted); null when it is not exempt. */
export function exemptionOf(facts: GateFacts): 'owner' | 'legacy' | null {
    if (facts.ownerId !== null && sameId(facts.ownerId, facts.creatorId)) return 'owner';
    if (facts.onboarding === null) return 'legacy';
    if (facts.onboarding && facts.onboarding.status === 'completed' && facts.onboarding.filled_by === null) return 'legacy';
    return null;
}

/** Does the tenant predate onboarding (the owner included)? The meter and the gate both ask. */
export const isGrandfathered = (facts: GateFacts): boolean => exemptionOf(facts) !== null;

/**
 * What decides exemption, read in the order that keeps the owner's path independent of the rest: the owner first (a cached read of
 * the first creator), and only for anyone else the onboarding row.
 */
export async function readGateFacts(creatorId: string): Promise<GateFacts> {
    const ownerId = await getPlatformOwnerId();
    if (ownerId !== null && sameId(ownerId, creatorId)) return { creatorId, ownerId };
    return { creatorId, ownerId, onboarding: await loadOnboarding(creatorId) };
}

// ─── The refusal ───────────────────────────────────────────────────────────────────────────────

export class ProfileIncomplete extends Error {
    readonly status = 409;
    readonly code = 'PROFILE_INCOMPLETE';
    constructor(readonly agent: GatedAgent, readonly missing: string[], readonly fixStep: FixStep) {
        super(`Fill in ${missing.join(', ')} before switching on the ${agent}.`);
        this.name = 'ProfileIncomplete';
    }
}

/**
 * What the route sends beside the 409: the shared envelope (src/services/errorCodes.ts), with `agent`, `missing` and `fixStep` also kept
 * as top-level fields, where `api.js` and the profile sheet read them. Paths and words only: nothing the tenant typed.
 */
export function profileIncompleteBody(err: ProfileIncomplete): ErrorBody {
    const facts = { agent: err.agent, missing: err.missing, fixStep: err.fixStep };
    return errorBody('PROFILE_INCOMPLETE', facts, err.message, facts);
}

/**
 * Throws `ProfileIncomplete` when `agent` cannot be switched on for this tenant yet. Returns when it can, when the tenant is exempt,
 * and when the facts could not be read (see the top of the file).
 */
export async function assertAgentReady(creatorId: string, agent: GatedAgent): Promise<void> {
    let missing: string[];
    try {
        const facts = await readGateFacts(creatorId);
        if (isGrandfathered(facts)) return;
        missing = agentMissing((await loadProfile(creatorId)).profile, agent);
    } catch (err) {
        log('warn', 'profile.gate_unreadable', { tenant_id: creatorId, agent, ...describeError(err) });
        return;
    }
    if (missing.length > 0) throw new ProfileIncomplete(agent, missing, fixStepFor(missing[0]!));
}

/**
 * The DM bot's switch: a save that asks for the bot ON is the switch only when the bot was not on already. A tenant with no agent row
 * yet is switched on by its first save (the screen shows the bot on by default), and saving a prompt on a bot that is on, or turning
 * it off, never asks. If the agent's row cannot be read the save goes on, as every unreadable gate does.
 */
export async function assertDmSwitchOn(creatorId: string): Promise<void> {
    let switching: boolean;
    try {
        const before = await pool.query<{ is_active: boolean | null }>('SELECT is_active FROM ai_agents WHERE creator_id = $1', [creatorId]);
        switching = before.rows.length === 0 || before.rows[0]!.is_active === false;
    } catch (err) {
        log('warn', 'profile.gate_unreadable', { tenant_id: creatorId, agent: 'dm', ...describeError(err) });
        return;
    }
    if (switching) await assertAgentReady(creatorId, 'dm');
}
