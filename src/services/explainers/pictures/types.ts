/**
 * What an image provider is, as far as illustrated explainers need it: the request, the picture that comes back, and the two ways a call fails.
 * A leaf module (it imports only the logger and the type of a picture) so that `provider.ts` (which builds providers) and `cloudflare.ts` (one of
 * them) can both use it without importing each other. Everything here is re-exported from `provider.ts`, which is where the rest of the code imports
 * it from.
 */
import { describeError, log } from '../../../utils/log.js';
import type { PictureMime } from './imageSize.js';

/** One reference picture, sent beside the prompt so the model draws the same character again (research.md R6). */
export interface DrawReference {
    data: Uint8Array;
    mime: PictureMime;
}

export interface DrawRequest {
    prompt: string;
    width: number;
    height: number;
    /** A whole number below 2^31: the same prompt and seed give the same picture, so a retry repeats a draw and a redraw changes it. */
    seed: number;
    /** At most four, each smaller than 512×512 (the guard is in draw.ts; a provider refuses what it cannot take). */
    references?: readonly DrawReference[];
}

export interface DrawnPicture {
    data: Buffer;
    /** What the bytes really are, from their first bytes: the file is stored with this type. */
    mime: PictureMime;
    provider: string;
    model: string;
}

export interface ImageProvider {
    /** The registry name, and the `provider` of this provider's rows in `image_allowance`: `cloudflare`. */
    readonly id: string;
    readonly model: string;
    /** Pictures a day the owner allows. The allowance counts units, and this many pictures' worth of them is the day's budget. */
    readonly dailyCap: number;
    /** The estimated units one picture costs. The provider does not say what a call cost, so this is a setting, recalibrated from live calls. */
    readonly unitsPerPicture: number;
    draw(request: DrawRequest): Promise<DrawnPicture>;
}

/**
 * Why a draw call failed.
 *
 *   ALLOWANCE_EXHAUSTED   the provider says the free allocation is used up (Cloudflare error 3036, or 4006 in older answers; a 429 that is only Cloudflare being busy is a PROVIDER_ERROR). Nothing is wrong with the
 *                         request: drawing pauses until the allocation resets, and the same scene is drawn then.
 *   PROVIDER_ERROR        anything else: a refusal, a bad token, a timeout, an answer that is not a picture. The units are given back and
 *                         the scene is marked with the reason.
 *
 * `message` is written for the owner to read and never holds a credential.
 */
export type ImageProviderErrorKind = 'ALLOWANCE_EXHAUSTED' | 'PROVIDER_ERROR';

export class ImageProviderError extends Error {
    constructor(
        readonly kind: ImageProviderErrorKind,
        message: string,
        /** What the provider answered, for the logs: the HTTP status and its error code. Plain data. */
        readonly detail: { status?: number; code?: number | string } = {}
    ) {
        super(message);
        this.name = 'ImageProviderError';
    }
}

/**
 * A failure of a provider call, as an `ImageProviderError`. One that is not the provider's own (a bug, a thrown string) becomes a plain
 * PROVIDER_ERROR whose words are the same every time and say nothing of the cause: what went wrong is for the log, which gets it with `context`,
 * and a message that reaches the owner must never carry a credential or a stack.
 */
export function asProviderError(err: unknown, context: Record<string, unknown> = {}): ImageProviderError {
    if (err instanceof ImageProviderError) return err;
    log('error', 'explainer.picture_bug', { ...context, ...describeError(err) });
    return new ImageProviderError('PROVIDER_ERROR', 'The image provider failed unexpectedly.');
}
