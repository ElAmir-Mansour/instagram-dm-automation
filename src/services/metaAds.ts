/**
 * Boost a published post with the Meta Marketing API (docs/META_ADS_RESEARCH.md, option 2).
 *
 * Two halves. The PURE half decides everything that can be decided without Meta: the money (minor units, the daily maximum, the monthly
 * cap), and the exact parameters of each object. The Graph half sends them and reads back. `src/services/adBoosts.ts` is the store and
 * the order of operations; this file never touches the database.
 *
 * The chain, all on `act_<ad account>`:
 *   1. campaign   objective, `status=PAUSED`, no special ad category
 *   2. ad set     a LIFETIME budget of daily × days (so Meta cannot spend more than the boost's total), the window, the country, `PAUSED`
 *   3. creative   Instagram: `object_id=<page>`, `instagram_user_id`, `source_instagram_media_id`. Facebook: `object_story_id=<page>_<post>`
 *   4. ad         the creative in the ad set, `PAUSED`
 * Nothing spends until `activateBoostObjects` sets ad, ad set and campaign ACTIVE, the campaign LAST: until it is active, nothing under it
 * delivers, so an activation that fails half way spends nothing.
 *
 * Every call goes through the ads Graph client (src/services/ads/graph.ts): the ads module's pinned version, the pacer, and no retry of a
 * rate or edit limit. Every create is a POST that may have landed even when it timed out, so it is sent with `creates: true`: only a
 * connection that never went out is retried. Status changes are idempotent and retry on a 5xx or a dropped connection.
 * Field names are the v25+ ones: `instagram_user_id`, not `instagram_actor_id`; `source_instagram_media_id`, not `instagram_story_id`.
 */
import { metaErrorCode, metaErrorSubcode } from './http.js';
import { adsDelete, adsGet, adsPost, type GraphParams } from './ads/graph.js';

export type { GraphParams };

export type BoostPlatform = 'instagram' | 'facebook';
export type BoostObjective = 'ENGAGEMENT' | 'AWARENESS' | 'TRAFFIC';

export const BOOST_PLATFORMS: readonly BoostPlatform[] = ['instagram', 'facebook'];
export const BOOST_OBJECTIVES: readonly BoostObjective[] = ['ENGAGEMENT', 'AWARENESS', 'TRAFFIC'];
export const BOOST_DAYS_MIN = 1;
export const BOOST_DAYS_MAX = 30;

// ─── Money ────────────────────────────────────────────────────────────────────────────────

/**
 * Currencies Meta counts in whole units (offset 1): every other one is sent in hundredths. A budget of 50 JPY is `50`; 50 USD is `5000`.
 * @see https://developers.facebook.com/docs/marketing-api/currencies
 */
const WHOLE_UNIT_CURRENCIES: ReadonlySet<string> = new Set(['CLP', 'COP', 'CRC', 'HUF', 'ISK', 'IDR', 'JPY', 'KRW', 'PYG', 'TWD', 'VND']);

export function currencyOffset(currency: string): 1 | 100 {
    return WHOLE_UNIT_CURRENCIES.has(currency.toUpperCase()) ? 1 : 100;
}

/** An amount in major units (5.5 = $5.50) as the integer Meta wants. */
export function toMinorUnits(amount: number, currency: string): number {
    return Math.round(amount * currencyOffset(currency));
}

/** Meta's integer (a `min_daily_budget`) back to major units. */
export function fromMinorUnits(minor: number, currency: string): number {
    return minor / currencyOffset(currency);
}

/** Hundredths, so 0.1 + 0.2 compares as 30, not 30.000000000000004. Every money comparison here goes through it. */
function cents(amount: number): number {
    return Math.round(amount * 100);
}

/** An amount kept to two decimals, the precision the `ad_boosts` columns store. */
export function roundMoney(amount: number): number {
    return cents(amount) / 100;
}

export interface BoostLimits {
    /** Major units. No single boost's daily budget may exceed it. */
    maxDailyBudget: number;
}

