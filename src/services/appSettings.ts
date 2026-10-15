/**
 * App-wide operational settings, stored in the database and edited from the dashboard.
 *
 * The rule this module exists to enforce: config the operator needs to change mid-task lives
 * here, with an environment variable as a fallback — never the other way round. Env values
 * cannot be changed without a redeploy, cannot be read back (`vercel env pull` returns
 * `[ENCRYPTED]`), and drift silently: production ran for months with `META_VERIFY_TOKEN=""`.
 *
 * Secret values are encrypted with the same AES-256-GCM key as the Meta page token and are
 * never returned to a client — `describeSetting` reports whether one is set and a masked hint.
 */
import { encryptSecret, decryptSecret } from '../config/crypto.js';
import { queryOne, queryCount, queryRows } from '../db/query.js';
import type { AppSettingRow } from '../db/rows.js';
import { log } from '../utils/log.js';
import { CONTENT_RULE_PRESETS, type ContentRulePreset } from './profile/types.js';
import { PRODUCTION_ORIGIN } from './publicPages.js';

/** Every key this codebase reads. A typo becomes a compile error rather than a silent null. */
export const APP_SETTING_KEYS = {
    tiktokClientKey: 'tiktok.client_key',
    tiktokClientSecret: 'tiktok.client_secret',
    /** e.g. `tiktokAbC123.txt` — the file TikTok's URL-property verification asks you to serve. */
    tiktokVerificationFilename: 'tiktok.verification_filename',
    /** The exact contents of that file. */
    tiktokVerificationContent: 'tiktok.verification_content',
    /**
     * JSON `[{ filename, content }]` — every verification file saved before the current one.
     * TikTok hands out a new file per property (URL prefix, domain…), and saving a new one must
     * not take the page an earlier property was verified against offline.
     */
    tiktokVerificationHistory: 'tiktok.verification_history',
    /**
     * The canonical public origin, e.g. `https://msg-response-auto.vercel.app`.
     *
     * TikTok compares the OAuth `redirect_uri` byte-for-byte against the one registered in its
     * developer portal. Building it from the request's Host header — which is how media URLs are
     * built today — would produce a different URI on every preview deployment and fail there.
     */
    publicBaseUrl: 'app.public_base_url',
    /**
     * 'true' once Direct Post is switched on for the app in TikTok's portal. It decides whether
     * Connect asks for `video.publish` — asking for a scope the app does not have fails the
     * whole authorisation, so this cannot simply always be on.
     */
    tiktokDirectPostEnabled: 'tiktok.direct_post_enabled',
    /**
     * 'true' once TikTok has audited the app for Direct Post. Before that, TikTok forces every
     * direct post to SELF_ONLY and requires the account itself to be private.
     */
    tiktokAudited: 'tiktok.audited',
    /**
     * 'true' once the TikTok portal has approved the `user.info.profile` scope for the app (P33). It decides whether Connect asks for it:
     * the scope returns the creator's bio, profile link, username and verified flag, which the onboarding draft reads
     * (docs/onboarding/03 §1, "TikTok"). Asking for a scope the app does not have fails the WHOLE authorisation, so this defaults OFF and
     * OFF means the request is exactly the one made before the scope existed, like `tiktok.direct_post_enabled`. Not a secret.
     */
    tiktokProfileScopeEnabled: 'tiktok.profile_scope_enabled',
    /** The Google OAuth client (type "Web application") the YouTube connection uses. */
    youtubeClientId: 'youtube.client_id',
    youtubeClientSecret: 'youtube.client_secret',
    /**
     * A Google API key (not OAuth) for READING public YouTube data: a channel's description and recent titles, for the onboarding
     * draft of a tenant that has not connected YouTube (docs/onboarding/03 §1). `channels.list` and `playlistItems.list` cost one quota
     * unit each. Unset means that source is skipped, not failed: the draft is made from the rest. `YOUTUBE_API_KEY` is the fallback.
     * Operations → Onboarding saves it (src/services/onboardingSettings.ts), encrypted.
     */
    youtubeApiKey: 'youtube.api_key',
    /**
     * 'true': tenants may connect their own Facebook Page and Instagram account with Facebook Login for Business
     * (`POST /api/meta/connect`, src/routes/meta.ts). Off by default, and off means every Meta connect route answers 409 and the
     * callback refuses: nothing about the owner's connection or the paste-a-token path depends on it. Not a secret. Edited by a
     * platform admin through `POST /api/meta/app-settings`.
     */
    metaLoginEnabled: 'meta.login_enabled',
    /**
     * The Facebook Login for Business configuration id, which the operator creates in Meta's App Dashboard and pastes
     * (docs/onboarding/04 §2). The configuration carries the permissions, so the dialog is built from this id alone. Not a secret.
     * `META_LOGIN_CONFIG_ID` is the fallback. Unset, the dialog falls back to a plain `scope=` list, which works for people with a
     * role on the app. The app id and secret stay in `META_APP_ID` / `META_APP_SECRET` (the webhook is signed with the same ones).
     */
    metaLoginConfigId: 'meta.login_config_id',
    /**
     * 'true': Shorts upload public. Off: private. YouTube may lock an unaudited project's uploads
     * private whatever is asked; this owner's were not (2026-10-06: a private test Short could be
     * made public in Studio, and YouTube reported it public), so the owner chose public.
     */
    youtubePublicUploads: 'youtube.public_uploads',
    /**
     * The Gemini API key the whole platform runs on: every tenant's DM replies, the AI Settings
     * test box and the Studio. Saved by a platform admin on the Operations screen, after Google
     * has accepted it (src/services/geminiKey.ts). `GEMINI_API_KEY` is the fallback, and stays
     * in use until a key is saved here.
     */
    geminiApiKey: 'gemini.api_key',
    /**
     * The Supabase project that holds media, e.g. `https://abcd1234.supabase.co`. With the key
     * below it moves new uploads out of Postgres and into the Storage bucket `media`
     * (src/services/storage.ts). `SUPABASE_URL` is the fallback.
     */
    mediaStorageUrl: 'storage.supabase_url',
    /**
     * The key the server uses with Supabase Storage: a secret key (`sb_secret_…`) or the legacy
     * `service_role` JWT. `SUPABASE_SERVICE_ROLE_KEY` is the fallback.
     */
    mediaStorageKey: 'storage.supabase_service_key',
    /**
     * 'true': the daily sweep deletes a file as soon as the post that used it is PUBLISHED and
     * nothing else still needs it (Meta, TikTok and YouTube keep their own copies), and any file
     * nothing names after a week (src/services/retention.ts). The owner asked for it on 2026-10-04,
     * with the 1 GB Storage tier full. Unset: `MEDIA_RETENTION_DAYS` decides, as before.
     */
    mediaCleanup: 'storage.cleanup_after_publish',
    /**
     * The three values the public site prints (src/index.ts `renderPublicPage`). Each was a
     * literal in six HTML files before; now the public pages carry `{{…}}` tokens and read
     * these on every request. Env fallbacks: SITE_WHATSAPP_NUMBER / SITE_CONTACT_EMAIL /
     * SITE_EID_COUPONS_EXPIRE.
     */
    /** Digits only, E.164 without the `+`: `9665xxxxxxxx`. Builds the wa.me link. */
    siteWhatsappNumber: 'site.whatsapp_number',
    /**
     * The address behind every `mailto:` on the public pages. Never empty: with nothing saved
     * and no SITE_CONTACT_EMAIL it falls back to DEFAULT_CONTACT_EMAIL, so no page can end up
     * with zero ways to reach anyone.
     */
    siteContactEmail: 'site.contact_email',
    /** `YYYY-MM-DD` — the last day the Eid page's Udemy coupons work. Empty = no campaign. */
    siteEidCouponsExpire: 'site.eid_coupons_expire',
    /**
     * JSON `["<creator uuid>", …]`: the tenants whose Claude work (the Monteur's `monteur_think`, an
     * infographic Claude writes) may run on the operator's Mac, on his personal Claude plan, BESIDES the
     * owner (the first creator ever made), who is always allowed. Anthropic's terms forbid routing anyone
     * else's work through it, so anyone else is refused (409 `NEEDS_API_BRAIN`, src/services/macBrain.ts).
     * Unset and `[]` both mean the owner only: the setting only adds tenants. Not a secret. Written by
     * `PUT /api/admin/mac-brain-tenants`.
     */
    studioMacBrainTenants: 'studio.mac_brain_tenants',
    /**
     * JSON `["no_women_imagery", …]`: the content rules a tenant created by the operator starts with, pre-ticked on its
     * profile (D9). Unset means `['no_women_imagery']`, the owner's standard and the platform's default; `[]` is a
     * deliberate "none". The owner's own profile is not touched by it, and neither is any tenant that already exists:
     * it is read once, when a tenant is created (`getOnboardingDefaultRules`). Not a secret. Edited on the Settings → Onboarding card
     * with the invite settings below.
     */
    onboardingDefaultRules: 'onboarding.default_rules',
    /**
     * The AI providers layer (docs/onboarding/06, `src/services/aiProviders/settings.ts`): the operator's own API keys, one secret row per
     * provider, each checked with the provider before it is saved. Gemini has no row here: it is `gemini.api_key` above, shared with the
     * DM bot and the Studio. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY` and `GROQ_API_KEY` are the fallbacks; Custom has none.
     * A key is never returned by any route: the Operations card is told `{set, source, last4}` and nothing else.
     */
    aiProviderKeyAnthropic: 'ai.providers.anthropic.api_key',
    aiProviderKeyOpenai: 'ai.providers.openai.api_key',
    aiProviderKeyOpenrouter: 'ai.providers.openrouter.api_key',
    aiProviderKeyGroq: 'ai.providers.groq.api_key',
    aiProviderKeyCustom: 'ai.providers.custom.api_key',
    /**
     * JSON `{ "<provider>": { enabled?, defaultModel?, baseUrl?, jsonMode? } }`: what the operator changed about a provider. `baseUrl` and
     * `jsonMode` are Custom's alone; `enabled: false` keeps a saved key out of every route and out of the default pick. Not a secret.
     */
    aiProviders: 'ai.providers',
    /** JSON `{ "<purpose>": { provider, model, effort } }`: which provider and model answers each purpose. A purpose with no entry takes the first provider that has a key. Not a secret. */
    aiRouting: 'ai.routing',
    /** JSON `{ "<model id>": { in, out } }`: US dollars per million tokens, laid over the table the code ships (`DEFAULT_PRICES`). Not a secret. */
    aiPrices: 'ai.prices',
    /**
     * Spend ceilings in US dollars over `ai_usage`, in UTC: the platform per day and per month, and each tenant per day and per month. Unset
     * is no limit; `0` refuses every call. A call is refused once the period's spend has reached the figure. Not secrets.
     */
    aiBudgetDailyUsd: 'ai.budget.daily_usd',
    aiBudgetMonthlyUsd: 'ai.budget.monthly_usd',
    aiBudgetTenantDailyUsd: 'ai.budget.tenant_daily_usd',
    aiBudgetTenantMonthlyUsd: 'ai.budget.tenant_monthly_usd',
    /**
     * How many days an invite link (`purpose` join) lasts: 1 to 90, default 7. Read when the link is made, so a change reaches
     * links created after it and never shortens or stretches one already out (`src/services/onboardingSettings.ts`). Not a secret.
     */
    onboardingInviteTtlDays: 'onboarding.invite_ttl_days',
    /** How many hours a password-reset link lasts: 1 to 168, default 24. Read when the link is made. */
    onboardingResetTtlHours: 'onboarding.reset_ttl_hours',
    /** The membership role an invite gives when the operator does not choose one: `owner` (default), `operator` or `viewer`. */
    onboardingDefaultRole: 'onboarding.default_role',
    /**
     * Days a "keep me signed in" session lasts: 1 to 90, default 30. Read when the session is issued, and the token carries its
     * own expiry from then on (`createSession`'s `ttlMs`), so a change never reaches a session that already exists.
     */
    onboardingSessionDays: 'onboarding.session_days',
    /**
     * The name an invite page shows as whoever sent it ("{name} invited you"). Never an email: the page is public. Unset: the
     * page says nothing about who invited.
     */
    onboardingInviterName: 'onboarding.inviter_name',
    /**
     * The WhatsApp message the invite card prefills, with `{name}` (the tenant), `{inviter}` and `{link}` filled in. It must
     * contain `{link}`. Unset: the card uses its own text, in the language the link was made for.
     */
    onboardingWhatsappText: 'onboarding.whatsapp_text',
    /**
     * The tenant whose connected Instagram account the platform reads OTHER people's public profiles with (Business Discovery, the
     * main Instagram source of an onboarding draft, 03 §1). A creator id. Unset means the owner's tenant, which is also what a saved
     * value that is not a tenant id falls back to. That account's rate limit is shared with its Growth competitor checks. Not a
     * secret. No Settings field edits it yet.
     */
    onboardingDiscoveryCreatorId: 'onboarding.discovery_creator_id',
    /**
     * Minutes after a sales DM's link before the ONE follow-up nudge is due (`src/services/dmSales/followup.ts`, DM plan §7): 0 to 1320,
     * default 240 (four hours). `0` switches follow-ups off. Read when the link is sent (it sets when the nudge is due) and again when the
     * nudge runs (a 0 saved in between cancels it). The 22 h ceiling keeps every delay inside Meta's 24 h window. Not a secret. Edited by a platform admin on the AI settings screen
     * (`POST /api/settings/sales-followup`).
     */
    dmSalesFollowupMinutes: 'dm.sales.followup_minutes',
    /**
     * Handoff alerts to the owner (docs/DM_SALES_PLAN.md S8, `src/services/notify.ts`): a Telegram bot the owner makes with @BotFather.
     * The token is the one secret (encrypted, and the Settings card is told `{set, last4}` and nothing else). The chat id is the owner's
     * own (a number, or `@channel`). `enabled` is 'true' once the owner has switched alerts on, and `hot_leads` is 'false' only when
     * the owner turned the hot-lead pings off (unset means they are on: the owner's decision of 2026-10-14). Alerts exist for the
     * platform owner's tenant only: until a per-tenant channel exists, another tenant's customers are never sent to this chat.
     */
    notifyTelegramBotToken: 'notify.telegram_bot_token',
    notifyTelegramChatId: 'notify.telegram_chat_id',
    notifyTelegramEnabled: 'notify.telegram_enabled',
    notifyTelegramHotLeads: 'notify.telegram_hot_leads',
    /**
     * 'true': an echo (`is_echo`) that proves a person replied by hand pauses the bot for that conversation (`src/webhook/echo.ts`).
     * Unset is off, and off means echoes are dropped before they become jobs, exactly as before this setting existed. DM plan
     * assumption A4 (can our own sends be told from the owner's replies in the Instagram app?) is unverified, so it ships off.
     */
    dmEchoTakeover: 'dm.echo_takeover',
    /**
     * Comma-separated Meta app ids the owner ADDS to the ones whose echoes mean "a person replied". The documented one (the Facebook Page
     * inbox app, `PAGE_INBOX_APP_IDS` in `src/webhook/echo.ts`) is always in the list; the owner adds the id the Instagram app's echoes carry
     * once the log line `dm.echo_classified` shows it.
     */
    dmEchoOwnerAppIds: 'dm.echo_owner_app_ids',
} as const;

