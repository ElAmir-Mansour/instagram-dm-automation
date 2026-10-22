/**
 * The Ads Manager's builder, as a pure function: a `CampaignSpec` (what the owner chose) in, the exact Marketing API parameters of every
 * object out (docs/specs/002-meta-ads-manager/contracts/meta-graph.md "Writes"). No database, no network: the server resolves everything
 * the spec only names (ids, the currency, the op tag, minted links) into a `SpecContext` first, so this file is testable by calling it.
 *
 * The server creates, in order, campaign → ad sets → creatives → ads, and each step needs the id of an earlier one. So the payloads come
 * as parts, and two helpers plug the ids in:
 *   const p = mapSpec(spec, ctx);
 *   POST campaigns   p.campaign
 *   POST adsets      adsetParams(p, i, campaignId)           one per spec.adsets[i]
 *   POST adcreatives p.creatives[j]                           one per spec.ads[j], in order
 *   POST ads         adParams(p, j, adsetIds[p.ads[j].adsetIndex], creativeIds[j])
 * `mapSpec(spec, ctx, campaignId)` also accepts the campaign id up front, for a caller that already has it.
 *
 * What is never left to a Meta default, because the default changes with the API version or spends money:
 *   - `status: 'PAUSED'` on EVERY object. Nothing here can start spending; Activate is a separate, deliberate step.
 *   - `special_ad_categories` (required; `[]` for none), `bid_strategy` (omitted means LOWEST_COST_WITH_BID_CAP on the campaign),
 *     `targeting_automation.advantage_audience` (0 or 1), and `degrees_of_freedom_spec` (the Advantage+ creative rewrites, opted out).
 *   - every name ends with the op tag `AR·<op id>`, so an object orphaned by a failed create can be found in Ads Manager.
 *
 * Not every mapping has been proved against Meta; each unproved one is marked `LIVE-CHECK` and is one constant to flip:
 *   - POST_GREETING_PLACEMENT   where the greeting (`page_welcome_message`) goes on a creative built from an existing POST. Meta documents
 *                               a place for it only under `link_data` / `video_data`, which a post creative does not have.
 *   - FB_POST_MESSENGER_OK      whether an `object_story_id` creative can carry a Messenger CTA (the Messenger page says no, the
 *                               Instagram page says yes). Until a live check says yes, a Facebook post is refused for message ads.
 *   - CREATIVE_OPT_OUTS         the `creative_features_spec` keys. An "unknown key" error from Meta (validate_only tells) means: remove
 *                               that key from the list. Nothing else changes.
 *
 * v1 Boost is a preset of this: `boostToSpec` turns a boost's inputs into a spec, and the tests compare what it produces with
 * `buildCampaignParams` / `buildAdSetParams` / `buildCreativeParams` in metaAds.ts.
 */
import { EU_COUNTRIES, graphTime, normaliseCountry, normaliseLink, toMinorUnits, type GraphParams } from '../metaAds.js';

// ─── The spec ─────────────────────────────────────────────────────────────────────────────

export type AdGoal = 'messages' | 'engagement' | 'reach' | 'traffic';
export type MessageDestination = 'instagram' | 'messenger' | 'whatsapp';
export type SpecialCategory = 'none' | 'employment' | 'financial' | 'housing' | 'political';

export interface CampaignSpec {
    name: string;
    /** 'leads' is part of the contract but refused until A10. */
    goal: AdGoal | 'leads';
    destinations?: MessageDestination[];
    specialCategory: SpecialCategory;
    /** `amount` is in MAJOR units (5 = 5 USD). With home 'adset' it is the budget of EACH ad set; with 'campaign' it is the one shared budget. */
    budget: { home: 'campaign' | 'adset'; kind: 'daily' | 'lifetime'; amount: number; start: string; end?: string };
    adsets: Array<{
        name: string;
        targeting: {
            countries: string[];
            cities?: Array<{ key: string; radiusKm: number }>;
            ageMin: number;
            ageMax?: number;
            genders?: Array<1 | 2>;
            locales?: number[];
            interests?: Array<{ id: string; name?: string }>;
            includeAudiences?: string[];
            excludeAudiences?: string[];
            advantageAudience: boolean;
        };
        placements: 'automatic' | { facebook?: string[]; instagram?: string[] };
        /** Reserved: A4 supports only each goal's own optimization goal, so a different value is refused rather than ignored. */
        optimization?: string;
    }>;
    ads: Array<{
        adsetIndex: number;
        name: string;
        creative: { source: 'post'; postId: string; platform: 'instagram' | 'facebook' }
            | { source: 'media'; mediaId: string; verticalMediaId?: string; coverMediaId?: string };
        /** For a post creative only `cta` (traffic) matters: the post carries its own caption. */
        copy: { primaryText: string; headline?: string; cta?: string };
        link?: { trackedOfferId: string } | { url: string };
        message?: { greeting: string; iceBreakers: Array<{ title: string; response?: string }> };
        offerId?: string;
    }>;
}

/** Everything the server resolved before mapping. */
export interface SpecContext {
    adAccountId: string;
    currency: string;
    pageId: string;
    igUserId: string | null;
    /** E.164 digits, or null when no WhatsApp Business number is linked to the Page. */
    whatsappPhone: string | null;
    /** `AR·<op id>`: every object name contains it. '' when the queue tags each create itself (drafts.ts). */
    opTag: string;
    /** Short id for `ref=ar_<refShort>`. */
    refShort: string;
    now: Date;
    /** By postId: the stored post. `mediaId` is the IG media id, or the Facebook `<page>_<post>` story id. */
    posts: Record<string, { platform: 'instagram' | 'facebook'; mediaId: string }>;
    /** By mediaId (A5 uploads). */
    media?: Record<string, { kind: 'image' | 'video'; imageHash?: string; videoId?: string; coverUrl?: string }>;
    /** trackedOfferId → the minted `<public base>/r/<code>` URL. */
    links?: Record<string, string>;
}