export type BudgetRefusal = 'INVALID' | 'OVER_DAILY_MAX' | 'BELOW_META_MINIMUM';

export type BudgetCheck =
    | { ok: true; dailyBudget: number; plannedTotal: number }
    | { ok: false; code: BudgetRefusal; field: 'dailyBudget' | 'days'; message: string };

/**
 * A boost's own budget: whole days within 1–30, a positive daily budget, at most `maxDailyBudget`, and at least Meta's minimum for the
 * account when known (Meta would refuse it anyway, less clearly). A boost spends at most `daily × days` (the ad set's lifetime budget).
 * Whether that total fits this month is the money rule's (src/services/ads/money.ts), not this.
 */
export function checkBoostBudget(input: {
    dailyBudget: unknown;
    days: unknown;
    limits: { maxDailyBudget: number | null };
    minDailyBudget?: number | null;
}): BudgetCheck {
    const days = input.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < BOOST_DAYS_MIN || days > BOOST_DAYS_MAX) {
        return { ok: false, code: 'INVALID', field: 'days', message: `Days must be a whole number from ${BOOST_DAYS_MIN} to ${BOOST_DAYS_MAX}.` };
    }
    const raw = input.dailyBudget;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || cents(raw) <= 0) {
        return { ok: false, code: 'INVALID', field: 'dailyBudget', message: 'The daily budget must be a positive amount.' };
    }
    const dailyBudget = roundMoney(raw);
    const max = input.limits.maxDailyBudget;
    if (typeof max !== 'number' || !(max > 0)) {
        // A missing limit is not "no limit": the caller should have refused as unconfigured, and this refuses again rather than spend.
        return { ok: false, code: 'OVER_DAILY_MAX', field: 'dailyBudget', message: 'Set a max daily budget and a monthly spend cap in Settings first.' };
    }
    if (cents(dailyBudget) > cents(max)) {
        return { ok: false, code: 'OVER_DAILY_MAX', field: 'dailyBudget', message: `The daily budget ${dailyBudget} is over your max daily budget of ${max}.` };
    }
    if (typeof input.minDailyBudget === 'number' && input.minDailyBudget > 0 && cents(dailyBudget) < cents(input.minDailyBudget)) {
        return { ok: false, code: 'BELOW_META_MINIMUM', field: 'dailyBudget', message: `Meta's minimum daily budget for this ad account is ${input.minDailyBudget}.` };
    }
    return { ok: true, dailyBudget, plannedTotal: cents(dailyBudget) * days / 100 };
}

// ─── Inputs ───────────────────────────────────────────────────────────────────────────────

/** `act_123…` or `123…` → the digits, or null when it is not an ad account id. */
export function normaliseAdAccountId(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const digits = input.trim().replace(/^act_/i, '');
    return /^[0-9]{5,25}$/.test(digits) ? digits : null;
}

/**
 * EU member states. Meta requires `dsa_payor` and `dsa_beneficiary` (who pays, who benefits, under the EU Digital Services Act) on any ad
 * set that targets one, and Boost does not collect them yet, so such a country is refused with that reason rather than failing at Meta.
 */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
    'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO',
    'SK', 'SI', 'ES', 'SE',
]);

