/**
 * The platform admin's view of every tenant's ads (research R18, contracts/dashboard-api.md "Platform admin"): `GET /api/admin/ads/tenants`.
 *
 * Postgres only, never Meta: the switch, the ceiling and the stored health check come from `app_settings`, this month's spend from the
 * stored copy (`ads_insights_daily`, account rows), the alerts from `ads_alerts`. Spend is the client's business, so:
 *   - `capUsePct` (spent / monthly cap) is always shown: it is the health signal the admin needs;
 *   - the amounts (`spend`) appear ONLY when the tenant's owner turned on `ads.share_spend.<t>`. Without it the row carries no spend and no
 *     monthly cap either, because the cap times the percentage is the spend.
 * The token is never read: only whether a row for it exists.
 */
import { queryRows } from '../../db/query.js';
import { TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { getPlatformOwnerId } from '../tenant.js';
import { describeError, log } from '../../utils/log.js';
import {
    isConfigured, parseCeiling, parseStoredSettings, tokenView, type AdsCeiling, type AdsHealth, EMPTY_HEALTH,
} from './settings.js';

/** How far back an alert still counts as open: alerts are once-a-day facts with no "resolved" state (ads_alerts, v53). */
export const OPEN_ALERT_DAYS = 7;

export interface OpenAlert {
    kind: string;
    count: number;
    lastAt: string;
}

export interface SharedSpend {
    currency: string | null;
    /** Null: no stored spend yet (the sync has not run), not zero. */
    spentThisMonth: number | null;
    spentToday: number | null;
    monthlyCap: number | null;
    maxDailyBudget: number | null;
}

export interface Signoff {
    id: string;
    scope: string;
    countries: string[];
    note: string | null;
    recordedAt: string;
}

export interface AdsTenantRow {
    tenantId: string;
    name: string | null;
    enabled: boolean;
    isPlatformOwner: boolean;
    ceiling: AdsCeiling | null;
    configured: boolean;
    tokenHealth: 'ok' | 'expiring' | 'dead' | 'unknown' | 'none';
    accountStatus: string | null;
    paymentMethod: boolean | null;
    checkedAt: string | null;
    capUsePct: number | null;
    openAlerts: OpenAlert[];
    shareSpend: boolean;
    spend?: SharedSpend;
    /** Null until A8's `ads_legal_signoffs` table exists. */
    signoffs: Signoff[] | null;
}

/** The account's calendar day and the first day of its month, as `YYYY-MM-DD`, from the offset the last health check stored. */
export function accountDays(now: Date, offsetHours: number): { today: string; monthStart: string } {
    const local = new Date(now.getTime() + offsetHours * 3_600_000).toISOString().slice(0, 10);
    return { today: local, monthStart: `${local.slice(0, 8)}01` };
}

/** Spent / cap as a whole percentage. Unknown spend or no cap is null, never 0: "nothing spent" and "cannot tell" must look different. */
export function capUsePercent(spentThisMonth: number | null, monthlyCap: number | null): number | null {
    if (spentThisMonth === null || monthlyCap === null || !(monthlyCap > 0)) return null;
    return Math.round((spentThisMonth / monthlyCap) * 100);
}

function parseHealth(raw: string | undefined): AdsHealth {
    if (!raw) return structuredClone(EMPTY_HEALTH);
    try {
        const v = JSON.parse(raw) as Partial<AdsHealth>;
        return { ...structuredClone(EMPTY_HEALTH), ...v, token: { ...EMPTY_HEALTH.token, ...(v.token ?? {}) } };
    } catch {
        return structuredClone(EMPTY_HEALTH);
    }
}

function parseJson(raw: string | undefined): unknown {
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

const PREFIXES = TENANT_SETTING_PREFIXES;
/** The non-secret families the overview reads. `ads.token.` is listed separately: only whether it exists, never its value. */
const READ_PREFIXES = [PREFIXES.adsSettings, PREFIXES.adsEnabled, PREFIXES.adsCeiling, PREFIXES.adsHealth, PREFIXES.adsShareSpend] as const;

/** One read of every tenant's ads settings rows, keyed `prefix → tenant → value`. */
async function readAdsSettingRows(): Promise<{ values: Map<string, Map<string, string>>; tokens: Set<string> }> {
    const rows = await queryRows<{ key: string; value: string | null; is_secret: boolean }>(
        `SELECT key, CASE WHEN is_secret THEN NULL ELSE value END AS value, is_secret
           FROM app_settings
          WHERE key LIKE 'ads.%' AND value IS NOT NULL AND value <> ''`,
    );
    const values = new Map<string, Map<string, string>>(READ_PREFIXES.map((p) => [p, new Map()]));
    const tokens = new Set<string>();
    for (const row of rows) {
        if (row.key.startsWith(PREFIXES.adsToken)) {
            tokens.add(row.key.slice(PREFIXES.adsToken.length));
            continue;
        }
        if (row.is_secret || row.value === null) continue;
        const prefix = READ_PREFIXES.find((p) => row.key.startsWith(p));
        if (prefix) values.get(prefix)!.set(row.key.slice(prefix.length), row.value);
    }
    return { values, tokens };
}

/** This month's and today's spend per tenant from the stored copy; a tenant with no account rows is absent (unknown). */
async function readSpend(accounts: Array<{ creatorId: string; adAccountId: string; today: string; monthStart: string }>): Promise<Map<string, { month: number; today: number }>> {
    const out = new Map<string, { month: number; today: number }>();
    if (accounts.length === 0) return out;
    const rows = await queryRows<{ creator_id: string; month: string; today: string }>(
        `SELECT a.creator_id,
                COALESCE(SUM(i.spend), 0)::text AS month,
                COALESCE(SUM(i.spend) FILTER (WHERE i.day = a.today), 0)::text AS today
           FROM unnest($1::uuid[], $2::text[], $3::date[], $4::date[]) AS a(creator_id, ad_account_id, today, month_start)
           JOIN ads_insights_daily i
             ON i.creator_id = a.creator_id
            AND i.level = 'account'
            AND i.meta_id IN (a.ad_account_id, 'act_' || a.ad_account_id)
            AND i.day >= a.month_start AND i.day <= a.today
          GROUP BY a.creator_id`,
        [accounts.map((a) => a.creatorId), accounts.map((a) => a.adAccountId), accounts.map((a) => a.today), accounts.map((a) => a.monthStart)],
    );
    for (const r of rows) out.set(r.creator_id, { month: Number(r.month), today: Number(r.today) });
    return out;
}

async function readOpenAlerts(): Promise<Map<string, OpenAlert[]>> {
    const rows = await queryRows<{ creator_id: string; kind: string; count: number; last_at: Date | string }>(
        `SELECT creator_id, kind, COUNT(*)::int AS count, MAX(created_at) AS last_at
           FROM ads_alerts
          WHERE created_at > NOW() - make_interval(days => $1)
          GROUP BY creator_id, kind
          ORDER BY MAX(created_at) DESC`,
        [OPEN_ALERT_DAYS],
    );
    const out = new Map<string, OpenAlert[]>();
    for (const r of rows) {
        const list = out.get(r.creator_id) ?? [];
        list.push({ kind: r.kind, count: r.count, lastAt: new Date(r.last_at).toISOString() });
        out.set(r.creator_id, list);
    }
    return out;
}

/** A8's table (v56). Before it exists the panel says sign-offs arrive with Audiences, rather than showing an empty list that looks final. */
async function readSignoffs(): Promise<Map<string, Signoff[]> | null> {
    const [exists] = await queryRows<{ present: boolean }>(`SELECT to_regclass('public.ads_legal_signoffs') IS NOT NULL AS present`);
    if (!exists?.present) return null;
    const rows = await queryRows<{ id: string; creator_id: string; scope: string; countries: string[] | null; note: string | null; recorded_at: Date | string }>(
        `SELECT id, creator_id, scope, countries, note, recorded_at
           FROM ads_legal_signoffs
          WHERE revoked_at IS NULL
          ORDER BY recorded_at DESC`,
    );
    const out = new Map<string, Signoff[]>();
    for (const r of rows) {
        const list = out.get(r.creator_id) ?? [];
        list.push({ id: r.id, scope: r.scope, countries: r.countries ?? [], note: r.note, recordedAt: new Date(r.recorded_at).toISOString() });
        out.set(r.creator_id, list);
    }
    return out;
}

export async function listAdsTenants(now = new Date()): Promise<AdsTenantRow[]> {
    const [creators, ownerId, settingRows, alerts, signoffs] = await Promise.all([
        queryRows<{ id: string; name: string | null }>(`SELECT id, name FROM creators ORDER BY name NULLS LAST, created_at`),
        getPlatformOwnerId(),
        readAdsSettingRows(),
        readOpenAlerts().catch((err) => {
            // Before v53 is applied the table is missing: the rest of the overview still renders.
            log('warn', 'admin.ads_alerts_unreadable', describeError(err));
            return new Map<string, OpenAlert[]>();
        }),
        readSignoffs().catch((err) => {
            log('warn', 'admin.ads_signoffs_unreadable', describeError(err));
            return null;
        }),
    ]);
    const { values, tokens } = settingRows;
    const get = (prefix: (typeof READ_PREFIXES)[number], id: string) => values.get(prefix)!.get(id);

    const base = creators.map((c) => {
        const settings = parseStoredSettings(get(PREFIXES.adsSettings, c.id) ?? null);
        const health = parseHealth(get(PREFIXES.adsHealth, c.id));
        const hasToken = tokens.has(c.id);
        return { c, settings, health, hasToken, days: accountDays(now, health.account?.timezoneOffsetHours ?? 0) };
    });

    const spend = await readSpend(
        base.filter((b) => b.settings.adAccountId).map((b) => ({ creatorId: b.c.id, adAccountId: b.settings.adAccountId!, today: b.days.today, monthStart: b.days.monthStart })),
    ).catch((err) => {
        log('warn', 'admin.ads_spend_unreadable', describeError(err));
        return new Map<string, { month: number; today: number }>();
    });

    return base.map(({ c, settings, health, hasToken }) => {
        const shareSpend = get(PREFIXES.adsShareSpend, c.id) === 'true';
        const spent = spend.get(c.id) ?? null;
        const token = tokenView(settings, hasToken ? 'x' : null, health, now);
        const row: AdsTenantRow = {
            tenantId: c.id,
            name: c.name,
            enabled: get(PREFIXES.adsEnabled, c.id) === 'true',
            isPlatformOwner: c.id === ownerId,
            ceiling: parseCeiling(parseJson(get(PREFIXES.adsCeiling, c.id))),
            configured: isConfigured(settings, hasToken ? 'x' : null),
            tokenHealth: hasToken ? token.health : 'none',
            accountStatus: health.account?.statusLabel ?? null,
            paymentMethod: health.account?.hasPaymentMethod ?? null,
            checkedAt: health.checkedAt,
            capUsePct: capUsePercent(spent?.month ?? null, settings.monthlyCap),
            openAlerts: alerts.get(c.id) ?? [],
            shareSpend,
            signoffs: signoffs === null ? null : (signoffs.get(c.id) ?? []),
        };
        if (shareSpend) {
            row.spend = {
                currency: health.account?.currency ?? null,
                spentThisMonth: spent?.month ?? null,
                spentToday: spent?.today ?? null,
                monthlyCap: settings.monthlyCap,
                maxDailyBudget: settings.maxDailyBudget,
            };
        }
        return row;
    });
}
