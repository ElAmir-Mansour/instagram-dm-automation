/**
 * The image provider illustrated explainers draw with: what is saved (`explainers.image_provider` in `app_settings`), how a platform admin's save
 * is checked, and `getImageProvider()`, which gives the code that draws a provider ready to call (data-model.md §6.2, research.md R5).
 *
 *   { provider: 'cloudflare', account_id, token_enc, model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 80, units_per_picture: 110 }
 *
 * Platform-wide, because the provider account is the owner's: one setting, one allowance (`allowance.ts`), whichever tenant draws.
 *
 * THE TOKEN. It is encrypted with `src/config/crypto.ts` BEFORE the JSON is written (`token_enc`), so the row holds ciphertext even though the row
 * itself is not an `is_secret` one. It is decrypted in one place, `getImageProvider`, for one provider object that keeps it private
 * (cloudflare.ts), and in one other, `describeImageProvider`, for its last four characters. Every answer built from here carries `token_last4` and
 * never the token or `token_enc`; nothing here logs either.
 *
 * `daily_cap` is in PICTURES (default 80) and `units_per_picture` in the provider's own unit (Cloudflare's neurons, estimated at 110 for a picture
 * with one reference): the allowance budgets `daily_cap × units_per_picture` units a UTC day, which leaves room under Cloudflare's 10,000. Both are
 * the owner's to recalibrate from live calls, so a stored value that cannot be one falls back to the default and never to something surprising.
 */
import { decryptSecret, encryptSecret } from '../../../config/crypto.js';
import { describeError, log } from '../../../utils/log.js';
import { APP_SETTING_KEYS, getSetting, last4, setSetting } from '../../appSettings.js';
import type { FetchLike } from '../../llm/types.js';
import { isPlainObject } from '../../studio/common.js';
import { ExplainerError } from '../errors.js';
import { CloudflareImageProvider, isCloudflareAccountId, isCloudflareModel } from './cloudflare.js';
import type { ImageProvider } from './types.js';

export type { DrawReference, DrawRequest, DrawnPicture, ImageProvider, ImageProviderErrorKind } from './types.js';
export { ImageProviderError } from './types.js';

export const DEFAULT_IMAGE_PROVIDER_MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
/** Pictures a day: about 90 fit in Cloudflare's 10,000 free neurons at 110 each, so 80 leaves headroom. */
export const DEFAULT_DAILY_CAP = 80;
export const DEFAULT_UNITS_PER_PICTURE = 110;
export const MAX_DAILY_CAP = 1000;
export const MAX_UNITS_PER_PICTURE = 10_000;

const TOKEN_MIN = 20;
const TOKEN_MAX = 200;

/** What is stored. `provider` is the registry name; today only `cloudflare` exists. */
export interface ImageProviderConfig {
    provider: 'cloudflare';
    account_id: string;
    /** The API token, encrypted with `encryptSecret`. */
    token_enc: string;
    model: string;
    daily_cap: number;
    units_per_picture: number;
}

const isDailyCap = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_DAILY_CAP;
const isUnitCost = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_UNITS_PER_PICTURE;

/**
 * The saved setting as a config, or null when there is nothing usable: not JSON, not an object, a provider this build does not know, an account
 * id that is not one, or no token. A cap, a unit cost or a model that cannot be one is replaced by its default.
 */
export function parseImageProviderConfig(raw: string | null | undefined): ImageProviderConfig | null {
    if (typeof raw !== 'string' || !raw) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!isPlainObject(parsed)) return null;
    if (parsed.provider !== 'cloudflare') return null;
    if (!isCloudflareAccountId(parsed.account_id)) return null;
    if (typeof parsed.token_enc !== 'string' || !parsed.token_enc) return null;
    return {
        provider: 'cloudflare',
        account_id: parsed.account_id,
        token_enc: parsed.token_enc,
        model: isCloudflareModel(parsed.model) ? parsed.model : DEFAULT_IMAGE_PROVIDER_MODEL,
        daily_cap: isDailyCap(parsed.daily_cap) ? parsed.daily_cap : DEFAULT_DAILY_CAP,
        units_per_picture: isUnitCost(parsed.units_per_picture) ? parsed.units_per_picture : DEFAULT_UNITS_PER_PICTURE,
    };
}

/** The saved config, or null when nothing usable is saved. Never decrypts. */
export async function readImageProviderConfig(): Promise<ImageProviderConfig | null> {
    return parseImageProviderConfig(await getSetting(APP_SETTING_KEYS.explainersImageProvider));
}

let providerFetch: FetchLike | undefined;