/** An ISO 3166-1 alpha-2 country code, upper-cased, or null. */
export function normaliseCountry(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const code = input.trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** An https URL for a TRAFFIC boost's button, or null. */
export function normaliseLink(input: unknown): string | null {
    if (typeof input !== 'string' || input.length > 2000) return null;
    try {
        const url = new URL(input.trim());
        return url.protocol === 'https:' && url.hostname.includes('.') ? url.toString() : null;
    } catch {
        return null;
    }
}

// ─── Payloads ─────────────────────────────────────────────────────────────────────────────

export interface BoostSpec {
    /** The `ad_boosts` row id: in every object's name, so an object orphaned by a failure can be found in Ads Manager. */
    boostId: string;
    adAccountId: string;
    platform: BoostPlatform;
    objective: BoostObjective;
    country: string;
    /** Required for TRAFFIC. */
    link: string | null;
    dailyBudget: number;
    days: number;
    currency: string;
    pageId: string;
    /** Instagram only. */
    igUserId: string | null;
    /** Instagram: the IG media id. Facebook: the `<page>_<post>` story id. */
    mediaId: string;
}

const CAMPAIGN_OBJECTIVE: Record<BoostObjective, string> = {
    ENGAGEMENT: 'OUTCOME_ENGAGEMENT',
    AWARENESS: 'OUTCOME_AWARENESS',
    TRAFFIC: 'OUTCOME_TRAFFIC',
};

const OPTIMIZATION_GOAL: Record<BoostObjective, string> = {
    ENGAGEMENT: 'POST_ENGAGEMENT',
    AWARENESS: 'REACH',
    TRAFFIC: 'LINK_CLICKS',
};

/** Graph parameters: scalars as they are, objects and arrays as JSON. Form-encoded, the shape every Marketing API example uses. */

function name(spec: Pick<BoostSpec, 'boostId' | 'platform'>, what: string): string {
    return `AutoReply boost ${spec.boostId} · ${spec.platform} · ${what}`;
}

/** Start now, end `days` days later (whole days, so a 3-day boost runs 72 hours). */
export function boostWindow(days: number, now: Date): { start: Date; end: Date } {
    return { start: new Date(now.getTime()), end: new Date(now.getTime() + days * 86_400_000) };
}

/** Meta's time format: ISO 8601 with an offset, to the second. */
export function graphTime(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, '+0000');
}

export function buildCampaignParams(spec: BoostSpec): GraphParams {
    return {
        name: name(spec, 'campaign'),
        objective: CAMPAIGN_OBJECTIVE[spec.objective],
        status: 'PAUSED',
        buying_type: 'AUCTION',
        special_ad_categories: [],
        // No campaign budget: the ad set holds it. Meta requires this to be said explicitly for such a campaign since v24.
        is_adset_budget_sharing_enabled: false,
    };
}

export function buildAdSetParams(spec: BoostSpec, campaignId: string, now: Date): GraphParams {
    const window = boostWindow(spec.days, now);
    const params: GraphParams = {
        name: name(spec, 'ad set'),
        campaign_id: campaignId,
        status: 'PAUSED',
        // A lifetime budget, not a daily one: Meta may spend up to 75% over a DAILY budget on a given day, never over a lifetime budget.
        // That is what makes `planned_total` a ceiling the monthly cap can count on.
        lifetime_budget: toMinorUnits(spec.dailyBudget, spec.currency) * spec.days,
        start_time: graphTime(window.start),
        end_time: graphTime(window.end),
        billing_event: 'IMPRESSIONS',
        optimization_goal: OPTIMIZATION_GOAL[spec.objective],
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
            geo_locations: { countries: [spec.country] },
            age_min: 18,
            publisher_platforms: [spec.platform],
            // Said explicitly: from v26 Meta requires it in some categories, and leaving it to a default changes with the version.
            targeting_automation: { advantage_audience: 1 },
        },
    };
    if (spec.objective === 'ENGAGEMENT') params['destination_type'] = 'ON_POST';
    // TRAFFIC sends no destination_type: Meta's ODAX table lists none for Traffic, and WEBSITE is documented only under other objectives.
    // The link is the creative's call to action.
    if (spec.objective === 'AWARENESS') params['promoted_object'] = { page_id: spec.pageId };
    return params;
}

export function buildCreativeParams(spec: BoostSpec): GraphParams {
    if (spec.platform === 'instagram') {
        if (!spec.igUserId) throw new Error('An Instagram boost needs the Instagram account id.');
        const params: GraphParams = {
            name: name(spec, 'creative'),
            object_id: spec.pageId,
            instagram_user_id: spec.igUserId,
            source_instagram_media_id: spec.mediaId,
        };
        if (spec.objective === 'TRAFFIC') {
            if (!spec.link) throw new Error('A link-clicks boost needs a link.');
            params['call_to_action'] = { type: 'LEARN_MORE', value: { link: spec.link } };
        }
        return params;
    }
    // A Facebook post is boosted as it is: its own link (if any) is the destination, so there is no button to add.
    return { name: name(spec, 'creative'), object_story_id: spec.mediaId };
}

