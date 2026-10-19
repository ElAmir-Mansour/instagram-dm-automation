/**
 * What became of one comment's DM: delivered, not delivered on purpose, not delivered by accident, still in flight, or blocked by the
 * person. Dashboard UX overhaul, research R-03, data-model "Outcome".
 *
 * Today every one of those that is not `SENT` is written as `FAILED`, so "5 DMs failed today" mixes a dead token (the owner must
 * act) with a person who was already messaged (nothing to do, and the product did it on purpose). A red number that is mostly the
 * second kind teaches the owner to ignore red (audit OV-03). This classifies at READ time instead of changing what the comment path
 * writes: the live webhook is untouched (constitution VII), and rows already in the table are classified correctly with no backfill.
 *
 * The judgement about which failures were chosen lives in `failureReasons.ts` (`isExpectedFailure`), next to the sentences it reads.
 *
 * | status             | outcome                                                                               |
 * |--------------------|---------------------------------------------------------------------------------------|
 * | `SENT`             | delivered                                                                             |
 * | `PENDING`          | pending: shown, never counted as a success or a failure                               |
 * | `USER_BLOCKED_DMS` | blocked: neutral, the person's own privacy setting                                    |
 * | `SKIPPED`          | by_design                                                                             |
 * | `FAILED`, expected | by_design: send caps, "already has a reply" (codes -1 / 10900), public reply instead  |
 * | any other `FAILED` | actionable                                                                            |
 *
 * Pure, so every row of that table is pinned by `outcomes.test.ts` against the strings the comment path really writes.
 */
import { isExpectedFailure } from './failureReasons.js';

export const OUTCOMES = ['delivered', 'by_design', 'actionable', 'pending', 'blocked'] as const;
export type Outcome = typeof OUTCOMES[number];

/**
 * The outcome of one `interactions` row.
 *
 * A status this function does not know is `actionable`, not a quiet bucket: the column is a free VARCHAR with no CHECK, and a value
 * nobody planned for is exactly the kind of thing that should be looked at rather than counted as fine.
 */
export function classifyOutcome(status: unknown, errorLog?: unknown): Outcome {
    switch (status) {
        case 'SENT': return 'delivered';
        case 'PENDING': return 'pending';
        case 'USER_BLOCKED_DMS': return 'blocked';
        case 'SKIPPED': return 'by_design';
        case 'FAILED': return isExpectedFailure(errorLog) ? 'by_design' : 'actionable';
        default: return 'actionable';
    }
}

/** Counts per outcome, every key present. */
export type OutcomeCounts = Record<Outcome, number>;

/**
 * Delivered ÷ (delivered + actionable): the one success-rate definition (audit OV-20). Pending rows are not attempts yet, by-design
 * skips are not failures, and a blocked recipient is not the product's doing, so none of them move it. `null` when nothing has been
 * attempted: no rate is not a rate of 0% or of 100%.
 */
export function successRate(counts: Pick<OutcomeCounts, 'delivered' | 'actionable'>): number | null {
    const attempted = counts.delivered + counts.actionable;
    return attempted > 0 ? counts.delivered / attempted : null;
}
