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
 * Every create is a POST that may have landed even when it timed out, so it goes through `withRetry` with `creates: true`: only a failure
 * that proves Meta did nothing (a rate limit, a connection that never went out) is retried. Status changes are idempotent and retry normally.
 * Field names are the v25+ ones: `instagram_user_id`, not `instagram_actor_id`; `source_instagram_media_id`, not `instagram_story_id`.
 */
import { GRAPH_BASE, metaFailure } from './instagram.js';
import { metaErrorCode, metaErrorSubcode, metaHttp, withRetry } from './http.js';

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
    /** Major units. What every boost counted this month may add up to, this one included. */
    monthlyCap: number;
}

export type BudgetRefusal = 'INVALID' | 'BUDGET_OVER_DAILY_MAX' | 'BUDGET_OVER_MONTHLY_CAP' | 'BUDGET_UNDER_MINIMUM';

export type BudgetCheck =
    | { ok: true; dailyBudget: number; plannedTotal: number }
    | { ok: false; code: BudgetRefusal; field: 'dailyBudget' | 'days'; message: string };

/**
 * THE spend guard. A boost spends at most `daily × days` (the ad set's lifetime budget), and it may be created or activated only when
 * that fits under the owner's limits:
 *   - the daily budget is at most `maxDailyBudget`,
 *   - it is at least Meta's minimum for the account, when known (Meta would refuse it anyway, less clearly),
 *   - `committedThisMonth` (every other boost counted this calendar month, see adBoosts.ts) plus this boost's total is at most `monthlyCap`.
 * Pure: the caller reads the limits and the committed amount, and must hold the tenant's boost lock between this check and its write.
 */
export function checkBoostBudget(input: {
    dailyBudget: unknown;
    days: unknown;
    limits: BoostLimits;
    committedThisMonth: number;
    minDailyBudget?: number | null;
}): BudgetCheck {
    const { limits } = input;
    const days = input.days;
    if (typeof days !== 'number' || !Number.isInteger(days) || days < BOOST_DAYS_MIN || days > BOOST_DAYS_MAX) {
        return { ok: false, code: 'INVALID', field: 'days', message: `Days must be a whole number from ${BOOST_DAYS_MIN} to ${BOOST_DAYS_MAX}.` };
    }
    const raw = input.dailyBudget;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || cents(raw) <= 0) {
        return { ok: false, code: 'INVALID', field: 'dailyBudget', message: 'The daily budget must be a positive amount.' };
    }
    const dailyBudget = roundMoney(raw);
    if (!(limits.maxDailyBudget > 0) || !(limits.monthlyCap > 0)) {
        // A missing limit is not "no limit": the caller should have refused as unconfigured, and this refuses again rather than spend.
        return { ok: false, code: 'BUDGET_OVER_DAILY_MAX', field: 'dailyBudget', message: 'Set a max daily budget and a monthly spend cap in Settings first.' };
    }
    if (cents(dailyBudget) > cents(limits.maxDailyBudget)) {
        return {
            ok: false, code: 'BUDGET_OVER_DAILY_MAX', field: 'dailyBudget',
            message: `The daily budget ${dailyBudget} is over your max daily budget of ${limits.maxDailyBudget}.`,
        };
    }
    if (typeof input.minDailyBudget === 'number' && input.minDailyBudget > 0 && cents(dailyBudget) < cents(input.minDailyBudget)) {
        return {
            ok: false, code: 'BUDGET_UNDER_MINIMUM', field: 'dailyBudget',
            message: `Meta's minimum daily budget for this ad account is ${input.minDailyBudget}.`,
        };
    }
    const plannedTotal = cents(dailyBudget) * days / 100;
    const committed = Math.max(0, input.committedThisMonth);
    if (cents(committed) + cents(plannedTotal) > cents(limits.monthlyCap)) {
        const left = Math.max(0, cents(limits.monthlyCap) - cents(committed)) / 100;
        return {
            ok: false, code: 'BUDGET_OVER_MONTHLY_CAP', field: 'dailyBudget',
            message: `This boost could spend ${plannedTotal}, but only ${left} of your monthly cap of ${limits.monthlyCap} is left this month.`,
        };
    }
    return { ok: true, dailyBudget, plannedTotal };
}

// ─── Inputs ───────────────────────────────────────────────────────────────────────────────

/** `act_123…` or `123…` → the digits, or null when it is not an ad account id. */
export function normaliseAdAccountId(input: unknown): string | null {
    if (typeof input !== 'string') return null;
    const digits = input.trim().replace(/^act_/i, '');
    return /^[0-9]{5,25}$/.test(digits) ? digits : null;
}

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
export type GraphParams = Record<string, string | number | boolean | object>;

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
    if (spec.objective === 'TRAFFIC') params['destination_type'] = 'WEBSITE';
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

function num(value: unknown): number {
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

function form(params: GraphParams): URLSearchParams {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        body.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return body;
}

function auth(token: string) {
    return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' } };
}

/** A POST that creates something: retried only when Meta certainly did nothing. Throws a MetaApiError with Meta's own message. */
async function createObject(path: string, params: GraphParams, token: string, label: string): Promise<string> {
    try {
        const res = await withRetry(() => metaHttp.post(`${GRAPH_BASE}/${path}`, form(params), auth(token)), { label, creates: true });
        const id = res.data?.id;
        if (typeof id !== 'string' && typeof id !== 'number') throw new Error(`${label}: Meta answered without an id.`);
        return String(id);
    } catch (error) {
        throw metaFailure(`Meta ads (${label})`, error);
    }
}

/** Setting a status is idempotent, so it retries like a read. */
async function updateObject(id: string, params: GraphParams, token: string, label: string): Promise<void> {
    try {
        await withRetry(() => metaHttp.post(`${GRAPH_BASE}/${id}`, form(params), auth(token)), { label });
    } catch (error) {
        throw metaFailure(`Meta ads (${label})`, error);
    }
}

async function getNode(id: string, params: Record<string, string>, token: string, label: string): Promise<any> {
    try {
        const res = await withRetry(() => metaHttp.get(`${GRAPH_BASE}/${id}`, { params, headers: { Authorization: `Bearer ${token}` } }), { label });
        return res.data;
    } catch (error) {
        throw metaFailure(`Meta ads (${label})`, error);
    }
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
        await withRetry(() => metaHttp.delete(`${GRAPH_BASE}/${id}`, { headers: { Authorization: `Bearer ${token}` } }), { label: 'delete ad object' });
    } catch (error) {
        // 100/33, "does not exist": an object already deleted, which is the outcome asked for.
        if (metaErrorCode(error) === 100 && metaErrorSubcode(error) === 33) return;
        throw metaFailure('Meta ads (delete)', error);
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