export function buildAdParams(spec: BoostSpec, adsetId: string, creativeId: string): GraphParams {
    return {
        name: name(spec, 'ad'),
        adset_id: adsetId,
        creative: { creative_id: creativeId },
        status: 'PAUSED',
    };
}

/** What Activate sends to the ad set: ACTIVE, and the window moved to start now, so a boost activated days after it was made still runs its days. */
export function buildAdSetActivationParams(days: number, now: Date): GraphParams {
    const window = boostWindow(days, now);
    return { status: 'ACTIVE', start_time: graphTime(window.start), end_time: graphTime(window.end) };
}

/**
 * Which boosts the form may offer for a platform and objective. A Facebook post is promoted as it stands, so it cannot be given a
 * link-clicks button: TRAFFIC is Instagram only. Null when the pair is fine, else the reason.
 */
export function objectiveProblem(platform: BoostPlatform, objective: BoostObjective, link: string | null): string | null {
    if (objective !== 'TRAFFIC') return null;
    if (platform === 'facebook') return 'Link clicks is for Instagram posts. A Facebook post is boosted with its own link: choose Engagement or Reach.';
    if (!link) return 'Link clicks needs an https link for the button.';
    return null;
}

/** The `<page>_<post>` story id for a stored Facebook id that is already one; null when it is a bare photo or video id. */
export function storyIdIfComplete(fbId: string): string | null {
    return /^[0-9]+_[0-9]+$/.test(fbId) ? fbId : null;
}

// ─── Reading Meta's answers ───────────────────────────────────────────────────────────────

export interface Eligibility {
    /** Null when Meta did not say: the form still lets the owner try, and creation is the real test. */
    eligible: boolean | null;
    reason: string | null;
}

/**
 * Meta's eligibility answer, read defensively. Instagram: `boost_eligibility_info` on the media (`eligible_to_boost` plus a reason when
 * not). Facebook: `is_eligible_for_promotion` on the post. Anything else is "did not say".
 */
export function readEligibility(platform: BoostPlatform, data: unknown): Eligibility {
    const node = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    if (platform === 'facebook') {
        const flag = node['is_eligible_for_promotion'];
        return { eligible: typeof flag === 'boolean' ? flag : null, reason: flag === false ? 'Meta says this Facebook post cannot be promoted.' : null };
    }
    const info = node['boost_eligibility_info'];
    if (!info || typeof info !== 'object') return { eligible: null, reason: null };
    const rec = info as Record<string, unknown>;
    const flag = rec['eligible_to_boost'] ?? rec['is_eligible'] ?? rec['eligible'];
    const eligible = typeof flag === 'boolean' ? flag : null;
    const reasonRaw = rec['ineligible_reason'] ?? rec['boost_ineligible_reason'] ?? rec['reason'] ?? rec['ineligibility_reason'];
    const reason = typeof reasonRaw === 'string' && reasonRaw.trim() ? reasonRaw.trim().slice(0, 300) : null;
    return { eligible, reason: eligible === false ? (reason ?? 'Meta says this post cannot be boosted.') : null };
}

export interface BoostInsights {
    spend: number;
    reach: number;
    impressions: number;
    clicks: number;
    cpm: number | null;
    /** The objective's own result: post engagements, people reached, or link clicks. */
    results: number;
}

const RESULT_ACTION: Record<BoostObjective, string> = {
    ENGAGEMENT: 'post_engagement',
    AWARENESS: '',
    TRAFFIC: 'link_click',
};

export function num(value: unknown): number {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    return Number.isFinite(n) ? n : 0;
}