export type AppSettingKey = (typeof APP_SETTING_KEYS)[keyof typeof APP_SETTING_KEYS];

/**
 * Settings that belong to ONE tenant, in the same table: the prefix and the tenant's id make the key (`dm.ice_breakers.<creator uuid>`).
 * `APP_SETTING_KEYS` is the deployment's own list, one value each; a tenant's value cannot be a constant, so it has a family. The key is
 * always built from the request's resolved tenant (`getTenantId`), never from anything a client sent, and `tenantSettingKey` refuses an id
 * that is not the shape of one, so a request cannot reach another tenant's row or a deployment-wide key by choosing its "id".
 *
 *   dmIceBreakers   the Instagram ice breakers and persistent menu the owner edits, and the record of the last publish (DM plan S13,
 *                   `src/services/dmSales/iceBreakerStore.ts`). Not a secret. There is no tenant deletion in this product (a tenant is
 *                   deactivated), so a row is never orphaned.
 *   dmVariants      the owner's A/B wording experiment for the DM sales turn: up to three variants of how to open and how to offer the link, their
 *                   weights, and whether it is running (DM plan S14, `src/services/dmSales/variantStore.ts`). Not a secret.
 */
export const TENANT_SETTING_PREFIXES = {
    dmIceBreakers: 'dm.ice_breakers.',
    dmVariants: 'dm.variants.',
} as const;

