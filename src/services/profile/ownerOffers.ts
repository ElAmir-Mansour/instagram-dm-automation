/**
 * Seeding the owner's offers (docs/onboarding/05 P13, TENANT_ONBOARDING_PLAN §4b): what `scripts/seed-owner-offers.mts` does,
 * with every decision in a pure function so a test can run it with no database.
 *
 * The owner's nine campaign mappings (`legacyCourseMappings.ts`) become `course` offers with their `campaign` set, so that
 * `campaignSeeds(profile)` gives the Campaigns screen the same nine, in the same order, byte for byte, and the dashboard
 * (and the fallback in `readCampaignSeeds`) can stop carrying them.
 *
 *   planOwnerOffers(profile)      pure: the profile with the nine merged in, and what happens to each offer. An offer that already
 *                                 is one of the nine (carries its key, or is a course whose name the import would give to it) gets
 *                                 the campaign; it is not duplicated. The primary offer and everything else stay as they are.
 *   assessOwnerOffers(input)      the plan, and every reason not to save it. Nothing is written.
 *   applyOwnerOffers(...)         the write: `saveProfile` with the version the plan was made from, only for a plan that passed.
 *
 * **What makes a plan safe to save** (`assessOwnerOffers` refuses otherwise, and says which):
 *
 *   - The profile it makes is valid, and every offer in it is a `course`: any other kind makes the owner's offers "mixed", which
 *     turns the DM bot's rule 2 from «كورسات» into «عروض» and its button `GO_TO_COURSE_1` into `GO_TO_OFFER_1` (§4b).
 *   - His campaign seeds are exactly his nine, and his primary offer is untouched (`saveProfile` mirrors it into `product`).
 *   - **The prompt surface does not move.** Every builder the parity script hashes (`tenantSurface`, the one list the goldens
 *     and `prompt-parity.mts` share) is built from the profile as it is and from the profile as it would be, and `compareSurfaces`
 *     (the parity script's own comparison) must find every row equal. One row that differs, or throws, refuses the save. The
 *     views the save mirrors back into the Studio and Growth rows must be equal too: the save writes nothing else.
 *   - The stored profile is one this release reads cleanly: nothing repaired, not written by a newer release.
 *
 * Nothing on a request path imports this: it reaches `promptSurface.ts`, which holds test fixtures.
 */
import { isDeepStrictEqual } from 'node:util';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { campaignSeeds, legacyCampaignSeeds } from './campaignSeeds.js';
import { offerKindOf } from './context.js';
import { LEGACY_COURSE_MAPPINGS, type LegacyCourseMapping } from './legacyCourseMappings.js';
import { compareSurfaces, type ParityReport, profileProblemsOf } from './parity.js';
import { type AgentPersona, tenantSurface } from './promptSurface.js';
import { type SavedProfile, saveProfile } from './store.js';
import type { CreatorProfile, Offer, OfferCampaign } from './types.js';
import { primaryOffer, validateProfile } from './validate.js';
import { growthView, studioView } from './views.js';

// ─── The plan ─────────────────────────────────────────────────────────────────────────────────

/** A mapping as an offer's campaign: the two joined lists split on their separators (", " and " | "), the DM as it is. */
export function campaignOf(key: string, m: LegacyCourseMapping): OfferCampaign {
    return {
        name_match: key,
        // The bulk import never sent a match_mode, so the campaigns it made were substring ones.
        match: 'substring',
        keywords: m.triggerKeywords.split(', '),
        dm_template: m.dmTemplate,
        public_replies: m.publicReplies.split(' | '),
    };
}

/** The offer id a new course gets: its key, as a slug ('c#' is 'course-c-sharp'). */
export const offerIdFor = (key: string): string => `course-${key.replace(/#/g, '-sharp').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`;

/** The course title a mapping's DM names, in quotes: the one place the owner's data holds it. Null unless there is exactly one. */
export function courseTitleOf(m: LegacyCourseMapping): string | null {
    const titles = [...m.dmTemplate.matchAll(/"([^"\n]+)"/g)].map((x) => x[1]!);
    return titles.length === 1 ? titles[0]! : null;
}

/** What the plan does to one offer. */
export interface OfferAction {
    /** The offer's id: the existing one, or the one it is created with. */
    id: string;
    key: string;
    name: string;
    /** `attach` sets the campaign on an offer that exists; `create` adds the offer; `unchanged` already carries this exact campaign; `conflict` carries another. */
    action: 'attach' | 'create' | 'unchanged' | 'conflict';
}

