/**
 * Boost: the store and the order of operations (docs/META_ADS_RESEARCH.md option 2). `src/services/metaAds.ts` holds the payloads and the
 * Graph calls; `src/routes/ads.ts` the routes. Migration v52 is the table.
 *
 * Config is per tenant and DB-first (`app_settings`, families `ads.settings.<tenant>` and `ads.token.<tenant>`), never env: the ad account
 * id, the max daily budget and the monthly spend cap are the owner's to change from Settings, and the system-user token is encrypted at rest.
 * The settings code lives in src/services/ads/settings.ts (re-exported here for one phase).
 *
 * The money rule is src/services/ads/money.ts, the same one every screen and the guard use. A boost is created PAUSED; creating it checks
 * the daily max and Meta's minimum (`checkBoostBudget`) and that its total fits what is left this month (`moneyFor`, the figure the dialog
 * showed). ACTIVATING is the step that spends, and the binding check: the month is read live from Meta first, outside any transaction, then
 * a short locked transaction re-checks it with whatever else is about to run and records the activation as a running op, then Meta is
 * called. No Graph call ever runs inside a database transaction.
 */
import type { QueryResultRow } from 'pg';
import { queryOne, queryRows } from '../db/query.js';
import { log, describeError } from '../utils/log.js';
import { setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from './appSettings.js';
import { publishedPlatforms } from './publishedIds.js';
import { getTenant } from './tenant.js';
import { withTransaction } from './studio/common.js';
import { MetaApiError } from './instagram.js';
import { inspectToken } from './tokenHealth.js';
import { AdsGraphError } from './ads/graph.js';
import { checkAndStartSpend, checkDailyMax, finishSpendOp, lockMoney, mayHaveLanded, moneyFor, MoneyRefused, readMonth } from './ads/money.js';
import { isConfigured, readAdsSettings, readHealth, type AdsSettings } from './ads/settings.js';
import {
    activateBoostObjects, BOOST_OBJECTIVES, BOOST_PLATFORMS, checkBoostBudget, checkEligibility, createPausedBoost, deleteAdObject,
    normaliseCountry, normaliseLink, objectiveProblem, pauseBoostCampaign, readAdAccount, readAdState,
    resolveFacebookStoryId, boostWindow, listAdAccounts, fetchAccountState, currencyOffset, EU_COUNTRIES, type AdAccountState, pickAdAccount, type AdAccountChoice, type AdAccountInfo, type BoostInsights, type BoostObjective, type BoostPlatform,
    type BudgetRefusal, type CreatedObjects, type Eligibility,
} from './metaAds.js';

export {
    ADS_LIMIT_MAX, parseSettingsInput, parseStoredSettings, readAdsSettings, saveAdsSettings,
    type AdsSettings, type ParsedSettingsInput, type SettingsInput,
} from './ads/settings.js';
export { describeAdsSettings, type AdsSettingsView } from './ads/health.js';

// ─── Errors ───────────────────────────────────────────────────────────────────────────────

export type AdsErrorCode =
    | BudgetRefusal
    | 'OVER_MONTHLY_CAP'
    | 'OVER_CEILING'
    | 'RATE_LIMITED'
    | 'EDIT_LIMIT'
    | 'TOKEN_INVALID'
    | 'ADS_DISABLED'
    | 'CEILING_REQUIRED'
    | 'ADS_NOT_CONFIGURED'
    | 'POST_NOT_PUBLISHED'
    | 'POST_NOT_FOUND'
    | 'NOT_ELIGIBLE'
    | 'BOOST_NOT_FOUND'
    | 'BOOST_STATE'
    | 'META_NOT_CONNECTED'
    | 'META_ERROR'
    | 'PAYMENT_METHOD_MISSING'
    | 'BUDGET_NOT_EDITABLE'
    | 'CAMPAIGN_ACTIVE'
    | 'CAMPAIGN_NOT_FOUND';

/** A refusal the route answers as `{ error, code, field?, metaCode?, metaSubcode?, retryAt? }` with `status`. */
export class AdsError extends Error {
    constructor(
        readonly status: number,
        readonly code: AdsErrorCode,
        message: string,
        readonly field?: string,
        readonly metaCode?: number,
        readonly extra: { metaSubcode?: number; retryAt?: Date | null } = {},
    ) {
        super(message);
        this.name = 'AdsError';
    }
}

/**
 * Meta's failure as the answer the screen shows (contracts/dashboard-api.md "Codes"): a throttle is 429 RATE_LIMITED with the time to
 * try again, an edit limit 429 EDIT_LIMIT, a dead token 409 TOKEN_INVALID (never 401, which the dashboard reads as "signed out"), the
 * money rule 400 OVER_MONTHLY_CAP, and anything else 502 META_ERROR with Meta's code and subcode.
 */
export function metaRefusal(err: unknown): AdsError {
    if (err instanceof AdsError) return err;
    if (err instanceof MoneyRefused) return new AdsError(400, 'OVER_MONTHLY_CAP', err.message);
    const message = err instanceof Error ? err.message : 'Meta refused the request.';
    if (err instanceof AdsGraphError) {
        const extra = { metaSubcode: err.metaSubcode, retryAt: err.retryAt };
        if (err.klass === 'throttle') return new AdsError(429, 'RATE_LIMITED', 'Meta\'s limit for this ad account is reached for now; try again at the time shown.', undefined, err.metaCode, extra);
        if (err.klass === 'budget_limit' || err.klass === 'object_busy' || err.klass === 'spend_cap_limit') return new AdsError(429, 'EDIT_LIMIT', message, undefined, err.metaCode, extra);
        if (err.klass === 'token_dead') return new AdsError(409, 'TOKEN_INVALID', 'Meta no longer accepts the ads token: generate a new one and paste it in Settings.', 'token', err.metaCode, extra);
        return new AdsError(502, 'META_ERROR', message, undefined, err.metaCode, extra);
    }
    const metaCode = err instanceof MetaApiError ? err.metaCode : undefined;
    return new AdsError(502, 'META_ERROR', message, undefined, metaCode, { metaSubcode: err instanceof MetaApiError ? err.metaSubcode : undefined });
}

// ─── One-click: the ads token from Connect ────────────────────────────────────────────────

/**
 * Called by Facebook Login's callback (`finishLogin`) with the person's long-lived user token and what they granted. With
 * `ads_management` granted, the token becomes the tenant's ads token (encrypted), its expiry is read from `debug_token`, and the ad
 * account is filled when there is only one to choose (`pickAdAccount`). The limits are never filled: they decide how much money can be
 * spent, so the owner sets them. Without the permission nothing changes, so a pasted token is never replaced by "no ads access".
 */
export async function captureAdsAccess(creatorId: string, userToken: string, granted: readonly string[], updatedBy: string | null): Promise<{ captured: boolean; adAccountId: string | null }> {
    if (!granted.includes('ads_management')) return { captured: false, adAccountId: null };
    const { settings } = await readAdsSettings(creatorId);
    const [accounts, inspection] = await Promise.all([
        listAdAccounts(userToken).catch((err) => {
            log('warn', 'ads.connect_accounts_unreadable', { creator_id: creatorId, metaCode: err instanceof MetaApiError ? err.metaCode ?? null : null });
            return [] as AdAccountChoice[];
        }),
        inspectToken(userToken).catch(() => null),
    ]);
    const adAccountId = pickAdAccount(accounts, settings.adAccountId);
    const next: AdsSettings = {
        ...settings,
        adAccountId: adAccountId ?? (settings.adAccountId && accounts.length === 0 ? settings.adAccountId : null),
        tokenSource: 'connect',
        tokenExpiresAt: inspection?.expiresAt ? inspection.expiresAt.toISOString() : null,
    };
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, creatorId), userToken, updatedBy);
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, creatorId), JSON.stringify(next), updatedBy);
    log('info', 'ads.connect_captured', { creator_id: creatorId, accounts: accounts.length, ad_account_picked: Boolean(next.adAccountId) });
    return { captured: true, adAccountId: next.adAccountId };
}

