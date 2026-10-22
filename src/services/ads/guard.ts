/**
 * The spending guard (research R8): THE cap after switch-on. For every tenant with ads enabled and configured, at most once an hour,
 * called from every `/api/jobs/drain`: if the month's spend has reached the monthly cap, or one more day of every active campaign (daily
 * budgets at 1.75×, lifetime budgets' whole unspent part) would carry it past, every ACTIVE campaign in the ad account is PAUSED. That
 * includes campaigns made in Meta Ads Manager: the cap is the owner's ceiling for the account, wherever a campaign came from. Pausing
 * spends nothing and is undone with one tap on the Ads screen.
 *
 * It never goes quiet:
 *   - `ads.cap_checked.<t>` is written only AFTER a successful check (pauses included). A failure writes only `ads.cap_attempt.<t>`, so the
 *     tenant is tried again 10 minutes later instead of an hour later;
 *   - it takes the drain's deadline and stops between tenants and between pauses (what is left is done by the next drain);
 *   - a pause raises a `cap_paused` alert and writes an `ads.cap_paused` audit row;
 *   - a tenant without a successful check for 2 hours raises `guard_blind` (a dead token, throttling, Meta down);
 *   - a dead token is recorded (`ads.health.<t>`) and raises `token_dead`.
 *
 * The pauses are `priority` calls: they skip the pacer's own estimate (being refused by our bookkeeping would let the money run on), never
 * Meta's block.
 */
