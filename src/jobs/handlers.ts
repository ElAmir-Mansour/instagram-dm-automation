/**
 * What each job kind actually does.
 *
 * Deliberately thin. The comment and DM pipelines are unchanged and still live in
 * `src/webhook/`; these are adapters that unpack a stored payload and call them. Keeping the
 * business logic out of the job layer is what makes this change reversible — the legacy
 * inline path in `src/webhook/router.ts` calls the very same functions, so the two routes
 * through the system cannot drift.
 */
import { runFollowup } from '../services/dmSales/followupJob.js';
import { handleCommentChange } from '../webhook/comments.js';
import { handleMessagingEvent } from '../webhook/messaging.js';
import { handleWhatsAppInbound } from '../webhook/whatsappInbound.js';
import { redactedPreferencePayload, redactedStatusPayload } from '../webhook/whatsappRedact.js';
import { handleWhatsAppEvent } from '../services/whatsappStatus.js';
import { redactOnFailure } from './redaction.js';
import { isWhatsAppDmPayload, type JobHandlerRegistry } from './types.js';

/**
 * Whether this is the attempt after which nothing else will run.
 *
 * `attempts` has already been incremented by the claim, so on the third attempt of a job with
 * `max_attempts = 3` this is true — and both pipelines use it to decide whether a transient
 * failure may be left retryable or has to be written down as final. Getting it wrong in the
 * optimistic direction strands a row at PENDING forever, which in the dashboard looks exactly
 * like the webhook having stopped.
 */
export function isLastAttempt(job: { attempts: number; max_attempts: number }): boolean {
    return job.attempts >= job.max_attempts;
}

export const handlers: JobHandlerRegistry = {
    'comment.process': async (payload, job) => {
        await handleCommentChange(payload.change, payload.entryId, {
            lastAttempt: isLastAttempt(job),
        });
    },
    'dm.process': async (payload, job) => {
        // A WhatsApp message (`object: 'whatsapp'`) is stored, and answered for the owner's test senders, by its own handler (whatsappInbound.ts).
        // What it returns is the redacted payload the queue stores as the job completes (a stranger's message must not sit in `jobs` for a week).
        if (isWhatsAppDmPayload(payload)) {
            return handleWhatsAppInbound(payload, { lastAttempt: isLastAttempt(job) });
        }
        await handleMessagingEvent(payload.event, payload.entryId, {
            lastAttempt: isLastAttempt(job),
            object: payload.object,
        });
    },
    // A WhatsApp status of one of our messages, an account event or a preference change: never a customer message, never an AI, never a send.
    // A status or a preference change names a customer's phone number, and nothing is needed from the payload once the handler has run: it is cut
    // down as the job completes, and, if the job fails for good, as it fails (a failed row is never pruned). An account event names no one.
    'wa.event': async (payload) => {
        if (payload.kind === 'account') {
            await handleWhatsAppEvent(payload);
            return;
        }
        const redacted = payload.kind === 'status' ? redactedStatusPayload(payload) : redactedPreferencePayload(payload);
        try {
            await handleWhatsAppEvent(payload);
        } catch (err) {
            throw redactOnFailure(err, redacted);
        }
        return { redactPayload: redacted };
    },
    // Not a Meta event: the sales turn queues it after a link (DM plan S9). The handler re-reads the conversation and may well do nothing: a
    // person who answered, clicked or said stop in the meantime is simply not eligible, and the job ends as done. A transient send failure
    // throws, which the runner retries; everything else is a normal return.
    'dm.followup': async (payload) => {
        await runFollowup(payload);
    },
};