/** Meta was disconnected (or the person removed the app): an ads token that came with that Connect goes too. A pasted one stays. */
export async function forgetConnectedAdsAccess(creatorId: string): Promise<boolean> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!token || settings.tokenSource !== 'connect') return false;
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, creatorId), null, null);
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, creatorId), JSON.stringify({ ...settings, tokenSource: null, tokenExpiresAt: null }), null);
    log('info', 'ads.connect_forgotten', { creator_id: creatorId });
    return true;
}

/** The ad accounts the saved token reached at the last "Test connection", for the Settings card's picker. Stored data: no Meta call. */
export async function listAdAccountsFor(creatorId: string): Promise<AdAccountChoice[]> {
    const { token } = await readAdsSettings(creatorId);
    if (!token) throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Connect Meta with ads access (or paste a token) first.');
    return (await readHealth(creatorId)).assets?.adAccounts ?? [];
}

export async function requireConfig(creatorId: string): Promise<{ settings: AdsSettings & { adAccountId: string; maxDailyBudget: number; monthlyCap: number }; token: string }> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!isConfigured(settings, token)) {
        throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Set the ad account, the ads token, the max daily budget and the monthly cap in Settings first.');
    }
    return { settings: settings as AdsSettings & { adAccountId: string; maxDailyBudget: number; monthlyCap: number }, token: token! };
}

