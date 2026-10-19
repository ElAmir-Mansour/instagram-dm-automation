/**
 * The agent gate (P30): switching an agent on needs what that agent writes from, for a tenant that is new, and never for the owner.
 *
 * What is pinned, because each is a way the gate goes wrong:
 *
 *   - **the owner is never gated.** Not with an empty niche (his is empty in production), not with no DM hand-off rule (he has none),
 *     not with an onboarding row that says `invited`, not when his profile or his onboarding row cannot be read. He is decided FIRST,
 *     before either is read, and nothing but that check exempts him: this file is the one the mutation "remove the owner exemption"
 *     was verified against;
 *   - **a tenant that predates onboarding is never gated either**: no row, or a `completed` row nobody filled in (what v34 inserted);
 *   - **a new tenant is refused** with the paths it lacks and where the first is fixed, and is let through the moment it has them;
 *   - **it is a gate on a switch, not a reader**: it writes nothing, and a database that cannot answer lets the switch through.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setLogSink } from '../../utils/log.js';
import { invalidateTenantCache } from '../tenant.js';
import { addNewcomer, installOnboardingWorld, NEWCOMER, OWNER, type OnboardingWorld } from '../wizard/testDb.js';
import {
    agentMissing, AGENT_REQUIRES, assertAgentReady, exemptionOf, fixStepFor, GATED_AGENTS, isGatedAgent, isGrandfathered, ProfileIncomplete,
    profileIncompleteBody, type GatedAgent,
} from './agentGate.js';
import { FIELDS } from './completeness.js';
import { defaultProfile } from './defaults.js';
import { FITNESS_EN, SHOP_EG } from './fixtures.js';
import { setPlatformOwner } from './testDb.js';
import { throughJsonb } from './testSupport.js';
import type { CreatorProfile } from './types.js';

const edit = (profile: CreatorProfile, change: (p: CreatorProfile) => void): CreatorProfile => {
    const copy = structuredClone(profile);
    change(copy);
    return copy;
};

/** A tenant that finished the wizard (the six activation fields) and nothing else. */
const FINISHED: CreatorProfile = edit(defaultProfile({ lang: 'en', rules: [] }), (p) => {
    p.identity = { ...p.identity, display_name: { ar: '', en: 'Nour Shop' }, kind: 'shop', niche: 'Linen homewares', timezone: 'Europe/London' };
    p.offers = [{ id: 'main', kind: 'product', name: 'Linen throw', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }];
});

let world: OnboardingWorld;
let logs: string[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    invalidateTenantCache();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
    world = installOnboardingWorld();
    setPlatformOwner(world.db, OWNER);
});

afterEach(() => {
    world.restore();
    restoreSink?.();
    invalidateTenantCache();
});

const newcomer = (profile: CreatorProfile, onboarding: Parameters<typeof addNewcomer>[2] = {}) => addNewcomer(world, throughJsonb(profile), onboarding);
const refusal = async (creatorId: string, agent: GatedAgent): Promise<ProfileIncomplete> => {
    try {
        await assertAgentReady(creatorId, agent);
    } catch (err) {
        assert.ok(err instanceof ProfileIncomplete, String(err));
        return err;
    }
    assert.fail(`${agent} was not refused`);
};
const writes = () => world.db.statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s.sql));

