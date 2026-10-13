/**
 * Campaign seeds (`campaignSeeds.ts`, docs/onboarding/05 P13): what the Campaigns screen's bulk import starts each imported
 * course from, read from a tenant's offers.
 *
 * Pinned: the owner's offers give exactly the nine of `__golden__/elamir/campaigns.course-mappings.json`, read here straight from
 * the file and compared byte for byte, in the golden's order; the two second tenants give their own and nothing of his
 * (`assertNoOwnerMarkers`); an offer with no campaign, or none to match by, is not a seed; and `readCampaignSeeds` answers the owner's
 * nine ONLY for the platform owner while his profile has none of its own, and never for anyone else.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { invalidateTenantCache } from '../tenant.js';
import { setLogSink } from '../../utils/log.js';
import { campaignSeeds, type CampaignSeed, legacyCampaignSeeds, readCampaignSeeds, seedOf } from './campaignSeeds.js';
import { FITNESS_EN, offer, SHOP_EG } from './fixtures.js';
import { profileFromLegacy } from './legacy.js';
import { LEGACY_COURSE_MAPPINGS } from './legacyCourseMappings.js';
import { planOwnerOffers } from './ownerOffers.js';
import { resetProfileTableWarning } from './store.js';
import { installProfileDb, OTHER, OWNER, type ProfileDb, seededState, setPlatformOwner, type State } from './testDb.js';
import { assertNoArabicScript, assertNoGulfInEgyptianOrMsa, assertNoOwnerMarkers, deepFreeze, throughJsonb } from './testSupport.js';
import type { CreatorProfile, Offer, OfferCampaign } from './types.js';

// ─── The owner: his nine, from the golden file ───────────────────────────────────────────────

type Mapping = { triggerKeywords: string; dmTemplate: string; publicReplies: string };
const GOLDEN: Record<string, Mapping> = JSON.parse(readFileSync(new URL('./__golden__/elamir/campaigns.course-mappings.json', import.meta.url), 'utf8'));
const GOLDEN_SEEDS: CampaignSeed[] = Object.entries(GOLDEN).map(([key, m]) => ({
    name_match: key, match: 'substring', trigger_keyword: m.triggerKeywords, dm_template: m.dmTemplate, public_reply_template: m.publicReplies,
}));

/** The owner as the seed script leaves him: his backfilled profile with the nine merged into its offers. */
const ownerSeeded = (): CreatorProfile => planOwnerOffers(profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH)).next;
const ownerBackfilled = (): CreatorProfile => profileFromLegacy(ELAMIR_SEED_SETTINGS, ELAMIR_GROWTH);

const same = (a: string, b: string): boolean => Buffer.from(a, 'utf8').equals(Buffer.from(b, 'utf8'));

describe('the owner\'s offers give exactly the golden\'s nine seeds', () => {
    it('nine entries, in the golden\'s order, every field the same bytes', () => {
        const seeds = campaignSeeds(ownerSeeded());
        assert.equal(seeds.length, 9);
        assert.deepStrictEqual(seeds.map((s) => s.name_match), Object.keys(GOLDEN), 'the order the import tries them in');
        seeds.forEach((s, i) => {
            const want = GOLDEN_SEEDS[i]!;
            assert.equal(s.match, 'substring', want.name_match);
            for (const field of ['trigger_keyword', 'dm_template', 'public_reply_template'] as const) {
                assert.ok(same(s[field], want[field]), `${want.name_match}.${field} is the same bytes`);
            }
        });
        assert.deepStrictEqual(seeds, GOLDEN_SEEDS);
        assert.equal(JSON.stringify(seeds), JSON.stringify(GOLDEN_SEEDS), 'key order of every seed included');
    });

    it('a seed is exactly the five columns a campaign import needs, and no more', () => {
        for (const s of campaignSeeds(ownerSeeded())) {
            assert.deepStrictEqual(Object.keys(s), ['name_match', 'match', 'trigger_keyword', 'dm_template', 'public_reply_template']);
        }
    });

    it('his built-in fallback (`legacyCampaignSeeds`) is the same nine: the dashboard cannot tell which answered', () => {
        assert.deepStrictEqual(legacyCampaignSeeds(), GOLDEN_SEEDS);
        assert.deepStrictEqual(campaignSeeds(ownerSeeded()), legacyCampaignSeeds());
        assert.deepStrictEqual(JSON.parse(JSON.stringify(LEGACY_COURSE_MAPPINGS)), GOLDEN, 'and the constant is the golden');
    });

    it('his backfilled profile, before the script, has no seeds of its own', () => {
        assert.deepStrictEqual(campaignSeeds(ownerBackfilled()), []);
    });

    it('the fallback hands out fresh copies: a caller that edits one cannot edit the constant', () => {
        const first = legacyCampaignSeeds();
        first[0]!.name_match = 'changed';
        first[0]!.trigger_keyword = 'changed';
        assert.deepStrictEqual(legacyCampaignSeeds(), GOLDEN_SEEDS);
    });
});