// ─── The lock ─────────────────────────────────────────────────────────────────────────────

/** v1's name for the tenant's money lock (ads/money.ts `lockMoney`): one key for boosts, campaigns and the guard. */
export const lockTenantBoosts = lockMoney;

function budgetRefusal(check: Exclude<ReturnType<typeof checkBoostBudget>, { ok: true }>): AdsError {
    return new AdsError(400, check.code, check.message, check.field);
}

// ─── Rows ─────────────────────────────────────────────────────────────────────────────────

export type BoostStatus = 'creating' | 'paused' | 'active' | 'completed' | 'failed' | 'deleted';

export interface AdBoostRow extends QueryResultRow {
    id: string;
    creator_id: string;
    scheduled_post_id: string | null;
    platform: BoostPlatform;
    media_id: string;
    ad_account_id: string;
    objective: BoostObjective;
    country: string;
    link: string | null;
    currency: string;
    daily_budget: string;
    days: number;
    planned_total: string;
    status: BoostStatus;
    campaign_id: string | null;
    adset_id: string | null;
    creative_id: string | null;
    ad_id: string | null;
    spend: string | null;
    insights: BoostInsights | null;
    error: string | null;
    created_at: Date;
    activated_at: Date | null;
    ends_at: Date | null;
    synced_at: Date | null;
}

export interface BoostView {
    id: string;
    postId: string | null;
    platform: BoostPlatform;
    objective: BoostObjective;
    country: string;
    link: string | null;
    dailyBudget: number;
    days: number;
    plannedTotal: number;
    currency: string;
    status: BoostStatus;
    campaignId: string | null;
    adsetId: string | null;
    adId: string | null;
    spend: number | null;
    insights: BoostInsights | null;
    error: string | null;
    createdAt: Date;
    activatedAt: Date | null;
    endsAt: Date | null;
    syncedAt: Date | null;
}

export function toView(row: AdBoostRow): BoostView {
    return {
        id: row.id,
        postId: row.scheduled_post_id,
        platform: row.platform,
        objective: row.objective,
        country: row.country,
        link: row.link,
        dailyBudget: Number(row.daily_budget),
        days: row.days,
        plannedTotal: Number(row.planned_total),
        currency: row.currency,
        status: row.status,
        campaignId: row.campaign_id,
        adsetId: row.adset_id,
        adId: row.ad_id,
        spend: row.spend === null ? null : Number(row.spend),
        insights: row.insights,
        error: row.error,
        createdAt: row.created_at,
        activatedAt: row.activated_at,
        endsAt: row.ends_at,
        syncedAt: row.synced_at,
    };
}

export async function listBoosts(creatorId: string): Promise<BoostView[]> {
    const rows = await queryRows<AdBoostRow>('SELECT * FROM ad_boosts WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 200', [creatorId]);
    return rows.map(toView);
}

export async function readBoost(creatorId: string, id: string): Promise<AdBoostRow> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AdsError(404, 'BOOST_NOT_FOUND', 'No such boost.');
    const row = await queryOne<AdBoostRow>('SELECT * FROM ad_boosts WHERE id = $1 AND creator_id = $2', [id, creatorId]);
    if (!row) throw new AdsError(404, 'BOOST_NOT_FOUND', 'No such boost.');
    return row;
}