describe('what each agent needs', () => {
    it('is the six activation fields for all of them, and one more for three', () => {
        assert.deepEqual([...GATED_AGENTS], ['studio', 'monteur', 'coach', 'dm']);
        assert.deepEqual(AGENT_REQUIRES, { studio: [], monteur: ['presenter'], coach: ['audience.description'], dm: ['dm.handoff'] });
        for (const agent of GATED_AGENTS) assert.equal(isGatedAgent(agent), true);
        for (const other of ['infographics', 'Studio', '', null, undefined, 3]) assert.equal(isGatedAgent(other), false);
    });

    it('says what a blank profile lacks, activation first, then the agent\'s own', () => {
        const blank = defaultProfile({ lang: 'ar' });
        const activation = ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name'];
        assert.deepEqual(agentMissing(blank, 'studio'), activation);
        assert.deepEqual(agentMissing(blank, 'monteur'), [...activation, 'presenter']);
        assert.deepEqual(agentMissing(blank, 'coach'), [...activation, 'audience.description']);
        assert.deepEqual(agentMissing(blank, 'dm'), [...activation, 'dm.handoff']);
    });

    it('says nothing is lacking for FITNESS_EN, who has it all; and what SHOP_EG lacks', () => {
        for (const agent of GATED_AGENTS) assert.deepEqual(agentMissing(FITNESS_EN, agent), [], agent);
        assert.deepEqual(agentMissing(SHOP_EG, 'studio'), []);
        assert.deepEqual(agentMissing(SHOP_EG, 'monteur'), ['presenter']);
        assert.deepEqual(agentMissing(SHOP_EG, 'coach'), ['audience.description']);
        assert.deepEqual(agentMissing(SHOP_EG, 'dm'), ['dm.handoff']);
    });

    it('agrees with the meter about whether each extra field is there: the sheet and the 409 cannot disagree', () => {
        const meterField = (path: string) => FIELDS.find((f) => f.paths.includes(path))!;
        const profiles = [
            FINISHED, FITNESS_EN, SHOP_EG, defaultProfile({ lang: 'ar' }),
            edit(FINISHED, (p) => { p.presenter = { name: '', pronouns: 'he', on_camera: 'face' }; }),
            edit(FINISHED, (p) => { p.audience.description = '   '; }),
            edit(FINISHED, (p) => { p.audience.description = 'Parents'; }),
            edit(FINISHED, (p) => { p.dm.handoff = { when: 'w', message: '' }; }),
        ];
        for (const profile of profiles) {
            for (const agent of GATED_AGENTS) {
                for (const path of AGENT_REQUIRES[agent]) {
                    const lacks = agentMissing(profile, agent).includes(path);
                    assert.equal(lacks, meterField(path).filled(profile) < 1, `${path}`);
                }
            }
        }
    });

    it('sends a missing field to where it is fixed: the wizard\'s two steps, or the one-field sheet', () => {
        assert.equal(fixStepFor('identity.display_name'), 'about');
        assert.equal(fixStepFor('identity.kind'), 'about');
        assert.equal(fixStepFor('identity.niche'), 'about');
        assert.equal(fixStepFor('identity.timezone'), 'about');
        assert.equal(fixStepFor('offers.primary.name'), 'about');
        assert.equal(fixStepFor('offers.primary.url'), 'about');
        assert.equal(fixStepFor('language.primary'), 'voice');
        assert.equal(fixStepFor('language.register'), 'voice');
        for (const path of ['presenter', 'audience.description', 'dm.handoff']) assert.equal(fixStepFor(path), 'ask', path);
    });
});

describe('who is exempt', () => {
    const onboarding = (status: 'invited' | 'in_progress' | 'completed', filled_by: 'tenant' | 'admin' | null) => ({ status, filled_by });

    it('the owner, whatever his onboarding row says, and without his row having been read', () => {
        for (const row of [undefined, null, onboarding('invited', null), onboarding('in_progress', 'tenant'), onboarding('completed', 'admin')]) {
            assert.equal(exemptionOf({ creatorId: OWNER, ownerId: OWNER, onboarding: row }), 'owner');
        }
        assert.equal(exemptionOf({ creatorId: OWNER.toUpperCase(), ownerId: OWNER }), 'owner', 'an id is an id in either case');
    });

    it('a tenant that predates onboarding: no row, or a completed row nobody filled in', () => {
        assert.equal(exemptionOf({ creatorId: NEWCOMER, ownerId: OWNER, onboarding: null }), 'legacy');
        assert.equal(exemptionOf({ creatorId: NEWCOMER, ownerId: OWNER, onboarding: onboarding('completed', null) }), 'legacy');
    });

    it('nobody else: not a tenant mid-wizard, not one that finished it, not one an admin filled in', () => {
        for (const row of [onboarding('invited', null), onboarding('in_progress', null), onboarding('in_progress', 'tenant'), onboarding('completed', 'tenant'), onboarding('completed', 'admin')]) {
            assert.equal(exemptionOf({ creatorId: NEWCOMER, ownerId: OWNER, onboarding: row }), null, JSON.stringify(row));
            assert.equal(isGrandfathered({ creatorId: NEWCOMER, ownerId: OWNER, onboarding: row }), false);
        }
        assert.equal(exemptionOf({ creatorId: NEWCOMER, ownerId: OWNER }), null, 'a row that was not read exempts nobody but the owner');
        assert.equal(exemptionOf({ creatorId: NEWCOMER, ownerId: null, onboarding: onboarding('invited', null) }), null, 'no owner at all: nobody is him');
    });
});

