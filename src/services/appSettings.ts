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
     * The canonical public origin, e.g. `https://msg-response-auto.vercel.app`.
     *
     * TikTok compares the OAuth `redirect_uri` byte-for-byte against the one registered in its
     * developer portal. Building it from the request's Host header — which is how media URLs are
     * built today — would produce a different URI on every preview deployment and fail there.
     */
    publicBaseUrl: 'app.public_base_url',
} as const;

export type AppSettingKey = (typeof APP_SETTING_KEYS)[keyof typeof APP_SETTING_KEYS];

const SECRET_KEYS: ReadonlySet<AppSettingKey> = new Set([APP_SETTING_KEYS.tiktokClientSecret]);

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