// ─── What counts as a seed ──────────────────────────────────────────────────────────────────

const campaign = (over: Partial<OfferCampaign> = {}): OfferCampaign => ({
    name_match: 'plan', match: 'substring', keywords: ['plan', 'program'], dm_template: 'Hi {username}: {url}', public_replies: ['Sent!', 'Check your DMs'], ...over,
});
const withOffers = (offers: Offer[]): Pick<CreatorProfile, 'offers'> => ({ offers });

describe('campaignSeeds', () => {
    it('joins the keywords on ", " and the replies on " | ", and keeps the DM and the match mode as they are', () => {
        const seeds = campaignSeeds(withOffers([offer({ id: 'a', campaign: campaign({ match: 'word', dm_template: 'Line one\nLine two {url} {username}' }) })]));
        assert.deepStrictEqual(seeds, [{
            name_match: 'plan', match: 'word', trigger_keyword: 'plan, program', dm_template: 'Line one\nLine two {url} {username}', public_reply_template: 'Sent! | Check your DMs',
        }]);
    });

    it('is one seed per offer that has a campaign, in the offers\' order, skipping the offers that have none', () => {
        const seeds = campaignSeeds(withOffers([
            offer({ id: 'a', campaign: campaign({ name_match: 'first' }) }),
            offer({ id: 'b' }),
            offer({ id: 'c', campaign: campaign({ name_match: 'second' }) }),
            offer({ id: 'd' }),
            offer({ id: 'e', campaign: campaign({ name_match: 'third' }) }),
        ]));
        assert.deepStrictEqual(seeds.map((s) => s.name_match), ['first', 'second', 'third']);
    });

    it('an offer with a campaign but nothing to match a course name by is not a seed: "" is a substring of every name', () => {
        const seeds = campaignSeeds(withOffers([
            offer({ id: 'a', campaign: campaign({ name_match: '' }) }),
            offer({ id: 'b', campaign: campaign({ name_match: '   ' }) }),
            offer({ id: 'c', campaign: campaign({ name_match: 'kept' }) }),
        ]));
        assert.deepStrictEqual(seeds.map((s) => s.name_match), ['kept']);
    });

    it('no offers, or none with a campaign, is no seeds', () => {
        assert.deepStrictEqual(campaignSeeds(withOffers([])), []);
        assert.deepStrictEqual(campaignSeeds(withOffers([offer({ id: 'a' }), offer({ id: 'b' })])), []);
    });

    it('drops a blank keyword or reply rather than send an empty one to the webhook\'s splitter', () => {
        assert.deepStrictEqual(seedOf(campaign({ keywords: ['a', '', ' ', 'b'], public_replies: ['x', '', 'y'] })).trigger_keyword, 'a, b');
        assert.deepStrictEqual(seedOf(campaign({ keywords: ['a', '', ' ', 'b'], public_replies: ['x', '', 'y'] })).public_reply_template, 'x | y');
    });

    it('never changes its input, and answers copies of it', () => {
        const profile = deepFreeze(structuredClone(ownerSeeded()));
        const seeds = campaignSeeds(profile);
        seeds[0]!.dm_template = 'edited';
        assert.notEqual(profile.offers[0]!.campaign!.dm_template, 'edited');
    });
});

// ─── The second tenants: their own seeds, none of his ─────────────────────────────────────────

