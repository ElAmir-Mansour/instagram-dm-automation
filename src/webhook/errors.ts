/**
 * Turning a failed Meta send into a row the dashboard can explain.
 *
 * The status strings are load-bearing: the dashboard filters on them, so they stay exactly
 * as the inline version wrote them.
 */
import { isPermanentMetaError, isTokenDeathError, metaErrorCode } from '../services/http.js';

export interface DmErrorClassification {
    /** Written to `interactions.status`. */
    status: 'FAILED' | 'USER_BLOCKED_DMS';
    /** Written to `interactions.error_log`. */
    error: string;
    /** True when retrying could never succeed — a dead token, a missing scope, a block. */
    permanent: boolean;
}

/**
 * After a DM that can never be delivered, reply to the comment publicly instead, so the person
 * who asked still gets the link. Not when the token is dead (the reply would fail too) or when
 * Meta says the comment already had its private reply (10900): then a DM exists.
 */
export function shouldPostDmFallback(err: any): boolean {
    if (isTokenDeathError(err)) return false;
    return metaErrorCode(err) !== 10900;
}

/**
 * The public reply that replaces an undeliverable DM. Facebook makes links in comments
 * clickable, so it carries the campaign's link (the first URL in its DM). Instagram doesn't,
 * so it points to the bio. Arabic when the DM is Arabic, English otherwise: a product default,
 * not any one tenant's copy.
 */
export function dmFallbackReply(input: { dmText: string; isFacebook: boolean }): string {
    const arabic = /[\u0600-\u06FF]/.test(input.dmText);
    const link = /https?:\/\/[^\s<>"'()]+/.exec(input.dmText)?.[0]?.replace(/[.,،!?؟]+$/u, '');
    if (!input.isFacebook) {
        return arabic ? 'ما قدرنا نرسل لك على الخاص 🙏 الرابط في البايو 🔗' : "We couldn't message you privately 🙏 The link is in our bio 🔗";
    }
    if (link) {
        return arabic ? `ما قدرنا نرسل لك على الخاص 🙏 هذا الرابط: ${link}` : `We couldn't message you privately 🙏 Here's the link: ${link}`;
    }
    return arabic ? 'ما قدرنا نرسل لك على الخاص 🙏 راسلنا على الخاص ونرسل لك التفاصيل' : "We couldn't message you privately 🙏 Send us a message and we'll share the details.";
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

    // "Invalid parameter" on a DM to a commenter: Meta won't take a private reply to this
    // comment, typically because the person can't receive messages from Pages (Facebook then
    // reports can_reply_privately=false and withholds their name). The same request fails on
    // every retry, and waiting ~10 minutes for the backoff only delays the fallback reply.
    if (code === 100) {
        return {
            status: 'FAILED',
            error: `Meta won't accept a private reply to this comment, usually because the person can't receive messages from Pages. (${message})`,
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