export type TenantSettingKey = `${(typeof TENANT_SETTING_PREFIXES)[keyof typeof TENANT_SETTING_PREFIXES]}${string}`;

/** A tenant id as a key part: letters, digits and dashes (a uuid), at most 64 of them. The column is 100 characters wide. */
const TENANT_ID_PART = /^[A-Za-z0-9-]{1,64}$/;

export function tenantSettingKey(prefix: (typeof TENANT_SETTING_PREFIXES)[keyof typeof TENANT_SETTING_PREFIXES], creatorId: string): TenantSettingKey {
    if (!TENANT_ID_PART.test(creatorId)) throw new Error('tenantSettingKey: not a tenant id.');
    return `${prefix}${creatorId}`;
}

const SECRET_KEYS: ReadonlySet<AppSettingKey> = new Set([
    APP_SETTING_KEYS.tiktokClientSecret,
    APP_SETTING_KEYS.youtubeClientSecret,
    APP_SETTING_KEYS.youtubeApiKey,
    APP_SETTING_KEYS.geminiApiKey,
    APP_SETTING_KEYS.mediaStorageKey,
    APP_SETTING_KEYS.aiProviderKeyAnthropic,
    APP_SETTING_KEYS.aiProviderKeyOpenai,
    APP_SETTING_KEYS.aiProviderKeyOpenrouter,
    APP_SETTING_KEYS.aiProviderKeyGroq,
    APP_SETTING_KEYS.aiProviderKeyCustom,
    APP_SETTING_KEYS.notifyTelegramBotToken,
]);