export interface SpecProblem { field: string; code: 'INVALID' | 'UNSUPPORTED'; message: string }

/** Thrown by `mapSpec` for what only the context can show is wrong (no WhatsApp number, a post that was not resolved). */
export class SpecError extends Error {
    constructor(readonly code: SpecProblem['code'], readonly field: string, message: string) {
        super(message);
        this.name = 'SpecError';
    }
}

export interface AdPayload {
    /** Which ad set (an index into `adsets`) this ad belongs in: the server maps it to that ad set's id. */
    adsetIndex: number;
    /** `name` and `status`; `adset_id` and `creative` are added by `adParams` once the ids exist. */
    params: GraphParams;
}

export interface SpecPayloads {
    campaign: GraphParams;
    /** Same order as `spec.adsets`. Without `campaign_id` unless `mapSpec` was given one: use `adsetParams`. */
    adsets: GraphParams[];
    /** Same order as `spec.ads`. */
    creatives: GraphParams[];
    /** Same order as `spec.ads`. */
    ads: AdPayload[];
    warnings: Array<{ code: 'UNTRACKED_LINK' | 'NO_GREETING_ON_POST'; field: string; message: string }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────────────────

/**
 * LIVE-CHECK (T094 / R11). Meta documents `page_welcome_message` only under `link_data` / `video_data`. A creative built from an existing
 * post has neither, so 'cta_value' tries it inside the call to action's `value` (unverified). If validate_only refuses it, change this to
 * 'omit': the ad then runs with Meta's default greeting and the mapping adds the warning NO_GREETING_ON_POST.
 */
export const POST_GREETING_PLACEMENT = 'cta_value' as const;

/**
 * LIVE-CHECK (T094). The Messenger CTM page says creatives made with `object_story_id` are not supported; the Instagram and boost pages
 * say a Facebook post can carry a message CTA. Until a live check settles it, a Facebook post is refused for message ads.
 */
export const FB_POST_MESSENGER_OK = false;

/**
 * The Advantage+ creative features that rewrite the owner's text or image, each sent as an explicit OPT_OUT: Arabic copy in فصحى, the
 * brand's no-women-images rule and the owner's exact wording must not be changed by Meta. `standard_enhancements` is NOT here: that
 * bundle is dead since v22. LIVE-CHECK: if Meta answers "unknown key" for one of these, delete it from this list (validate_only shows it).
 */
export const CREATIVE_OPT_OUTS = [
    'text_optimizations', 'image_touchups', 'image_brightness_and_contrast', 'image_uncrop', 'image_templates', 'enhance_cta', 'video_auto_crop',
    'inline_comment', 'description_automation', 'text_generation', 'image_background_gen', 'add_text_overlay', 'music', 'product_extensions',
    'site_extensions', 'ig_video_native_subtitle', 'reveal_details_over_time', 'carousel_to_video', 'profile_card', 'show_summary',
    'show_destination_blurbs',
] as const;

const SPECIAL_CATEGORY: Record<SpecialCategory, string[]> = {
    none: [],
    employment: ['EMPLOYMENT'],
    financial: ['FINANCIAL_PRODUCTS_SERVICES'],
    housing: ['HOUSING'],
    political: ['ISSUES_ELECTIONS_POLITICS'],
};

const CAMPAIGN_OBJECTIVE: Record<AdGoal, string> = {
    messages: 'OUTCOME_ENGAGEMENT',
    engagement: 'OUTCOME_ENGAGEMENT',
    reach: 'OUTCOME_AWARENESS',
    traffic: 'OUTCOME_TRAFFIC',
};

const OPTIMIZATION_GOAL: Record<AdGoal, string> = {
    messages: 'CONVERSATIONS',
    engagement: 'POST_ENGAGEMENT',
    reach: 'REACH',
    traffic: 'LINK_CLICKS',
};

/** The one canonical order: the order of the destination in a multi value, and of the CTAs in the feed. */
const DESTINATION_ORDER: readonly MessageDestination[] = ['instagram', 'messenger', 'whatsapp'];

const SINGLE_DESTINATION_TYPE: Record<MessageDestination, string> = { instagram: 'INSTAGRAM_DIRECT', messenger: 'MESSENGER', whatsapp: 'WHATSAPP' };

const MULTI_DESTINATION_TYPE: Record<string, string> = {
    'instagram,messenger,whatsapp': 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER_WHATSAPP',
    'instagram,messenger': 'MESSAGING_INSTAGRAM_DIRECT_MESSENGER',
    'messenger,whatsapp': 'MESSAGING_MESSENGER_WHATSAPP',
    'instagram,whatsapp': 'MESSAGING_INSTAGRAM_DIRECT_WHATSAPP',
};

const CTA_BY_DESTINATION: Record<MessageDestination, { type: string; app_destination: string; link: string }> = {
    instagram: { type: 'INSTAGRAM_MESSAGE', app_destination: 'INSTAGRAM_DIRECT', link: 'https://www.instagram.com' },
    messenger: { type: 'MESSAGE_PAGE', app_destination: 'MESSENGER', link: 'https://fb.com/messenger_doc/' },
    whatsapp: { type: 'WHATSAPP_MESSAGE', app_destination: 'WHATSAPP', link: 'https://api.whatsapp.com/send' },
};

const LIMITS = {
    greeting: 300, iceBreakerTitle: 80, iceBreakerResponse: 300, iceBreakers: 4,
    name: 200, primaryText: 2200, headline: 255, budgetDaysMax: 90,
    cityRadiusMin: 17, cityRadiusMax: 80, specialCityRadiusMin: 25, ageMin: 13, ageMax: 65, locales: 50, audiences: 20,
} as const;

const DAY_MS = 86_400_000;

/** The Messenger/WhatsApp/Instagram `destination_type` for a set of destinations, in any order. Null when the set has none. */
export function messageDestinationType(destinations: readonly MessageDestination[]): string | null {
    const ordered = DESTINATION_ORDER.filter(d => destinations.includes(d));
    if (ordered.length === 0) return null;
    if (ordered.length === 1) return SINGLE_DESTINATION_TYPE[ordered[0]!];
    return MULTI_DESTINATION_TYPE[ordered.join(',')] ?? null;
}

// ─── validateSpec ─────────────────────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Everything about a spec that can be said without the context. Never throws; `spec` comes back normalised (countries upper-cased). */
export function validateSpec(input: unknown): { ok: true; spec: CampaignSpec } | { ok: false; problems: SpecProblem[] } {
    const problems: SpecProblem[] = [];
    const bad = (field: string, message: string, code: SpecProblem['code'] = 'INVALID'): void => { problems.push({ field, code, message }); };
    if (!isRec(input)) {
        return { ok: false, problems: [{ field: 'spec', code: 'INVALID', message: 'The campaign must be an object.' }] };
    }
    const spec = structuredClone(input);

    if (!isText(spec['name']) || spec['name'].length > LIMITS.name) bad('name', `The campaign needs a name of at most ${LIMITS.name} characters.`);

    // goal
    const goalRaw = spec['goal'];
    let goal: AdGoal | null = null;
    if (goalRaw === 'leads') bad('goal', 'Lead ads come later (A10).', 'UNSUPPORTED');
    else if (goalRaw === 'messages' || goalRaw === 'engagement' || goalRaw === 'reach' || goalRaw === 'traffic') goal = goalRaw;
    else bad('goal', 'The goal must be messages, engagement, reach or traffic.');

    const category = spec['specialCategory'];
    const categoryOk = typeof category === 'string' && Object.prototype.hasOwnProperty.call(SPECIAL_CATEGORY, category);
    if (!categoryOk) bad('specialCategory', 'The special ad category must be none, employment, financial, housing or political.');
    const special = categoryOk && category !== 'none';

    // destinations (messages only)
    let destinations: MessageDestination[] = [];
    if (goal === 'messages') {
        const raw = spec['destinations'];
        if (!Array.isArray(raw) || raw.length === 0) bad('destinations', 'Choose at least one place for the messages: Instagram, Messenger or WhatsApp.');
        else if (!raw.every(d => d === 'instagram' || d === 'messenger' || d === 'whatsapp')) bad('destinations', 'A destination must be instagram, messenger or whatsapp.');
        else if (new Set(raw).size !== raw.length) bad('destinations', 'A destination can be chosen only once.');
        else {
            destinations = raw as MessageDestination[];
            if (destinations.length > 1 && special) bad('destinations', 'An ad with several message destinations cannot have a special ad category.', 'UNSUPPORTED');
        }
    }

    // budget
    const budget = spec['budget'];
    if (!isRec(budget)) bad('budget', 'The budget is missing.');
    else {
        if (budget['home'] !== 'campaign' && budget['home'] !== 'adset') bad('budget.home', 'The budget lives on the campaign or on the ad set.');
        if (budget['kind'] !== 'daily' && budget['kind'] !== 'lifetime') bad('budget.kind', 'The budget is daily or lifetime.');
        if (!isNum(budget['amount']) || budget['amount'] <= 0) bad('budget.amount', 'The budget amount must be a number above zero.');
        const start = typeof budget['start'] === 'string' ? new Date(budget['start']) : null;
        if (!start || Number.isNaN(start.getTime())) bad('budget.start', 'The start must be a date and time.');
        else {
            const endRaw = budget['end'];
            const end = typeof endRaw === 'string' ? new Date(endRaw) : null;
            if (endRaw !== undefined && endRaw !== null && (!end || Number.isNaN(end.getTime()))) bad('budget.end', 'The end must be a date and time.');
            else if (end) {
                const span = end.getTime() - start.getTime();
                if (span <= 0) bad('budget.end', 'The end must be after the start.');
                else if (span > LIMITS.budgetDaysMax * DAY_MS) bad('budget.end', `A campaign can run at most ${LIMITS.budgetDaysMax} days.`);
                else if (budget['kind'] === 'daily' && span < DAY_MS) bad('budget.end', 'A daily budget needs a window longer than 24 hours.');
            } else if (budget['kind'] === 'lifetime') bad('budget.end', 'A lifetime budget needs an end.');
        }
    }

    // ad sets
    const adsets = spec['adsets'];
    if (!Array.isArray(adsets) || adsets.length === 0 || adsets.length > 10) bad('adsets', 'A campaign needs between 1 and 10 ad sets.');
    else {
        adsets.forEach((raw, i) => {
            const at = `adsets.${i}`;
            if (!isRec(raw)) { bad(at, 'The ad set must be an object.'); return; }
            if (!isText(raw['name']) || raw['name'].length > LIMITS.name) bad(`${at}.name`, 'The ad set needs a name.');
            if (raw['optimization'] !== undefined && goal && raw['optimization'] !== OPTIMIZATION_GOAL[goal]) {
                bad(`${at}.optimization`, `This goal optimises for ${OPTIMIZATION_GOAL[goal]} only.`, 'UNSUPPORTED');
            }
            validatePlacements(raw['placements'], `${at}.placements`, bad);
            const t = raw['targeting'];
            if (!isRec(t)) { bad(`${at}.targeting`, 'The targeting is missing.'); return; }
            validateTargeting(t, `${at}.targeting`, special, bad);
        });
    }

    // ads
    const ads = spec['ads'];
    if (!Array.isArray(ads) || ads.length === 0 || ads.length > 30) bad('ads', 'A campaign needs between 1 and 30 ads.');
    else {
        ads.forEach((raw, i) => {
            const at = `ads.${i}`;
            if (!isRec(raw)) { bad(at, 'The ad must be an object.'); return; }
            if (!isText(raw['name']) || raw['name'].length > LIMITS.name) bad(`${at}.name`, 'The ad needs a name.');
            const index = raw['adsetIndex'];
            if (!isInt(index) || index < 0 || (Array.isArray(adsets) && index >= adsets.length)) bad(`${at}.adsetIndex`, 'The ad must belong to one of the ad sets.');
            validateCreative(raw, at, goal, bad);
            validateCopy(raw['copy'], `${at}.copy`, bad);
            if (goal === 'traffic') validateLink(raw['link'], `${at}.link`, bad);
            if (goal === 'messages' && raw['message'] !== undefined) validateMessage(raw['message'], `${at}.message`, bad);
        });
    }

    if (problems.length > 0) return { ok: false, problems };

    // Normalise what is only a spelling: countries come back upper-case and trimmed.
    for (const adset of spec['adsets'] as Rec[]) {
        const t = adset['targeting'] as Rec;
        t['countries'] = (t['countries'] as unknown[]).map(c => normaliseCountry(c) as string);
    }
    return { ok: true, spec: spec as unknown as CampaignSpec };
}

type Bad = (field: string, message: string, code?: SpecProblem['code']) => void;

function validatePlacements(raw: unknown, at: string, bad: Bad): void {
    if (raw === 'automatic') return;
    if (!isRec(raw)) { bad(at, 'Placements are "automatic" or a list per platform.'); return; }
    let any = false;
    for (const platform of ['facebook', 'instagram']) {
        const list = raw[platform];
        if (list === undefined) continue;
        if (!Array.isArray(list) || !list.every(p => typeof p === 'string' && /^[a-z_]{2,40}$/.test(p))) { bad(`${at}.${platform}`, 'Positions are lower-case names.'); return; }
        if (list.length > 0) any = true;
    }
    if (!any) bad(at, 'Choose at least one placement, or use automatic.');
}

function validateTargeting(t: Rec, at: string, special: boolean, bad: Bad): void {
    // Countries: ISO codes, none in the EU (the DSA payor and beneficiary are not collected).
    const countries = t['countries'];
    if (!Array.isArray(countries) || countries.length === 0 || countries.length > 25) bad(`${at}.countries`, 'Choose between 1 and 25 countries.');
    else {
        const codes = countries.map(normaliseCountry);
        if (codes.some(c => c === null)) bad(`${at}.countries`, 'A country must be a two-letter ISO code.');
        else if (codes.some(c => EU_COUNTRIES.has(c as string))) {
            bad(`${at}.countries`, 'Ads in EU countries need the payer and beneficiary under the EU Digital Services Act, which are not collected yet.', 'UNSUPPORTED');
        }
    }

    const cities = t['cities'];
    if (cities !== undefined) {
        if (!Array.isArray(cities) || cities.length > 50) bad(`${at}.cities`, 'Cities are a list of at most 50.');
        else cities.forEach((c, i) => {
            if (!isRec(c) || !isText(c['key'])) { bad(`${at}.cities.${i}`, 'A city needs a key.'); return; }
            const r = c['radiusKm'];
            if (!isNum(r) || r < LIMITS.cityRadiusMin || r > LIMITS.cityRadiusMax) bad(`${at}.cities.${i}.radiusKm`, `The radius is ${LIMITS.cityRadiusMin} to ${LIMITS.cityRadiusMax} km.`);
            else if (special && r < LIMITS.specialCityRadiusMin) bad(`${at}.cities.${i}.radiusKm`, `A special ad category needs a radius of ${LIMITS.specialCityRadiusMin} km or more.`);
        });
    }

    const ageMin = t['ageMin'];
    const ageMax = t['ageMax'];
    const ageMinOk = isInt(ageMin) && ageMin >= LIMITS.ageMin && ageMin <= LIMITS.ageMax;
    if (!ageMinOk) bad(`${at}.ageMin`, `The minimum age is a whole number from ${LIMITS.ageMin} to ${LIMITS.ageMax}.`);
    const ageMaxOk = ageMax === undefined || (isInt(ageMax) && ageMax >= LIMITS.ageMin && ageMax <= LIMITS.ageMax && (!ageMinOk || ageMax >= (ageMin as number)));
    if (!ageMaxOk) bad(`${at}.ageMax`, 'The maximum age is a whole number, not below the minimum, up to 65.');

    const advantage = t['advantageAudience'];
    if (typeof advantage !== 'boolean') bad(`${at}.advantageAudience`, 'advantageAudience must be true or false.');
    else if (advantage && ageMinOk && ageMaxOk) {
        // Advantage+ audience treats the age as a suggestion: Meta needs the minimum at 25 or under and no maximum.
        if ((ageMin as number) < 18 || (ageMin as number) > 25) bad(`${at}.ageMin`, 'With Advantage+ audience the minimum age is 18 to 25.');
        else if (ageMax !== undefined) bad(`${at}.ageMax`, 'With Advantage+ audience there is no maximum age.');
    }
    if (special) {
        // Employment, financial and housing ads may not target by age, gender or exclusions.
        if (ageMinOk && ageMin !== 18) bad(`${at}.ageMin`, 'A special ad category targets 18 and over.');
        if (ageMaxOk && ageMax !== undefined && ageMax !== 65) bad(`${at}.ageMax`, 'A special ad category targets every age up to 65+.');
        if (Array.isArray(t['genders']) && t['genders'].length > 0) bad(`${at}.genders`, 'A special ad category cannot target by gender.');
        if (Array.isArray(t['excludeAudiences']) && t['excludeAudiences'].length > 0) bad(`${at}.excludeAudiences`, 'A special ad category cannot exclude audiences.');
    }

    const genders = t['genders'];
    if (genders !== undefined && (!Array.isArray(genders) || genders.length > 2 || !genders.every(g => g === 1 || g === 2))) bad(`${at}.genders`, 'Genders are 1 (men) and 2 (women).');
    const locales = t['locales'];
    if (locales !== undefined && (!Array.isArray(locales) || locales.length > LIMITS.locales || !locales.every(isInt))) bad(`${at}.locales`, `Locales are up to ${LIMITS.locales} ids.`);
    const interests = t['interests'];
    if (interests !== undefined && (!Array.isArray(interests) || interests.length > 50 || !interests.every(x => isRec(x) && isText(x['id'])))) bad(`${at}.interests`, 'Interests need an id.');
    for (const key of ['includeAudiences', 'excludeAudiences']) {
        const list = t[key];
        if (list !== undefined && (!Array.isArray(list) || list.length > LIMITS.audiences || !list.every(isText))) bad(`${at}.${key}`, 'Audiences are ids.');
    }
}

function validateCreative(ad: Rec, at: string, goal: AdGoal | null, bad: Bad): void {
    const c = ad['creative'];
    if (!isRec(c)) { bad(`${at}.creative`, 'The ad needs a creative.'); return; }
    if (c['source'] === 'post') {
        if (!isText(c['postId'])) { bad(`${at}.creative.postId`, 'Choose a post.'); return; }
        if (c['platform'] !== 'instagram' && c['platform'] !== 'facebook') { bad(`${at}.creative.platform`, 'The post is on instagram or facebook.'); return; }
        if (c['platform'] === 'facebook' && goal === 'messages' && !FB_POST_MESSENGER_OK) {
            bad(`${at}.creative`, "A Facebook post can't be used for a Messenger message ad yet; use the Instagram copy of the reel.", 'UNSUPPORTED');
        }
        if (c['platform'] === 'facebook' && goal === 'traffic') {
            bad(`${at}.creative`, 'Link clicks is for Instagram posts. A Facebook post is boosted with its own link: choose Engagement or Reach.', 'UNSUPPORTED');
        }
    } else if (c['source'] === 'media') {
        if (!isText(c['mediaId'])) { bad(`${at}.creative.mediaId`, 'Choose an image or a video.'); return; }
        for (const key of ['verticalMediaId', 'coverMediaId']) if (c[key] !== undefined && !isText(c[key])) bad(`${at}.creative.${key}`, 'A media id is text.');
        // An uploaded ad is built as link_data / video_data, which has a place for a message CTA or a link: engagement and reach have neither.
        if (goal === 'engagement' || goal === 'reach') bad(`${at}.creative`, 'An uploaded image or video can be used for messages or link clicks. Engagement and reach use an existing post.', 'UNSUPPORTED');
    } else bad(`${at}.creative.source`, 'The creative is a post or uploaded media.');
}

function validateCopy(raw: unknown, at: string, bad: Bad): void {
    if (!isRec(raw)) { bad(at, 'The ad needs its copy.'); return; }
    if (typeof raw['primaryText'] !== 'string' || raw['primaryText'].length > LIMITS.primaryText) bad(`${at}.primaryText`, `The text is at most ${LIMITS.primaryText} characters.`);
    if (raw['headline'] !== undefined && (typeof raw['headline'] !== 'string' || raw['headline'].length > LIMITS.headline)) bad(`${at}.headline`, `The headline is at most ${LIMITS.headline} characters.`);
    if (raw['cta'] !== undefined && (typeof raw['cta'] !== 'string' || !/^[A-Z_]{2,40}$/.test(raw['cta']))) bad(`${at}.cta`, 'The button is a Meta call-to-action type, like LEARN_MORE.');
}

function validateLink(raw: unknown, at: string, bad: Bad): void {
    if (!isRec(raw)) { bad(at, 'Link-click ads need a link.'); return; }
    if ('trackedOfferId' in raw) { if (!isText(raw['trackedOfferId'])) bad(`${at}.trackedOfferId`, 'Choose one of your offers.'); return; }
    if (normaliseLink(raw['url']) === null) bad(`${at}.url`, 'The link must be an https address.');
}

function validateMessage(raw: unknown, at: string, bad: Bad): void {
    if (!isRec(raw)) { bad(at, 'The message settings must be an object.'); return; }
    const greeting = raw['greeting'];
    if (!isText(greeting) || greeting.length > LIMITS.greeting) bad(`${at}.greeting`, `The greeting is 1 to ${LIMITS.greeting} characters.`);
    const breakers = raw['iceBreakers'];
    if (!Array.isArray(breakers) || breakers.length > LIMITS.iceBreakers) { bad(`${at}.iceBreakers`, `At most ${LIMITS.iceBreakers} ice breakers.`); return; }
    breakers.forEach((b, i) => {
        if (!isRec(b)) { bad(`${at}.iceBreakers.${i}`, 'An ice breaker needs a title.'); return; }
        if (!isText(b['title']) || b['title'].length > LIMITS.iceBreakerTitle) bad(`${at}.iceBreakers.${i}.title`, `The title is 1 to ${LIMITS.iceBreakerTitle} characters.`);
        const response = b['response'];
        if (response !== undefined && (typeof response !== 'string' || response.length > LIMITS.iceBreakerResponse)) bad(`${at}.iceBreakers.${i}.response`, `The response is at most ${LIMITS.iceBreakerResponse} characters.`);
    });
}

// ─── mapSpec ──────────────────────────────────────────────────────────────────────────────

/**
 * The parameters of every object. Runs `validateSpec` first and throws its first problem as a `SpecError`, so a spec that gets this far is
 * sound; then throws for what only the context can show. Never calls Meta.
 */
export function mapSpec(input: CampaignSpec, ctx: SpecContext, campaignId?: string): SpecPayloads {
    const checked = validateSpec(input);
    if (!checked.ok) { const first = checked.problems[0]!; throw new SpecError(first.code, first.field, first.message); }
    const spec = checked.spec;
    const goal = spec.goal as AdGoal;
    const destinations = goal === 'messages' ? DESTINATION_ORDER.filter(d => spec.destinations!.includes(d)) : [];
    const warnings: SpecPayloads['warnings'] = [];

    if (destinations.includes('whatsapp') && !ctx.whatsappPhone) {
        throw new SpecError('UNSUPPORTED', 'destinations', 'WhatsApp needs a WhatsApp Business number linked to the Page');
    }
    if (destinations.includes('instagram') && !ctx.igUserId) {
        throw new SpecError('UNSUPPORTED', 'destinations', 'Instagram messages need the Instagram account connected to the Page');
    }

    // An empty tag leaves the name as it is: the queue (ops.ts `taggedParams`) adds `AR·<op id>` to every create when it sends it, and the
    // op id is only known once the op exists.
    const opName = (name: string): string => (ctx.opTag ? `${name.trim()} · ${ctx.opTag}` : name.trim());
    const start = graphTime(new Date(spec.budget.start));
    const end = spec.budget.end ? graphTime(new Date(spec.budget.end)) : null;
    const budgetKey = spec.budget.kind === 'daily' ? 'daily_budget' : 'lifetime_budget';
    const budgetValue = toMinorUnits(spec.budget.amount, ctx.currency);
    const cboHome = spec.budget.home === 'campaign';

    // Campaign.
    const campaign: GraphParams = {
        name: opName(spec.name),
        objective: CAMPAIGN_OBJECTIVE[goal],
        status: 'PAUSED',
        buying_type: 'AUCTION',
        special_ad_categories: [...SPECIAL_CATEGORY[spec.specialCategory]],
    };
    if (cboHome) {
        // Advantage+ campaign budget: the bid strategy belongs on the campaign, and the budget is the campaign's.
        campaign['bid_strategy'] = 'LOWEST_COST_WITHOUT_CAP';
        campaign[budgetKey] = budgetValue;
        if (spec.budget.kind === 'lifetime' && end) campaign['stop_time'] = end;
    } else {
        // No campaign budget: each ad set holds it. Meta requires this to be said explicitly for such a campaign since v24.
        campaign['is_adset_budget_sharing_enabled'] = false;
    }

    // Ad sets.
    const adsets = spec.adsets.map((adset, i): GraphParams => {
        const params: GraphParams = {
            name: opName(adset.name),
            status: 'PAUSED',
            billing_event: 'IMPRESSIONS',
            optimization_goal: OPTIMIZATION_GOAL[goal],
            start_time: start,
            targeting: buildTargeting(adset, platformOfAdset(spec, ctx, i)),
        };
        if (campaignId) params['campaign_id'] = campaignId;
        if (end) params['end_time'] = end;
        if (!cboHome) {
            params[budgetKey] = budgetValue;
            params['bid_strategy'] = 'LOWEST_COST_WITHOUT_CAP';
        }
        if (goal === 'messages') {
            params['destination_type'] = messageDestinationType(destinations)!;
            const promoted: GraphParams = { page_id: ctx.pageId };
            if (destinations.includes('whatsapp')) promoted['whatsapp_phone_number'] = ctx.whatsappPhone!;
            params['promoted_object'] = promoted;
        } else if (goal === 'engagement') {
            params['destination_type'] = 'ON_POST';
        } else if (goal === 'reach') {
            params['promoted_object'] = { page_id: ctx.pageId };
        }
        // Traffic sends no destination_type (as v1): Meta's ODAX table lists none for Traffic. The link is the creative's call to action.
        return params;
    });

    // Creatives and ads.
    const creatives: GraphParams[] = [];
    const ads: AdPayload[] = [];
    spec.ads.forEach((ad, i) => {
        creatives.push(buildCreative(ad, i, goal, destinations, ctx, opName, warnings));
        ads.push({ adsetIndex: ad.adsetIndex, params: { name: opName(ad.name), status: 'PAUSED' } });
    });

    return { campaign, adsets, creatives, ads, warnings };
}

/** The ad set's parameters with its campaign id. */
export function adsetParams(payloads: SpecPayloads, index: number, campaignId: string): GraphParams {
    return { ...payloads.adsets[index]!, campaign_id: campaignId };
}

/** The ad's parameters with the ids of its ad set and creative. */
export function adParams(payloads: SpecPayloads, index: number, adsetId: string, creativeId: string): GraphParams {
    return { ...payloads.ads[index]!.params, adset_id: adsetId, creative: { creative_id: creativeId } };
}

/**
 * The platform an ad set is tied to: when EVERY ad in it is a post creative on one platform, that platform (v1 behaviour: boosting an
 * Instagram post runs on Instagram only). Null for media ads, mixed ads, or an ad set with no ads.
 */
function platformOfAdset(spec: CampaignSpec, ctx: SpecContext, index: number): 'instagram' | 'facebook' | null {
    const mine = spec.ads.filter(a => a.adsetIndex === index);
    if (mine.length === 0) return null;
    const platforms = new Set<string>();
    for (const a of mine) {
        if (a.creative.source !== 'post') return null;
        platforms.add(ctx.posts[a.creative.postId]?.platform ?? a.creative.platform);
    }
    return platforms.size === 1 ? ([...platforms][0] as 'instagram' | 'facebook') : null;
}

function buildTargeting(adset: CampaignSpec['adsets'][number], postPlatform: 'instagram' | 'facebook' | null): GraphParams {
    const t = adset.targeting;
    // With cities, the cities alone: Meta takes the UNION of countries and cities, which would target the whole country.
    // (`countries` stays required in the spec: the EU check and the report read it.)
    const geo: GraphParams = t.cities && t.cities.length > 0
        ? { cities: t.cities.map(c => ({ key: c.key, radius: c.radiusKm, distance_unit: 'kilometer' })) }
        : { countries: [...t.countries] };
    const targeting: GraphParams = {
        geo_locations: geo,
        age_min: t.ageMin,
        // Said explicitly: from v26 Meta requires it in some ad sets, and a default changes with the version.
        targeting_automation: { advantage_audience: t.advantageAudience ? 1 : 0 },
    };
    // With Advantage+ audience the age is a suggestion and a maximum is not allowed (validateSpec refuses one); never send it.
    if (!t.advantageAudience && t.ageMax !== undefined) targeting['age_max'] = t.ageMax;
    if (t.genders && t.genders.length > 0) targeting['genders'] = [...t.genders];
    if (t.locales && t.locales.length > 0) targeting['locales'] = [...t.locales];
    if (t.interests && t.interests.length > 0) targeting['flexible_spec'] = [{ interests: t.interests.map(x => (x.name ? { id: x.id, name: x.name } : { id: x.id })) }];
    if (t.includeAudiences && t.includeAudiences.length > 0) targeting['custom_audiences'] = t.includeAudiences.map(id => ({ id }));
    if (t.excludeAudiences && t.excludeAudiences.length > 0) targeting['excluded_custom_audiences'] = t.excludeAudiences.map(id => ({ id }));

    if (adset.placements === 'automatic') {
        // A post creative runs on its own platform (v1: an Instagram boost is Instagram only). Otherwise no placement keys: Advantage+ placements.
        if (postPlatform) targeting['publisher_platforms'] = [postPlatform];
    } else {
        const platforms: string[] = [];
        if (adset.placements.facebook && adset.placements.facebook.length > 0) { platforms.push('facebook'); targeting['facebook_positions'] = [...adset.placements.facebook]; }
        if (adset.placements.instagram && adset.placements.instagram.length > 0) { platforms.push('instagram'); targeting['instagram_positions'] = [...adset.placements.instagram]; }
        targeting['publisher_platforms'] = platforms;
    }
    return targeting;
}

// ─── Creatives ────────────────────────────────────────────────────────────────────────────

function creativeFeatures(): GraphParams {
    const features: Record<string, { enroll_status: string }> = {};
    for (const key of CREATIVE_OPT_OUTS) features[key] = { enroll_status: 'OPT_OUT' };
    features['adapt_to_placement'] = { enroll_status: 'OPT_IN' };
    return { creative_features_spec: features };
}

type MessageSettings = NonNullable<CampaignSpec['ads'][number]['message']>;

function welcomeMessage(message: MessageSettings): GraphParams {
    return {
        type: 'VISUAL_EDITOR',
        version: 2,
        landing_screen_type: 'welcome_message',
        media_type: 'text',
        text_format: {
            customer_action_type: 'ice_breakers',
            message: {
                text: message.greeting,
                ice_breakers: message.iceBreakers.map(b => (b.response ? { title: b.title, response: b.response } : { title: b.title })),
            },
        },
    };
}

function messageCta(destination: MessageDestination, welcome?: GraphParams): GraphParams {
    const cta = CTA_BY_DESTINATION[destination];
    const value: GraphParams = { app_destination: cta.app_destination, link: cta.link };
    if (welcome) value['page_welcome_message'] = welcome;
    return { type: cta.type, value };
}

function buildCreative(
    ad: CampaignSpec['ads'][number], index: number, goal: AdGoal, destinations: MessageDestination[], ctx: SpecContext,
    opName: (name: string) => string, warnings: SpecPayloads['warnings'],
): GraphParams {
    const at = `ads.${index}`;
    const creative: GraphParams = { name: opName(ad.name) };

    // The link or button of a traffic ad.
    let link: string | null = null;
    if (goal === 'traffic') {
        const l = ad.link!;
        if ('trackedOfferId' in l) {
            const minted = ctx.links?.[l.trackedOfferId];
            if (!minted) throw new SpecError('INVALID', `${at}.link.trackedOfferId`, 'That offer has no tracked link yet.');
            link = minted;
        } else {
            link = normaliseLink(l.url)!;
            warnings.push({ code: 'UNTRACKED_LINK', field: `${at}.link`, message: 'Clicks on this link will not be counted; pick one of your offers to count them.' });
        }
    }
    const trafficCta = (): GraphParams => ({ type: ad.copy.cta ?? 'LEARN_MORE', value: { link: link! } });

    const message = goal === 'messages' ? ad.message : undefined;
    const welcome = message ? welcomeMessage(message) : undefined;
    const multi = destinations.length > 1;

    if (ad.creative.source === 'post') {
        const post = ctx.posts[ad.creative.postId];
        if (!post) throw new SpecError('INVALID', `${at}.creative.postId`, 'That post was not found.');
        if (post.platform !== ad.creative.platform) throw new SpecError('INVALID', `${at}.creative.platform`, 'The post is on a different platform than the ad says.');
        if (post.platform === 'instagram') {
            if (!ctx.igUserId) throw new SpecError('INVALID', `${at}.creative`, 'An Instagram post needs the Instagram account id.');
            // Instagram: object_id=<page>, instagram_user_id, source_instagram_media_id. (`instagram_actor_id` and `instagram_story_id` are the old names.)
            creative['object_id'] = ctx.pageId;
            creative['instagram_user_id'] = ctx.igUserId;
            creative['source_instagram_media_id'] = post.mediaId;
        } else {
            // A Facebook post is promoted as it stands: its own link (if any) is the destination.
            creative['object_story_id'] = post.mediaId;
        }
        if (goal === 'messages') {
            // LIVE-CHECK (T094/R11): see POST_GREETING_PLACEMENT.
            const placement: 'cta_value' | 'omit' = POST_GREETING_PLACEMENT as 'cta_value' | 'omit';
            const inCta = placement === 'cta_value' ? welcome : undefined;
            if (welcome && placement === 'omit') {
                warnings.push({ code: 'NO_GREETING_ON_POST', field: `${at}.message`, message: 'A boosted post cannot carry its own greeting; Meta will show its default greeting.' });
            }
            if (multi) creative['asset_feed_spec'] = messagingFeed(destinations, inCta);
            else creative['call_to_action'] = messageCta(destinations[0]!, inCta);
        } else if (goal === 'traffic') {
            creative['call_to_action'] = trafficCta();
        }
    } else {
        const media = ctx.media?.[ad.creative.mediaId];
        if (!media) throw new SpecError('INVALID', `${at}.creative.mediaId`, 'That image or video was not found.');
        // `link` is required in link_data; a message ad has none, so it carries the destination's own CTA link.
        const pageLink = goal === 'messages' ? CTA_BY_DESTINATION[destinations[0]!].link : link!;
        const singleCta = goal === 'messages' ? (multi ? undefined : messageCta(destinations[0]!)) : trafficCta();
        const story: GraphParams = { page_id: ctx.pageId };
        if (ctx.igUserId) story['instagram_user_id'] = ctx.igUserId;
        if (media.kind === 'image') {
            if (!media.imageHash) throw new SpecError('INVALID', `${at}.creative.mediaId`, 'That image has not been uploaded to Meta yet.');
            const data: GraphParams = { image_hash: media.imageHash, link: pageLink, message: ad.copy.primaryText };
            if (ad.copy.headline) data['name'] = ad.copy.headline;
            if (singleCta) data['call_to_action'] = singleCta;
            if (welcome) data['page_welcome_message'] = welcome;
            story['link_data'] = data;
        } else {
            if (!media.videoId) throw new SpecError('INVALID', `${at}.creative.mediaId`, 'That video has not been uploaded to Meta yet.');
            const cover = media.coverUrl ?? (ad.creative.coverMediaId ? ctx.media?.[ad.creative.coverMediaId]?.coverUrl : undefined);
            // Always a cover: frame 0 of a video is black.
            if (!cover) throw new SpecError('INVALID', `${at}.creative.coverMediaId`, 'A video needs a cover image.');
            const data: GraphParams = { video_id: media.videoId, image_url: cover, message: ad.copy.primaryText };
            if (ad.copy.headline) data['title'] = ad.copy.headline;
            if (singleCta) data['call_to_action'] = singleCta;
            if (welcome) data['page_welcome_message'] = welcome;
            story['video_data'] = data;
        }
        creative['object_story_spec'] = story;
        if (goal === 'messages' && multi) creative['asset_feed_spec'] = messagingFeed(destinations);
        // `verticalMediaId` (a 9:16 version for Stories and Reels) is A5's placement customisation: not mapped here.
    }

    if (goal === 'messages' || goal === 'traffic') {
        // The ad's `ref`. Meta's referral carries `ref` only when one was set on the ad, so it goes in as url_tags; A3 joins a conversation
        // to its ad by `ad_id` whether or not the `ref` arrives.
        creative['url_tags'] = `ref=ar_${ctx.refShort}`;
    }
    creative['degrees_of_freedom_spec'] = creativeFeatures();
    return creative;
}

function messagingFeed(destinations: MessageDestination[], welcome?: GraphParams): GraphParams {
    return { optimization_type: 'DOF_MESSAGING_DESTINATION', call_to_actions: destinations.map(d => messageCta(d, welcome)) };
}

// ─── Boost as a preset ────────────────────────────────────────────────────────────────────

/**
 * The v1 Boost (one post, one country, a daily budget for some days) as a spec. The budget is LIFETIME, daily × days, on the ad set: Meta
 * may spend up to 75% over a DAILY budget on a given day, never over a lifetime budget, so the planned total stays a ceiling.
 */
export function boostToSpec(input: {
    postId: string; platform: 'instagram' | 'facebook'; dailyBudget: number; days: number;
    objective: 'ENGAGEMENT' | 'AWARENESS' | 'TRAFFIC' | 'MESSAGES'; country: string; link?: string;
    destinations?: MessageDestination[]; greeting?: string; iceBreakers?: Array<{ title: string; response?: string }>;
}, now: Date): CampaignSpec {
    const goal: AdGoal = ({ ENGAGEMENT: 'engagement', AWARENESS: 'reach', TRAFFIC: 'traffic', MESSAGES: 'messages' } as const)[input.objective];
    const end = new Date(now.getTime() + input.days * DAY_MS);
    const ad: CampaignSpec['ads'][number] = {
        adsetIndex: 0,
        name: `${input.platform} post`,
        creative: { source: 'post', postId: input.postId, platform: input.platform },
        copy: { primaryText: '' },
    };
    if (goal === 'traffic' && input.link) ad.link = { url: input.link };
    if (goal === 'messages' && (input.greeting !== undefined || input.iceBreakers !== undefined)) {
        ad.message = { greeting: input.greeting ?? '', iceBreakers: input.iceBreakers ?? [] };
    }
    const spec: CampaignSpec = {
        name: `AutoReply boost · ${input.platform}`,
        goal,
        specialCategory: 'none',
        budget: { home: 'adset', kind: 'lifetime', amount: Math.round(input.dailyBudget * input.days * 100) / 100, start: now.toISOString(), end: end.toISOString() },
        adsets: [{ name: input.country, targeting: { countries: [input.country], ageMin: 18, advantageAudience: true }, placements: 'automatic' }],
        ads: [ad],
    };
    if (goal === 'messages' && input.destinations !== undefined) spec.destinations = [...input.destinations];
    return spec;
}
