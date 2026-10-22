/**
 * The ads settings families (data-model.md "Settings"), all in `app_settings`, all DB-first and edited from the dashboard (never env).
 *
 *   per tenant (`TENANT_SETTING_PREFIXES`)
 *     ads.settings.<t>       { adAccountId, maxDailyBudget, monthlyCap, tokenSource, tokenExpiresAt, businessId, defaultCountries,
 *                              leadRetentionDays }: the owner's
 *     ads.token.<t>          the system-user token (or Connect's user token). SECRET, encrypted
 *     ads.enabled.<t>        'true' or absent: the platform admin's switch; every /api/ads route answers 404 ADS_DISABLED without it
 *     ads.ceiling.<t>        { maxDailyBudget, monthlyCap }: the platform admin's ceiling. A managed client's limits may not exceed it,
 *                            and a client cannot be enabled without one
 *     ads.alerts.<t>         { telegramChatId, email, lang, kinds }: where this tenant's alerts go (ads/notify.ts)
 *     ads.health.<t>         the stored copy of the last account and token check (ads/health.ts, POST /settings/test). A key of its own,
 *                            not a field of ads.settings, so the daily check can never overwrite a save the owner made meanwhile
 *     ads.cap_checked.<t>    ISO time of the guard's last SUCCESSFUL check (ads/guard.ts)
 *     ads.cap_attempt.<t>    ISO time of its last attempt, successful or not: a failing tenant is retried every 10 minutes, not every drain
 *     ads.bot_context.<t>, ads.extended_window.<t>, ads.share_spend.<t>   phases A3 and A11; read here with their defaults (off)
 *   platform: ads.api_version (ads/graph.ts), ads.copy_admin (ads/notify.ts)
 *
 * Moved here from adBoosts.ts (which re-exports it for one phase).
 */
import { getSetting, last4, setSetting, tenantSettingKey, TENANT_SETTING_PREFIXES } from '../appSettings.js';
import { getPlatformOwnerId } from '../tenant.js';
import { isEmailAddress } from '../notifyEmail.js';
import { CHAT_ID_PATTERN } from '../notify.js';
import { normaliseAdAccountId, normaliseCountry, roundMoney } from './metaAds.js';
import { forgetStoredCopy } from './mirror.js';

// ─── ads.settings ───────────────────────────────────────────────────────────────────────────

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
    /** The Meta business id (digits), for what needs it later (split tests). */
    businessId: string | null;
    /** ISO-2 codes the builder starts from. */
    defaultCountries: string[];
    /** Days a lead's answers are kept (lead ads, locked until legal sign-off). */
    leadRetentionDays: number;
}

const EMPTY_SETTINGS: AdsSettings = {
    adAccountId: null, maxDailyBudget: null, monthlyCap: null, tokenSource: null, tokenExpiresAt: null, businessId: null, defaultCountries: [], leadRetentionDays: 90,
};

/** The highest limit the card accepts, in major units: a typo of an extra zero or three should be refused, not spent. */
export const ADS_LIMIT_MAX = 1_000_000;

function positiveMoney(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= ADS_LIMIT_MAX ? roundMoney(value) : null;
}

const BUSINESS_ID = /^[0-9]{5,25}$/;

function countries(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map(normaliseCountry).filter((c): c is string => c !== null))].slice(0, 25);
}

