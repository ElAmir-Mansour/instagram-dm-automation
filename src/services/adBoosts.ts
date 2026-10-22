/**
 * Boost: the store and the order of operations (docs/META_ADS_RESEARCH.md option 2). `src/services/metaAds.ts` holds the payloads and the
 * Graph calls; `src/routes/ads.ts` the routes. Migration v52 is the table.
 *
 * Config is per tenant and DB-first (`app_settings`, families `ads.settings.<tenant>` and `ads.token.<tenant>`), never env: the ad account
 * id, the max daily budget and the monthly spend cap are the owner's to change from Settings, and the system-user token is encrypted at rest.
 *
 * The money rule: a boost is created PAUSED, and the server checks `checkBoostBudget` both when it is created and when it is activated,
 * under a per-tenant advisory lock, so two requests at once cannot both fit under the cap. What counts against the cap this month
 * (`committedThisMonth`): every boost created or activated this UTC month that is creating, paused or active at its planned total (the
 * ad set's lifetime budget, which Meta does not exceed), and every completed or deleted one that ran at what it spent.
 */
import type { QueryResultRow } from 'pg';
import { queryOne, queryRows } from '../db/query.js';
import { log, describeError } from '../utils/log.js';
import { getSetting, last4, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from './appSettings.js';
import { publishedPlatforms } from './publishedIds.js';
import { getTenant } from './tenant.js';
import { withTransaction, type Exec } from './studio/common.js';
import { MetaApiError } from './instagram.js';
import { inspectToken } from './tokenHealth.js';
import {
    activateBoostObjects, BOOST_OBJECTIVES, BOOST_PLATFORMS, checkBoostBudget, checkEligibility, createPausedBoost, deleteAdObject,
    normaliseAdAccountId, normaliseCountry, normaliseLink, objectiveProblem, pauseBoostCampaign, readAdAccount, readAdState,
    resolveFacebookStoryId, roundMoney, boostWindow, listAdAccounts, fetchAccountState, type AdAccountState, pickAdAccount, type AdAccountChoice, type AdAccountInfo, type BoostInsights, type BoostObjective, type BoostPlatform,
    type BudgetRefusal, type CreatedObjects, type Eligibility,
} from './metaAds.js';

// ─── Errors ───────────────────────────────────────────────────────────────────────────────

export type AdsErrorCode =
    | BudgetRefusal
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

/** A refusal the route answers as `{ error, code, field? }` with `status`. */
export class AdsError extends Error {
    constructor(readonly status: number, readonly code: AdsErrorCode, message: string, readonly field?: string, readonly metaCode?: number) {
        super(message);
        this.name = 'AdsError';
    }
}

export function metaRefusal(err: unknown): AdsError {
    const metaCode = err instanceof MetaApiError ? err.metaCode : undefined;
    return new AdsError(502, 'META_ERROR', err instanceof Error ? err.message : 'Meta refused the request.', undefined, metaCode);
}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────

export interface AdsSettings {
    adAccountId: string | null;
    maxDailyBudget: number | null;
    monthlyCap: number | null;
    /**
     * Where the ads token came from: `connect` (granted on Facebook Login, a long-lived USER token of about 60 days that a Reconnect
     * renews, and removed when Meta is disconnected) or `pasted` (a system-user token the owner pasted, which never expires).
     */
    tokenSource: 'connect' | 'pasted' | null;
    /** ISO time a `connect` token stops working, from Meta's `debug_token`. Null for one that does not expire, or unknown. */
    tokenExpiresAt: string | null;
}

const EMPTY_SETTINGS: AdsSettings = { adAccountId: null, maxDailyBudget: null, monthlyCap: null, tokenSource: null, tokenExpiresAt: null };

/** The highest limit the card accepts, in major units: a typo of an extra zero or three should be refused, not spent. */
export const ADS_LIMIT_MAX = 1_000_000;

function positiveMoney(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ADS_LIMIT_MAX ? roundMoney(value) : null;
}

/** The stored JSON, read defensively: anything unreadable is "not set", which refuses boosts rather than spending without a limit. */
export function parseStoredSettings(raw: string | null): AdsSettings {
    if (!raw) return { ...EMPTY_SETTINGS };
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
            adAccountId: normaliseAdAccountId(parsed['adAccountId']),
            maxDailyBudget: positiveMoney(parsed['maxDailyBudget']),
            monthlyCap: positiveMoney(parsed['monthlyCap']),
            tokenSource: parsed['tokenSource'] === 'connect' || parsed['tokenSource'] === 'pasted' ? parsed['tokenSource'] : null,
            tokenExpiresAt: typeof parsed['tokenExpiresAt'] === 'string' && !Number.isNaN(Date.parse(parsed['tokenExpiresAt'])) ? parsed['tokenExpiresAt'] : null,
        };
    } catch {
        return { ...EMPTY_SETTINGS };
    }
}

