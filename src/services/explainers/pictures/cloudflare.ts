/**
 * Cloudflare Workers AI, FLUX.2 klein 4B: the first image provider of illustrated explainers (research.md R5, verified 2026-10-24).
 *
 * The call: `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`, `Authorization: Bearer`
 * the API token, a multipart form with `prompt`, `width`, `height`, `seed` and up to four reference pictures `input_image_0..3` (each smaller than
 * 512×512; the steps are fixed at 4 by the model). The answer is JSON with the picture as base64 in `result.image`. The free allocation is 10,000
 * neurons a day; when it is used up the API answers error code 3036, "Account limited" (HTTP 429; 4006 in older answers), and on the Workers Free
 * plan it never bills: it refuses. A 429 without that code is code 3040, "Out of capacity": Cloudflare is busy for a moment, which a retry
 * outlives, so it is never read as the day's allowance (Workers AI error table, developers.cloudflare.com/workers-ai/platform/errors, 2026-10-25).
 *
 * Failures are two kinds (`ImageProviderError`): the allowance is used up (the caller pauses drawing until it resets), or anything else (the
 * caller gives the units back and marks the scene). A call that does not answer in 55 seconds is the second kind.
 *
 * THE TOKEN. It is held in a `#private` field, so `JSON.stringify`, `util.inspect` and a spread of the object cannot reach it. It goes into one
 * request header and nowhere else, and no message leaves this file with it in: whatever Cloudflare echoes back, and whatever the network error
 * quotes, is scrubbed first. The account id and the model are put into the URL, so both are checked against a narrow pattern when the provider is
 * built: a stored value cannot change which endpoint the token is sent to.
 *
 * `fetch` is injected (`FetchLike`), as everywhere else this app calls a provider, so tests answer for Cloudflare.
 */
import type { FetchLike } from '../../llm/types.js';
import { sniffPictureMime } from './imageSize.js';
import { ImageProviderError, type DrawRequest, type DrawnPicture, type ImageProvider } from './types.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/**
 * How long one picture may take. plan.md hoped for 30 s, but the pilot's pictures (2026-10-25) took 15 to 26 s and one passed 30 s and failed,
 * so the call waits 55 s. The worker's draw-next call waits 120 s, and a synchronous route runs well within the function's limit.
 */
export const CLOUDFLARE_TIMEOUT_MS = 55_000;
/** `input_image_0` to `input_image_3`. */
export const CLOUDFLARE_MAX_REFERENCES = 4;
/** "you have used up your daily free allocation of 10,000 neurons": 3036 in Cloudflare's error table, 4006 in the REST API's older answers. */
const EXHAUSTED_CODES: ReadonlySet<number> = new Set([3036, 4006]);
/** Cloudflare's own words for it, whatever the code: an answer that says so is believed. */
const EXHAUSTED_WORDS = /daily free allocation/i;
/** The longest piece of Cloudflare's own words that goes into a message the owner reads. */
const MAX_PROVIDER_WORDS = 300;