export function isSecretSetting(key: AppSettingKey | TenantSettingKey): boolean {
    return SECRET_KEYS.has(key as AppSettingKey);
}

/** The decrypted value, or null when unset. */
export async function getSetting(key: AppSettingKey | TenantSettingKey): Promise<string | null> {
    const row = await queryOne<Pick<AppSettingRow, 'value' | 'is_secret'>>(
        'SELECT value, is_secret FROM app_settings WHERE key = $1',
        [key]
    );
    if (!row || row.value === null || row.value === '') return null;
    return row.is_secret ? decryptSecret(row.value) : row.value;
}

/**
 * Several settings in one round trip: the decrypted value of each key, or null when unset. A key asked for is always in the map.
 * The AI layer reads about a dozen rows per call (`src/services/aiProviders/settings.ts`), so one indexed `ANY` read replaces a dozen.
 */
export async function getSettings(keys: readonly AppSettingKey[]): Promise<Map<AppSettingKey, string | null>> {
    const out = new Map<AppSettingKey, string | null>(keys.map((key) => [key, null]));
    if (keys.length === 0) return out;
    const rows = await queryRows<Pick<AppSettingRow, 'key' | 'value' | 'is_secret'>>(
        'SELECT key, value, is_secret FROM app_settings WHERE key = ANY($1::text[])',
        [keys]
    );
    for (const row of rows) {
        if (!out.has(row.key as AppSettingKey)) continue;
        if (row.value === null || row.value === '') continue;
        out.set(row.key as AppSettingKey, row.is_secret ? decryptSecret(row.value) : row.value);
    }
    return out;
}

/**
 * Write a setting. `null` or an empty string deletes it, so the env fallback takes over again.
 * Secrets are encrypted here, the one place they are written.
 */
export async function setSetting(
    key: AppSettingKey | TenantSettingKey,
    value: string | null,
    updatedBy: string | null
): Promise<void> {
    if (value === null || value === '') {
        await queryCount('DELETE FROM app_settings WHERE key = $1', [key]);
        return;
    }
    const secret = isSecretSetting(key);
    await queryCount(
        `INSERT INTO app_settings (key, value, is_secret, updated_at, updated_by)
         VALUES ($1, $2, $3, NOW(), $4)
         ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, is_secret = EXCLUDED.is_secret,
                updated_at = NOW(), updated_by = EXCLUDED.updated_by`,
        [key, secret ? encryptSecret(value) : value, secret, updatedBy]
    );
}