/** The stored JSON, read defensively: anything unreadable is "not set", which refuses spending rather than spending without a limit. */
export function parseStoredSettings(raw: string | null): AdsSettings {
    if (!raw) return { ...EMPTY_SETTINGS };
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const days = parsed['leadRetentionDays'];
        return {
            adAccountId: normaliseAdAccountId(parsed['adAccountId']),
            maxDailyBudget: positiveMoney(parsed['maxDailyBudget']),
            monthlyCap: positiveMoney(parsed['monthlyCap']),
            tokenSource: parsed['tokenSource'] === 'connect' || parsed['tokenSource'] === 'pasted' ? parsed['tokenSource'] : null,
            tokenExpiresAt: typeof parsed['tokenExpiresAt'] === 'string' && !Number.isNaN(Date.parse(parsed['tokenExpiresAt'])) ? parsed['tokenExpiresAt'] : null,
            businessId: typeof parsed['businessId'] === 'string' && BUSINESS_ID.test(parsed['businessId']) ? parsed['businessId'] : null,
            defaultCountries: countries(parsed['defaultCountries']),
            leadRetentionDays: typeof days === 'number' && Number.isInteger(days) && days >= 1 && days <= 365 ? days : 90,
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

export type ParsedSettingsInput =
    | { ok: true; value: SettingsInput }
    | { ok: false; error: string; field: string; code: 'INVALID' | 'OVER_CEILING' };

/**
 * The card's body: any subset of `{ adAccountId, token, maxDailyBudget, monthlyCap, businessId, defaultCountries, leadRetentionDays }`.
 * Absent leaves a value; '' or null clears it. Every field is checked before anything is written. The daily max may not exceed the
 * monthly cap (it could never be used), and neither limit may exceed the platform admin's ceiling for the tenant.
 */
export function parseSettingsInput(body: unknown, current: AdsSettings, ceiling: AdsCeiling | null = null): ParsedSettingsInput {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const out: SettingsInput = { settings: {} };
    const invalid = (error: string, field: string): ParsedSettingsInput => ({ ok: false, error, field, code: 'INVALID' });

    if (b['adAccountId'] !== undefined) {
        if (b['adAccountId'] === '' || b['adAccountId'] === null) out.settings.adAccountId = null;
        else {
            const id = normaliseAdAccountId(b['adAccountId']);
            if (!id) return invalid('The ad account id is the number in Ads Manager, e.g. act_1234567890.', 'adAccountId');
            out.settings.adAccountId = id;
        }
    }
    if (b['token'] !== undefined) {
        if (b['token'] === '' || b['token'] === null) out.token = null;
        else if (typeof b['token'] !== 'string' || !/^[A-Za-z0-9_\-|.]{20,1000}$/.test(b['token'].trim())) {
            return invalid('That does not look like a Meta access token.', 'token');
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
        if (value === null) return invalid(`Enter an amount above 0 and at most ${ADS_LIMIT_MAX}.`, field);
        out.settings[field] = value;
    }
    if (b['businessId'] !== undefined) {
        if (b['businessId'] === '' || b['businessId'] === null) out.settings.businessId = null;
        else if (typeof b['businessId'] !== 'string' || !BUSINESS_ID.test(b['businessId'].trim())) return invalid('The business id is the number in Business Settings → Business info.', 'businessId');
        else out.settings.businessId = b['businessId'].trim();
    }
    if (b['defaultCountries'] !== undefined) {
        if (!Array.isArray(b['defaultCountries'])) return invalid('Countries are a list of two-letter codes.', 'defaultCountries');
        const list = countries(b['defaultCountries']);
        if (list.length !== new Set(b['defaultCountries']).size) return invalid('Each country is a two-letter code, e.g. SA.', 'defaultCountries');
        out.settings.defaultCountries = list;
    }
    if (b['leadRetentionDays'] !== undefined) {
        const d = b['leadRetentionDays'];
        if (typeof d !== 'number' || !Number.isInteger(d) || d < 1 || d > 365) return invalid('Keep leads for 1 to 365 days.', 'leadRetentionDays');
        out.settings.leadRetentionDays = d;
    }

    const after = { ...current, ...out.settings };
    if (after.maxDailyBudget !== null && after.monthlyCap !== null && after.maxDailyBudget > after.monthlyCap) {
        return invalid('The max daily budget cannot be more than the monthly spend cap.', 'maxDailyBudget');
    }
    if (ceiling) {
        for (const field of ['maxDailyBudget', 'monthlyCap'] as const) {
            const v = out.settings[field];
            if (typeof v === 'number' && Math.round(v * 100) > Math.round(ceiling[field] * 100)) {
                return { ok: false, code: 'OVER_CEILING', field, error: `Your limit cannot be more than ${ceiling[field]}, the most your account manager allows.` };
            }
        }
    }
    if (Object.keys(out.settings).length === 0 && out.token === undefined) return invalid('Nothing to save.', 'adAccountId');
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
        // A new token deserves a new verdict: the stored one was about the old token.
        await writeHealth(creatorId, { ...(await readHealth(creatorId)), token: { health: 'unknown', checkedAt: null, scopes: [], missingScopes: [] } });
    }
    // Disconnected: the token removed, or a different ad account chosen. The stored copy of the old account goes (mirror.ts).
    const switched = input.settings.adAccountId !== undefined && current.adAccountId !== null && input.settings.adAccountId !== current.adAccountId;
    if (input.token === null || switched) await forgetStoredCopy(creatorId);
}

export function isConfigured(settings: AdsSettings, token: string | null): boolean {
    return Boolean(settings.adAccountId && token && settings.maxDailyBudget && settings.monthlyCap);
}

// ─── ads.enabled and ads.ceiling (platform admin) ───────────────────────────────────────────

export async function isAdsEnabled(creatorId: string): Promise<boolean> {
    return (await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsEnabled, creatorId))) === 'true';
}