export interface SettingsInput {
    settings: Partial<AdsSettings>;
    /** Absent: leave the token. Null: remove it. A string: the new token. */
    token?: string | null;
}

export type ParsedSettingsInput = { ok: true; value: SettingsInput } | { ok: false; error: string; field: string };

/**
 * The card's body: any subset of `{ adAccountId, token, maxDailyBudget, monthlyCap }`. Absent leaves a value; '' clears the account id or
 * the token. Every field is checked before anything is written. The daily max may not exceed the monthly cap (it could never be used).
 */
export function parseSettingsInput(body: unknown, current: AdsSettings): ParsedSettingsInput {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const out: SettingsInput = { settings: {} };

    if (b['adAccountId'] !== undefined) {
        if (b['adAccountId'] === '' || b['adAccountId'] === null) out.settings.adAccountId = null;
        else {
            const id = normaliseAdAccountId(b['adAccountId']);
            if (!id) return { ok: false, error: 'The ad account id is the number in Ads Manager, e.g. act_1234567890.', field: 'adAccountId' };
            out.settings.adAccountId = id;
        }
    }
    if (b['token'] !== undefined) {
        if (b['token'] === '' || b['token'] === null) out.token = null;
        else if (typeof b['token'] !== 'string' || !/^[A-Za-z0-9_\-|.]{20,1000}$/.test(b['token'].trim())) {
            return { ok: false, error: 'That does not look like a Meta access token.', field: 'token' };
        } else out.token = b['token'].trim();
    }
    for (const field of ['maxDailyBudget', 'monthlyCap'] as const) {
        if (b[field] === undefined) continue;
        if (b[field] === null || b[field] === '') {
            out.settings[field] = null;
            continue;
        }
        const n = typeof b[field] === 'string' ? Number(b[field]) : b[field];
        const value = positiveMoney(n);
        if (value === null) return { ok: false, error: `Enter an amount above 0 and at most ${ADS_LIMIT_MAX}.`, field };
        out.settings[field] = value;
    }

    const after = { ...current, ...out.settings };
    if (after.maxDailyBudget !== null && after.monthlyCap !== null && after.maxDailyBudget > after.monthlyCap) {
        return { ok: false, error: 'The max daily budget cannot be more than the monthly spend cap.', field: 'maxDailyBudget' };
    }
    if (Object.keys(out.settings).length === 0 && out.token === undefined) return { ok: false, error: 'Nothing to save.', field: 'adAccountId' };
    return { ok: true, value: out };
}

export async function readAdsSettings(creatorId: string): Promise<{ settings: AdsSettings; token: string | null }> {
    const [raw, token] = await Promise.all([
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, creatorId)),
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, creatorId)),
    ]);
    return { settings: parseStoredSettings(raw), token };
}

export async function saveAdsSettings(creatorId: string, input: SettingsInput, current: AdsSettings, updatedBy: string | null): Promise<void> {
    // A token typed on the card is a pasted one; removing it forgets where the old one came from.
    const tokenMeta: Partial<AdsSettings> = input.token === undefined ? {} : { tokenSource: input.token ? 'pasted' : null, tokenExpiresAt: null };
    if (Object.keys(input.settings).length > 0 || input.token !== undefined) {
        const next = { ...current, ...input.settings, ...tokenMeta };
        await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, creatorId), JSON.stringify(next), updatedBy);
    }
    if (input.token !== undefined) {
        await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, creatorId), input.token, updatedBy);
    }
}

function isConfigured(settings: AdsSettings, token: string | null): boolean {
    return Boolean(settings.adAccountId && token && settings.maxDailyBudget && settings.monthlyCap);
}

export interface AdsSettingsView {
    configured: boolean;
    adAccountId: string | null;
    token: { set: boolean; last4: string | null };
    tokenSource: AdsSettings['tokenSource'];
    tokenExpiresAt: string | null;
    maxDailyBudget: number | null;
    monthlyCap: number | null;
    committedThisMonth: number;
    account: AdAccountInfo | null;
    accountError: string | null;
}