/** A masked hint of a value — enough to recognise it, never enough to use it. */
export function maskValue(value: string): string {
    if (value.length <= 6) return '•'.repeat(value.length);
    return `${value.slice(0, 3)}${'•'.repeat(Math.max(value.length - 5, 3))}${value.slice(-2)}`;
}

/**
 * The last four characters of a secret, for "which key is this" on the Operations screen: all the card is ever told of a key beside
 * whether one is set. Null for a value too short for four characters to be a small part of it (a key under 12 characters is a typo,
 * not a credential, and four of its characters would be a third of it).
 */
export function last4(value: string): string | null {
    return value.length >= 12 ? value.slice(-4) : null;
}

/** What the DM bot and the Studio fail with when there is no key anywhere. */
export const MISSING_GEMINI_KEY = 'No Gemini API key: save one on the Operations screen, or set GEMINI_API_KEY.';

export interface GeminiKey {
    key: string;
    /** Which one is answering, so the Operations screen can say so. */
    source: 'database' | 'env';
}

/**
 * The Gemini API key: the one saved on the Operations screen, then `GEMINI_API_KEY`. Null when
 * neither is set — callers then throw `MISSING_GEMINI_KEY`, which names both places to fix it.
 *
 * Read on every call, not cached: a key saved from the dashboard has to reach every warm
 * serverless instance, and the read is one indexed row.
 */
export async function getGeminiKey(): Promise<GeminiKey | null> {
    const saved = await getSetting(APP_SETTING_KEYS.geminiApiKey);
    if (saved) return { key: saved, source: 'database' };
    const env = process.env.GEMINI_API_KEY?.trim();
    return env ? { key: env, source: 'env' } : null;
}

export interface GeminiKeyStatus {
    /** Which key is answering right now, or null when there is none at all. */
    source: 'database' | 'env' | null;
    /** A masked hint of the saved key. An env key is never previewed, only reported present. */
    preview: string | null;
    /** Whether removing the saved key would fall back to `GEMINI_API_KEY` or leave nothing. */
    envFallback: boolean;
}

/** What the Operations screen shows. Never the key itself. */
export async function describeGeminiKey(): Promise<GeminiKeyStatus> {
    const saved = await getSetting(APP_SETTING_KEYS.geminiApiKey);
    const envFallback = Boolean(process.env.GEMINI_API_KEY?.trim());
    return {
        source: saved ? 'database' : envFallback ? 'env' : null,
        preview: saved ? maskValue(saved) : null,
        envFallback,
    };
}

export interface TikTokAppConfig {
    clientKey: string;
    clientSecret: string;
    /** Where each value came from, so the dashboard can say "set in the environment". */
    source: { clientKey: 'database' | 'env'; clientSecret: 'database' | 'env' };
}

/**
 * The TikTok app credentials: database first, then `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`.
 * Null when either half is missing — a key without a secret cannot complete an OAuth exchange.
 */
export async function getTikTokAppConfig(): Promise<TikTokAppConfig | null> {
    const [dbKey, dbSecret] = await Promise.all([
        getSetting(APP_SETTING_KEYS.tiktokClientKey),
        getSetting(APP_SETTING_KEYS.tiktokClientSecret),
    ]);
    const clientKey = dbKey ?? (process.env.TIKTOK_CLIENT_KEY?.trim() || null);
    const clientSecret = dbSecret ?? (process.env.TIKTOK_CLIENT_SECRET?.trim() || null);
    if (!clientKey || !clientSecret) return null;
    return {
        clientKey,
        clientSecret,
        source: { clientKey: dbKey ? 'database' : 'env', clientSecret: dbSecret ? 'database' : 'env' },
    };
}

export interface YouTubeAppConfig {
    clientId: string;
    clientSecret: string;
    source: { clientId: 'database' | 'env'; clientSecret: 'database' | 'env' };
}

/**
 * The Google OAuth client for YouTube: database first, then `YOUTUBE_CLIENT_ID` /
 * `YOUTUBE_CLIENT_SECRET`. Null when either half is missing.
 */
export async function getYouTubeAppConfig(): Promise<YouTubeAppConfig | null> {
    const [dbId, dbSecret] = await Promise.all([
        getSetting(APP_SETTING_KEYS.youtubeClientId),
        getSetting(APP_SETTING_KEYS.youtubeClientSecret),
    ]);
    const clientId = dbId ?? (process.env.YOUTUBE_CLIENT_ID?.trim() || null);
    const clientSecret = dbSecret ?? (process.env.YOUTUBE_CLIENT_SECRET?.trim() || null);
    if (!clientId || !clientSecret) return null;
    return {
        clientId,
        clientSecret,
        source: { clientId: dbId ? 'database' : 'env', clientSecret: dbSecret ? 'database' : 'env' },
    };
}

export interface YouTubeApiKey {
    key: string;
    /** Which one is answering, so Settings can say so. */
    source: 'database' | 'env';
}

/**
 * The Google API key that reads public YouTube data: the one saved in Settings (`youtube.api_key`), then `YOUTUBE_API_KEY`.
 * Null when neither is set, and then the onboarding draft skips YouTube as "unavailable" rather than failing. Read on every call,
 * not cached: a key saved from the dashboard has to reach every warm serverless instance.
 */
