/**
 * Stable codes for the refusals a person reads (UX overhaul, F1: research R-15, audits ST-08, PO-17, JB-05,
 * ER-03, IG-02, IN-16, AI-11, SE-01).
 *
 * WHY. A refusal used to arrive as one English sentence in `{ error }`, and the dashboard printed it as it came: an
 * Arabic, right-to-left screen showed "That job is "done", not failed or cancelled", with no next step. A sentence
 * is also the wrong thing to match on, because sentences get reworded. A code is stable, so the dashboard can map
 * it to a translated sentence plus what to do next and show the English text behind "Details". The convention shared
 * with `UI.errorText`: `errors.<CODE>` holds the sentence (what happened) and `errors.<CODE>.next` the next step
 * (what to do), in both catalogues.
 *
 * THE SHAPE. The contract drafted in specs/001-dashboard-ux/contracts/api.md was `{ error: { code, params,
 * message } }`. That is NOT what is sent, because `error` has been a plain string since the first route, and every
 * client reads it as one: `dashboard/js/api.js` does `new Error(body.error || body.message)`, which would turn an
 * object into "[object Object]" on every screen, in every cached copy of the dashboard, the moment one route
 * switched. So the envelope is flat and additive:
 *
 *     { error: "<English sentence>",      // unchanged; what every existing client reads
 *       message: "<same sentence>",       // the contract's name for it
 *       code: "JOB_NOT_RETRYABLE",        // from ERROR_CODES below
 *       params: { status: "done" },       // values the translated sentence interpolates ({} when none)
 *       ...extra }                        // legacy top-level fields some clients already read
 *
 * `code` was already a top-level sibling of `error` on about thirty responses (`PROFILE_INCOMPLETE`,
 * `META_NOT_CONNECTED`, `PAGE_ID_IN_USE`, ...), so this is the shape the codebase already had, made uniform.
 * `extra` carries the fields a client reads off `err.body` today (`problems`, `field`, `missing`, `fixStep`,
 * `status`): they stay where they were. The envelope's own four fields always win over `extra`.
 *
 * Only the refusals named in the audits are here. A route that sends `{ error }` without a code is not wrong, it is
 * not converted yet: the dashboard falls back to the sentence it receives. Add a code here, its `errors.<CODE>` and
 * `errors.<CODE>.next` strings in `dashboard/js/i18n.ar.js` and `i18n.en.js` (errorCodes.test.ts fails otherwise),
 * and send it with `sendError`.
 *
 * `params` are plain data and are never read back by the server. They must hold nothing a person typed that the
 * response did not already echo, and never a token, a key or a connection string.
 */
import type { Response } from 'express';
import { log } from '../utils/log.js';

export interface ErrorCodeSpec {
    /** The HTTP status(es) the code is sent with. `sendError` logs a warning when it is used with any other. */
    readonly status: readonly number[];
    /** One line: what happened, for whoever reads this file, not for the end user. */
    readonly meaning: string;
    /** The `params` keys the translated sentence may interpolate, `{name}` style. Documentation: not enforced at runtime. */
    readonly params?: readonly string[];
}