export async function setAdsEnabled(creatorId: string, enabled: boolean, updatedBy: string | null): Promise<void> {
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsEnabled, creatorId), enabled ? 'true' : null, updatedBy);
}

export interface AdsCeiling {
    maxDailyBudget: number;
    monthlyCap: number;
}

export function parseCeiling(value: unknown): AdsCeiling | null {
    const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
    const num = (x: unknown) => positiveMoney(typeof x === 'string' && x.trim() !== '' ? Number(x) : x);
    const maxDailyBudget = num(v['maxDailyBudget']);
    const monthlyCap = num(v['monthlyCap']);
    if (maxDailyBudget === null || monthlyCap === null || maxDailyBudget > monthlyCap) return null;
    return { maxDailyBudget, monthlyCap };
}

export async function readCeiling(creatorId: string): Promise<AdsCeiling | null> {
    const raw = await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsCeiling, creatorId));
    if (!raw) return null;
    try {
        return parseCeiling(JSON.parse(raw));
    } catch {
        return null;
    }
}

export async function saveCeiling(creatorId: string, ceiling: AdsCeiling, updatedBy: string | null): Promise<void> {
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsCeiling, creatorId), JSON.stringify(ceiling), updatedBy);
}

/** The platform owner's own tenant needs no ceiling: the owner is the one who sets ceilings. */
export async function needsCeiling(creatorId: string): Promise<boolean> {
    return (await getPlatformOwnerId()) !== creatorId;
}

// ─── ads.alerts ─────────────────────────────────────────────────────────────────────────────

/** The alert kinds (data-model.md `ads_alerts.kind`). A1 raises the first nine; the rest arrive with their phases. */
export const ADS_ALERT_KINDS = [
    'cap_paused', 'payment', 'account_disabled', 'ad_rejected', 'ad_issues', 'token_dead', 'token_expiring', 'guard_blind', 'version_mismatch',
    'rule_blind', 'rule_acted', 'business_ai', 'window_error', 'proposal_ready', 'lead_received',
] as const;
export type AdsAlertKind = (typeof ADS_ALERT_KINDS)[number];

/** The kinds shown on the card in A1. */
export const A1_ALERT_KINDS: readonly AdsAlertKind[] = ADS_ALERT_KINDS.slice(0, 9);

/** The kinds the card shows: A1's, A3's two about ad conversations (Business AI holds a thread; the longer reply window was refused), A7's daily-review proposals, and A9's rules (one acted; one is not watching). */
export const SHOWN_ALERT_KINDS: readonly AdsAlertKind[] = [...A1_ALERT_KINDS, 'business_ai', 'window_error', 'proposal_ready', 'rule_acted', 'rule_blind'];

/** Kinds that cannot be switched off: each means money may be spending with nobody watching. */
export const REQUIRED_ALERT_KINDS: readonly AdsAlertKind[] = ['cap_paused', 'guard_blind', 'token_dead'];

export interface AdsAlertSettings {
    telegramChatId: string | null;
    email: string | null;
    lang: 'ar' | 'en';
    kinds: Record<AdsAlertKind, boolean>;
}

function allKinds(on: boolean): Record<AdsAlertKind, boolean> {
    return Object.fromEntries(ADS_ALERT_KINDS.map((k) => [k, on])) as Record<AdsAlertKind, boolean>;
}

export function parseStoredAlerts(raw: string | null): AdsAlertSettings {
    const out: AdsAlertSettings = { telegramChatId: null, email: null, lang: 'ar', kinds: allKinds(true) };
    if (!raw) return out;
    try {
        const v = JSON.parse(raw) as Record<string, unknown>;
        if (typeof v['telegramChatId'] === 'string' && CHAT_ID_PATTERN.test(v['telegramChatId'])) out.telegramChatId = v['telegramChatId'];
        if (typeof v['email'] === 'string' && isEmailAddress(v['email'])) out.email = v['email'];
        if (v['lang'] === 'en') out.lang = 'en';
        const kinds = (v['kinds'] && typeof v['kinds'] === 'object' ? v['kinds'] : {}) as Record<string, unknown>;
        for (const k of ADS_ALERT_KINDS) if (kinds[k] === false) out.kinds[k] = false;
    } catch {
        // Unreadable: alerts still go nowhere new, and every kind stays on.
    }
    for (const k of REQUIRED_ALERT_KINDS) out.kinds[k] = true;
    return out;
}

export type ParsedAlertsInput = { ok: true; value: AdsAlertSettings; test: boolean } | { ok: false; error: string; field: string };