export async function getYouTubeApiKey(): Promise<YouTubeApiKey | null> {
    const saved = await getSetting(APP_SETTING_KEYS.youtubeApiKey);
    if (saved) return { key: saved, source: 'database' };
    const env = process.env.YOUTUBE_API_KEY?.trim();
    return env ? { key: env, source: 'env' } : null;
}

export interface MetaLoginSettings {
    /** Whether tenants may use Connect with Facebook. Default false. */
    enabled: boolean;
    /** The Facebook Login for Business configuration id, or null (the dialog then asks for `scope=` instead). */
    configId: string | null;
    /** Where the id came from, so the card can say "set in the environment". */
    configIdSource: 'database' | 'env' | null;
}

/** A Login for Business configuration id is a number: Meta's own are 15 or 16 digits, and nothing shorter than 6 or longer than 30 is one. */
export const META_CONFIG_ID_PATTERN = /^[0-9]{6,30}$/;

/**
 * The operator's two Meta login settings: the switch (database only, default off) and the configuration id (database first, then
 * `META_LOGIN_CONFIG_ID`). A saved or env value that is not a configuration id is ignored with a log line, never sent to Meta.
 */
export async function getMetaLoginSettings(): Promise<MetaLoginSettings> {
    const [enabled, dbConfig] = await Promise.all([
        getSetting(APP_SETTING_KEYS.metaLoginEnabled),
        getSetting(APP_SETTING_KEYS.metaLoginConfigId),
    ]);
    const envConfig = process.env.META_LOGIN_CONFIG_ID?.trim() || null;
    const candidate = dbConfig ?? envConfig;
    const configId = candidate && META_CONFIG_ID_PATTERN.test(candidate) ? candidate : null;
    if (candidate && !configId) log('warn', 'meta.login_config_id_unreadable', { source: dbConfig ? 'database' : 'env' });
    return {
        enabled: enabled === 'true',
        configId,
        configIdSource: configId ? (dbConfig ? 'database' : 'env') : null,
    };
}

/** Whether Shorts upload public (Settings → YouTube → "Upload Shorts as public"). Off by default. */
export async function youtubeUploadsPublic(): Promise<boolean> {
    return (await getSetting(APP_SETTING_KEYS.youtubePublicUploads)) === 'true';
}

/** What a created tenant starts with when `onboarding.default_rules` says nothing usable: D9's pre-ticked rule. */
export const DEFAULT_ONBOARDING_RULES: readonly ContentRulePreset[] = Object.freeze(['no_women_imagery'] as const);

/**
 * `onboarding.default_rules` as stored: a JSON array of rule presets this release knows, without repeats. Null when it is
 * not one (not JSON, not an array, a member that is no preset): a typo must not silently drop the pre-ticked rule, so
 * the caller falls back to the default instead of to "no rules".
 */
export function parseOnboardingRules(raw: string): ContentRulePreset[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed) || !parsed.every((rule) => typeof rule === 'string' && (CONTENT_RULE_PRESETS as readonly string[]).includes(rule))) return null;
    return [...new Set(parsed as ContentRulePreset[])];
}

/**
 * The rules a tenant the operator creates starts with. Read on every create (one indexed row). A saved value that cannot
 * be read is logged and ignored, which gives the default; a database that cannot be read fails the create rather than
 * guess, because a tenant stored without the rule it was meant to have is exactly what this setting exists to prevent.
 */
export async function getOnboardingDefaultRules(): Promise<ContentRulePreset[]> {
    const raw = await getSetting(APP_SETTING_KEYS.onboardingDefaultRules);
    if (raw === null) return [...DEFAULT_ONBOARDING_RULES];
    const rules = parseOnboardingRules(raw);
    if (rules) return rules;
    log('warn', 'onboarding.default_rules_unreadable', { setting: APP_SETTING_KEYS.onboardingDefaultRules });
    return [...DEFAULT_ONBOARDING_RULES];
}

export interface MediaStorageConfig {
    /** The Supabase project's origin, normalised: `https://abcd1234.supabase.co`. */
    url: string;
    /** A secret key (`sb_secret_…`) or the legacy service_role JWT. */
    key: string;
    source: { url: 'database' | 'env'; key: 'database' | 'env' };
}

/**
 * Supabase Storage for media: what is saved in Settings, then `SUPABASE_URL` /
 * `SUPABASE_SERVICE_ROLE_KEY`, each half on its own. Null when either half is missing or the URL
 * is not an https origin — and then new uploads stay in Postgres (src/services/storage.ts).
 *
 * Read on every call, not cached, for the same reason as the Gemini key.
 */
export async function getMediaStorageConfig(): Promise<MediaStorageConfig | null> {
    const [dbUrl, dbKey] = await Promise.all([
        getSetting(APP_SETTING_KEYS.mediaStorageUrl),
        getSetting(APP_SETTING_KEYS.mediaStorageKey),
    ]);
    const rawUrl = dbUrl ?? (process.env.SUPABASE_URL?.trim() || null);
    const url = rawUrl ? normaliseOrigin(rawUrl) : null;
    const key = dbKey ?? (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null);
    if (!url || !key) return null;
    return { url, key, source: { url: dbUrl ? 'database' : 'env', key: dbKey ? 'database' : 'env' } };
}

