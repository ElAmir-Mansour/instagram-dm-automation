/**
 * Move a proposal on: queue the `ads.draft` app job for it (src/jobs), and drain it at once under `waitUntil`.
 *
 * Called when a proposal is requested (routes), when Claude's answer lands on the Mac's job (studio/jobs.ts `completeJob`, after its
 * transaction commits) and when that job fails. The job's handler is `advanceProposal` (service.ts), which is idempotent: it reads the
 * proposal and its latest `ads_think` job and does whatever comes next, so a duplicate advance does nothing twice.
 *
 * Its own small file so that studio/jobs.ts can import it without importing the service (which imports studio/jobs.ts). Never throws:
 * a failure to queue is logged, and the daily cron's sweep (`expireProposals`) is the backstop for a draft nobody moved on.
 */
import { getJobQueue } from '../../../jobs/queue.js';
import { describeError, log } from '../../../utils/log.js';
import { waitUntil } from '../../../utils/waitUntil.js';

export type AdvanceReason = 'requested' | 'mac_done' | 'mac_failed' | 'regenerate' | 'sweep';

export function queueAdvance(creatorId: string, proposalId: string, reason: AdvanceReason, stamp: string = String(Date.now())): void {
    waitUntil((async () => {
        try {
            await getJobQueue().enqueue({
                kind: 'ads.draft',
                payload: { creatorId, proposalId },
                creatorId,
                // One advance per reason and moment: a Mac retry of the same result maps to the same job.
                dedupeKey: `ads.draft:${proposalId}:${reason}:${stamp}`,
                maxAttempts: 3,
            });
            const { drainInline } = await import('../../../jobs/drain.js');
            await drainInline();
        } catch (err) {
            log('error', 'ads.proposal_advance_queue_failed', { creator_id: creatorId, proposal_id: proposalId, reason, ...describeError(err) });
        }
    })());
}