/** `GET /{ad}/insights` → the numbers the Posts screen shows. Spend is already in major units. Null when Meta has no row yet. */
export function readInsights(objective: BoostObjective, data: unknown): BoostInsights | null {
    const rows = (data as { data?: unknown })?.data;
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row || typeof row !== 'object') return null;
    const r = row as Record<string, unknown>;
    const reach = num(r['reach']);
    let results = reach;
    const action = RESULT_ACTION[objective];
    if (action) {
        const actions = Array.isArray(r['actions']) ? (r['actions'] as Array<Record<string, unknown>>) : [];
        results = num(actions.find((a) => a?.['action_type'] === action)?.['value']);
    }
    return {
        spend: roundMoney(num(r['spend'])),
        reach,
        impressions: num(r['impressions']),
        clicks: num(r['clicks']),
        cpm: r['cpm'] === undefined ? null : roundMoney(num(r['cpm'])),
        results,
    };
}

// ─── Graph calls ──────────────────────────────────────────────────────────────────────────

/** A POST that creates something: resent only when Meta certainly did nothing (ads/graph.ts). Throws an AdsGraphError with Meta's own message. */
async function createObject(path: string, params: GraphParams, token: string, label: string): Promise<string> {
    const res = await adsPost(path, params, token, { label, creates: true });
    const id = res.data?.id;
    if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`${label}: Meta answered without an id.`);
    return String(id);
}

/** Setting a status is idempotent, so it retries like a read (but never on a rate or edit limit). */
export async function updateObject(id: string, params: GraphParams, token: string, label: string, opts: { priority?: boolean } = {}): Promise<void> {
    await adsPost(id, params, token, { label, ...opts });
}

export async function getNode(id: string, params: Record<string, string>, token: string, label: string): Promise<any> {
    return (await adsGet(id, params, token, { label })).data;
}

export interface AdAccountInfo {
    name: string | null;
    currency: string;
    /** Meta's `account_status`: 1 is active. */
    status: number | null;
    /** Major units, or null when Meta did not give it. */
    minDailyBudget: number | null;
}

/** The ad account the token reaches: name, currency, status, and Meta's minimum daily budget. Proves the token and the id together. */
export async function readAdAccount(adAccountId: string, token: string): Promise<AdAccountInfo> {
    let data: any;
    try {
        data = await getNode(`act_${adAccountId}`, { fields: 'name,currency,account_status,min_daily_budget' }, token, 'ad account');
    } catch (err) {
        // An older or newer version without `min_daily_budget` answers code 100 for the whole read: ask again without it.
        if (metaErrorCode(err) !== 100) throw err;
        data = await getNode(`act_${adAccountId}`, { fields: 'name,currency,account_status' }, token, 'ad account');
    }
    const currency = typeof data?.currency === 'string' ? data.currency : '';
    if (!currency) throw new Error('Meta did not say which currency this ad account uses.');
    const minMinor = num(data?.min_daily_budget);
    return {
        name: typeof data?.name === 'string' ? data.name : null,
        currency,
        status: typeof data?.account_status === 'number' ? data.account_status : null,
        minDailyBudget: minMinor > 0 ? fromMinorUnits(minMinor, currency) : null,
    };
}

export interface AdAccountChoice {
    /** The digits, without `act_`. */
    id: string;
    name: string | null;
    currency: string | null;
    /** Meta's `account_status`: 1 is active. */
    status: number | null;
}