export function parseAlertsInput(body: unknown, current: AdsAlertSettings): ParsedAlertsInput {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const next: AdsAlertSettings = { ...current, kinds: { ...current.kinds } };
    if (b['telegramChatId'] !== undefined) {
        const v = typeof b['telegramChatId'] === 'number' ? String(b['telegramChatId']) : b['telegramChatId'];
        if (v === '' || v === null) next.telegramChatId = null;
        else if (typeof v !== 'string' || !CHAT_ID_PATTERN.test(v.trim())) return { ok: false, error: 'A Telegram chat id is a number (or @channel).', field: 'telegramChatId' };
        else next.telegramChatId = v.trim();
    }
    if (b['email'] !== undefined) {
        if (b['email'] === '' || b['email'] === null) next.email = null;
        else if (typeof b['email'] !== 'string' || !isEmailAddress(b['email'].trim())) return { ok: false, error: 'That is not an email address.', field: 'email' };
        else next.email = b['email'].trim();
    }
    if (b['lang'] !== undefined) {
        if (b['lang'] !== 'ar' && b['lang'] !== 'en') return { ok: false, error: 'The language is ar or en.', field: 'lang' };
        next.lang = b['lang'];
    }
    if (b['kinds'] !== undefined) {
        if (!b['kinds'] || typeof b['kinds'] !== 'object') return { ok: false, error: 'kinds is an object of switches.', field: 'kinds' };
        for (const [k, v] of Object.entries(b['kinds'] as Record<string, unknown>)) {
            if (!(ADS_ALERT_KINDS as readonly string[]).includes(k)) return { ok: false, error: `Unknown alert kind: ${k}.`, field: 'kinds' };
            if (typeof v !== 'boolean') return { ok: false, error: 'Each alert kind is on or off.', field: 'kinds' };
            next.kinds[k as AdsAlertKind] = v;
        }
        for (const k of REQUIRED_ALERT_KINDS) next.kinds[k] = true;
    }
    return { ok: true, value: next, test: b['test'] === true };
}

export async function readAlerts(creatorId: string): Promise<AdsAlertSettings> {
    return parseStoredAlerts(await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsAlerts, creatorId)));
}

export async function saveAlerts(creatorId: string, alerts: AdsAlertSettings, updatedBy: string | null): Promise<void> {
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsAlerts, creatorId), JSON.stringify(alerts), updatedBy);
}

/** The card's view of the alerts: the kinds raised so far (`SHOWN_ALERT_KINDS`), and which of them cannot be switched off. */
export function alertsView(a: AdsAlertSettings) {
    return {
        telegramChatId: a.telegramChatId,
        email: a.email,
        lang: a.lang,
        kinds: Object.fromEntries(SHOWN_ALERT_KINDS.map((k) => [k, a.kinds[k]])),
        required: [...REQUIRED_ALERT_KINDS],
    };
}

// ─── ads.health: the stored copy of the last check ──────────────────────────────────────────

export type TokenHealth = 'ok' | 'expiring' | 'dead' | 'unknown';

export interface AccountSnapshot {
    name: string | null;
    currency: string;
    timezone: string | null;
    timezoneOffsetHours: number;
    status: number | null;
    statusLabel: string;
    disableReason: string | null;
    hasPaymentMethod: boolean | null;
    isPrepay: boolean | null;
    spendCap: number | null;
    amountSpent: number | null;
    minDailyBudget: number | null;
    billingUrl: string;
    adsManagerUrl: string;
    syncedAt: string;
    /** Meta's Custom Audience Terms for this account (A8): accepted, not, or not said. Absent on snapshots stored before A8. */
    tosAccepted?: { custom: boolean | null; lookalike: boolean | null };
}

export interface AdsHealth {
    account: AccountSnapshot | null;
    accountError: string | null;
    token: { health: TokenHealth; checkedAt: string | null; scopes: string[]; missingScopes: string[] };
    tier: string | null;
    servedVersion: string | null;
    /** The ad accounts, Pages and Instagram accounts the token reached at the last test (the card's picker reads this, not Meta). */
    assets: { adAccounts: Array<{ id: string; name: string | null; currency: string | null; status: number | null }>; pages: Array<{ id: string; name: string | null }>; igAccounts: Array<{ id: string; username: string | null }> } | null;
    checkedAt: string | null;
}

export const EMPTY_HEALTH: AdsHealth = { account: null, accountError: null, token: { health: 'unknown', checkedAt: null, scopes: [], missingScopes: [] }, tier: null, servedVersion: null, assets: null, checkedAt: null };

