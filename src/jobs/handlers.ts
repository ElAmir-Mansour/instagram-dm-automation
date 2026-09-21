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

export const handlers: JobHandlerRegistry = {
    'comment.process': async (payload) => {
        await handleCommentChange(payload.change, payload.entryId);
    },
    'dm.process': async (payload) => {
        await handleMessagingEvent(payload.event, payload.entryId);
    },
};