const ACCOUNT_ID = /^[A-Za-z0-9]{8,64}$/;
/** `@cf/<author>/<model>`, each part starting with a letter or digit: a part of dots alone (`..`) would walk out of the path. */
const MODEL_ID = /^@cf\/[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const isCloudflareAccountId = (value: unknown): value is string => typeof value === 'string' && ACCOUNT_ID.test(value);
export const isCloudflareModel = (value: unknown): value is string => typeof value === 'string' && MODEL_ID.test(value);

export interface CloudflareConfig {
    accountId: string;
    /** The API token, in the clear: the caller decrypted it for this one provider object. */
    token: string;
    model: string;
    dailyCap: number;
    unitsPerPicture: number;
}

export interface CloudflareOptions {
    /** For tests. Defaults to the global `fetch`. */
    fetchImpl?: FetchLike;
    /** For tests. Defaults to 55 seconds. */
    timeoutMs?: number;
}

/** `text` without the secret, wherever it appears. */
const scrub = (text: string, secret: string): string => (secret ? text.split(secret).join('[redacted]') : text);

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export class CloudflareImageProvider implements ImageProvider {
    readonly id = 'cloudflare';
    readonly model: string;
    readonly dailyCap: number;
    readonly unitsPerPicture: number;
    readonly #accountId: string;
    readonly #token: string;
    readonly #fetch: FetchLike;
    readonly #timeoutMs: number;

    constructor(config: CloudflareConfig, options: CloudflareOptions = {}) {
        if (!isCloudflareAccountId(config.accountId)) throw new Error('The Cloudflare account id is not valid: it is letters and digits only.');
        if (!isCloudflareModel(config.model)) throw new Error('The Cloudflare model is not valid: it looks like @cf/black-forest-labs/flux-2-klein-4b.');
        if (typeof config.token !== 'string' || !config.token) throw new Error('The Cloudflare token is empty.');
        this.model = config.model;
        this.dailyCap = config.dailyCap;
        this.unitsPerPicture = config.unitsPerPicture;
        this.#accountId = config.accountId;
        this.#token = config.token;
        this.#fetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
        this.#timeoutMs = options.timeoutMs ?? CLOUDFLARE_TIMEOUT_MS;
    }

    async draw(request: DrawRequest): Promise<DrawnPicture> {
        const references = request.references ?? [];
        if (references.length > CLOUDFLARE_MAX_REFERENCES) {
            throw new ImageProviderError('PROVIDER_ERROR', `Cloudflare takes at most ${CLOUDFLARE_MAX_REFERENCES} reference pictures; this draw has ${references.length}.`);
        }

        const form = new FormData();
        form.set('prompt', request.prompt);
        form.set('width', String(request.width));
        form.set('height', String(request.height));
        form.set('seed', String(request.seed));
        references.forEach((reference, index) => {
            const extension = reference.mime === 'image/png' ? 'png' : 'jpg';
            form.set(`input_image_${index}`, new Blob([Uint8Array.from(reference.data)], { type: reference.mime }), `reference-${index}.${extension}`);
        });

        let status: number;
        let text: string;
        try {
            const response = await this.#fetch(`${CLOUDFLARE_API}/accounts/${this.#accountId}/ai/run/${this.model}`, {
                method: 'POST',
                // No Content-Type: fetch writes the multipart one itself, with its boundary.
                headers: { Authorization: `Bearer ${this.#token}` },
                body: form,
                signal: AbortSignal.timeout(this.#timeoutMs),
            });
            status = response.status;
            text = await response.text();
        } catch (err) {
            throw this.#unreachable(err);
        }

        let body: unknown = null;
        try {
            body = JSON.parse(text);
        } catch {
            // Not JSON: a gateway page, or nothing. The HTTP status is what there is.
        }
        const answer = (typeof body === 'object' && body !== null ? body : {}) as {
            success?: unknown; errors?: unknown; result?: { image?: unknown } | null; image?: unknown;
        };
        const errors = (Array.isArray(answer.errors) ? answer.errors : []) as { code?: unknown; message?: unknown }[];

        if (status < 200 || status >= 300 || answer.success === false) throw this.#failure(status, errors);

        const image = answer.result?.image ?? answer.image;
        if (typeof image !== 'string' || !image) throw new ImageProviderError('PROVIDER_ERROR', 'Cloudflare answered without a picture.', { status });
        const data = Buffer.from(image.replace(/^data:[^,]*,/, ''), 'base64');
        const mime = sniffPictureMime(data);
        if (!mime) throw new ImageProviderError('PROVIDER_ERROR', 'Cloudflare answered with something that is not a PNG or a JPEG picture.', { status });
        return { data, mime, provider: this.id, model: this.model };
    }

    /** A refusal or a failure Cloudflare answered: the allowance is used up (code 4006, or 429), or any other reason. */
    #failure(status: number, errors: { code?: unknown; message?: unknown }[]): ImageProviderError {
        const code = (value: unknown): number | string | undefined => (typeof value === 'number' || typeof value === 'string' ? value : undefined);
        const exhaustedAt = errors.find((error) => EXHAUSTED_CODES.has(Number(error?.code)) || EXHAUSTED_WORDS.test(String(error?.message ?? '')));
        const first = errors[0];
        const reported = code((exhaustedAt ?? first)?.code);
        const detail: { status: number; code?: number | string } = reported === undefined ? { status } : { status, code: reported };
        const said = clip(scrub(String((exhaustedAt ?? first)?.message ?? ''), this.#token), MAX_PROVIDER_WORDS);

        if (exhaustedAt) {
            return new ImageProviderError('ALLOWANCE_EXHAUSTED', `Cloudflare says the free daily allowance is used up${said ? ` (${said})` : ''}.`, detail);
        }
        if (status === 429) {
            // 3040, "Out of capacity", or a 429 that does not say: busy for a moment, not out of allowance. Drawing is not paused until tomorrow.
            return new ImageProviderError('PROVIDER_ERROR', `Cloudflare is busy right now${said ? ` (${said})` : ''}; try again in a few minutes.`, detail);
        }
        return new ImageProviderError('PROVIDER_ERROR', said ? `Cloudflare refused the picture: ${said}` : `Cloudflare answered HTTP ${status}.`, detail);
    }

    /** The call never got an answer: it timed out, or the network failed. What the error quotes is scrubbed of the token. */
    #unreachable(err: unknown): ImageProviderError {
        const name = (err as { name?: unknown } | null)?.name;
        if (name === 'TimeoutError' || name === 'AbortError') return new ImageProviderError('PROVIDER_ERROR', 'Cloudflare did not answer in time.');
        const said = clip(scrub(err instanceof Error ? err.message : String(err), this.#token), MAX_PROVIDER_WORDS);
        return new ImageProviderError('PROVIDER_ERROR', `Cloudflare could not be reached${said ? `: ${said}` : ''}.`);
    }
}
