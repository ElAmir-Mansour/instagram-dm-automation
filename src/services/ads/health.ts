/**
 * The ads health check (research R8): once a day from the cron, for every tenant with ads enabled and a token, and on demand from
 * Settings → "Test connection". It checks:
 *   1. the token: `debug_token` for a Connect token (it expires: `token_expiring` within 14 days), a cheap `GET /me` for a pasted
 *      system-user token; Meta's 190/102 is `token_dead`, which also stops the tenant's ads writes (`isQueueStopped`);
 *   2. the ad account: its status (2, 100, 101 → `account_disabled`; 3, 9 → `payment`) and its funding (none → `payment`);
 *   3. the version Meta served the call on (`version_mismatch` when it is not the pinned one).
 * (Disapproved ads from the stored copy join in phase A2, when there is a stored copy.)
 *
 * What it saw is written to `ads.health.<tenant>`, the stored copy every ads screen reads instead of calling Meta: never a token, never
 * the card's display string. Alerts go through notify.ts, once a day each.
 *
 * Also here: the daily retention sweep (`ads_alerts` after a year, finished `ads_ops` after 180 days, results after 37 months), and the Settings card's view.
 */
import { describeError, log } from '../../utils/log.js';
import { queryCount, queryRows } from '../../db/query.js';
import { getSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { inspectToken } from '../tokenHealth.js';
import { metaErrorCode, metaErrorSubcode } from '../http.js';
import { normaliseAdAccountId, readAccountState } from './metaAds.js';
import { adsApiVersion, adsGet, AdsGraphError, withAdsContext } from './graph.js';
import { readUsage } from './metaUsage.js';
import { notifyAds, type AdsAlert } from './notify.js';
import {
    alertsView, isConfigured, readAdsSettings, readAlerts, readCeiling, readHealth, readSwitches, setupSteps, tokenView, writeHealth,
    type AccountSnapshot, type AdsHealth, type AdsSettings, type TokenHealth,
} from './settings.js';
import { spendCapChangesLeft } from './spendCap.js';

export const EXPIRY_WARNING_DAYS = 14;
/** What a system-user token needs for everything the Ads Manager does (Help → Ads → Connect lists the same). */
export const ADS_SCOPES = ['ads_management', 'ads_read', 'business_management', 'pages_read_engagement', 'pages_manage_ads'] as const;

const BILLING_FIELDS = ['funding_source', 'funding_source_details', 'balance'];
export const HEALTH_FIELDS = [
    'name', 'currency', 'timezone_name', 'timezone_offset_hours_utc', 'account_status', 'disable_reason', ...BILLING_FIELDS,
    'is_prepay_account', 'spend_cap', 'amount_spent', 'min_daily_budget', 'tos_accepted', 'business',
].join(',');

// ─── Pure ───────────────────────────────────────────────────────────────────────────────────

/** What an account's state asks of the owner. */
export function accountAlerts(a: AccountSnapshot): AdsAlert[] {
    const out: AdsAlert[] = [];
    if (a.status === 2 || a.status === 100 || a.status === 101) {
        out.push({ kind: 'account_disabled', status: a.status, label: a.statusLabel, disableReason: a.disableReason });
        return out;
    }
    if (a.status === 3) out.push({ kind: 'payment', reason: 'unsettled', status: a.status });
    else if (a.status === 9) out.push({ kind: 'payment', reason: 'grace_period', status: a.status });
    else if (a.hasPaymentMethod === false) out.push({ kind: 'payment', reason: 'no_payment_method', status: a.status });
    return out;
}

function snapshotOf(adAccountId: string, data: unknown, paymentReadable: boolean, now: Date): AccountSnapshot {
    const s = readAccountState(adAccountId, data, paymentReadable);
    return {
        name: s.name, currency: s.currency, timezone: s.timezoneName, timezoneOffsetHours: s.timezoneOffsetHours, status: s.status,
        statusLabel: s.statusLabel, disableReason: s.disableReason, hasPaymentMethod: s.hasPaymentMethod, isPrepay: s.isPrepay,
        spendCap: s.spendCap, amountSpent: s.amountSpent, minDailyBudget: s.minDailyBudget, billingUrl: s.billingUrl,
        adsManagerUrl: s.adsManagerUrl, syncedAt: now.toISOString(),
    };
}

// ─── Reading Meta ───────────────────────────────────────────────────────────────────────────

/** The account node with its billing fields, or without them when the token may not read billing (then payment is "unknown"). */
async function readAccount(adAccountId: string, token: string, now: Date): Promise<{ snapshot: AccountSnapshot; headers: unknown }> {
    try {
        const res = await adsGet(`act_${adAccountId}`, { fields: HEALTH_FIELDS }, token, { label: 'account health' });
        return { snapshot: snapshotOf(adAccountId, res.data, true, now), headers: res.headers };
    } catch (err) {
        if (metaErrorCode(err) !== 100 && metaErrorCode(err) !== 200) throw err;
        const fields = HEALTH_FIELDS.split(',').filter((f) => !BILLING_FIELDS.includes(f)).join(',');
        const res = await adsGet(`act_${adAccountId}`, { fields }, token, { label: 'account health (no billing)' });
        return { snapshot: snapshotOf(adAccountId, res.data, false, now), headers: res.headers };
    }
}

interface TokenVerdict {
    health: TokenHealth;
    scopes: string[];
    expiresAt: string | null;
    code: number | null;
}

/** `debug_token` says what a Connect token's expiry and scopes are; `GET /me` is the cheapest proof a pasted one still works. */
async function checkToken(settings: AdsSettings, token: string, now: Date): Promise<TokenVerdict> {
    if (settings.tokenSource === 'connect') {
        const inspection = await inspectToken(token);
        if (!inspection.isValid) return { health: 'dead', scopes: inspection.scopes, expiresAt: null, code: 190 };
        const expiresAt = inspection.expiresAt ? inspection.expiresAt.toISOString() : settings.tokenExpiresAt;
        const left = expiresAt ? Date.parse(expiresAt) - now.getTime() : Infinity;
        return { health: left <= EXPIRY_WARNING_DAYS * 86_400_000 ? 'expiring' : 'ok', scopes: inspection.scopes, expiresAt, code: null };
    }
    try {
        await adsGet('me', { fields: 'id' }, token, { label: 'token check' });
        return { health: 'ok', scopes: [], expiresAt: null, code: null };
    } catch (err) {
        if (err instanceof AdsGraphError && err.klass === 'token_dead') return { health: 'dead', scopes: [], expiresAt: null, code: err.metaCode ?? null };
        throw err;
    }
}

export interface TenantHealthResult {
    ok: boolean;
    /** The kinds of alert this check raised (before the per-day dedupe). */
    alerts: AdsAlert['kind'][];
    health: AdsHealth;
}

/** One tenant's check. Writes `ads.health.<tenant>` and raises the alerts. Throws only for what it could not read (the caller logs). */
export async function checkTenantHealth(creatorId: string, now = new Date()): Promise<TenantHealthResult> {
    const { settings, token } = await readAdsSettings(creatorId);
    const health = await readHealth(creatorId);
    if (!token || !settings.adAccountId) return { ok: false, alerts: [], health };
    const adAccountId = settings.adAccountId;
    const raised: AdsAlert[] = [];

    await withAdsContext({ creatorId, adAccountId }, async () => {
        const verdict = await checkToken(settings, token, now);
        health.token = { ...health.token, health: verdict.health, checkedAt: now.toISOString(), ...(verdict.scopes.length ? { scopes: verdict.scopes, missingScopes: ADS_SCOPES.filter((s) => !verdict.scopes.includes(s)) } : {}) };
        if (verdict.health === 'dead') {
            raised.push({ kind: 'token_dead', code: verdict.code });
            return;
        }
        if (verdict.health === 'expiring' && verdict.expiresAt) {
            raised.push({ kind: 'token_expiring', expiresAt: verdict.expiresAt, daysLeft: Math.max(0, Math.ceil((Date.parse(verdict.expiresAt) - now.getTime()) / 86_400_000)) });
        }
        const { snapshot, headers } = await readAccount(adAccountId, token, now);
        const usage = readUsage(headers);
        const pinned = await adsApiVersion();
        health.account = snapshot;
        health.accountError = null;
        health.servedVersion = usage.servedVersion ?? health.servedVersion;
        health.tier = usage.tier ?? health.tier;
        if (usage.servedVersion && usage.servedVersion !== pinned) raised.push({ kind: 'version_mismatch', pinned, served: usage.servedVersion });
        raised.push(...accountAlerts(snapshot));
    });

    health.checkedAt = now.toISOString();
    await writeHealth(creatorId, health);
    const target = { creatorId, adAccountId, accountName: health.account?.name ?? null, offsetHours: health.account?.timezoneOffsetHours ?? 0 };
    for (const alert of raised) await notifyAds(alert, target, { now });
    return { ok: true, alerts: raised.map((a) => a.kind), health };
}

/** Every tenant with ads enabled. */
async function enabledTenants(): Promise<string[]> {
    const rows = await queryRows<{ key: string }>("SELECT key FROM app_settings WHERE key LIKE 'ads.enabled.%' AND value = 'true'");
    return rows.map((r) => r.key.slice(TENANT_SETTING_PREFIXES.adsEnabled.length)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
}

/** The daily pass (the cron): every enabled tenant, fail-soft per tenant, then the retention sweep. */
export async function runAdsHealth(opts: { now?: Date; deadline?: number } = {}): Promise<{ checked: number; failed: number; alerts: number; swept: number }> {
    const now = opts.now ?? new Date();
    const out = { checked: 0, failed: 0, alerts: 0, swept: 0 };
    for (const creatorId of await enabledTenants()) {
        if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
        try {
            const r = await checkTenantHealth(creatorId, now);
            if (r.ok) out.checked++;
            out.alerts += r.alerts.length;
        } catch (err) {
            out.failed++;
            log('warn', 'ads.health_failed', { creator_id: creatorId, meta_code: metaErrorCode(err) ?? null, meta_subcode: metaErrorSubcode(err) ?? null, ...describeError(err) });
            const health = await readHealth(creatorId).catch(() => null);
            if (health) await writeHealth(creatorId, { ...health, accountError: err instanceof Error ? err.message.slice(0, 300) : 'Meta did not answer.', checkedAt: now.toISOString() }).catch(() => undefined);
        }
    }
    try {
        out.swept += await queryCount("DELETE FROM ads_alerts WHERE created_at < NOW() - INTERVAL '1 year'");
        out.swept += await queryCount("DELETE FROM ads_ops WHERE created_at < NOW() - INTERVAL '180 days' AND state IN ('done', 'failed', 'cancelled')");
        // Results are kept 37 months, Meta's own horizon for aggregate results (privacy.html says so); the breakdowns go with them.
        out.swept += await queryCount("DELETE FROM ads_insights_daily WHERE day < CURRENT_DATE - INTERVAL '37 months'");
        out.swept += await queryCount("DELETE FROM ads_insights_breakdown WHERE day < CURRENT_DATE - INTERVAL '37 months'");
    } catch (err) {
        log('warn', 'ads.retention_failed', describeError(err));
    }
    return out;
}

// ─── Test connection ────────────────────────────────────────────────────────────────────────

export interface ConnectionTest {
    ok: true;
    scopes: string[];
    missingScopes: string[];
    assets: NonNullable<AdsHealth['assets']>;
    tier: string | null;
    servedVersion: string | null;
}

/**
 * Settings → "Test connection" (1–2 points on the ad account, the rest on the token): who the token is, what it reaches, its scopes, and
 * the configured account's state. Everything is stored in `ads.health.<tenant>`, which the card and the account picker then read.
 */
export async function testConnection(creatorId: string, now = new Date()): Promise<ConnectionTest> {
    const { settings, token } = await readAdsSettings(creatorId);
    if (!token) throw new Error('NO_TOKEN');
    const health = await readHealth(creatorId);
    return withAdsContext({ creatorId, adAccountId: settings.adAccountId }, async () => {
        const me = await adsGet('me', { fields: 'id,name' }, token, { label: 'token test' });
        const [accounts, pages, inspection] = await Promise.all([
            adsGet('me/adaccounts', { fields: 'account_id,name,currency,account_status', limit: '200' }, token, { label: 'ad accounts' }),
            adsGet('me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: '100' }, token, { label: 'pages' }).catch((err) => {
                log('info', 'ads.test_pages_unreadable', { creator_id: creatorId, meta_code: metaErrorCode(err) ?? null });
                return null;
            }),
            inspectToken(token).catch(() => null),
        ]);
        const assets: NonNullable<AdsHealth['assets']> = { adAccounts: [], pages: [], igAccounts: [] };
        for (const r of Array.isArray(accounts.data?.data) ? accounts.data.data : []) {
            const id = normaliseAdAccountId(typeof r?.account_id === 'string' ? r.account_id : typeof r?.id === 'string' ? r.id : '');
            if (id) assets.adAccounts.push({ id, name: typeof r?.name === 'string' ? r.name : null, currency: typeof r?.currency === 'string' ? r.currency : null, status: typeof r?.account_status === 'number' ? r.account_status : null });
        }
        for (const p of Array.isArray(pages?.data?.data) ? pages!.data.data : []) {
            if (typeof p?.id !== 'string') continue;
            assets.pages.push({ id: p.id, name: typeof p?.name === 'string' ? p.name : null });
            const ig = p?.instagram_business_account;
            if (ig && typeof ig.id === 'string') assets.igAccounts.push({ id: ig.id, username: typeof ig.username === 'string' ? ig.username : null });
        }
        const scopes = inspection?.scopes ?? [];
        health.token = { health: inspection && !inspection.isValid ? 'dead' : 'ok', checkedAt: now.toISOString(), scopes, missingScopes: scopes.length ? ADS_SCOPES.filter((s) => !scopes.includes(s)) : [] };
        health.assets = assets;
        let usage = readUsage(me.headers);
        if (settings.adAccountId) {
            try {
                const { snapshot, headers } = await readAccount(settings.adAccountId, token, now);
                health.account = snapshot;
                health.accountError = null;
                usage = readUsage(headers);
            } catch (err) {
                health.accountError = err instanceof Error ? err.message.slice(0, 300) : 'Meta did not answer.';
            }
        }
        health.tier = usage.tier ?? health.tier;
        health.servedVersion = usage.servedVersion ?? health.servedVersion;
        health.checkedAt = now.toISOString();
        await writeHealth(creatorId, health);
        return { ok: true as const, scopes, missingScopes: health.token.missingScopes, assets, tier: health.tier, servedVersion: health.servedVersion };
    });
}

// ─── The Settings card's view ───────────────────────────────────────────────────────────────

/**
 * `GET /api/ads/settings`: stored data only. The one exception is a tenant whose account was never checked: its first view reads the
 * account once (1 point) so the steps are not all "unknown" until the next daily check.
 */
export async function describeAdsSettings(creatorId: string, now = new Date()) {
    const { settings, token } = await readAdsSettings(creatorId);
    let health = await readHealth(creatorId);
    if (token && settings.adAccountId && !health.account && !health.accountError && health.token.health !== 'dead') {
        try {
            await withAdsContext({ creatorId, adAccountId: settings.adAccountId }, async () => {
                const { snapshot } = await readAccount(settings.adAccountId!, token, now);
                health = { ...health, account: snapshot, checkedAt: now.toISOString() };
            });
        } catch (err) {
            health = { ...health, accountError: err instanceof Error ? err.message.slice(0, 300) : 'Meta did not answer.' };
            if (err instanceof AdsGraphError && err.klass === 'token_dead') health.token = { ...health.token, health: 'dead', checkedAt: now.toISOString() };
        }
        await writeHealth(creatorId, health).catch((err) => log('warn', 'ads.health_write_failed', describeError(err)));
    }
    const [ceiling, alerts, switches, capChangesLeft] = await Promise.all([
        readCeiling(creatorId), readAlerts(creatorId), readSwitches(creatorId),
        settings.adAccountId ? spendCapChangesLeft(creatorId, settings.adAccountId, health.account?.timezoneOffsetHours ?? 0, now) : Promise.resolve(10),
    ]);
    const tokenSet = Boolean(token);
    return {
        enabled: true,
        configured: isConfigured(settings, token),
        steps: setupSteps(settings, tokenSet, health),
        adAccountId: settings.adAccountId,
        token: tokenView(settings, token, health, now),
        scopes: { found: health.token.scopes, missing: health.token.missingScopes },
        account: health.account,
        accountError: health.accountError,
        limits: { maxDailyBudget: settings.maxDailyBudget, monthlyCap: settings.monthlyCap },
        ceiling,
        alerts: alertsView(alerts),
        spendCap: { amount: health.account?.spendCap ?? null, changesLeftToday: capChangesLeft },
        switches,
        businessId: settings.businessId,
        defaultCountries: settings.defaultCountries,
        leadRetentionDays: settings.leadRetentionDays,
        tier: health.tier,
        servedVersion: health.servedVersion,
        checkedAt: health.checkedAt,
        helpUrl: '#/help/ads',
        // Kept for one phase so an older cached bundle does not break.
        tokenSource: token ? settings.tokenSource : null,
        tokenExpiresAt: token ? settings.tokenExpiresAt : null,
        maxDailyBudget: settings.maxDailyBudget,
        monthlyCap: settings.monthlyCap,
    };
}

export type AdsSettingsView = Awaited<ReturnType<typeof describeAdsSettings>>;

/** The cap guard's last successful check, and whether it has gone blind (no success for 2 h while it was trying). */
export async function guardState(creatorId: string, now = new Date()): Promise<{ lastCheckedAt: string | null; blind: boolean }> {
    const [ok, attempt] = await Promise.all([
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsCapChecked, creatorId)),
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsCapAttempt, creatorId)),
    ]);
    const okAt = Date.parse(ok ?? '');
    const attemptAt = Date.parse(attempt ?? '');
    const blind = Number.isNaN(okAt) ? !Number.isNaN(attemptAt) : now.getTime() - okAt >= 2 * 3_600_000;
    return { lastCheckedAt: Number.isNaN(okAt) ? null : new Date(okAt).toISOString(), blind };
}
