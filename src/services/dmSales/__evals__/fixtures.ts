/**
 * The profiles the evaluation builds its prompts from (docs/DM_SALES_PLAN.md §11: "from the golden fixture profile, not the live DB").
 *
 * Three, all committed and none read from a database. They are what the golden prompts are made of (`golden.test.ts`), so a prompt the
 * harness sends is the one `__golden__/…/dm.sales-system-filled.*` pins, apart from the conversation's own last block:
 *
 *   owner-ar          the owner's profile as production holds it (his nine offers, one with a link) with a sales block typed in. Its price is
 *                     typed but has NO valid-until date, so the bot may state no price: "the current price is on the page", the owner's rule
 *   owner-ar-priced   the same, with a price whose date has not passed: 49 USD is the one number it may say
 *   coach-en          the English control tenant, a fitness coach, with a live price and a sales block of its own
 *
 * The moment is fixed (`NOW`, from the sales test fixtures), so a price's "valid until" does not expire under a run and two runs of one
 * prompt are one prompt. The conversation's facts are the runner's: this is the part of the prompt that does not change from turn to turn.
 */
import { createHash } from 'node:crypto';
import { contextFor } from '../../profile/context.js';
import { upgradeProfile } from '../../profile/defaults.js';
import { FITNESS_EN } from '../../profile/fixtures.js';
import { throughJsonb } from '../../profile/jsonb.js';
import { kitForLang } from '../../profile/kits.js';
import { profileFromLegacy } from '../../profile/legacy.js';
import { planOwnerOffers } from '../../profile/ownerOffers.js';
import type { CreatorProfile, OfferSales } from '../../profile/types.js';
import { ELAMIR_AGENT, ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../../studio/testFixtures.js';
import { buildSalesPrompt, type SalesContext } from '../prompt.js';
import { NOW, withSales } from '../testFixtures.js';
import { assertFixture } from './refusal.js';
import { FIXTURE_NAMES, type FixtureName } from './types.js';

export interface EvalFixture {
    name: FixtureName;
    /** `ai_agents.system_prompt`, as the owner wrote it. */
    persona: string;
    /** `ai_agents.knowledge_base`. */
    knowledge: string | null;
    profile: CreatorProfile;
    ctx: SalesContext;
    timezone: string;
    now: Date;
}

/** The sales block of the English coach: fitness, not the text `withSales` brings for the neutral tests. No proof: none was ever collected. */
const COACH_SALES: Partial<OfferSales> = {
    for_whom: 'Busy parents who want a home workout plan with no equipment and under an hour a day. Not for competitive athletes.',
    level: 'beginner',
    outcomes: ['Finish three short workouts a week at home', 'Build a routine that fits around the kids', 'Know what to eat on training days'],
    faqs: [
        { q: 'Do I need equipment?', a: 'No. Every workout uses your bodyweight and a chair.' },
        { q: 'How long is each workout?', a: 'About 30 minutes, three times a week.' },
    ],
    objections: [
        { objection: 'It is too expensive', answer: 'The current price is on the plan page, and it moves with promotions.' },
        { objection: 'I have no time', answer: 'Each workout is about 30 minutes, three times a week.' },
    ],
    proof: [],
    price_note: 'The price moves with promotions; the page shows today\'s.',
};

/** The owner's profile as production holds it: his stored profile (read back as storage returns it) with the eight other offers the seed script adds. */
function ownerProfile(): CreatorProfile {
    const stored = upgradeProfile(throughJsonb(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH))).profile;
    return planOwnerOffers(stored).next;
}

function build(name: FixtureName): EvalFixture {
    switch (name) {
        case 'owner-ar':
        case 'owner-ar-priced': {
            // `withSales` types a price and a date that has not passed; the plain fixture blanks the date, which is how a price the owner never dated reads.
            const profile = withSales(ownerProfile(), 'ar', name === 'owner-ar' ? { price_valid_until: '' } : {});
            return {
                name, persona: ELAMIR_AGENT.system_prompt, knowledge: ELAMIR_AGENT.knowledge_base, profile,
                ctx: contextFor(profile, 'dm', null), timezone: ELAMIR_SEED_SETTINGS.schedule.timezone, now: NOW,
            };
        }
        case 'coach-en': {
            const profile = withSales(FITNESS_EN, 'en', COACH_SALES);
            profile.dm = {
                faq: [{ q: 'Where do I do the workouts?', a: 'At home, in about 30 minutes.' }],
                handoff: { when: 'They ask for a refund or have a payment problem', message: 'Sami will reply personally soon.' },
                hours: { days: [1, 2, 3, 4, 5], from: '09:00', to: '17:00' },
            };
            return {
                name, persona: kitForLang('en').starterPersona, knowledge: null, profile,
                ctx: contextFor(profile, 'dm', null), timezone: FITNESS_EN.identity.timezone, now: NOW,
            };
        }
    }
}

const built = new Map<FixtureName, EvalFixture>();

/** A fixture by name. Anything that is not one (a tenant id included) is refused by `EvalRefusal`, before anything is built. */
export function resolveFixture(name: unknown): EvalFixture {
    const known = assertFixture(name, 'fixture');
    let fixture = built.get(known);
    if (!fixture) {
        fixture = build(known);
        built.set(known, fixture);
    }
    return fixture;
}

/** A short digest of what the sales prompt says for each fixture (its static prefix), so two reports can be told to be about one prompt. */
export function promptDigest(names: readonly FixtureName[] = FIXTURE_NAMES): string {
    const hash = createHash('sha256');
    for (const name of [...new Set(names)].sort()) {
        const f = resolveFixture(name);
        hash.update(`${name}\n${buildSalesPrompt({ persona: f.persona, knowledge: f.knowledge, ctx: f.ctx, timezone: f.timezone, now: f.now }).prefix}\n`);
    }
    return hash.digest('hex').slice(0, 12);
}