export async function readHealth(creatorId: string): Promise<AdsHealth> {
    const raw = await getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsHealth, creatorId));
    if (!raw) return structuredClone(EMPTY_HEALTH);
    try {
        const v = JSON.parse(raw) as Partial<AdsHealth>;
        return { ...structuredClone(EMPTY_HEALTH), ...v, token: { ...EMPTY_HEALTH.token, ...(v.token ?? {}) } };
    } catch {
        return structuredClone(EMPTY_HEALTH);
    }
}

export async function writeHealth(creatorId: string, health: AdsHealth): Promise<void> {
    await setSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsHealth, creatorId), JSON.stringify(health), null);
}

/** A token Meta has refused (190/102) stops this tenant's ads writes until a new one is saved (the queue of A2 checks this too). */
export function isQueueStopped(health: AdsHealth): boolean {
    return health.token.health === 'dead';
}

// ─── Switches (A3, A11): read with their defaults ───────────────────────────────────────────

export interface AdsSwitches {
    botContext: boolean;
    extendedWindow: { instagram: boolean; messenger: boolean };
}

export async function readSwitches(creatorId: string): Promise<AdsSwitches> {
    const [bot, windowRaw] = await Promise.all([
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsBotContext, creatorId)),
        getSetting(tenantSettingKey(TENANT_SETTING_PREFIXES.adsExtendedWindow, creatorId)),
    ]);
    let w: Record<string, unknown> = {};
    try {
        w = windowRaw ? (JSON.parse(windowRaw) as Record<string, unknown>) : {};
    } catch {
        w = {};
    }
    return { botContext: bot === 'on', extendedWindow: { instagram: w['instagram'] === true, messenger: w['messenger'] === true } };
}

// ─── The setup steps ────────────────────────────────────────────────────────────────────────

export type SetupStepId = 'token' | 'account' | 'payment' | 'limits';

export type StepHintCode =
    | 'token_missing' | 'token_dead' | 'account_missing' | 'account_status' | 'payment_unchecked' | 'payment_missing' | 'payment_unknown' | 'limits_missing';

export interface SetupStep {
    id: SetupStepId;
    done: boolean;
    /** What to do next, in English (logs, the API); the screens show `ads.stepHint.<hintCode>` in the reader's language. */
    hint: string | null;
    hintCode: StepHintCode | null;
}

const HINTS: Record<StepHintCode, string> = {
    token_missing: 'Paste a system-user token with ads_management and ads_read.',
    token_dead: 'Meta no longer accepts this token: generate a new one and paste it.',
    account_missing: 'Choose the ad account (the act= number in Ads Manager).',
    account_status: 'Meta says this ad account is not active.',
    payment_unchecked: 'Press Test connection to check the payment method.',
    payment_missing: 'Add a payment method in Meta (billing).',
    payment_unknown: 'Meta did not say whether there is a payment method.',
    limits_missing: 'Set the max daily budget and the monthly spend cap.',
};

function step(id: SetupStepId, done: boolean, code: StepHintCode | null): SetupStep {
    const hintCode = done ? null : code;
    return { id, done, hint: hintCode ? HINTS[hintCode] : null, hintCode };
}

/** The four steps an unconfigured tenant sees instead of an error (Overview and the Settings card), from stored data only. */
export function setupSteps(settings: AdsSettings, tokenSet: boolean, health: AdsHealth): SetupStep[] {
    const tokenDead = health.token.health === 'dead';
    const account = health.account;
    return [
        step('token', tokenSet && !tokenDead, !tokenSet ? 'token_missing' : 'token_dead'),
        step('account', Boolean(settings.adAccountId) && (account === null || account.statusLabel === 'active'), !settings.adAccountId ? 'account_missing' : 'account_status'),
        step('payment', account?.hasPaymentMethod === true, !account ? 'payment_unchecked' : account.hasPaymentMethod === false ? 'payment_missing' : 'payment_unknown'),
        step('limits', Boolean(settings.maxDailyBudget && settings.monthlyCap), 'limits_missing'),
    ];
}

/** The token as the card may see it: never the value. */
export function tokenView(settings: AdsSettings, token: string | null, health: AdsHealth, now = new Date()) {
    let h: TokenHealth = token ? health.token.health : 'unknown';
    if (token && h !== 'dead' && settings.tokenSource === 'connect' && settings.tokenExpiresAt) {
        const left = Date.parse(settings.tokenExpiresAt) - now.getTime();
        if (left <= 0) h = 'dead';
        else if (left <= 14 * 86_400_000) h = 'expiring';
    }
    return { set: Boolean(token), last4: token ? last4(token) : null, source: token ? settings.tokenSource : null, expiresAt: token ? settings.tokenExpiresAt : null, health: h };
}