export async function updateBoost(id: string, fields: Record<string, unknown>): Promise<AdBoostRow> {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const row = await queryOne<AdBoostRow>(
        `UPDATE ad_boosts SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [id, ...keys.map((k) => (k === 'insights' && fields[k] !== null ? JSON.stringify(fields[k]) : fields[k])) as never[]]
    );
    if (!row) throw new AdsError(404, 'BOOST_NOT_FOUND', 'No such boost.');
    return row;
}

// ─── The post ─────────────────────────────────────────────────────────────────────────────

interface BoostTarget {
    postId: string;
    platform: BoostPlatform;
    /** The id as stored: an IG media id, or a Facebook post/photo/video id. */
    storedId: string;
    pageId: string;
    igUserId: string | null;
}

async function readTarget(creatorId: string, postId: unknown, platform: unknown): Promise<BoostTarget> {
    if (typeof platform !== 'string' || !(BOOST_PLATFORMS as readonly string[]).includes(platform)) {
        throw new AdsError(400, 'INVALID', 'Choose Instagram or Facebook.', 'platform');
    }
    if (typeof postId !== 'string' || !/^[0-9a-f-]{36}$/i.test(postId)) throw new AdsError(404, 'POST_NOT_FOUND', 'No such post.');
    const post = await queryOne<{ id: string; status: string; published_post_id: string | null }>(
        'SELECT id, status, published_post_id FROM scheduled_posts WHERE id = $1 AND creator_id = $2',
        [postId, creatorId]
    );
    if (!post) throw new AdsError(404, 'POST_NOT_FOUND', 'No such post.');
    const ids = publishedPlatforms(post.published_post_id);
    const storedId = platform === 'instagram' ? ids.ig : ids.fb;
    if (post.status !== 'PUBLISHED' || !storedId) {
        throw new AdsError(409, 'POST_NOT_PUBLISHED', `This post has no published ${platform === 'instagram' ? 'Instagram' : 'Facebook'} copy to boost.`, 'platform');
    }
    const tenant = await getTenant(creatorId, ['id', 'instagram_page_id', 'facebook_page_id']);
    if (!tenant?.facebook_page_id || (platform === 'instagram' && !tenant.instagram_page_id)) {
        // A boost always runs under the Page (an Instagram creative's `object_id` is the Page), so both need the connection.
        throw new AdsError(409, 'META_NOT_CONNECTED', 'Connect the Facebook Page (and Instagram account) first.');
    }
    return { postId: post.id, platform: platform as BoostPlatform, storedId, pageId: tenant.facebook_page_id, igUserId: tenant.instagram_page_id ?? null };
}

async function mediaIdFor(target: BoostTarget, token: string): Promise<string> {
    if (target.platform === 'instagram') return target.storedId;
    try {
        return await resolveFacebookStoryId(target.pageId, target.storedId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
}

export async function eligibilityFor(creatorId: string, postId: unknown, platform: unknown): Promise<Eligibility> {
    const { token } = await requireConfig(creatorId);
    const target = await readTarget(creatorId, postId, platform);
    const mediaId = await mediaIdFor(target, token);
    try {
        return await checkEligibility(target.platform, mediaId, token);
    } catch (err) {
        // A read Meta refused (a field this version lacks, a permission) is "did not say", not "no": creation is the real test.
        log('warn', 'ads.eligibility_unreadable', { creator_id: creatorId, platform: target.platform, ...describeError(err) });
        return { eligible: null, reason: null };
    }
}

// ─── Create ───────────────────────────────────────────────────────────────────────────────

export interface CreateInput {
    postId: unknown;
    platform: unknown;
    dailyBudget: unknown;
    days: unknown;
    objective: unknown;
    country: unknown;
    link?: unknown;
}

/**
 * Creates the boost PAUSED. Order: validate → the daily max and the money rule (its total must fit what is left this month, the figure the
 * dialog showed) → Meta's account (currency, minimum) → eligibility → the `creating` row (one live boost per post and platform, held by
 * the database) → the four objects, each id recorded as it exists → `paused`. A paused boost spends nothing and reserves nothing: the
 * binding money check is Activate's. A failure after the row exists marks it `failed` and deletes whatever was created (best effort: every
 * object is PAUSED and spends nothing).
 */
export async function createBoost(creatorId: string, input: CreateInput, userId: string | null, now = new Date()): Promise<BoostView> {
    const { settings, token } = await requireConfig(creatorId);
    if (typeof input.objective !== 'string' || !(BOOST_OBJECTIVES as readonly string[]).includes(input.objective)) {
        throw new AdsError(400, 'INVALID', 'Choose an objective: engagement, reach or link clicks.', 'objective');
    }
    const objective = input.objective as BoostObjective;
    const country = normaliseCountry(input.country);
    if (!country) throw new AdsError(400, 'INVALID', 'The country is a two-letter code, e.g. SA.', 'country');
    if (EU_COUNTRIES.has(country)) {
        throw new AdsError(400, 'INVALID', 'Boosting into an EU country needs who pays and who benefits declared (EU Digital Services Act), which Boost does not ask for yet. Choose a country outside the EU, or boost it from Ads Manager.', 'country');
    }
    const link = input.link === undefined || input.link === null || input.link === '' ? null : normaliseLink(input.link);
    if (input.link && !link) throw new AdsError(400, 'INVALID', 'The link must be an https address.', 'link');

    const target = await readTarget(creatorId, input.postId, input.platform);
    const problem = objectiveProblem(target.platform, objective, link);
    if (problem) throw new AdsError(400, 'INVALID', problem, objective === 'TRAFFIC' && target.platform === 'instagram' ? 'link' : 'objective');

    // The daily max first (no Meta call), then the money rule as the screens see it. Activation checks it again, live and under the lock.
    const pre = checkBoostBudget({ dailyBudget: input.dailyBudget, days: input.days, limits: settings });
    if (!pre.ok) throw budgetRefusal(pre);
    const money = await moneyFor(creatorId, settings, token, { kind: 'lifetime', amount: pre.plannedTotal, days: input.days as number }, now);
    if (money.reason === 'OVER_MONTHLY_CAP') {
        throw new AdsError(400, 'OVER_MONTHLY_CAP', `This boost could spend ${pre.plannedTotal}, but only ${money.remaining} of your monthly cap of ${settings.monthlyCap} is left this month.`, 'dailyBudget');
    }

    let account: AdAccountInfo;
    try {
        account = await readAdAccount(settings.adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    // A currency Meta counts in whole units (JPY, KRW…) has no cents: 50.5 would be rounded to 51 at Meta, past the planned total.
    if (currencyOffset(account.currency) === 1 && typeof input.dailyBudget === 'number' && !Number.isInteger(input.dailyBudget)) {
        throw new AdsError(400, 'INVALID', `${account.currency} has no cents: enter a whole amount.`, 'dailyBudget');
    }
    const mediaId = await mediaIdFor(target, token);
    try {
        const eligibility = await checkEligibility(target.platform, mediaId, token);
        if (eligibility.eligible === false) throw new AdsError(409, 'NOT_ELIGIBLE', eligibility.reason ?? 'Meta says this post cannot be boosted.');
    } catch (err) {
        if (err instanceof AdsError) throw err;
        log('warn', 'ads.eligibility_unreadable', { creator_id: creatorId, platform: target.platform, ...describeError(err) });
    }

    const days = input.days as number;
    const check = checkBoostBudget({ dailyBudget: input.dailyBudget, days, limits: settings, minDailyBudget: account.minDailyBudget });
    if (!check.ok) throw budgetRefusal(check);
    const row = await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        const res = await tx.query<AdBoostRow>(
            `INSERT INTO ad_boosts (creator_id, scheduled_post_id, platform, media_id, ad_account_id, objective, country, link, currency,
                                    daily_budget, days, planned_total, status, created_by, ends_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'creating', $13, $14) RETURNING *`,
            [creatorId, target.postId, target.platform, mediaId, settings.adAccountId, objective, country, link, account.currency,
                check.dailyBudget, days, check.plannedTotal, userId, boostWindow(days, now).end]
        );
        return res.rows[0]!;
    }).catch((err) => {
        // migration v53's idx_ad_boosts_one_live: this post already has a live boost on this platform.
        if ((err as { code?: string })?.code === '23505') throw new AdsError(409, 'BOOST_STATE', `This post already has a boost on ${target.platform === 'instagram' ? 'Instagram' : 'Facebook'}: pause or delete it first.`, 'platform');
        throw err;
    });

    let created: CreatedObjects = {};
    try {
        const ids = await createPausedBoost({
            boostId: row.id, adAccountId: settings.adAccountId, platform: target.platform, objective, country, link,
            dailyBudget: Number(row.daily_budget), days, currency: account.currency, pageId: target.pageId, igUserId: target.igUserId, mediaId,
        }, token, now, async (soFar) => {
            created = soFar;
            await updateBoost(row.id, {
                campaign_id: soFar.campaignId ?? null, adset_id: soFar.adsetId ?? null,
                creative_id: soFar.creativeId ?? null, ad_id: soFar.adId ?? null,
            });
        });
        const done = await updateBoost(row.id, { status: 'paused', error: null });
        log('info', 'ads.boost_created', { creator_id: creatorId, boost_id: row.id, platform: target.platform, campaign_id: ids.campaignId });
        return toView(done);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await cleanUp(created, token);
        await updateBoost(row.id, { status: 'failed', error: message.slice(0, 1000) }).catch(() => undefined);
        log('warn', 'ads.boost_create_failed', { creator_id: creatorId, boost_id: row.id, step: nextStep(created), ...describeError(err) });
        throw metaRefusal(err);
    }
}

function nextStep(ids: CreatedObjects): string {
    if (!ids.campaignId) return 'campaign';
    if (!ids.adsetId) return 'ad set';
    if (!ids.creativeId) return 'creative';
    return 'ad';
}

/** Deletes what a failed chain left. The campaign takes its ad set and ad with it; a creative is its own object. Never throws. */
async function cleanUp(ids: CreatedObjects, token: string): Promise<void> {
    for (const id of [ids.campaignId, ids.creativeId]) {
        if (!id) continue;
        try {
            await deleteAdObject(id, token);
        } catch (err) {
            log('warn', 'ads.cleanup_failed', { object_id: id, ...describeError(err) });
        }
    }
}

// ─── Activate, pause, delete ──────────────────────────────────────────────────────────────

/**
 * THE step that spends. Only a `paused` boost with all its objects, and only when its total still fits this month (the month may have
 * changed, the limits been lowered, or other campaigns started since it was created). In three steps, with no Meta call inside the
 * transaction (ads/money.ts):
 *   1. the account and the month are read from Meta live;
 *   2. under the tenant's lock: the row is re-read, the daily max and the money rule (with what else is about to run) re-checked,
 *      `activated_at` written, and the activation recorded as a running op, so a second activation racing this one counts it;
 *   3. ad → ad set → campaign are switched on, the campaign last, and the op is marked done, failed, or `verify` when the call may have
 *      landed (it then keeps counting against the cap for a day, because the boost may be spending).
 */
export async function activateBoost(creatorId: string, id: string, now = new Date(), actor: { userId: string | null } = { userId: null }): Promise<BoostView> {
    const { settings, token } = await requireConfig(creatorId);
    const before = await readBoost(creatorId, id);
    if (before.status !== 'paused' || !before.campaign_id || !before.adset_id || !before.ad_id) {
        throw new AdsError(409, 'BOOST_STATE', `Only a paused boost can be activated; this one is ${before.status}.`);
    }
    const daily = checkDailyMax({ kind: 'lifetime', amount: Number(before.planned_total), days: before.days }, settings.maxDailyBudget);
    if (!daily.ok) throw new AdsError(400, 'OVER_DAILY_MAX', daily.message);
    // Meta cannot take a payment method through the API, and an account without one runs nothing: say so before switching anything on.
    let account: AdAccountState;
    let month;
    try {
        account = await fetchAccountState(settings.adAccountId, token);
        if (account.hasPaymentMethod === false) {
            throw new AdsError(409, 'PAYMENT_METHOD_MISSING', 'This ad account has no payment method, so nothing can run. Add one in Meta (Ads screen → Add payment in Meta), then activate.');
        }
        month = await readMonth(settings.adAccountId, token, account.currency, account.timezoneOffsetHours, before.campaign_id, now);
    } catch (err) {
        throw err instanceof AdsError || err instanceof AdsGraphError ? metaRefusal(err) : new AdsError(502, 'META_ERROR', err instanceof Error ? err.message : String(err));
    }

    let opId: string;
    try {
        ({ opId } = await checkAndStartSpend({
            creatorId, adAccountId: settings.adAccountId, objectKey: before.campaign_id, kind: 'status', month,
            candidate: Number(before.planned_total), monthlyCap: settings.monthlyCap,
            payload: { to: 'ACTIVE', boost_id: id, campaign_id: before.campaign_id }, actor: { userId: actor.userId, via: 'owner' },
            inside: async (tx) => {
                const fresh = (await tx.query<AdBoostRow>('SELECT * FROM ad_boosts WHERE id = $1 AND creator_id = $2 FOR UPDATE', [id, creatorId])).rows[0];
                if (!fresh || fresh.status !== 'paused') throw new AdsError(409, 'BOOST_STATE', 'This boost changed meanwhile: reload and try again.');
                await tx.query('UPDATE ad_boosts SET activated_at = $2, ends_at = $3, updated_at = NOW() WHERE id = $1', [id, now, boostWindow(fresh.days, now).end]);
            },
        }));
    } catch (err) {
        throw metaRefusal(err);
    }

    try {
        await activateBoostObjects({ campaignId: before.campaign_id, adsetId: before.adset_id, adId: before.ad_id }, before.days, token, now);
    } catch (err) {
        await finishSpendOp(opId, mayHaveLanded(err) ? 'verify' : 'failed', { code: (err as MetaApiError)?.metaCode ?? null, message: err instanceof Error ? err.message.slice(0, 300) : null });
        await updateBoost(id, { error: `Activation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000) }).catch(() => undefined);
        log('warn', 'ads.boost_activate_failed', { creator_id: creatorId, boost_id: id, ...describeError(err) });
        throw metaRefusal(err);
    }
    await finishSpendOp(opId, 'done', { campaign_id: before.campaign_id });
    log('info', 'ads.boost_activated', { creator_id: creatorId, boost_id: id, planned_total: Number(before.planned_total) });
    return toView(await updateBoost(id, { status: 'active', error: null }));
}

