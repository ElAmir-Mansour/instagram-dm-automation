/**
 * The refusals of illustrated explainers (data-model.md §8): a code, the HTTP status a route sends it with, and a sentence.
 *
 * Every code is a key of `ERROR_CODES` (src/services/errorCodes.ts), with an `errors.<CODE>` sentence and next step in BOTH dashboard catalogues (T055), and
 * `handle()` in routes/studio.ts answers an `ExplainerError` with its status, its code, its params and, for a refused draft, its `findings`. Which code a route
 * sends is below, with the status it goes with; the registry's own test fails if a code here is missing there.
 */
import type { ErrorParams } from '../errorCodes.js';

/** Status per code. Each is registered in `ERROR_CODES` with the same status. */
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
    /** Sound is music and the explainer has no track to use: none chosen, or the one chosen is no longer in the library. */
    EXPLAINER_NO_TRACK: 409,
    /** Scheduling when the brand's `infographic.platforms` names none of Instagram, Facebook, YouTube or TikTok (schedule.ts). */
    EXPLAINER_NO_PLATFORMS: 409,
    EXPLAINER_NEEDS_REFERENCE: 409,
    /** Explainers can only be switched on for the platform owner in this version (switch.ts). */
    EXPLAINERS_OWNER_ONLY: 409,
    /**
     * The script breaks a rule of `spec.ts` that a save may not add or an approval may not carry: a closing line that is not a question, engagement bait, a woman
     * in a picture brief, a field past its limit. The answer carries every finding (`findings`), so the owner fixes the script in one pass.
     */
    EXPLAINER_DRAFT_REFUSED: 422,
    /** The narration changed since it was voiced, so pictures cannot be approved and a video cannot be rendered until it is voiced again. */
    EXPLAINER_AUDIO_STALE: 409,
    /** Pictures cannot be approved while a scene has none: `missing` of them, `positions` says which. */
    EXPLAINER_PICTURES_MISSING: 409,
    /** The video was rendered before the narration or the sound last changed, so it is not the script's: render again before scheduling. */
    EXPLAINER_RENDER_STALE: 409,
} as const;

export type ExplainerErrorCode = keyof typeof EXPLAINER_ERROR_STATUS;

export class ExplainerError extends Error {
    readonly status: number;

    constructor(
        readonly code: ExplainerErrorCode,
        message: string,
        /** Values a translated sentence for `code` interpolates. Plain data, never a secret. */
        readonly params?: ErrorParams,
        /** Beside the answer, as top-level fields: a refused draft's `findings`, a missing picture's `positions`. Plain data, never a secret. */
        readonly extra?: Record<string, unknown>
    ) {
        super(message);
        this.name = 'ExplainerError';
        this.status = EXPLAINER_ERROR_STATUS[code];
    }
}