export interface OwnerOffersPlan {
    /** The profile with the nine merged in: a copy, the argument is not touched. */
    next: CreatorProfile;
    actions: OfferAction[];
    /** Whether `next` differs from the profile the plan was made from. */
    changed: boolean;
    /** What stops the merge itself (a conflict, a mapping with no title); the checks on its result come after, in the assessment. */
    problems: string[];
}

/** The first key, in the import's order, that the lower-cased name contains: what `seedFor` (the dashboard) gives a course of that name. */
function firstKeyOf(name: string, keys: readonly string[]): string | null {
    const lower = name.toLowerCase();
    return keys.find((key) => lower.includes(key)) ?? null;
}

/**
 * `profile` with the nine mappings merged into its offers (see the top of the file). For each mapping, in order: the offer that
 * already carries its key, else a course nobody has claimed whose name the import would give this key (the owner's primary
 * course, which the backfill made from his product), else a new offer. A new offer is a `course` ordered by message: the
 * mappings hold no link (the import puts each course's own coupon link into `{url}`), and a link made up here would be sent
 * to followers. New offers are appended in the mappings' order, which is the order the import tries the keys in.
 */
export function planOwnerOffers(profile: CreatorProfile, mappings: Readonly<Record<string, Readonly<LegacyCourseMapping>>> = LEGACY_COURSE_MAPPINGS): OwnerOffersPlan {
    const next = structuredClone(profile);
    const keys = Object.keys(mappings);
    const claimed = new Set<Offer>();
    const actions: OfferAction[] = [];
    const problems: string[] = [];

    for (const [key, m] of Object.entries(mappings)) {
        const campaign = campaignOf(key, m);
        const own = next.offers.find((o) => !claimed.has(o) && o.campaign?.name_match === key)
            ?? next.offers.find((o) => !claimed.has(o) && o.campaign === undefined && o.kind === 'course' && firstKeyOf(o.name, keys) === key);
        if (own) {
            claimed.add(own);
            if (own.campaign === undefined) {
                own.campaign = campaign;
                actions.push({ id: own.id, key, name: own.name, action: 'attach' });
            } else if (isDeepStrictEqual(own.campaign, campaign)) {
                actions.push({ id: own.id, key, name: own.name, action: 'unchanged' });
            } else {
                actions.push({ id: own.id, key, name: own.name, action: 'conflict' });
                problems.push(`offer ${own.id} already has a campaign for «${key}» that is not the owner's mapping: it is not overwritten`);
            }
            continue;
        }
        const title = courseTitleOf(m);
        if (title === null) {
            problems.push(`the mapping «${key}» does not name its course exactly once in quotes, so the new offer has no name`);
            continue;
        }
        if (!title.toLowerCase().includes(key)) {
            problems.push(`the mapping «${key}» names «${title}», which the import would not give to this key`);
            continue;
        }
        const created: Offer = {
            id: offerIdFor(key), kind: 'course', name: title, order_via: 'dm', url: '', price: '', facts: [], bullets: [], keyword: '', primary: false, campaign,
        };
        next.offers.push(created);
        claimed.add(created);
        actions.push({ id: created.id, key, name: title, action: 'create' });
    }

    return { next, actions, changed: !isDeepStrictEqual(profile, next), problems };
}

// ─── The assessment ───────────────────────────────────────────────────────────────────────────

/** The tenant's rows and the profile read through them, as the parity script reads them. */
export interface OwnerOffersInput {
    studio: StudioSettings;
    growth: GrowthSettings;
    profile: CreatorProfile;
    /** The stored version the profile was read at, or null for a tenant whose profile is still the virtual one. */
    version: number | null;
    /** The DM agent's persona, when the tenant has one. The same before and after. */
    agent?: AgentPersona | null;
    /** What reading the stored profile found; omit for a tenant with none stored. */
    stored?: { repaired: readonly string[]; newerSchema: boolean } | null;
}

export type OwnerOffersStatus = 'ready' | 'unchanged' | 'refused';