export const ERROR_CODES = {
    // ─── Connections ────────────────────────────────────────────────────────────────────────────────────
    /** The state, not a refusal: sent as `code` beside `status: 'not_connected'` on `GET /api/settings/token/status` (SE-01). */
    NOT_CONNECTED: { status: [200], meaning: 'This tenant has never connected Instagram and Facebook: no token to check, nothing to send with.' },
    /** The refusal form of NOT_CONNECTED. The longer name predates the registry: `ice_breakers.js` reads it. */
    META_NOT_CONNECTED: { status: [409], meaning: 'An action that needs the Meta connection (schedule a Meta post, send a DM) on a tenant that has none.' },
    TIKTOK_NOT_CONNECTED: { status: [409], meaning: 'An action that needs TikTok, and TikTok is not connected (or needs reconnecting).' },
    TIKTOK_DIRECT_POST_UNAVAILABLE: { status: [409], meaning: 'Direct Post was asked for, but the portal switch is off or the connection lacks `video.publish`.' },
    TIKTOK_UPLOAD_PERMISSION_MISSING: { status: [409], meaning: 'Sending to TikTok drafts needs `video.upload`, which this connection does not have.' },

    // ─── The AI agents ──────────────────────────────────────────────────────────────────────────────────
    PROFILE_INCOMPLETE: { status: [409], meaning: 'An agent was switched on before the profile holds what it writes from.', params: ['agent', 'missing', 'fixStep'] },
    PROFILE_UNREADABLE: { status: [503], meaning: 'The creator profile could not be read just now (a database hiccup), so nothing was written. Try again.' },

    // ─── Posts (the composer, the scheduler) ────────────────────────────────────────────────────────────
    POST_FIELDS_REQUIRED: { status: [400], meaning: 'Creating a post without a platform, a type or a time.' },
    INVALID_SCHEDULE_TIME: { status: [400], meaning: 'A scheduled time that is not a date and time (Posts, Studio, Monteur).' },
    POST_UNSUPPORTED_COMBINATION: { status: [400], meaning: 'A platform and post type that cannot go together (a story to both, a photo to YouTube).' },
    POST_MEDIA_INVALID: { status: [400], meaning: 'The post\'s media breaks a platform rule: slide count, JPEG only, an outside link, a missing file.' },
    POST_OPTIONS_INVALID: { status: [400], meaning: 'Instagram\'s reach levers (alt text, collaborators, trial reel) are malformed or not allowed for this post.' },
    TIKTOK_OPTIONS_INVALID: { status: [400], meaning: 'The TikTok choices (privacy, interactions, disclosure) are incomplete or not allowed yet.' },
    TIKTOK_NEEDS_VIDEO: { status: [400], meaning: 'A TikTok video post with no video attached.' },
    POST_LOCKED: { status: [409], meaning: 'Editing a post that is already with TikTok (in the inbox, or being published).', params: ['status'] },
    POST_NOT_PUBLISHABLE: { status: [409], meaning: 'Publish now on a post that is not pending or failed.', params: ['status'] },

    // ─── Uploads ────────────────────────────────────────────────────────────────────────────────────────
    UPLOAD_FIELDS_REQUIRED: { status: [400], meaning: 'An upload missing its file name, type or bytes.' },
    UPLOAD_TYPE_UNSUPPORTED: { status: [400], meaning: 'A file type the platforms cannot ingest.', params: ['mimeType'] },
    UPLOAD_TOO_LARGE: { status: [400, 413], meaning: 'A file over the cap this endpoint can take (3.2MB; Vercel caps the request at 4.5MB).', params: ['maxMb', 'maxBytes'] },

    // ─── Jobs and erasure (platform admin) ──────────────────────────────────────────────────────────────
    JOB_NOT_RETRYABLE: { status: [409], meaning: 'Retry on a job that has not stopped (only failed or cancelled jobs can be retried).', params: ['status'] },
    JOB_NOT_CANCELLABLE: { status: [409], meaning: 'Cancel on a job that has started or finished (only a pending job can be cancelled).', params: ['status'] },
    ERASURE_COUNTS_DRIFTED: { status: [409], meaning: 'What the handle matches changed since the preview. Nothing was deleted.' },
    ERASURE_PREVIEW_EXPIRED: { status: [400], meaning: 'The erasure token is older than 10 minutes. Nothing was deleted.' },
    ERASURE_TOKEN_INVALID: { status: [400], meaning: 'The erasure token is missing, malformed or does not verify. Nothing was deleted.' },
    ERASURE_AUDIT_FAILED: { status: [500], meaning: 'The erasure was rolled back because the audit row could not be written. Nothing was deleted.' },

    // ─── Studio: infographics ───────────────────────────────────────────────────────────────────────────
    CAPTION_EMPTY: { status: [409], meaning: 'Scheduling an infographic whose caption is empty.' },
    CAPTION_MISSING_COLUMNS: { status: [409], meaning: 'The caption does not name every column the GIF shows (the owner\'s rule, 2026-10-12).', params: ['columns', 'list'] },
    CAPTION_TOO_LONG: { status: [409], meaning: 'The caption is longer than Instagram takes.', params: ['length', 'max'] },
    INFOGRAPHIC_WRITING: { status: [409], meaning: 'Claude is still writing this infographic.' },
    INFOGRAPHIC_RENDERING: { status: [409], meaning: 'This infographic is still rendering.' },
    INFOGRAPHIC_SCHEDULED: { status: [409], meaning: 'This infographic is already scheduled: make a copy to change it.' },
    INFOGRAPHIC_NOT_READY: { status: [409], meaning: 'Scheduling an infographic that is not ready (writing, rendering, failed).', params: ['status'] },
    INFOGRAPHIC_NOT_WRITTEN: { status: [409], meaning: 'Editing or copying an infographic Claude has not written yet.' },
    INFOGRAPHIC_NO_PLATFORMS: { status: [409], meaning: 'Scheduling an infographic when the brand settings choose no platform to post to.' },

    // ─── Studio and Monteur: carousels, reels ───────────────────────────────────────────────────────────
    NO_FREE_SLOT: { status: [409], meaning: 'No free posting slot in the look-ahead window (or on a day this video has no reel yet).' },
    KEYWORD_CLASH: { status: [409], meaning: 'A comment keyword would fire alongside a live campaign\'s keyword.', params: ['trigger', 'live'] },
    CLIP_KEYWORD_ASK_MISSING: { status: [400], meaning: 'The reel\'s caption must keep the «keyword» ask, or every comment would arrive and none be answered.', params: ['keyword'] },
    CLIP_TIKTOK_LINE_MISSING: { status: [400], meaning: 'The reel\'s TikTok caption must keep the line the Monteur settings require.', params: ['line'] },
    REEL_SCHEDULED: { status: [409], meaning: 'A reel that is already scheduled: its post is edited, or deleted, in Posts.' },
    REEL_REJECTED: { status: [409], meaning: 'A reel that was rejected cannot be changed.' },
    REEL_NOT_IN_REVIEW: { status: [409], meaning: 'Approving a reel that is not in review.', params: ['status'] },
    REEL_DAY_TAKEN: { status: [409], meaning: 'Another reel from the same video is already scheduled on the chosen day.', params: ['day'] },
    DRAFT_SCHEDULED: { status: [409], meaning: 'A carousel draft that is scheduled cannot be changed, scheduled again or deleted.' },
    DRAFT_WRITING: { status: [409], meaning: 'A carousel draft that is still being written cannot be changed.' },
    DRAFT_NOT_READY: { status: [409], meaning: 'Scheduling a carousel draft whose slides are not rendered yet.' },
    CHANGED_MEANWHILE: { status: [409], meaning: 'A concurrent change won the race while this one was being saved: reload and try again.' },

    // ─── Tenant AI work (the providers layer and the Mac) ───────────────────────────────────────────────
    NEEDS_API_BRAIN: { status: [400, 409], meaning: 'Claude work for a tenant the operator\'s Mac does not serve, and the AI providers layer was not chosen.' },
    MAC_BRAIN_TENANT: { status: [400, 409], meaning: 'A tenant the Mac serves was routed onto the AI providers layer.' },
    NEEDS_AI_PROVIDER: { status: [409], meaning: 'No AI provider is ready: the operator has not saved a key.' },
    AI_BUDGET_SPENT: { status: [429], meaning: 'A spending or usage limit of the AI providers layer is used up.' },
    AI_PROVIDER_REJECTED: { status: [503], meaning: 'The AI provider refused the operator\'s key or plan. Nothing the tenant can fix.' },
    AI_UNAVAILABLE: { status: [503], meaning: 'The AI provider is busy or not answering. May pass.' },
    AI_ANSWER_UNUSABLE: { status: [502], meaning: 'The AI answered something that could not be used.' },
} as const satisfies Record<string, ErrorCodeSpec>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ERROR_CODE_LIST = Object.keys(ERROR_CODES) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
    return typeof value === 'string' && Object.hasOwn(ERROR_CODES, value);
}