/** `/me/adaccounts`: every ad account the token reaches (the first 50, which is more than any one business here has). */
export async function listAdAccounts(token: string): Promise<AdAccountChoice[]> {
    const data = await getNode('me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: '50' }, token, 'ad accounts');
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
        .map((r: any): AdAccountChoice | null => {
            const id = normaliseAdAccountId(typeof r?.account_id === 'string' ? r.account_id : typeof r?.id === 'string' ? r.id : '');
            if (!id) return null;
            return {
                id,
                name: typeof r?.name === 'string' ? r.name : null,
                currency: typeof r?.currency === 'string' ? r.currency : null,
                status: typeof r?.account_status === 'number' ? r.account_status : null,
            };
        })
        .filter((r: AdAccountChoice | null): r is AdAccountChoice => r !== null);
}

/**
 * The ad account to save on its own after Connect: the saved one when the token still reaches it, else the only ACTIVE one. Null when
 * there is a real choice (or none), which the Settings card's picker then asks.
 */
export function pickAdAccount(accounts: readonly AdAccountChoice[], saved: string | null): string | null {
    if (saved && accounts.some((a) => a.id === saved)) return saved;
    const active = accounts.filter((a) => a.status === 1);
    return active.length === 1 ? active[0]!.id : null;
}

/**
 * The `<page>_<post>` id a Facebook creative needs. Feed posts are stored that way already; a photo post is stored by its photo id, whose
 * `page_story_id` is the post. A video is stored by its video id, and a Page video's post is `<page>_<video>`.
 */
export async function resolveFacebookStoryId(pageId: string, fbId: string, token: string): Promise<string> {
    const complete = storyIdIfComplete(fbId);
    if (complete) return complete;
    try {
        const data = await getNode(fbId, { fields: 'page_story_id' }, token, 'facebook story id');
        if (typeof data?.page_story_id === 'string' && storyIdIfComplete(data.page_story_id)) return data.page_story_id;
    } catch {
        // Not a photo (a video has no such field): fall through to the video form.
    }
    return `${pageId}_${fbId}`;
}

export async function checkEligibility(platform: BoostPlatform, mediaId: string, token: string): Promise<Eligibility> {
    const fields = platform === 'instagram' ? 'boost_eligibility_info' : 'is_eligible_for_promotion';
    return readEligibility(platform, await getNode(mediaId, { fields }, token, 'eligibility'));
}

export interface CreatedObjects {
    campaignId?: string;
    adsetId?: string;
    creativeId?: string;
    adId?: string;
}

/**
 * Creates the four objects, all PAUSED. `onProgress` is called after each one with every id so far, so the caller can record them as
 * they exist: if a later step throws, the earlier objects are named in the row and can be deleted.
 */
export async function createPausedBoost(
    spec: BoostSpec,
    token: string,
    now: Date,
    onProgress: (ids: CreatedObjects) => Promise<void>
): Promise<Required<CreatedObjects>> {
    const ids: CreatedObjects = {};
    const act = `act_${spec.adAccountId}`;
    ids.campaignId = await createObject(`${act}/campaigns`, buildCampaignParams(spec), token, 'campaign');
    await onProgress({ ...ids });
    ids.adsetId = await createObject(`${act}/adsets`, buildAdSetParams(spec, ids.campaignId, now), token, 'ad set');
    await onProgress({ ...ids });
    ids.creativeId = await createObject(`${act}/adcreatives`, buildCreativeParams(spec), token, 'creative');
    await onProgress({ ...ids });
    ids.adId = await createObject(`${act}/ads`, buildAdParams(spec, ids.adsetId, ids.creativeId), token, 'ad');
    await onProgress({ ...ids });
    return ids as Required<CreatedObjects>;
}

/** Ad, then ad set (with its window moved to start now), then the campaign: the campaign is the switch, so it goes last. */
export async function activateBoostObjects(
    ids: { campaignId: string; adsetId: string; adId: string },
    days: number,
    token: string,
    now: Date
): Promise<void> {
    await updateObject(ids.adId, { status: 'ACTIVE' }, token, 'activate ad');
    await updateObject(ids.adsetId, buildAdSetActivationParams(days, now), token, 'activate ad set');
    await updateObject(ids.campaignId, { status: 'ACTIVE' }, token, 'activate campaign');
}

/** The campaign is the switch: pausing it stops everything under it. */
export async function pauseBoostCampaign(campaignId: string, token: string): Promise<void> {
    await updateObject(campaignId, { status: 'PAUSED' }, token, 'pause campaign');
}

/** Deletes a campaign at Meta, which deletes its ad sets and ads. Deleting spends nothing; an object already gone counts as deleted. */
export async function deleteAdObject(id: string, token: string): Promise<void> {
    try {
        await adsDelete(id, token, { label: 'delete ad object' });
    } catch (error) {
        // 100/33 means "does not exist" — or no permission, or an unsupported operation: Meta uses it for all three. It counts as deleted
        // only when a read of the object fails too; an object that can still be read was NOT deleted, and that is said.
        if (metaErrorCode(error) === 100 && metaErrorSubcode(error) === 33) {
            const stillThere = await getNode(id, { fields: 'id' }, token, 'delete check').then(() => true, () => false);
            if (!stillThere) return;
        }
        throw error;
    }
}

export interface AdState {
    effectiveStatus: string | null;
    insights: BoostInsights | null;
}

/** The ad's effective status and its lifetime insights. */
export async function readAdState(adId: string, objective: BoostObjective, token: string): Promise<AdState> {
    const [node, insights] = await Promise.all([
        getNode(adId, { fields: 'effective_status' }, token, 'ad status'),
        getNode(`${adId}/insights`, { fields: 'spend,reach,impressions,clicks,cpm,actions', date_preset: 'maximum' }, token, 'insights'),
    ]);
    return {
        effectiveStatus: typeof node?.effective_status === 'string' ? node.effective_status : null,
        insights: readInsights(objective, insights),
    };
}

// ─── The account's state: status and payment method (the Ads screen; activation refuses without a payment method) ─────────

export type AccountStatusLabel = 'active' | 'disabled' | 'unsettled' | 'pending_review' | 'closed' | 'other';

/** Meta's numeric `account_status` as a word the screen can show. @see https://developers.facebook.com/docs/marketing-api/reference/ad-account */
export function accountStatusLabel(status: number | null): AccountStatusLabel {
    switch (status) {
        case 1: case 9: case 201: return 'active';
        case 2: return 'disabled';
        case 3: case 8: return 'unsettled';
        case 7: return 'pending_review';
        case 100: case 101: case 202: return 'closed';
        default: return 'other';
    }
}

const DISABLE_REASONS: Record<number, string> = {
    1: 'Ads integrity policy',
    2: 'Intellectual property review',
    3: 'Payment risk',
    4: 'Account shut down',
    5: 'Advertiser review',
    6: 'Business integrity review',
    7: 'Permanently closed',
    8: 'Unused reseller account',
    9: 'Unused account',
};

export interface AdAccountState extends AdAccountInfo {
    id: string;
    statusLabel: AccountStatusLabel;
    disableReason: string | null;
    /** Null when Meta would not say (a token without the permission to read billing, or the field left out). */
    hasPaymentMethod: boolean | null;
    /** The account's UTC offset in hours (Meta's `timezone_offset_hours_utc`): Meta's `this_month` is the account's month. 0 when unknown. */
    timezoneOffsetHours: number;
    /** Meta's `timezone_name`, an IANA zone name. Null when not said. */
    timezoneName: string | null;
    /** Meta's `is_prepay_account`: the account is paid in advance (a balance runs down), not charged after. Null when not said. */
    isPrepay: boolean | null;
    /** The account's spending limit (`spend_cap`), major units; null when none is set or not said. */
    spendCap: number | null;
    /** `amount_spent`, major units: what counts against the spending limit (or the account's total without one). */
    amountSpent: number | null;
    /** Meta's own display string, e.g. "Visa *1234". Never stored. */
    paymentMethod: string | null;
    billingUrl: string;
    adsManagerUrl: string;
}

/** Where the owner adds a payment method: Meta's billing page for this ad account. The Marketing API cannot add one. */
export function billingUrl(adAccountId: string): string {
    return `https://business.facebook.com/billing_hub/payment_settings/?asset_id=${encodeURIComponent(adAccountId)}`;
}

export function adsManagerUrl(adAccountId: string): string {
    return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${encodeURIComponent(adAccountId)}`;
}

/**
 * The account node read as the screen needs it. `paymentReadable` is false when the fields about billing could not be asked for: then
 * "has a payment method" is null (unknown), never false, so nothing is refused on a guess.
 */
/**
 * Meta's money string in MINOR units (`spend_cap`, `amount_spent` are read back in cents for a currency with cents) to major units. For a
 * spending limit, 0 means "no limit" and is null. The write is in major units, which `/api/ads/spend-cap` checks by reading it back.
 */
function minorMoney(value: unknown, currency: string, zeroIsNone: boolean): number | null {
    if (value === undefined || value === null || value === '' || !currency) return null;
    const n = num(value);
    if (zeroIsNone && n === 0) return null;
    return roundMoney(fromMinorUnits(n, currency));
}

export function readAccountState(adAccountId: string, data: any, paymentReadable: boolean): AdAccountState {
    const currency = typeof data?.currency === 'string' ? data.currency : '';
    const status = typeof data?.account_status === 'number' ? data.account_status : null;
    const reasonCode = typeof data?.disable_reason === 'number' ? data.disable_reason : 0;
    const details = data?.funding_source_details;
    const display = details && typeof details.display_string === 'string' && details.display_string.trim() ? details.display_string.trim().slice(0, 80) : null;
    const source = data?.funding_source;
    const hasSource = (typeof source === 'string' && source !== '' && source !== '0') || (typeof source === 'number' && source > 0) || display !== null;
    // Meta leaves fields it will not show out of the answer. Only a funding source that is present and empty is "none"; one that is
    // absent altogether is "could not tell", so Activate is never refused on a guess (an account with no payment method just gets no
    // delivery, which Meta says itself).
    const said = Object.prototype.hasOwnProperty.call(data ?? {}, 'funding_source') || Object.prototype.hasOwnProperty.call(data ?? {}, 'funding_source_details');
    const offset = num(data?.timezone_offset_hours_utc);
    const minMinor = num(data?.min_daily_budget);
    return {
        id: adAccountId,
        name: typeof data?.name === 'string' ? data.name : null,
        currency,
        status,
        minDailyBudget: minMinor > 0 && currency ? fromMinorUnits(minMinor, currency) : null,
        statusLabel: accountStatusLabel(status),
        disableReason: reasonCode > 0 ? (DISABLE_REASONS[reasonCode] ?? `Meta disable reason ${reasonCode}`) : null,
        hasPaymentMethod: paymentReadable ? (hasSource ? true : said ? false : null) : null,
        timezoneOffsetHours: Number.isFinite(offset) && Math.abs(offset) <= 14 ? offset : 0,
        timezoneName: typeof data?.timezone_name === 'string' && data.timezone_name ? data.timezone_name : null,
        isPrepay: typeof data?.is_prepay_account === 'boolean' ? data.is_prepay_account : null,
        spendCap: minorMoney(data?.spend_cap, currency, true),
        amountSpent: minorMoney(data?.amount_spent, currency, false),
        paymentMethod: paymentReadable ? display : null,
        billingUrl: billingUrl(adAccountId),
        adsManagerUrl: adsManagerUrl(adAccountId),
    };
}

export async function fetchAccountState(adAccountId: string, token: string): Promise<AdAccountState> {
    const base = 'name,currency,account_status,disable_reason,min_daily_budget,timezone_offset_hours_utc,timezone_name,is_prepay_account,spend_cap,amount_spent';
    try {
        const data = await getNode(`act_${adAccountId}`, { fields: `${base},funding_source,funding_source_details` }, token, 'ad account');
        return readAccountState(adAccountId, data, true);
    } catch (err) {
        // The billing fields need more than ads_read on some accounts: read the rest, and say "unknown" about payment.
        if (metaErrorCode(err) !== 100 && metaErrorCode(err) !== 200) throw err;
        const data = await getNode(`act_${adAccountId}`, { fields: 'name,currency,account_status,timezone_offset_hours_utc,timezone_name' }, token, 'ad account');
        return readAccountState(adAccountId, data, false);
    }
}
