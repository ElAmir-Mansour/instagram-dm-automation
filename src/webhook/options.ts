/**
 * What the pipelines need to know about the attempt they are running inside.
 *
 * Both pipelines can now leave work retryable: a transient Meta or Gemini failure re-raises so
 * the job runner schedules a backoff, and the domain row (`interactions.status`,
 * `messages.handled_at`) is left in a state a later attempt will pick up. That is only correct
 * while there *is* a later attempt. On the final attempt the same choice strands the row: an
 * interaction stuck at PENDING forever, which in the dashboard is indistinguishable from the
 * webhook having stopped — the single hardest failure in this project to diagnose.
 *
 * So the runner tells the handler which attempt this is, and the handler records a terminal
 * failure when there will be no other.
 */
export interface WebhookHandlerOptions {
    /**
     * True when no retry will follow, so every outcome must be written down as final.
     *
     * Defaults to true everywhere it is not supplied. That direction is deliberate: the
     * legacy inline path in `router.ts` has no retry at all, and a caller that forgets to
     * pass anything should get the safe behaviour (record the failure) rather than the one
     * that quietly relies on a retry that is never coming.
     */
    lastAttempt: boolean;
}

export const FINAL_ATTEMPT: WebhookHandlerOptions = { lastAttempt: true };