/** The fitness coach with a campaign on the plan she sells: English, left to right, no register. */
const fitnessWithCampaign = (): CreatorProfile => ({
    ...FITNESS_EN,
    offers: FITNESS_EN.offers.map((o) => (o.id === 'plan'
        ? {
            ...o,
            campaign: {
                name_match: 'twelve-week', match: 'word' as const, keywords: ['plan', 'twelve weeks'],
                dm_template: 'Hi {username}! Here is the twelve-week plan: {url}\nReply here if you get stuck.',
                public_replies: ['Sent to your DMs, {username}!', 'Check your inbox, {username}.'],
            },
        }
        : o)),
});

/** The shop with a campaign on its candle: Egyptian Arabic, no Gulf word in it. */
const shopWithCampaign = (): CreatorProfile => ({
    ...SHOP_EG,
    offers: SHOP_EG.offers.map((o) => (o.id === 'candle'
        ? {
            ...o,
            campaign: {
                name_match: 'لافندر', match: 'substring' as const, keywords: ['شمعة', 'لافندر'],
                dm_template: 'أهلا {username}! 🕯️\nده لينك الشمعة: {url}\nلو عايز حاجة تانية قولي.',
                public_replies: ['بعتنالك التفاصيل على الخاص يا {username} 📩', 'شوف الخاص يا {username} 🕯️'],
            },
        }
        : o)),
});

describe('the second tenants get their own seeds and nothing of the owner\'s', () => {
    it('FITNESS_EN: the plan\'s campaign, as the import would create it', () => {
        const seeds = campaignSeeds(fitnessWithCampaign());
        assert.deepStrictEqual(seeds, [{
            name_match: 'twelve-week', match: 'word', trigger_keyword: 'plan, twelve weeks',
            dm_template: 'Hi {username}! Here is the twelve-week plan: {url}\nReply here if you get stuck.',
            public_reply_template: 'Sent to your DMs, {username}! | Check your inbox, {username}.',
        }]);
        assertNoOwnerMarkers(JSON.stringify(seeds), 'FITNESS_EN seeds');
        assertNoArabicScript(JSON.stringify(seeds), 'FITNESS_EN seeds');
    });

    it('SHOP_EG: the candle\'s campaign, in Egyptian Arabic', () => {
        const seeds = campaignSeeds(shopWithCampaign());
        assert.equal(seeds.length, 1);
        assert.deepStrictEqual(seeds[0], {
            name_match: 'لافندر', match: 'substring', trigger_keyword: 'شمعة, لافندر',
            dm_template: 'أهلا {username}! 🕯️\nده لينك الشمعة: {url}\nلو عايز حاجة تانية قولي.',
            public_reply_template: 'بعتنالك التفاصيل على الخاص يا {username} 📩 | شوف الخاص يا {username} 🕯️',
        });
        assertNoOwnerMarkers(JSON.stringify(seeds), 'SHOP_EG seeds');
        assertNoGulfInEgyptianOrMsa(JSON.stringify(seeds), 'SHOP_EG seeds');
    });

    it('a second tenant with no campaigns has no seeds: never the owner\'s', () => {
        for (const tenant of [FITNESS_EN, SHOP_EG]) {
            assert.deepStrictEqual(campaignSeeds(tenant), []);
            assertNoOwnerMarkers(JSON.stringify(campaignSeeds(tenant)), 'seeds of a tenant with none');
        }
    });

    it('the seeds of one tenant never hold a word of the other\'s or of the owner\'s', () => {
        const fitness = JSON.stringify(campaignSeeds(fitnessWithCampaign()));
        const shop = JSON.stringify(campaignSeeds(shopWithCampaign()));
        assert.ok(!fitness.includes('لافندر') && !shop.includes('twelve-week'));
        for (const marker of ['golang', 'swift', 'agentic ai', 'Udemy', 'كوبون']) {
            assert.ok(!fitness.includes(marker) && !shop.includes(marker), marker);
        }
    });
});

// ─── What the route answers ──────────────────────────────────────────────────────────────────