/**
 * Normalise an origin the operator typed: scheme + host (+ port), no path, no trailing slash.
 * Returns null for anything that is not an absolute https URL (http is allowed for localhost only,
 * because TikTok refuses non-https redirect URIs and so would any real deployment).
 */
export function normaliseOrigin(input: string): string | null {
    let url: URL;
    try {
        url = new URL(input.trim());
    } catch {
        return null;
    }
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
    return url.origin;
}

/**
 * The public origin to build absolute URLs from: the saved setting, then `PUBLIC_BASE_URL`,
 * then — as a last resort that is right for production but wrong on preview deployments — the
 * origin the request arrived on.
 */
export async function getPublicBaseUrl(requestOrigin: string | null): Promise<string | null> {
    const saved = await getSetting(APP_SETTING_KEYS.publicBaseUrl);
    const fromSetting = saved ? normaliseOrigin(saved) : null;
    if (fromSetting) return fromSetting;
    const fromEnv = process.env.PUBLIC_BASE_URL ? normaliseOrigin(process.env.PUBLIC_BASE_URL) : null;
    if (fromEnv) return fromEnv;
    return requestOrigin ? normaliseOrigin(requestOrigin) : null;
}

/** `PUBLIC_BASE_URL`, or the production address when it is unset or not an https origin. What the site names itself at when the database cannot be read. */
export function siteOriginFromEnv(): string {
    const fromEnv = process.env.PUBLIC_BASE_URL ? normaliseOrigin(process.env.PUBLIC_BASE_URL) : null;
    return fromEnv ?? PRODUCTION_ORIGIN;
}

/**
 * The origin the public pages, `robots.txt` and the sitemap name themselves at: the saved `app.public_base_url`, then
 * `PUBLIC_BASE_URL`, then the production address (src/services/publicPages.ts `PRODUCTION_ORIGIN`).
 *
 * Not `getPublicBaseUrl(requestOrigin)`'s last resort. A canonical, an hreflang or an og:image built from the Host header makes
 * every preview deployment announce itself to crawlers as the real site, and a public page must still render when the settings
 * table is unreachable, so a failed read answers from the environment alone.
 */
export async function getSiteOrigin(): Promise<string> {
    try {
        return (await getPublicBaseUrl(null)) ?? PRODUCTION_ORIGIN;
    } catch {
        return siteOriginFromEnv();
    }
}

export interface TikTokPostingFlags {
    directPostEnabled: boolean;
    audited: boolean;
}

/** The two operator switches that decide how TikTok posts go out. Both default to off. */
export async function getTikTokPostingFlags(): Promise<TikTokPostingFlags> {
    const [direct, audited] = await Promise.all([
        getSetting(APP_SETTING_KEYS.tiktokDirectPostEnabled),
        getSetting(APP_SETTING_KEYS.tiktokAudited),
    ]);
    return { directPostEnabled: direct === 'true', audited: audited === 'true' };
}

/**
 * Whether the operator has said the TikTok portal approved `user.info.profile`. Off unless saved as 'true', and a settings table that
 * cannot be read answers off: the safe answer is the request the portal has always accepted.
 */
export async function getTikTokProfileScopeEnabled(): Promise<boolean> {
    try {
        return (await getSetting(APP_SETTING_KEYS.tiktokProfileScopeEnabled)) === 'true';
    } catch (err) {
        log('warn', 'tiktok.profile_scope_flag_unreadable', { message: err instanceof Error ? err.message : String(err) });
        return false;
    }
}

export interface VerificationFile { filename: string; content: string }

/** Every verification file to serve: the current one first, then the ones saved before it. */
export async function getVerificationFiles(): Promise<VerificationFile[]> {
    const [name, content, history] = await Promise.all([
        getSetting(APP_SETTING_KEYS.tiktokVerificationFilename),
        getSetting(APP_SETTING_KEYS.tiktokVerificationContent),
        getSetting(APP_SETTING_KEYS.tiktokVerificationHistory),
    ]);
    const files: VerificationFile[] = name && content ? [{ filename: name, content }] : [];
    try {
        const parsed = history ? JSON.parse(history) : [];
        if (Array.isArray(parsed)) {
            for (const f of parsed) {
                if (f && typeof f.filename === 'string' && typeof f.content === 'string'
                    && !files.some((x) => x.filename === f.filename)) {
                    files.push({ filename: f.filename, content: f.content });
                }
            }
        }
    } catch {
        // A malformed history must not take the current file down with it.
    }
    return files;
}

/** Save a new current verification file, keeping the previous ones (the last ten) servable. */
export async function saveVerificationFile(
    next: VerificationFile | null,
    updatedBy: string | null
): Promise<void> {
    const existing = await getVerificationFiles();
    const history = existing.filter((f) => !next || f.filename !== next.filename).slice(0, 10);
    await setSetting(APP_SETTING_KEYS.tiktokVerificationHistory, history.length ? JSON.stringify(history) : null, updatedBy);
    await setSetting(APP_SETTING_KEYS.tiktokVerificationFilename, next?.filename ?? null, updatedBy);
    await setSetting(APP_SETTING_KEYS.tiktokVerificationContent, next?.content ?? null, updatedBy);
}

// ─── The public site ────────────────────────────────────────────────────────────────────