import { describeError, log } from '../../utils/log.js';
import { queryRows, queryOne } from '../../db/query.js';
import { getSetting, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { AUDIT_ACTIONS, writeAudit } from '../audit.js';
import { fetchAccountState, updateObject, roundMoney } from '../metaAds.js';
import { AdsGraphError, withAdsContext } from './graph.js';
import { isActive, lifetimeSpend, oneDayRemaining, readCampaigns, readSpend, shouldPauseAll, type RawCampaign } from './money.js';
import { notifyAds } from './notify.js';
import { readAdsSettings, readHealth, writeHealth } from './settings.js';

/** How often each tenant's account is checked against its cap. */
export const CAP_CHECK_INTERVAL_MS = 60 * 60_000;
/** How soon a tenant whose check failed is tried again. */
export const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
/** No successful check for this long: the owner is told spending is not being watched. */
export const BLIND_AFTER_MS = 2 * 60 * 60_000;
/** The actor of the guard's audit rows: nobody signed in. */
export const ADS_GUARD_ACTOR_EMAIL = 'system:ads-guard';

export interface GuardResult {
    checked: number;
    paused: number;
    failed: number;
    blind: number;
    stoppedAtDeadline: boolean;
}

/** Tenants the platform admin switched ads on for. */
async function enabledTenants(): Promise<string[]> {
    const rows = await queryRows<{ key: string }>("SELECT key FROM app_settings WHERE key LIKE 'ads.enabled.%' AND value = 'true'");
    return rows.map((r) => r.key.slice(TENANT_SETTING_PREFIXES.adsEnabled.length)).filter((id) => /^[A-Za-z0-9-]{1,64}$/.test(id));
}

/** One more day of the active campaigns (`oneDayRemaining` each). */
export function nextDayRemaining(active: readonly RawCampaign[], currency: string, now: Date): number {
    return roundMoney(active.reduce((sum, c) => sum + oneDayRemaining(c, currency, lifetimeSpend(c), now), 0));
}

const time = (raw: string | null): number | null => {
    const t = Date.parse(raw ?? '');
    return Number.isNaN(t) ? null : t;
};

/**
 * Check every enabled tenant that is due. `only` + `force` check one tenant at once whatever the hour (a cap just lowered below the
 * month's spend). Never throws for one tenant; the caller logs the totals.
 */
export async function runGuard(opts: { now?: Date; deadline?: number; only?: string; force?: boolean } = {}): Promise<GuardResult> {
    const now = opts.now ?? new Date();
    const out: GuardResult = { checked: 0, paused: 0, failed: 0, blind: 0, stoppedAtDeadline: false };
    const tenants = opts.only ? [opts.only] : await enabledTenants();
    for (const creatorId of tenants) {
        if (opts.deadline !== undefined && Date.now() >= opts.deadline) {
            out.stoppedAtDeadline = true;
            break;
        }
        await guardTenant(creatorId, now, opts, out);
    }
    return out;
}

async function guardTenant(creatorId: string, now: Date, opts: { deadline?: number; force?: boolean }, out: GuardResult): Promise<void> {
    const checkedKey = tenantSettingKey(TENANT_SETTING_PREFIXES.adsCapChecked, creatorId);
    const attemptKey = tenantSettingKey(TENANT_SETTING_PREFIXES.adsCapAttempt, creatorId);
    const [okRaw, attemptRaw] = await Promise.all([getSetting(checkedKey), getSetting(attemptKey)]);
    const lastOk = time(okRaw);
    const lastAttempt = time(attemptRaw);
    if (!opts.force) {
        if (lastOk !== null && now.getTime() - lastOk < CAP_CHECK_INTERVAL_MS) return;
        const failing = lastAttempt !== null && (lastOk === null || lastAttempt > lastOk);
        if (failing && now.getTime() - lastAttempt! < RETRY_AFTER_FAILURE_MS) return;
    }

    const { settings, token } = await readAdsSettings(creatorId);
    if (!token || !settings.adAccountId || !settings.monthlyCap) return;
    const adAccountId = settings.adAccountId;
    const monthlyCap = settings.monthlyCap;
    out.checked++;
    await setSetting(attemptKey, now.toISOString(), null);

    let offsetHours = 0;
    let accountName: string | null = null;
    try {
        await withAdsContext({ creatorId, adAccountId }, async () => {
            const account = await fetchAccountState(adAccountId, token);
            offsetHours = account.timezoneOffsetHours;
            accountName = account.name;
            const [spent, campaigns] = await Promise.all([readSpend(adAccountId, 'this_month', token), readCampaigns(adAccountId, token)]);
            if (spent === null) throw new Error('this month\'s spend unreadable');
            const active = campaigns.filter(isActive);
            const nextDay = nextDayRemaining(active, account.currency, now);
            if (shouldPauseAll({ spentThisMonth: spent, nextDayRemaining: nextDay, monthlyCap })) {
                await pauseAll(creatorId, adAccountId, token, active, { spent, nextDay, monthlyCap, currency: account.currency, offsetHours, accountName }, opts.deadline, out);
            }
        });
        await setSetting(checkedKey, now.toISOString(), null);
    } catch (err) {
        out.failed++;
        log('warn', 'ads.cap_check_failed', { creator_id: creatorId, ...describeError(err) });
        const target = { creatorId, adAccountId, accountName, offsetHours };
        if (err instanceof AdsGraphError && err.klass === 'token_dead') {
            const health = await readHealth(creatorId);
            health.token = { ...health.token, health: 'dead', checkedAt: now.toISOString() };
            await writeHealth(creatorId, health).catch((e) => log('warn', 'ads.health_write_failed', describeError(e)));
            await notifyAds({ kind: 'token_dead', code: err.metaCode ?? null }, target, { now });
        }
        if (lastOk === null || now.getTime() - lastOk >= BLIND_AFTER_MS) {
            out.blind++;
            const reason = err instanceof AdsGraphError ? (err.klass === 'other' ? `Meta error ${err.metaCode ?? err.status ?? ''}`.trim() : err.klass) : 'Meta could not be read';
            await notifyAds({ kind: 'guard_blind', since: lastOk === null ? null : new Date(lastOk).toISOString(), reason }, target, { now });
        }
    }
}

interface PauseContext {
    spent: number;
    nextDay: number;
    monthlyCap: number;
    currency: string;
    offsetHours: number;
    accountName: string | null;
}

/** Pause every active campaign; throws (after alerting and auditing what was paused) when one could not be, or the deadline came. */
async function pauseAll(creatorId: string, adAccountId: string, token: string, active: RawCampaign[], ctx: PauseContext, deadline: number | undefined, out: GuardResult): Promise<void> {
    const done: string[] = [];
    let failure: unknown = null;
    for (const c of active) {
        if (deadline !== undefined && Date.now() >= deadline) {
            failure = new Error('deadline reached while pausing');
            break;
        }
        try {
            await updateObject(c.id, { status: 'PAUSED' }, token, 'cap pause', { priority: true });
            done.push(c.id);
            out.paused++;
        } catch (err) {
            failure = err;
            log('warn', 'ads.cap_pause_failed', { creator_id: creatorId, campaign_id: c.id, ...describeError(err) });
        }
    }
    if (done.length > 0) {
        await queryOne(
            "UPDATE ad_boosts SET status = 'paused', error = $3, updated_at = NOW() WHERE creator_id = $1 AND campaign_id = ANY($2::text[]) AND status = 'active' RETURNING id",
            [creatorId, done, 'Paused automatically: this month reached your monthly spending cap.']
        ).catch((err) => log('warn', 'ads.cap_boost_update_failed', { creator_id: creatorId, ...describeError(err) }));
        await writeAudit({ userId: null, email: ADS_GUARD_ACTOR_EMAIL }, {
            action: AUDIT_ACTIONS.adsCapPaused,
            targetType: 'creator',
            targetId: creatorId,
            detail: { ad_account_id: adAccountId, spent: ctx.spent, next_day: ctx.nextDay, cap: ctx.monthlyCap, currency: ctx.currency, campaign_ids: done, not_paused: active.length - done.length },
        });
        await notifyAds({ kind: 'cap_paused', spent: ctx.spent, cap: ctx.monthlyCap, nextDay: ctx.nextDay, paused: done.length, currency: ctx.currency },
            { creatorId, adAccountId, accountName: ctx.accountName, offsetHours: ctx.offsetHours });
    }
    log('warn', 'ads.cap_paused_all', { creator_id: creatorId, spent: ctx.spent, next_day: ctx.nextDay, cap: ctx.monthlyCap, paused: done.length, of: active.length });
    if (failure) throw failure;
}