describe('readCampaignSeeds', () => {
    let state: State;
    let db: ProfileDb;
    let restoreSink: (() => void) | undefined;

    beforeEach(() => {
        resetProfileTableWarning();
        invalidateTenantCache();
        const previous = setLogSink(() => {});
        restoreSink = () => setLogSink(previous);
        state = seededState();
        db = installProfileDb(state);
        setPlatformOwner(db, OWNER);
    });
    afterEach(() => {
        db.restore();
        restoreSink?.();
    });

    const store = (creator: string, profile: unknown, version = 1): void => {
        state.profiles.set(creator, { profile: throughJsonb(profile), version, activated_at: null, updated_by: null });
    };

    it('a tenant\'s own offers\' campaigns, `source: profile`', async () => {
        store(OTHER, fitnessWithCampaign());
        const answer = await readCampaignSeeds(OTHER);
        assert.equal(answer.source, 'profile');
        assert.deepStrictEqual(answer.seeds, campaignSeeds(fitnessWithCampaign()));
        assert.equal(db.statements.some((s) => /FROM creators ORDER BY created_at/.test(s.sql)), false, 'it did not even ask who the owner is: the answer was its own');
    });

    it('the owner once his offers carry the nine: from his profile, not the built-in copy', async () => {
        store(OWNER, ownerSeeded(), 2);
        const answer = await readCampaignSeeds(OWNER);
        assert.equal(answer.source, 'profile');
        assert.deepStrictEqual(answer.seeds, GOLDEN_SEEDS);
    });

    it('the owner before the script has run (a stored profile with no campaign): his nine from the built-in copy, `source: legacy`', async () => {
        store(OWNER, ownerBackfilled(), 1);
        const answer = await readCampaignSeeds(OWNER);
        assert.equal(answer.source, 'legacy');
        assert.deepStrictEqual(answer.seeds, GOLDEN_SEEDS);
    });

    it('the owner with no stored profile at all (his rows describe it): the same nine', async () => {
        const answer = await readCampaignSeeds(OWNER);
        assert.equal(answer.source, 'legacy');
        assert.deepStrictEqual(answer.seeds, GOLDEN_SEEDS);
    });

    it('ANOTHER tenant with no campaign never gets his nine: an empty list', async () => {
        store(OTHER, FITNESS_EN);
        const answer = await readCampaignSeeds(OTHER);
        assert.deepStrictEqual(answer, { seeds: [], source: 'profile' });
        assertNoOwnerMarkers(JSON.stringify(answer), 'another tenant\'s answer');
    });

    it('nor when it cannot be told who the owner is: no creators at all is not "he"', async () => {
        setPlatformOwner(db, null);
        store(OTHER, SHOP_EG);
        assert.deepStrictEqual(await readCampaignSeeds(OTHER), { seeds: [], source: 'profile' });
        assert.deepStrictEqual(await readCampaignSeeds(OWNER), { seeds: [], source: 'profile' }, 'and not even for the id that would have been him: the lookup found nobody');
    });

    it('a failing owner lookup is a failure, not a quiet "no": the route answers a 500 and nothing is served in his name', async () => {
        setPlatformOwner(db, new Error('connection refused'));
        store(OTHER, SHOP_EG);
        await assert.rejects(() => readCampaignSeeds(OTHER), /connection refused/);
    });

    it('the owner id is compared case-insensitively, as the Mac guard compares it', async () => {
        setPlatformOwner(db, OWNER.toUpperCase());
        store(OWNER, ownerBackfilled(), 1);
        assert.equal((await readCampaignSeeds(OWNER)).source, 'legacy');
    });

    it('a profile written by a newer release is not read for offers: the owner falls back, another tenant has none', async () => {
        store(OWNER, { ...ownerSeeded(), schema: 2 }, 5);
        store(OTHER, { ...fitnessWithCampaign(), schema: 2 }, 5);
        assert.equal((await readCampaignSeeds(OWNER)).source, 'legacy');
        assert.deepStrictEqual(await readCampaignSeeds(OTHER), { seeds: [], source: 'profile' });
    });

    it('a read writes nothing', async () => {
        store(OTHER, fitnessWithCampaign());
        await readCampaignSeeds(OTHER);
        await readCampaignSeeds(OWNER);
        assert.deepStrictEqual(db.statements.filter((s) => /^(INSERT|UPDATE|DELETE)/.test(s.sql)), []);
    });
});