export interface OwnerOffersAssessment {
    /** `ready`: save it. `unchanged`: the nine are already there, nothing to write. `refused`: see `reasons`. */
    status: OwnerOffersStatus;
    plan: OwnerOffersPlan;
    /** Every reason the plan is not saved. Empty unless `refused`. */
    reasons: string[];
    /** The prompt surface before against after (every builder `tenantSurface` makes). Null when it could not be compared. */
    surface: ParityReport | null;
    /** The kind every offer of the plan shares ('course' is what it must be). */
    offerKind: ReturnType<typeof offerKindOf>;
    /** The version the plan was made from: what the save must find still stored. */
    version: number | null;
}

/** Every builder, from `profile` read the way the parity script's path (b) reads a stored one. */
async function surfaceOf(input: OwnerOffersInput, profile: CreatorProfile) {
    return tenantSurface(
        { studio: studioView(input.studio, profile), growth: growthView(input.growth, profile), agent: input.agent ?? null, profile },
        { storedProfile: profile },
    );
}

/**
 * The plan for this tenant, and every reason not to save it (see the top of the file). Never throws for a plan that is merely
 * unsafe: that is a `refused` assessment that says why. A surface builder that throws is a row that says so and refuses too.
 */
export async function assessOwnerOffers(input: OwnerOffersInput): Promise<OwnerOffersAssessment> {
    const plan = planOwnerOffers(input.profile);
    const offerKind = offerKindOf(plan.next.offers);
    const base = { plan, offerKind, version: input.version };
    const reasons: string[] = [...plan.problems];

    for (const problem of profileProblemsOf(input.stored)) reasons.push(problem);

    if (!plan.changed && reasons.length === 0) return { ...base, status: 'unchanged', reasons: [], surface: null };

    const checked = validateProfile(plan.next);
    if ('problems' in checked) for (const p of checked.problems) reasons.push(`the profile it makes is not valid: ${p}`);

    const notCourses = plan.next.offers.filter((o) => o.kind !== 'course');
    if (notCourses.length > 0) {
        reasons.push(
            `offer ${notCourses.map((o) => `${o.id} (${o.kind})`).join(', ')} is not a course: his offers would be "${offerKind}", which turns the DM rule 2 into «عروض» and the button into GO_TO_OFFER_1`,
        );
    }

    if (!isDeepStrictEqual(campaignSeeds(plan.next), legacyCampaignSeeds())) {
        reasons.push('the campaign seeds its offers would give are not exactly the nine mappings, in their order');
    }
    // The primary offer gains its campaign (it is the Agentic AI course), and nothing else: everything the save mirrors into the
    // Studio product (name, link, facts, bullets) and its id and kind are as they were. `campaign` is not part of any view.
    const sansCampaign = (o: Offer | null): Omit<Offer, 'campaign'> | null => {
        if (!o) return null;
        const { campaign: _campaign, ...rest } = o;
        return rest;
    };
    if (!isDeepStrictEqual(sansCampaign(primaryOffer(input.profile.offers)), sansCampaign(primaryOffer(plan.next.offers)))) {
        reasons.push('the primary offer would change (other than gaining its campaign): the save mirrors it into the Studio product');
    }

    // What the save mirrors back into the Studio and Growth rows is the view of the new profile over them.
    if (!isDeepStrictEqual(studioView(input.studio, input.profile), studioView(input.studio, plan.next))) reasons.push('the Studio view would change: the save would rewrite the Studio settings');
    if (!isDeepStrictEqual(growthView(input.growth, input.profile), growthView(input.growth, plan.next))) reasons.push('the Growth view would change: the save would rewrite the Growth settings');

    // The same builders, the same comparison the parity script makes, on the profile as it is and as it would be.
    let surface: ParityReport | null = null;
    try {
        surface = compareSurfaces(await surfaceOf(input, input.profile), await surfaceOf(input, plan.next));
        for (const row of surface.rows) {
            if (row.error) reasons.push(`the prompt surface row ${row.name} threw, so it cannot be compared`);
            else if (!row.match) reasons.push(`the prompt surface row ${row.name} would change`);
        }
        if (surface.builders === 0) reasons.push('no prompt builder was compared, so nothing proves the surface stays as it is');
    } catch (err) {
        reasons.push(`the prompt surface could not be compared: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
    }

    return { ...base, status: reasons.length === 0 ? 'ready' : 'refused', reasons, surface };
}

// ─── The write ────────────────────────────────────────────────────────────────────────────────

/** What a refused or unchanged assessment answers when it is asked to be written. */
export class OwnerOffersRefused extends Error {
    constructor(readonly assessment: OwnerOffersAssessment) {
        super(assessment.status === 'unchanged' ? 'the owner\'s offers already carry the nine campaigns: nothing to write' : `refused: ${assessment.reasons.join('; ')}`);
        this.name = 'OwnerOffersRefused';
    }
}

/** The shape of `saveProfile` that the write needs, so a test can hand in a stand-in that records the call. */
export type SaveProfileFn = (creatorId: string, next: unknown, options: { expectVersion: number | null; source: 'backfill'; userId: null }) => Promise<SavedProfile>;

/**
 * Stores the assessed profile as the tenant's next version (source `backfill`, no user: a script), against the version it was
 * read at, so a profile that changed since the dry run is a `PROFILE_VERSION_CONFLICT` and not an overwrite. **The only way
 * the script writes, and only for a `ready` assessment**: anything else throws `OwnerOffersRefused` before `save` is called.
 */
export async function applyOwnerOffers(creatorId: string, assessment: OwnerOffersAssessment, save: SaveProfileFn = saveProfile): Promise<SavedProfile> {
    if (assessment.status !== 'ready') throw new OwnerOffersRefused(assessment);
    return save(creatorId, assessment.plan.next, { expectVersion: assessment.version, source: 'backfill', userId: null });
}

// ─── The report ───────────────────────────────────────────────────────────────────────────────

const SHOWN_NAME = 60;
const cut = (s: string): string => (s.length > SHOWN_NAME ? `${s.slice(0, SHOWN_NAME - 1)}…` : s);

/**
 * The dry run's output: one line per offer (what happens to it), what the seeds and the kind of offer come to, the surface
 * comparison in a line, and the verdict. Names are the courses' public titles; no link, no template, no setting is printed.
 */
export function formatOwnerOffers(a: OwnerOffersAssessment, header: { tenant: string; profile: string; target: string; mode: 'dry-run' | 'apply' }): string {
    const lines = [
        `seed owner offers · tenant ${header.tenant} · profile ${header.profile} · ${header.target}`,
        header.mode === 'apply' ? 'mode: APPLY (writes one profile version if the checks below pass)' : 'mode: DRY RUN (reads only; nothing is written)',
        '',
        `offers: ${a.plan.next.offers.length - a.plan.actions.filter((x) => x.action === 'create').length} now, ${a.plan.next.offers.length} after`,
    ];
    const width = Math.max(2, ...a.plan.actions.map((x) => x.id.length));
    for (const x of a.plan.actions) {
        const verb = { attach: 'campaign added to the existing offer', create: 'new offer', unchanged: 'already has this campaign', conflict: 'CONFLICT: has another campaign' }[x.action];
        lines.push(`  ${x.id.padEnd(width)}  «${x.key}»  ${verb}  ${cut(x.name)}`);
    }
    const seedsOk = isDeepStrictEqual(campaignSeeds(a.plan.next), legacyCampaignSeeds());
    lines.push(
        '',
        `kind of every offer: ${a.offerKind ?? 'none'}${a.offerKind === 'course' ? ' (DM rule 2 «كورسات», button GO_TO_COURSE_1: as today)' : ' (NOT course: the DM wording would change)'}`,
        `campaign seeds from the offers: ${campaignSeeds(a.plan.next).length}, ${seedsOk ? 'identical to the nine mappings the dashboard carried (keys, order, bytes)' : 'NOT the nine mappings'}`,
    );
    if (a.surface) {
        const s = a.surface;
        lines.push(`prompt surface, before against after: ${s.builders} builders · ${s.mismatches} differ · ${s.threw} threw · surface ${s.digest.a.slice(0, 16)} (after ${s.digest.b.slice(0, 16)})`);
    } else {
        lines.push('prompt surface: not compared');
    }
    lines.push('');
    if (a.status === 'unchanged') lines.push('verdict: NOTHING TO DO (the nine campaigns are already on his offers)');
    else if (a.status === 'ready') lines.push(`verdict: READY (${header.mode === 'apply' ? 'writing' : 'run again with --apply to write'} version ${a.version === null ? 2 : a.version + 1})`);
    else lines.push('verdict: REFUSED', ...a.reasons.map((r) => `  - ${r}`));
    return lines.join('\n');
}