/** Tests only: the `fetch` every provider built after this is given. Returns the previous one. */
export function setImageProviderFetch(next: FetchLike | undefined): FetchLike | undefined {
    const previous = providerFetch;
    providerFetch = next;
    return previous;
}

let providerOverride: ImageProvider | null | undefined;

/**
 * Tests only: the provider `getImageProvider` answers with, whatever is saved (`null` is "none set up"). `undefined` takes the override away.
 * Returns the previous one. Like `setMediaStore`, for a test of the code that draws, which has no business with a token or a cipher.
 */
export function setImageProvider(next: ImageProvider | null | undefined): ImageProvider | null | undefined {
    const previous = providerOverride;
    providerOverride = next;
    return previous;
}

/**
 * The provider to draw with, or null when none is set up (the caller answers 409 `EXPLAINER_NO_PROVIDER`).
 *
 * A token that cannot be decrypted (the encryption key changed since it was saved) is not "no provider": that is 502 `EXPLAINER_PROVIDER_ERROR`
 * with words that say what to do, because "set up a provider" would send the admin to a card that looks set up already.
 */
export async function getImageProvider(): Promise<ImageProvider | null> {
    if (providerOverride !== undefined) return providerOverride;
    const config = await readImageProviderConfig();
    if (!config) return null;
    let token: string;
    try {
        token = decryptSecret(config.token_enc);
    } catch (err) {
        // Not the error itself: what a failed decryption says is nothing a log needs, and nothing about the token belongs in one.
        log('error', 'explainer.provider_token_unreadable', { name: (err as { name?: string } | null)?.name });
        throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', 'The saved Cloudflare token cannot be read (the encryption key may have changed). Save the token again in Settings → Platform → Explainers.');
    }
    if (!token) {
        throw new ExplainerError('EXPLAINER_PROVIDER_ERROR', 'The saved Cloudflare token cannot be read (it is empty). Save the token again in Settings → Platform → Explainers.');
    }
    try {
        return new CloudflareImageProvider(
            { accountId: config.account_id, token, model: config.model, dailyCap: config.daily_cap, unitsPerPicture: config.units_per_picture },
            providerFetch ? { fetchImpl: providerFetch } : {}
        );
    } catch (err) {
        log('error', 'explainer.provider_unusable', describeError(err));
        return null;
    }
}

/** What the platform admin's card is shown: the setting, with the token as its last four characters and nothing more. */
export interface ImageProviderView {
    provider: string;
    account_id: string;
    token_last4: string | null;
    model: string;
    daily_cap: number;
    units_per_picture: number;
}

export function describeImageProvider(config: ImageProviderConfig | null): ImageProviderView | null {
    if (!config) return null;
    let tail: string | null = null;
    try {
        tail = last4(decryptSecret(config.token_enc));
    } catch {
        // Unreadable: the card shows no last four, and the provider test says why.
    }
    return {
        provider: config.provider,
        account_id: config.account_id,
        token_last4: tail,
        model: config.model,
        daily_cap: config.daily_cap,
        units_per_picture: config.units_per_picture,
    };
}

/**
 * The secrets of a saved config (the ciphertext, and the token when it can be read), for a guard that checks an answer is free of them before it is
 * sent. Never returned, never logged: it is only ever compared against.
 */
export function secretsOf(config: ImageProviderConfig | null): string[] {
    if (!config) return [];
    const secrets = [config.token_enc];
    try {
        const token = decryptSecret(config.token_enc);
        if (token) secrets.push(token);
    } catch {
        // Unreadable: the ciphertext alone is what there is to keep out.
    }
    return secrets;
}

/** The fields a platform admin may set. An omitted field stays as it is saved. */
export interface ImageProviderPatch {
    account_id?: string;
    token?: string;
    daily_cap?: number;
    units_per_picture?: number;
}

/** Keys of GET's answer, which a card may send straight back: `provider`, `model` and `token_last4` are accepted when they change nothing. */
const BODY_KEYS = ['account_id', 'token', 'daily_cap', 'units_per_picture', 'provider', 'model', 'token_last4'];

export type ParsedImageProviderPatch = { ok: true; patch: ImageProviderPatch; changed: string[] } | { ok: false; problems: string[] };

/**
 * The body of `PUT /api/admin/explainers/provider`, checked. A field that is null, missing or blank text is LEFT OUT (a form that always sends
 * every field must not wipe the token); a field of the wrong kind, or out of range, is a problem, and every problem is reported at once. The first
 * save needs the account id and the token. `changed` names the fields whose value is not what is saved: it is what the audit row records, since
 * it must say what changed and never the token.
 */
