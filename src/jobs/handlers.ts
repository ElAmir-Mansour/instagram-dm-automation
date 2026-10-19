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
import { handleWhatsAppEvent } from '../services/whatsappStatus.js';
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
        // A WhatsApp message (`object: 'whatsapp'`) is stored by its own handler: nothing is sent from it in this phase (whatsappInbound.ts).
        if (isWhatsAppDmPayload(payload)) {
            await handleWhatsAppInbound(payload, { lastAttempt: isLastAttempt(job) });
            return;
        }
        await handleMessagingEvent(payload.event, payload.entryId, {
            lastAttempt: isLastAttempt(job),
            object: payload.object,
        });
    },
    // A WhatsApp status of one of our messages, an account event or a preference change: never a customer message, never an AI, never a send.
    'wa.event': async (payload) => {
        await handleWhatsAppEvent(payload);
    },
    // Not a Meta event: the sales turn queues it after a link (DM plan S9). The handler re-reads the conversation and may well do nothing: a
    // person who answered, clicked or said stop in the meantime is simply not eligible, and the job ends as done. A transient send failure
    // throws, which the runner retries; everything else is a normal return.
    'dm.followup': async (payload) => {
        await runFollowup(payload);
    },
};
