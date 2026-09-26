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
import { queryOne, queryCount } from '../db/query.js';
import type { AppSettingRow } from '../db/rows.js';

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
} as const;

export type AppSettingKey = (typeof APP_SETTING_KEYS)[keyof typeof APP_SETTING_KEYS];

const SECRET_KEYS: ReadonlySet<AppSettingKey> = new Set([
    APP_SETTING_KEYS.tiktokClientSecret,
    APP_SETTING_KEYS.geminiApiKey,
    APP_SETTING_KEYS.mediaStorageKey,
]);

export function isSecretSetting(key: AppSettingKey): boolean {
    return SECRET_KEYS.has(key);
}

/** The decrypted value, or null when unset. */
export async function getSetting(key: AppSettingKey): Promise<string | null> {
    const row = await queryOne<Pick<AppSettingRow, 'value' | 'is_secret'>>(
        'SELECT value, is_secret FROM app_settings WHERE key = $1',
        [key]
    );
    if (!row || row.value === null || row.value === '') return null;
    return row.is_secret ? decryptSecret(row.value) : row.value;
}

/**
 * Write a setting. `null` or an empty string deletes it, so the env fallback takes over again.
 * Secrets are encrypted here, the one place they are written.
 */
export async function setSetting(
    key: AppSettingKey,
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
