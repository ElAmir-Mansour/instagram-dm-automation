/**
 * What the pipeline does with a message once Muse has had its say (docs/specs/005-muse-sees T032, T033, T043, T044). Pure: a stored perception and the account's
 * language in, one of two plans out, and `src/webhook/messaging.ts` carries it out.
 *
 *   answer   the sales turn answers it: the description is the row's `text` and its fact is told to the model (a shared reel, a photo, a story, a video).
 *            A personal document is an answer too, and is handed to a person by the turn without a model.
 *   ack      the fixed line goes out, exactly as it always did (`attachmentAck.ts`), with a trace of why: the kit's `resend` when the model could not read what a
 *            person SENT with confidence, the thanks that NAMES the story for a story mention, and today's line for every other outcome (the media did not come, the
 *            daily cap was reached, the model failed).
 *
 * A story mention is thanked and never answered by a sales turn: it asks nothing, and a model's reading of it only makes the thanks specific (`mentionLine`).
 * What each trace line says is one sentence the code writes (English, closed lists), shown to the owner under the line the customer was sent.
 */
import type { PerceivedTurn } from '../dmSales/turn.js';
import type { AttachmentLines } from '../profile/kits.js';
import { readPhrase } from './how.js';
import { mentionLine, perceivedFact, perceivedText } from './text.js';
import type { Perception, PerceptionKind } from './types.js';

export type WordlessPlan =
    /** The sales turn answers. `text` is the row's stored text, which is what the model reads as the customer's message. */
    | { kind: 'answer'; text: string; perceived: PerceivedTurn }
    /** A fixed line goes out. `line` is the kit's request or thanks when perception chose one; absent, the kit's usual line. */
    | { kind: 'ack'; perception?: { line?: string; reason: string; perceived: boolean } };

/** The kinds a person SENT, for which "send it again" means something. A story they replied to is the account's own, and a mention is their own story: nothing to resend. */
const RESENDABLE: ReadonlySet<PerceptionKind> = new Set<PerceptionKind>(['reel', 'share', 'story_share', 'image', 'video']);

/** Why a step that was asked for did not come to be, as a sentence. */
const FAILED: Readonly<Record<string, string>> = Object.freeze({
    too_large: 'it was too large to read',
    fetch_failed: 'it could not be downloaded',
    expired_url: 'its link had expired',
    provider_error: 'the reading service could not read it',
    timeout: 'it took too long',
});

const SKIPPED: Readonly<Record<string, string>> = Object.freeze({
    budget: 'the daily limit for reading media was reached',
    no_key: 'no Meta key is set up for reading media',
    no_url: 'there was nothing in it to open',
});

/** The trace for a message that was not read: it was tried or it was held back, and the customer got the usual line. Pure. */
export function notReadReason(p: Pick<Perception, 'status' | 'reason'>): string {
    const why = p.status === 'failed' ? FAILED[p.reason ?? ''] : SKIPPED[p.reason ?? ''];
    return `Could not read it${why ? `: ${why}` : ''}, so it sent the usual line.`;
}

export function planOf(p: Perception, lines: Pick<AttachmentLines, 'mentionNamed' | 'resend'>): WordlessPlan {
    if (p.status === 'ok') {
        if (p.kind === 'story_mention') {
            // Thanked by name when the summary is fit to say back (no number, no link, no handle, a few words), and when it is not a personal document.
            const named = p.about_owner === 'personal' ? null : mentionLine(lines.mentionNamed, p.mention_summary);
            return {
                kind: 'ack',
                perception: named
                    ? { line: named, reason: 'Read their story mention and thanked them for what they shared.', perceived: true }
                    : { reason: 'Read their story mention, but what it showed was not fit to say back, so it sent the usual thanks.', perceived: false },
            };
        }
        return {
            kind: 'answer',
            text: perceivedText(p.kind, p),
            perceived: { kind: p.kind, describedText: true, sent: perceivedFact(p), read: readPhrase(p.kind, p.seen), personal: p.about_owner === 'personal' },
        };
    }
    if (p.status === 'unreadable') {
        return RESENDABLE.has(p.kind)
            ? { kind: 'ack', perception: { line: lines.resend, reason: 'Could not read it with confidence, so it asked them to send it again.', perceived: false } }
            : { kind: 'ack', perception: { reason: 'Could not read it with confidence, so it sent the usual line.', perceived: false } };
    }
    return { kind: 'ack', perception: { reason: notReadReason(p), perceived: false } };
}
