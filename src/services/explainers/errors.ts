/**
 * The refusals of illustrated explainers (data-model.md §8): a code, the HTTP status a route sends it with, and a sentence.
 *
 * The codes are plain strings here and not yet keys of `ERROR_CODES` (src/services/errorCodes.ts). That registry's test wants an
 * `errors.<CODE>` sentence and next step in BOTH dashboard catalogues for every code, and the first release of the feature changes no
 * dashboard file. E2 registers them with the routes (tasks.md T055), answers an `ExplainerError` in `handle()` (routes/studio.ts), and
 * can then make this class a `StudioError`. Until then nothing sends one to a client: no route exists and the switch is off.
 */
import type { ErrorParams } from '../errorCodes.js';

/** Status per code. E1 throws `EXPLAINER_NOT_FOUND`, `EXPLAINER_BAD_STATE` and `EXPLAINERS_OWNER_ONLY`; the rest are E2's. */
export const EXPLAINER_ERROR_STATUS = {
    /** The platform admin has not switched Explainers on for this tenant. */
    EXPLAINERS_DISABLED: 404,
    EXPLAINER_NOT_FOUND: 404,
    /** The move is not one the status machine allows from where the explainer is (state.ts). */
    EXPLAINER_BAD_STATE: 409,
    /** A brief or a character description names a woman or a girl, or breaks another rule of the picture prompt: nothing was sent to the provider. */
    EXPLAINER_PROMPT_REFUSED: 422,
    EXPLAINER_NO_PROVIDER: 409,
    /** Drawing waits for the provider's allowance; `retryAt` says until when. */
    EXPLAINER_ALLOWANCE_PAUSED: 429,
    EXPLAINER_PROVIDER_ERROR: 502,
    EXPLAINER_NO_TRACK: 409,
    EXPLAINER_NEEDS_REFERENCE: 409,
    /** Explainers can only be switched on for the platform owner in this version (switch.ts). */
    EXPLAINERS_OWNER_ONLY: 409,
} as const;

export type ExplainerErrorCode = keyof typeof EXPLAINER_ERROR_STATUS;

export class ExplainerError extends Error {
    readonly status: number;

    constructor(
        readonly code: ExplainerErrorCode,
        message: string,
        /** Values a translated sentence for `code` interpolates. Plain data, never a secret. */
        readonly params?: ErrorParams
    ) {
        super(message);
        this.name = 'ExplainerError';
        this.status = EXPLAINER_ERROR_STATUS[code];
    }
}