export function parseImageProviderPatch(body: unknown, existing: ImageProviderConfig | null): ParsedImageProviderPatch {
    if (!isPlainObject(body)) return { ok: false, problems: ['The body must be a JSON object.'] };
    const problems: string[] = [];
    const patch: ImageProviderPatch = {};

    for (const key of Object.keys(body)) {
        if (!BODY_KEYS.includes(key)) problems.push(`${key} is not a setting of the image provider.`);
    }
    if (body.provider !== undefined && body.provider !== null && body.provider !== 'cloudflare') problems.push('provider must be cloudflare: it is the only image provider there is.');
    const model = existing?.model ?? DEFAULT_IMAGE_PROVIDER_MODEL;
    if (body.model !== undefined && body.model !== null && body.model !== model) problems.push(`model cannot be changed here: it is ${model}.`);

    const text = (value: unknown, name: string, bad: Set<string>): string | undefined => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== 'string') {
            problems.push(`${name} must be text.`);
            bad.add(name);
            return undefined;
        }
        return value.trim() === '' ? undefined : value.trim();
    };
    const reported = new Set<string>();

    const account = text(body.account_id, 'account_id', reported);
    if (account !== undefined) {
        if (isCloudflareAccountId(account)) patch.account_id = account;
        else {
            problems.push('account_id is the Cloudflare account id: letters and digits only, with no spaces or slashes.');
            reported.add('account_id');
        }
    }
    const token = text(body.token, 'token', reported);
    if (token !== undefined) {
        if (/\s/.test(token) || token.length < TOKEN_MIN || token.length > TOKEN_MAX) {
            problems.push(`token is the Cloudflare API token: ${TOKEN_MIN} to ${TOKEN_MAX} characters, with no spaces (paste the token alone, without "Bearer").`);
            reported.add('token');
        } else patch.token = token;
    }

    if (body.daily_cap !== undefined && body.daily_cap !== null) {
        if (isDailyCap(body.daily_cap)) patch.daily_cap = body.daily_cap;
        else problems.push(`daily_cap is the pictures a day: a whole number from 0 to ${MAX_DAILY_CAP}.`);
    }
    if (body.units_per_picture !== undefined && body.units_per_picture !== null) {
        if (isUnitCost(body.units_per_picture)) patch.units_per_picture = body.units_per_picture;
        else problems.push(`units_per_picture is what one picture costs: above 0 and at most ${MAX_UNITS_PER_PICTURE}.`);
    }

    if (!existing) {
        if (patch.account_id === undefined && !reported.has('account_id')) problems.push('account_id is required the first time: the Cloudflare account id.');
        if (patch.token === undefined && !reported.has('token')) problems.push('token is required the first time: a Cloudflare API token with Workers AI permission.');
    }
    if (problems.length) return { ok: false, problems };

    const changed: string[] = [];
    if (patch.account_id !== undefined && patch.account_id !== existing?.account_id) changed.push('account_id');
    if (patch.token !== undefined) changed.push('token');
    if (patch.daily_cap !== undefined && patch.daily_cap !== existing?.daily_cap) changed.push('daily_cap');
    if (patch.units_per_picture !== undefined && patch.units_per_picture !== existing?.units_per_picture) changed.push('units_per_picture');
    return { ok: true, patch, changed };
}

/**
 * Save the provider: what is saved, with `patch` over it. The token is encrypted here, before anything is written, and a save that sends none
 * keeps the saved ciphertext exactly as it is. The model is the saved one (the default on the first save). `patch` is what `parseImageProviderPatch`
 * accepted: this checks only what it cannot do without (the account and the token of a first save), and throws for those.
 */
export async function saveImageProvider(patch: ImageProviderPatch, updatedBy: string | null): Promise<ImageProviderConfig> {
    const existing = await readImageProviderConfig();
    const accountId = patch.account_id ?? existing?.account_id;
    if (!accountId) throw new Error('A first save needs the Cloudflare account id.');
    const tokenEnc = patch.token !== undefined ? encryptSecret(patch.token) : existing?.token_enc;
    if (!tokenEnc) throw new Error('A first save needs the Cloudflare API token.');

    const next: ImageProviderConfig = {
        provider: 'cloudflare',
        account_id: accountId,
        token_enc: tokenEnc,
        model: existing?.model ?? DEFAULT_IMAGE_PROVIDER_MODEL,
        daily_cap: patch.daily_cap ?? existing?.daily_cap ?? DEFAULT_DAILY_CAP,
        units_per_picture: patch.units_per_picture ?? existing?.units_per_picture ?? DEFAULT_UNITS_PER_PICTURE,
    };
    await setSetting(APP_SETTING_KEYS.explainersImageProvider, JSON.stringify(next), updatedBy);
    return next;
}