/** What the Settings card shows. With an account id and a token it asks Meta about the account, which proves both. Never the token. */
export async function describeAdsSettings(creatorId: string, now = new Date()): Promise<AdsSettingsView> {
    const { settings, token } = await readAdsSettings(creatorId);
    let account: AdAccountInfo | null = null;
    let accountError: string | null = null;
    if (settings.adAccountId && token) {
        try {
            account = await readAdAccount(settings.adAccountId, token);
        } catch (err) {
            accountError = err instanceof Error ? err.message : 'Meta did not answer.';
        }
    }
    return {
        configured: isConfigured(settings, token),
        adAccountId: settings.adAccountId,
        token: { set: Boolean(token), last4: token ? last4(token) : null },
        tokenSource: token ? settings.tokenSource : null,
        tokenExpiresAt: token ? settings.tokenExpiresAt : null,
        maxDailyBudget: settings.maxDailyBudget,
        monthlyCap: settings.monthlyCap,
        committedThisMonth: await committedThisMonth(null, creatorId, null, now),
        account,
        accountError,
    };
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

/** The ad accounts the saved token reaches, for the Settings card's picker. */
export async function listAdAccountsFor(creatorId: string): Promise<AdAccountChoice[]> {
    const { token } = await readAdsSettings(creatorId);
    if (!token) throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Connect Meta with ads access (or paste a token) first.');
    try {
        return await listAdAccounts(token);
    } catch (err) {
        throw metaRefusal(err);
    }
}

export async function requireConfig(creatorId: string): Promise<{ settings: AdsSettings & { adAccountId: string; maxDailyBudget: number; monthlyCap: number }; token: string }> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!isConfigured(settings, token)) {
        throw new AdsError(409, 'ADS_NOT_CONFIGURED', 'Set the ad account, the ads token, the max daily budget and the monthly cap in Settings first.');
    }
    return { settings: settings as AdsSettings & { adAccountId: string; maxDailyBudget: number; monthlyCap: number }, token: token! };
}

// ─── The cap ──────────────────────────────────────────────────────────────────────────────

/** The first instant of `now`'s UTC calendar month. */
export function monthStartUtc(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const COMMITTED_SQL = `
    SELECT COALESCE(SUM(CASE
               WHEN status IN ('creating', 'paused', 'active') THEN planned_total
               WHEN status IN ('completed', 'deleted') AND activated_at IS NOT NULL THEN COALESCE(spend, planned_total)
               ELSE 0 END), 0)::text AS committed
      FROM ad_boosts
     WHERE creator_id = $1
       AND COALESCE(activated_at, created_at) >= $2
       AND ($3::uuid IS NULL OR id <> $3::uuid)`;

/** What counts against this month's cap, `excludeId` aside (the boost being activated). See the top of the file. */
export async function committedThisMonth(exec: Exec | null, creatorId: string, excludeId: string | null, now: Date): Promise<number> {
    const params = [creatorId, monthStartUtc(now), excludeId];
    const row = exec
        ? (await exec.query<{ committed: string }>(COMMITTED_SQL, params)).rows[0]
        : await queryOne<{ committed: string }>(COMMITTED_SQL, params);
    return roundMoney(Number(row?.committed ?? 0));
}

/** One tenant's budget checks and the writes that follow them, one at a time. Held until the transaction ends. */
export async function lockTenantBoosts(exec: Exec, creatorId: string): Promise<void> {
    await exec.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`ad_boosts:${creatorId}`]);
}

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
 * Creates the boost PAUSED. Order: validate → Meta's account (currency, minimum) → eligibility → under the tenant's lock, the cap check and
 * the `creating` row (which counts against the cap from that moment) → the four objects, each id recorded as it exists → `paused`.
 * A failure after the row exists marks it `failed` and deletes whatever was created (best effort: every object is PAUSED and spends nothing).
 */