/** Values the translated sentence interpolates. Plain JSON, never secrets. */
export type ErrorParams = Record<string, unknown>;

/** The body of a refusal: the legacy `error` string, the contract's `message`, the stable `code`, its `params`. */
export interface ErrorBody {
    error: string;
    message: string;
    code: ErrorCode;
    params: ErrorParams;
    [legacyField: string]: unknown;
}

/**
 * The envelope as a value, for the places that hand a body to something else (an Express `res`, a `Reply` in a
 * test harness, `profileIncompleteBody`). `extra` is spread FIRST, so a legacy field can never overwrite the four
 * that make the envelope.
 */
export function errorBody(code: ErrorCode, params: ErrorParams | null | undefined, message: string, extra?: Record<string, unknown>): ErrorBody {
    return { ...(extra ?? {}), error: message, message, code, params: params ?? {} };
}

/**
 * Send a refusal. `params` is optional: `sendError(res, 409, 'NO_FREE_SLOT', message)` is the same as passing `{}`.
 *
 *     sendError(res, 409, 'JOB_NOT_RETRYABLE', { status }, `That job is "${status}", ...`, { status });
 *
 * The `message` is the English sentence the route has always sent: converting a route to `sendError` changes the
 * body's shape, never its text. `extra` keeps legacy top-level fields for the clients that read them.
 */
export function sendError(res: Response, status: number, code: ErrorCode, message: string): void;
export function sendError(res: Response, status: number, code: ErrorCode, params: ErrorParams | null | undefined, message: string, extra?: Record<string, unknown>): void;
export function sendError(
    res: Response,
    status: number,
    code: ErrorCode,
    paramsOrMessage: ErrorParams | string | null | undefined,
    maybeMessage?: string,
    extra?: Record<string, unknown>
): void {
    const shorthand = typeof paramsOrMessage === 'string';
    const params = shorthand ? undefined : paramsOrMessage;
    const message = shorthand ? paramsOrMessage : maybeMessage ?? '';
    // A status the registry does not list is a wrong status or a missing registry entry. Say so in the logs rather than
    // throwing: the person is owed their refusal either way.
    if (!(ERROR_CODES[code].status as readonly number[]).includes(status)) {
        log('warn', 'error_code.status_mismatch', { code, status, registered: [...ERROR_CODES[code].status] });
    }
    res.status(status).json(errorBody(code, params, message, extra));
}
