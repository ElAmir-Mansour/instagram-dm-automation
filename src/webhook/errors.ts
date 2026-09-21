/**
 * Turning a failed Meta send into a row the dashboard can explain.
 *
 * The status strings are load-bearing: the dashboard filters on them, so they stay exactly
 * as the inline version wrote them.
 */
import { isPermanentMetaError, metaErrorCode } from '../services/http.js';

export interface DmErrorClassification {
    /** Written to `interactions.status`. */
    status: 'FAILED' | 'USER_BLOCKED_DMS';
    /** Written to `interactions.error_log`. */
    error: string;
    /** True when retrying could never succeed — a dead token, a missing scope, a block. */
    permanent: boolean;
}

export function classifyDmError(err: any): DmErrorClassification {
    const message: string = err?.message ?? String(err);

    // `src/services/instagram.ts` rewraps axios failures, and used to interpolate the Meta code
    // into the string and discard `response.data.error` — so `permanent` came back false for
    // every error that came through it, including a dead token. The rewrap now carries
    // `metaCode`/`metaSubcode`, which `metaErrorCode` reads; the string check stays as the
    // backstop for an error raised somewhere that predates the wrapper.
    const code = metaErrorCode(err);

    if (code === 10903 || message.includes('Code: 10903')) {
        return {
            status: 'USER_BLOCKED_DMS',
            error: 'User privacy settings block DMs from Pages (Code 10903).',
            permanent: true,
        };
    }

    // A dead token (190) or a missing scope (200) is permanent whichever shape it arrives in.
    // This matters beyond bookkeeping: the comment pipeline now decides whether to leave the
    // interaction retryable on the strength of this flag, and a transient blip misread as
    // permanent is a customer who is never answered.
    const permanentByMessage = message.includes('Code: 190') || message.includes('Code: 200');

    return {
        status: 'FAILED',
        error: message,
        permanent: isPermanentMetaError(err) || permanentByMessage,
    };
}
