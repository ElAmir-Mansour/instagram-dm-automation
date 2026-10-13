/**
 * Campaign seeds (docs/onboarding/05 P13): the wording the Campaigns screen's "Import from CSV" starts each imported
 * course from, now read from the tenant's own offers instead of the nine the dashboard used to carry for the owner.
 *
 *   campaignSeeds(profile)          pure: one seed per offer that has a `campaign` and a name to match, in the offers' order
 *   legacyCampaignSeeds()           pure: the owner's nine `COURSE_MAPPINGS`, as seeds (`legacyCourseMappings.ts`)
 *   readCampaignSeeds(creatorId)    what `GET /api/profile/campaign-seeds` answers: `{ seeds, source }`
 *
 * **A seed is a campaign row's own columns plus how to find it.** The bulk import creates its campaigns through
 * `POST /api/campaigns`, so a seed holds exactly what that body takes: `trigger_keyword` (an offer's `keywords` joined
 * on ", ") and `public_reply_template` (its `public_replies` joined on " | "; the webhook splits it on "|"), `dm_template`
 * as it is with `{url}` and `{username}` still in it, and the campaign's `match_mode`. `name_match` is the lower-case
 * substring of a course name that picks the seed. The import tries the seeds in order and the first whose `name_match` the
 * lower-cased course name contains wins, so **the order of `offers` is the order of the keys**: it is the owner's order of
 * `COURSE_MAPPINGS`, and a rule changed here changes which campaign an import picks.
 *
 * An offer with a campaign but no `name_match` is not a seed: it is matched by no course name (`OfferCampaign.name_match`),
 * and an empty string is a substring of every name, so passing it on would make one offer's campaign the answer for every
 * course in the CSV.
 *
 * **The owner's fallback.** Until `scripts/seed-owner-offers.mts` has been applied his stored profile has no offer with a
 * campaign, and without a fallback his import would stop seeding his nine courses the day the dashboard stops carrying
 * them. So when a profile yields no seeds AND the tenant is the platform owner (`getPlatformOwnerId`, found and equal; a lookup
 * that fails or finds nobody is *not* him), the answer is his nine, `source: 'legacy'`. Every other tenant gets what its
 * own offers say, which is an empty list until they have campaigns, and never his: the nine are Arabic copy about his
 * Udemy courses. Once his offers carry them the fallback is dead code, and `source` says which one answered.
 */
import { pool } from '../../config/db.js';
import type { Exec } from '../studio/common.js';
import { getPlatformOwnerId } from '../tenant.js';
import { LEGACY_COURSE_MAPPINGS } from './legacyCourseMappings.js';
import { loadProfile } from './store.js';
import type { CreatorProfile, MatchMode, Offer, OfferCampaign } from './types.js';

/** One seed: the `POST /api/campaigns` fields an imported course starts from, and the key that picks it. */
export interface CampaignSeed {
    /** A lower-case substring of the course name. Never empty. */
    name_match: string;
    /** The campaign's `match_mode`: how its keywords are matched in a comment. */
    match: MatchMode;
    /** The campaign's `trigger_keyword`: the keywords, comma-separated. */
    trigger_keyword: string;
    /** The campaign's `dm_template`, with `{url}` and `{username}` in it. */
    dm_template: string;
    /** The campaign's `public_reply_template`: the replies, separated by " | ". */
    public_reply_template: string;
}

/** What the route answers: the seeds, and which source they came from. */
export interface CampaignSeedsAnswer {
    seeds: CampaignSeed[];
    /** 'profile': the tenant's own offers. 'legacy': the platform owner's nine, because his profile has no campaign yet. */
    source: 'profile' | 'legacy';
}

/** The two separators a campaign's lists are stored with (`trigger_keyword`, `public_reply_template`). */
const KEYWORD_SEPARATOR = ', ';
const REPLY_SEPARATOR = ' | ';

const nonBlank = (items: readonly string[]): string[] => items.filter((s) => s.trim() !== '');

/** An offer's campaign as a seed: the lists joined, everything else as it is. */
export function seedOf(campaign: OfferCampaign): CampaignSeed {
    return {
        name_match: campaign.name_match,
        match: campaign.match,
        trigger_keyword: nonBlank(campaign.keywords).join(KEYWORD_SEPARATOR),
        dm_template: campaign.dm_template,
        public_reply_template: nonBlank(campaign.public_replies).join(REPLY_SEPARATOR),
    };
}

/** An offer that can be a seed: it has a campaign, and that campaign has a name to be matched by. */
const seedable = (o: Offer): o is Offer & { campaign: OfferCampaign } => o.campaign !== undefined && o.campaign.name_match.trim() !== '';

/** The seeds a profile's offers give, in the offers' order (see the top of the file). */
export function campaignSeeds(profile: Pick<CreatorProfile, 'offers'>): CampaignSeed[] {
    return profile.offers.filter(seedable).map((o) => seedOf(o.campaign));
}

/** The owner's nine `COURSE_MAPPINGS` as seeds, in the order the import tried them. Fresh copies: the constant is frozen. */
export function legacyCampaignSeeds(): CampaignSeed[] {
    return Object.entries(LEGACY_COURSE_MAPPINGS).map(([key, m]) => ({
        name_match: key,
        // The bulk import never sent a match_mode, so the campaigns it made were substring ones.
        match: 'substring',
        trigger_keyword: m.triggerKeywords,
        dm_template: m.dmTemplate,
        public_reply_template: m.publicReplies,
    }));
}

/**
 * Whether `creatorId` is the platform owner, for sure: the lookup answered and named this tenant. Stricter than the DM's
 * `mayUseLegacyWording`, which lets anyone through when the owner cannot be found: that is right for wording (a hiccup must
 * not silence the owner) and wrong here, where the legacy answer is another person's Arabic copy about his courses.
 */
async function isPlatformOwner(creatorId: string): Promise<boolean> {
    const owner = await getPlatformOwnerId();
    return owner !== null && owner.toLowerCase() === creatorId.toLowerCase();
}

/**
 * The seeds for `creatorId`: its own offers' campaigns; and, when there are none and it is the platform owner, his nine
 * (`source: 'legacy'`). A profile written by a newer release is not read for offers, as the settings readers do not
 * overlay it (`overlayProfile`): it yields no seeds of its own. Throws what `loadProfile` throws, and the route answers a 500.
 */
export async function readCampaignSeeds(creatorId: string, exec: Exec = pool): Promise<CampaignSeedsAnswer> {
    const loaded = await loadProfile(creatorId, exec);
    const own = loaded.newerSchema ? [] : campaignSeeds(loaded.profile);
    if (own.length > 0) return { seeds: own, source: 'profile' };
    if (await isPlatformOwner(creatorId)) return { seeds: legacyCampaignSeeds(), source: 'legacy' };
    return { seeds: [], source: 'profile' };
}