export interface SiteSettings {
    /** Digits only, E.164 without the `+`, or null when no WhatsApp channel is offered. */
    whatsappNumber: string | null;
    contactEmail: string | null;
    /** `YYYY-MM-DD`, or null when there is no Eid coupon campaign running. */
    eidCouponsExpire: string | null;
}

/**
 * The address the public pages print when neither Settings nor SITE_CONTACT_EMAIL has one —
 * the founder's inbox, which every page carried as a literal before these were settings. It
 * lives here, not in the HTML, so the pages hold only `{{CONTACT_EMAIL}}`.
 */
export const DEFAULT_CONTACT_EMAIL = 'elamirmansour@outlook.com';

type SiteSource = 'database' | 'env' | 'default' | null;

export interface SiteSettingsStatus extends SiteSettings {
    /** Where each value comes from, so the Settings card can say "set in the environment". */
    source: { whatsappNumber: SiteSource; contactEmail: SiteSource; eidCouponsExpire: SiteSource };
}

/** E.164 is 8–15 digits with no leading zero; the `+` is never stored. */
const WHATSAPP_NUMBER = /^[1-9][0-9]{7,14}$/;
const CONTACT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * What the operator typed, as the digits wa.me wants: `+966 50 123 4567`, `00966501234567`
 * and `966501234567` all become `966501234567`, and so does the same number typed on an
 * Arabic keyboard (`٩٦٦٥٠١٢٣٤٥٦٧`, Arabic-Indic or Persian digits). Null when what is left is
 * not a phone number. The dashboard mirrors this (settings.js `normaliseWhatsapp`).
 */
export function normaliseWhatsappNumber(input: string): string | null {
    let digits = input
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
        .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
        .replace(/[\s\-().]/g, '');
    if (digits.startsWith('+')) digits = digits.slice(1);
    else if (digits.startsWith('00')) digits = digits.slice(2);
    return WHATSAPP_NUMBER.test(digits) ? digits : null;
}

export function normaliseContactEmail(input: string): string | null {
    const v = input.trim();
    return CONTACT_EMAIL.test(v) ? v : null;
}

/** A real calendar day in `YYYY-MM-DD`, or null. `2026-02-30` is refused. */
export function normaliseIsoDay(input: string): string | null {
    const m = ISO_DAY.exec(input.trim());
    if (!m) return null;
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const date = new Date(Date.UTC(y, mo - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
    return m[0];
}

/**
 * The environment's answer alone — what the public pages fall back to when the database is
 * down. The contact email alone has a last resort, DEFAULT_CONTACT_EMAIL.
 */
export function siteSettingsFromEnv(): SiteSettings {
    return {
        whatsappNumber: envWhatsappNumber(),
        contactEmail: envContactEmail() ?? DEFAULT_CONTACT_EMAIL,
        eidCouponsExpire: envEidCouponsExpire(),
    };
}

function envWhatsappNumber(): string | null {
    const v = process.env.SITE_WHATSAPP_NUMBER?.trim();
    return v ? normaliseWhatsappNumber(v) : null;
}

/** A blank or malformed SITE_CONTACT_EMAIL is not a value: the default answers instead. */
function envContactEmail(): string | null {
    const v = process.env.SITE_CONTACT_EMAIL?.trim();
    return v ? normaliseContactEmail(v) : null;
}

function envEidCouponsExpire(): string | null {
    const v = process.env.SITE_EID_COUPONS_EXPIRE?.trim();
    return v ? normaliseIsoDay(v) : null;
}

/**
 * The public site's contact channels and the Eid coupon expiry: what Settings saved, then the
 * environment, each on its own; null when neither has it — except the contact email, which
 * then falls back to DEFAULT_CONTACT_EMAIL (source 'default'). Read on every page request, not
 * cached, for the same reason as the Gemini key — a value saved from the dashboard has to
 * reach every warm instance (the CDN's `s-maxage` is the only cache).
 */
export async function describeSiteSettings(): Promise<SiteSettingsStatus> {
    const [dbNumber, dbEmail, dbExpire] = await Promise.all([
        getSetting(APP_SETTING_KEYS.siteWhatsappNumber),
        getSetting(APP_SETTING_KEYS.siteContactEmail),
        getSetting(APP_SETTING_KEYS.siteEidCouponsExpire),
    ]);
    const pick = (db: string | null, fromEnv: string | null, fallback: string | null = null): [string | null, SiteSource] =>
        db ? [db, 'database'] : fromEnv ? [fromEnv, 'env'] : fallback ? [fallback, 'default'] : [null, null];
    const [whatsappNumber, numberSource] = pick(dbNumber, envWhatsappNumber());
    const [contactEmail, emailSource] = pick(dbEmail, envContactEmail(), DEFAULT_CONTACT_EMAIL);
    const [eidCouponsExpire, expireSource] = pick(dbExpire, envEidCouponsExpire());
    return {
        whatsappNumber, contactEmail, eidCouponsExpire,
        source: { whatsappNumber: numberSource, contactEmail: emailSource, eidCouponsExpire: expireSource },
    };
}

/** `{ whatsappNumber, contactEmail, eidCouponsExpire }` — what the public pages print. */
export async function getSiteSettings(): Promise<SiteSettings> {
    const { whatsappNumber, contactEmail, eidCouponsExpire } = await describeSiteSettings();
    return { whatsappNumber, contactEmail, eidCouponsExpire };
}