describe('the owner is never gated', () => {
    it('for any agent, with his real gaps: no niche, no samples, an unnamed presenter and no DM hand-off rule', async () => {
        // His tenant has no stored profile in this stand-in, so it is described from his legacy rows: niche empty, no hand-off.
        for (const agent of GATED_AGENTS) await assertAgentReady(OWNER, agent);
        assert.deepEqual(writes(), []);
    });

    it('even when his onboarding row says he has not started, and his profile is as blank as a new tenant\'s', async () => {
        world.onboarding.set(OWNER, { status: 'invited', current_step: null, steps: {}, filled_by: null, started_at: null, completed_at: null });
        world.state.profiles.set(OWNER, { profile: throughJsonb(defaultProfile({ lang: 'ar' })), version: 1, activated_at: null, updated_by: null });
        for (const agent of GATED_AGENTS) await assertAgentReady(OWNER, agent);
    });

    it('without reading his onboarding row or his profile at all: his path depends on neither being readable', async () => {
        world.db.failOn = /FROM onboarding|creator_profiles/;
        for (const agent of GATED_AGENTS) await assertAgentReady(OWNER, agent);
        const reads = world.db.statements.map((s) => s.sql);
        assert.equal(reads.some((sql) => /FROM onboarding\b/.test(sql)), false, 'his row is never looked up');
        assert.equal(reads.some((sql) => /creator_profiles/.test(sql)), false, 'nor his profile');
        assert.equal(logs.some((line) => line.includes('profile.gate_unreadable')), false, 'and that is not an unreadable gate: it never tried');
    });

    it('whether or not his tenant is active', async () => {
        world.creators.get(OWNER)!.is_active = false;
        for (const agent of GATED_AGENTS) await assertAgentReady(OWNER, agent);
    });
});

describe('a tenant that predates onboarding is never gated', () => {
    it('one with no onboarding row, however blank its profile', async () => {
        newcomer(defaultProfile({ lang: 'ar' }));
        world.onboarding.delete(NEWCOMER);
        for (const agent of GATED_AGENTS) await assertAgentReady(NEWCOMER, agent);
    });

    it('one v34 inserted as completed, which nobody filled in', async () => {
        newcomer(defaultProfile({ lang: 'ar' }), { status: 'completed', filled_by: null, completed_at: new Date(0) });
        for (const agent of GATED_AGENTS) await assertAgentReady(NEWCOMER, agent);
    });
});

