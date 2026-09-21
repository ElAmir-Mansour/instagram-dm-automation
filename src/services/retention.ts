/**
 * Data retention.
 *
 * `messages.raw_payload` stores the entire Meta event, verbatim, forever. It exists for a
 * good reason — when a webhook shape changes or a handler mis-parses something, the original
 * event is the only way to find out what actually arrived — but "forever" was never a
 * decision anyone made. It is two separate problems:
 *
 *   Cost. Every inbound DM writes a JSONB blob several times the size of the columns beside
 *   it, into a database on a 500MB tier that already holds video in `media_uploads`.
 *
 *   Privacy. It is a permanent, unindexed record of what individual people wrote to this
 *   account, including their Meta user ids, long after they stopped interacting. Meta's
 *   Platform Terms require honouring deletion, and the app publishes a /data-deletion page
 *   promising exactly that — but a deletion request that clears `messages.text` and leaves
 *   `raw_payload` holding the same text has not deleted anything. This is the mechanism by
 *   which that promise is currently untrue.
 *
 * What this does NOT do: delete message rows. `text`, `direction` and `created_at` are what
 * the inbox renders and what `ai.ts` reads back as conversation history — losing them would
 * change the product. Only the redundant verbatim copy is cleared, and everything the
 * application actually reads has already been extracted into columns beside it.
 *
 * OPT-IN BY DESIGN. With `RAW_PAYLOAD_RETENTION_DAYS` unset this is a no-op. Nulling a column
 * is irreversible and this is a live account: the operator decides when, and the recommended
 * value (90) is in ARCHITECTURE.md rather than hardcoded here. Set it and the next cron run
 * begins clearing.
 */
import { queryCount } from '../db/query.js';
import { log } from '../utils/log.js';

/** Floor on the configurable window. Below this, debugging a live webhook issue is hopeless. */
export const MIN_RETENTION_DAYS = 7;

/**
 * Rows cleared per run.
 *
 * Bounded because the first run against an account with months of history would otherwise be
 * a single UPDATE over the whole table, inside a cron invocation with a wall clock — and an
 * UPDATE that times out rolls back entirely, so it would never make progress. Chipping away
 * converges instead.
 */
export const PRUNE_BATCH_SIZE = 5_000;

export type RetentionSetting =
    | { enabled: false; reason: 'unset' | 'invalid' | 'too_short' }
    | { enabled: true; days: number };

/**
 * Interpret `RAW_PAYLOAD_RETENTION_DAYS`.
 *
 * Separated from the query so the policy — including the refusal to accept a dangerously
 * short window, and the refusal to guess at a typo — is testable without a database.
 * A misconfigured value disables pruning rather than falling back to a default: silently
 * deleting on a different schedule than the operator asked for is worse than not deleting.
 */
export function resolveRetention(raw: string | undefined): RetentionSetting {
    if (raw === undefined || raw.trim() === '') return { enabled: false, reason: 'unset' };

    const days = Number(raw);
    if (!Number.isFinite(days) || !Number.isInteger(days) || days <= 0) {
        return { enabled: false, reason: 'invalid' };
    }
    if (days < MIN_RETENTION_DAYS) return { enabled: false, reason: 'too_short' };

    return { enabled: true, days };
}

/**
 * Clear `raw_payload` on messages older than the configured window.
 *
 * Called from the publish cron. Never throws: a retention sweep must not be able to stop the
 * scheduled posts that run after it.
 */
export async function pruneRawPayloads(): Promise<{ cleared: number; skipped: boolean }> {
    const setting = resolveRetention(process.env.RAW_PAYLOAD_RETENTION_DAYS);

    if (!setting.enabled) {
        // Only worth a line when the operator tried to configure it and got it wrong —
        // "unset" is the default state and does not need saying on every cron run.
        if (setting.reason !== 'unset') {
            log('warn', 'retention.misconfigured', {
                reason: setting.reason,
                value: process.env.RAW_PAYLOAD_RETENTION_DAYS,
                minimum_days: MIN_RETENTION_DAYS,
            });
        }
        return { cleared: 0, skipped: true };
    }

    try {
        const cleared = await queryCount(
            `UPDATE messages
                SET raw_payload = NULL
              WHERE id IN (
                    SELECT id FROM messages
                     WHERE raw_payload IS NOT NULL
                       AND created_at < NOW() - make_interval(days => $1)
                     LIMIT $2
              )`,
            [setting.days, PRUNE_BATCH_SIZE]
        );

        if (cleared > 0) {
            log('info', 'retention.pruned', {
                cleared,
                retention_days: setting.days,
                // The operator needs to know another pass is due; a full batch almost
                // certainly means there is more behind it.
                more_likely: cleared === PRUNE_BATCH_SIZE,
            });
        }
        return { cleared, skipped: false };
    } catch (err) {
        log('error', 'retention.prune_failed', { message: (err as Error)?.message });
        return { cleared: 0, skipped: true };
    }
}
