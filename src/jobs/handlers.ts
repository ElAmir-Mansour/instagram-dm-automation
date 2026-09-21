/**
 * What each job kind actually does.
 *
 * Deliberately thin. The comment and DM pipelines are unchanged and still live in
 * `src/webhook/`; these are adapters that unpack a stored payload and call them. Keeping the
 * business logic out of the job layer is what makes this change reversible — the legacy
 * inline path in `src/webhook/router.ts` calls the very same functions, so the two routes
 * through the system cannot drift.
 */
import { handleCommentChange } from '../webhook/comments.js';
import { handleMessagingEvent } from '../webhook/messaging.js';
import type { JobHandlerRegistry } from './types.js';

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
        await handleMessagingEvent(payload.event, payload.entryId, {
            lastAttempt: isLastAttempt(job),
        });
    },
};