describe('a new tenant', () => {
    it('is refused every agent while it has not told us who it is, naming what is missing and where the first is fixed', async () => {
        newcomer(defaultProfile({ lang: 'ar' }));
        for (const agent of GATED_AGENTS) {
            const err = await refusal(NEWCOMER, agent);
            assert.equal(err.status, 409);
            assert.equal(err.code, 'PROFILE_INCOMPLETE');
            assert.equal(err.agent, agent);
            assert.deepEqual(err.missing.slice(0, 5), ['identity.display_name', 'identity.kind', 'identity.niche', 'identity.timezone', 'offers.primary.name']);
            assert.equal(err.fixStep, 'about');
        }
        assert.deepEqual(writes(), [], 'reading, never writing');
    });

    it('is sent to where the FIRST thing lacking is fixed: an activation field before the agent\'s own', async () => {
        newcomer(edit(FINISHED, (p) => { p.identity.niche = ''; }), { status: 'in_progress', filled_by: 'tenant' });
        const err = await refusal(NEWCOMER, 'monteur');
        assert.deepEqual(err.missing, ['identity.niche', 'presenter']);
        assert.equal(err.fixStep, 'about', 'the wizard first; the sheet for a presenter comes after');
    });

    it('that has finished the wizard may use the Studio, and is asked for the one more thing each other agent needs', async () => {
        newcomer(FINISHED, { status: 'completed', filled_by: 'tenant', completed_at: new Date() });
        await assertAgentReady(NEWCOMER, 'studio');
        for (const [agent, path] of [['monteur', 'presenter'], ['coach', 'audience.description'], ['dm', 'dm.handoff']] as const) {
            const err = await refusal(NEWCOMER, agent);
            assert.deepEqual(err.missing, [path]);
            assert.equal(err.fixStep, 'ask');
        }
    });

    it('is let through the moment it has what the agent needs, and no sooner', async () => {
        newcomer(FINISHED, { status: 'completed', filled_by: 'admin', completed_at: new Date() });
        const give = (change: (p: CreatorProfile) => void) => {
            world.state.profiles.set(NEWCOMER, { profile: throughJsonb(edit(FINISHED, change)), version: 2, activated_at: null, updated_by: null });
        };
        give((p) => { p.presenter = { name: 'Nour', pronouns: 'she', on_camera: 'voice' }; });
        await assertAgentReady(NEWCOMER, 'monteur');
        assert.equal((await refusal(NEWCOMER, 'dm')).missing[0], 'dm.handoff', 'a presenter is no hand-off rule');
        give((p) => { p.dm.handoff = { when: 'A refund', message: 'A person will reply.' }; });
        await assertAgentReady(NEWCOMER, 'dm');
        give((p) => { p.audience.description = 'Parents with an hour a day'; });
        await assertAgentReady(NEWCOMER, 'coach');
    });

    it('is refused with a body of paths and words, and nothing it typed', async () => {
        newcomer(edit(defaultProfile({ lang: 'ar' }), (p) => { p.identity.niche = 'My secret niche'; p.offers = [{ id: 'm', kind: 'other', name: 'My private offer', order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: true }]; }));
        const err = await refusal(NEWCOMER, 'dm');
        const body = profileIncompleteBody(err);
        assert.deepEqual(Object.keys(body).sort(), ['agent', 'code', 'error', 'fixStep', 'message', 'missing', 'params']);
        assert.deepEqual(body.params, { agent: 'dm', missing: body.missing, fixStep: body.fixStep });
        assert.equal(body.code, 'PROFILE_INCOMPLETE');
        assert.equal(JSON.stringify(body).includes('secret'), false);
        assert.equal(JSON.stringify(body).includes('private'), false);
        assert.match(body.error, /dm\.handoff/);
    });
});

describe('a database that cannot answer', () => {
    it('lets a switch through and says so in the log: the gate is never the reason a tenant cannot work', async () => {
        newcomer(defaultProfile({ lang: 'ar' }));
        world.db.failOn = /FROM onboarding\b/;
        await assertAgentReady(NEWCOMER, 'dm');
        assert.equal(logs.some((line) => line.includes('profile.gate_unreadable')), true);
    });

    it('lets a switch through when the profile cannot be read, for a tenant that would otherwise have been refused', async () => {
        newcomer(defaultProfile({ lang: 'ar' }));
        world.db.failOn = /creator_profiles/;
        await assertAgentReady(NEWCOMER, 'monteur');
        assert.equal(logs.some((line) => line.includes('profile.gate_unreadable')), true);
    });

    it('lets a switch through on a database that has no onboarding table yet (v34 not applied): there is nothing to gate on', async () => {
        newcomer(defaultProfile({ lang: 'ar' }));
        world.noOnboardingTable = true;
        await assertAgentReady(NEWCOMER, 'studio');
    });
});