export async function pauseBoost(creatorId: string, id: string): Promise<BoostView> {
    const { token } = await requireConfig(creatorId);
    const row = await readBoost(creatorId, id);
    // A `paused` row that was activated may be running: its activation's last call can time out after landing. Pausing it is always safe.
    const mayRun = row.status === 'active' || (row.status === 'paused' && row.activated_at !== null);
    if (!mayRun || !row.campaign_id) throw new AdsError(409, 'BOOST_STATE', `Only an active boost can be paused; this one is ${row.status}.`);
    try {
        await pauseBoostCampaign(row.campaign_id, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    return toView(await updateBoost(id, { status: 'paused' }));
}

/** Deletes the campaign at Meta (its ad set and ad go with it) and the creative. Not while it is active: pause it first. */
export async function deleteBoost(creatorId: string, id: string): Promise<BoostView> {
    const { token } = await requireConfig(creatorId);
    const row = await readBoost(creatorId, id);
    if (row.status === 'active' || row.status === 'creating' || row.status === 'deleted') {
        throw new AdsError(409, 'BOOST_STATE', row.status === 'active' ? 'Pause the boost before deleting it.' : `This boost is ${row.status}.`);
    }
    // The last spend first: once deleted, the row's spend is what counts as spent this month, and it must not be a day old.
    if (row.ad_id && row.activated_at) {
        await syncRow(row, token, new Date()).catch((err) => log('warn', 'ads.sync_before_delete_failed', { boost_id: id, ...describeError(err) }));
    }
    try {
        if (row.campaign_id) await deleteAdObject(row.campaign_id, token);
        if (row.creative_id) await deleteAdObject(row.creative_id, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    return toView(await updateBoost(id, { status: 'deleted' }));
}

// ─── Insights ─────────────────────────────────────────────────────────────────────────────

/**
 * The status Meta's answer implies. Meta has no "finished" status for an ad, so the end time decides completion. An ACTIVE answer for a
 * row we hold as paused is an activation whose last call timed out but landed: it is believed, because it is spending.
 */
export function nextStatus(current: BoostStatus, effectiveStatus: string | null, endsAt: Date | null, activated: boolean, now: Date): BoostStatus {
    if (current === 'failed' || current === 'deleted' || current === 'creating') return current;
    if (effectiveStatus === 'DELETED' || effectiveStatus === 'ARCHIVED') return 'deleted';
    if (activated && endsAt && now.getTime() > endsAt.getTime()) return 'completed';
    if (effectiveStatus === 'ACTIVE') return 'active';
    if (effectiveStatus && effectiveStatus.includes('PAUSED') && current === 'active') return 'paused';
    return current;
}

async function syncRow(row: AdBoostRow, token: string, now: Date): Promise<AdBoostRow> {
    if (!row.ad_id) return row;
    const state = await readAdState(row.ad_id, row.objective, token);
    const status = nextStatus(row.status, state.effectiveStatus, row.ends_at, row.activated_at !== null, now);
    // Only if nobody changed the row since it was read: an activation or a pause that ran meanwhile wins over this older picture.
    const updated = await queryOne<AdBoostRow>(
        `UPDATE ad_boosts SET status = $3, spend = $4, insights = $5::jsonb, synced_at = $6, updated_at = NOW()
          WHERE id = $1 AND status = $2 RETURNING *`,
        [row.id, row.status, status, state.insights ? state.insights.spend : row.spend, JSON.stringify(state.insights ?? row.insights ?? null), now]
    );
    return updated ?? (await queryOne<AdBoostRow>('SELECT * FROM ad_boosts WHERE id = $1', [row.id])) ?? row;
}

export async function refreshBoost(creatorId: string, id: string, now = new Date()): Promise<BoostView> {
    const { token } = await requireConfig(creatorId);
    const row = await readBoost(creatorId, id);
    if (!row.ad_id || row.status === 'deleted' || row.status === 'failed') return toView(row);
    try {
        return toView(await syncRow(row, token, now));
    } catch (err) {
        throw metaRefusal(err);
    }
}

/**
 * The daily insights read (the cron's): every paused or active boost, and each completed in the last three days so its final spend lands.
 * Per row fail-soft. A tenant whose ads token is gone is skipped.
 */
export async function syncAllBoosts(now = new Date()): Promise<{ synced: number; failed: number; skipped: number }> {
    const rows = await queryRows<AdBoostRow>(
        `SELECT * FROM ad_boosts
          WHERE ad_id IS NOT NULL
            AND (status IN ('paused', 'active') OR (status = 'completed' AND ends_at > $1))
          ORDER BY creator_id, created_at LIMIT 100`,
        [new Date(now.getTime() - 3 * 86_400_000)]
    );
    const out = { synced: 0, failed: 0, skipped: 0 };
    const tokens = new Map<string, string | null>();

    // A chain that died mid-way (the function was frozen or timed out) leaves a row in `creating` forever, counted against the cap. After
    // ten minutes it is failed, and whatever it created (all PAUSED) is deleted.
    const stuck = await queryRows<AdBoostRow>(
        "SELECT * FROM ad_boosts WHERE status = 'creating' AND created_at < $1 ORDER BY created_at LIMIT 20",
        [new Date(now.getTime() - 10 * 60_000)]
    );
    for (const row of stuck) {
        if (!tokens.has(row.creator_id)) tokens.set(row.creator_id, (await readAdsSettings(row.creator_id)).token);
        const token = tokens.get(row.creator_id);
        if (token) await cleanUp({ campaignId: row.campaign_id ?? undefined, creativeId: row.creative_id ?? undefined }, token);
        await queryOne("UPDATE ad_boosts SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1 AND status = 'creating' RETURNING id",
            [row.id, 'Creating this boost stopped part way; what was made at Meta (all paused) was deleted.']);
        log('warn', 'ads.boost_creating_swept', { creator_id: row.creator_id, boost_id: row.id });
    }
    for (const row of rows) {
        if (!tokens.has(row.creator_id)) tokens.set(row.creator_id, (await readAdsSettings(row.creator_id)).token);
        const token = tokens.get(row.creator_id);
        if (!token) {
            out.skipped++;
            continue;
        }
        try {
            await syncRow(row, token, now);
            out.synced++;
        } catch (err) {
            out.failed++;
            log('warn', 'ads.sync_failed', { creator_id: row.creator_id, boost_id: row.id, ...describeError(err) });
        }
    }
    return out;
}