export async function createBoost(creatorId: string, input: CreateInput, userId: string | null, now = new Date()): Promise<BoostView> {
    const { settings, token } = await requireConfig(creatorId);
    if (typeof input.objective !== 'string' || !(BOOST_OBJECTIVES as readonly string[]).includes(input.objective)) {
        throw new AdsError(400, 'INVALID', 'Choose an objective: engagement, reach or link clicks.', 'objective');
    }
    const objective = input.objective as BoostObjective;
    const country = normaliseCountry(input.country);
    if (!country) throw new AdsError(400, 'INVALID', 'The country is a two-letter code, e.g. SA.', 'country');
    const link = input.link === undefined || input.link === null || input.link === '' ? null : normaliseLink(input.link);
    if (input.link && !link) throw new AdsError(400, 'INVALID', 'The link must be an https address.', 'link');

    const target = await readTarget(creatorId, input.postId, input.platform);
    const problem = objectiveProblem(target.platform, objective, link);
    if (problem) throw new AdsError(400, 'INVALID', problem, objective === 'TRAFFIC' && target.platform === 'instagram' ? 'link' : 'objective');

    // A first cheap check before calling Meta at all; the binding one is under the lock below.
    const pre = checkBoostBudget({ dailyBudget: input.dailyBudget, days: input.days, limits: settings, committedThisMonth: await committedThisMonth(null, creatorId, null, now) });
    if (!pre.ok) throw budgetRefusal(pre);

    let account: AdAccountInfo;
    try {
        account = await readAdAccount(settings.adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
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
    const row = await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        const check = checkBoostBudget({
            dailyBudget: input.dailyBudget, days, limits: settings,
            committedThisMonth: await committedThisMonth(tx, creatorId, null, now),
            minDailyBudget: account.minDailyBudget,
        });
        if (!check.ok) throw budgetRefusal(check);
        const res = await tx.query<AdBoostRow>(
            `INSERT INTO ad_boosts (creator_id, scheduled_post_id, platform, media_id, ad_account_id, objective, country, link, currency,
                                    daily_budget, days, planned_total, status, created_by, ends_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'creating', $13, $14) RETURNING *`,
            [creatorId, target.postId, target.platform, mediaId, settings.adAccountId, objective, country, link, account.currency,
                check.dailyBudget, days, check.plannedTotal, userId, boostWindow(days, now).end]
        );
        return res.rows[0]!;
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
 * THE step that spends. Only a `paused` boost with all its objects, and only when its planned total still fits this month's cap (the
 * month may have changed, or the limits been lowered, since it was created). `activated_at` is written under the lock before Meta is
 * called, so the boost counts against this month while the calls run; a failed activation leaves it `paused` and still counted, because
 * a timed-out call may have switched something on.
 */
export async function activateBoost(creatorId: string, id: string, now = new Date()): Promise<BoostView> {
    const { settings, token } = await requireConfig(creatorId);
    const before = await readBoost(creatorId, id);
    if (before.status !== 'paused' || !before.campaign_id || !before.adset_id || !before.ad_id) {
        throw new AdsError(409, 'BOOST_STATE', `Only a paused boost can be activated; this one is ${before.status}.`);
    }
    // Meta cannot take a payment method through the API, and an account without one runs nothing: say so before switching anything on.
    let account: AdAccountState;
    try {
        account = await fetchAccountState(settings.adAccountId, token);
    } catch (err) {
        throw metaRefusal(err);
    }
    if (account.hasPaymentMethod === false) {
        throw new AdsError(409, 'PAYMENT_METHOD_MISSING', 'This ad account has no payment method, so nothing can run. Add one in Meta (Ads screen → Add payment in Meta), then activate.');
    }

    await withTransaction(async (tx) => {
        await lockTenantBoosts(tx, creatorId);
        const fresh = (await tx.query<AdBoostRow>('SELECT * FROM ad_boosts WHERE id = $1 AND creator_id = $2 FOR UPDATE', [id, creatorId])).rows[0];
        if (!fresh || fresh.status !== 'paused') throw new AdsError(409, 'BOOST_STATE', 'This boost changed meanwhile: reload and try again.');
        const check = checkBoostBudget({
            dailyBudget: Number(fresh.daily_budget), days: fresh.days, limits: settings,
            committedThisMonth: await committedThisMonth(tx, creatorId, id, now),
        });
        if (!check.ok) throw budgetRefusal(check);
        await tx.query('UPDATE ad_boosts SET activated_at = $2, ends_at = $3, updated_at = NOW() WHERE id = $1', [id, now, boostWindow(fresh.days, now).end]);
    });

    try {
        await activateBoostObjects({ campaignId: before.campaign_id, adsetId: before.adset_id, adId: before.ad_id }, before.days, token, now);
    } catch (err) {
        await updateBoost(id, { error: `Activation failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000) }).catch(() => undefined);
        log('warn', 'ads.boost_activate_failed', { creator_id: creatorId, boost_id: id, ...describeError(err) });
        throw metaRefusal(err);
    }
    log('info', 'ads.boost_activated', { creator_id: creatorId, boost_id: id, planned_total: Number(before.planned_total) });
    return toView(await updateBoost(id, { status: 'active', error: null }));
}

export async function pauseBoost(creatorId: string, id: string): Promise<BoostView> {
    const { token } = await requireConfig(creatorId);
    const row = await readBoost(creatorId, id);
    if (row.status !== 'active' || !row.campaign_id) throw new AdsError(409, 'BOOST_STATE', `Only an active boost can be paused; this one is ${row.status}.`);
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
    return updateBoost(row.id, {
        status,
        spend: state.insights ? state.insights.spend : row.spend,
        insights: state.insights ?? row.insights,
        synced_at: now,
    });
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
