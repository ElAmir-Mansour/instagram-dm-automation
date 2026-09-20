/**
 * Turning a failed Meta send into a row the dashboard can explain.
 *
 * The status strings are load-bearing: the dashboard filters on them, so they stay exactly
 * as the inline version wrote them.
 */
import { isPermanentMetaError } from '../services/http.js';

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

    // `src/services/instagram.ts` rewraps axios failures into plain Errors with the Meta code
    // interpolated into the string, so the structured `response.data.error.code` is usually
    // gone by the time it reaches here. Check both shapes.
    const code = err?.response?.data?.error?.code;

    if (code === 10903 || message.includes('Code: 10903')) {
        return {
            status: 'USER_BLOCKED_DMS',
            error: 'User privacy settings block DMs from Pages (Code 10903).',
            permanent: true,
        };
    }

    return {
        status: 'FAILED',
        error: message,
        permanent: isPermanentMetaError(err),
    };
}
