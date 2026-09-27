/**
 * Auto mode (`monteur.mode = 'auto'`, MONTEUR.md §1, §6): the drain approves rendered reels itself,
 * through Approve — `approveClip`, the very path the Approve button takes — so an automatic
 * reel gets the same next free slot, under the same per-tenant publishing lock, with the same
 * campaign, and the same refusals.
 *
 * At most `MAX_AUTO_APPROVALS` attempts a drain call, each clip once. A refusal (a 409: no free
 * slot, a keyword that would really collide, TikTok not ready) leaves the reel in review with the
 * reason in its `error`, where the review card shows it, and the next drain tries it again. Reels
 * never refused go first, so one that cannot be scheduled never holds the others back.
 */
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { StudioError } from '../studio/common.js';
import { approveClip } from './clips.js';

export const MAX_AUTO_APPROVALS = 4;

/**
 * The reels to approve: in review with a render, of an active tenant whose Monteur is in auto mode
 * (a section saved before modes existed has no `mode`, and is review). Never-refused first, then
 * oldest first.
 */
export const AUTO_APPROVE_SQL = `
    SELECT c.id, c.creator_id, c.error
      FROM clip_drafts c
      JOIN creators cr ON cr.id = c.creator_id AND cr.is_active = TRUE
      JOIN studio_settings ss ON ss.creator_id = c.creator_id
     WHERE c.status = 'review' AND c.render IS NOT NULL
       AND ss.monteur->>'mode' = 'auto'
     ORDER BY (c.error IS NOT NULL), c.created_at, c.rank
     LIMIT $1`;

export interface AutoApproveResult {
    approved: number;
    refused: number;
}

/** Why Approve refused, for the review card: every problem when there are several. */
function refusalText(err: unknown): string {
    if (err instanceof StudioError && err.problems && err.problems.length > 1) return err.problems.join(' · ').slice(0, 1000);
    return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

export async function autoApproveClips(now: number = Date.now()): Promise<AutoApproveResult> {
    const { rows } = await pool.query<{ id: string; creator_id: string; error: string | null }>(AUTO_APPROVE_SQL, [MAX_AUTO_APPROVALS]);
    const result: AutoApproveResult = { approved: 0, refused: 0 };
    for (const row of rows.slice(0, MAX_AUTO_APPROVALS)) {
        try {
            const outcome = await approveClip(row.creator_id, row.id, {}, now);
            result.approved += 1;
            log('info', 'monteur.auto_approved', {
                clip_id: row.id, creator_id: row.creator_id, scheduled_time: outcome.scheduled_time,
                campaign_id: outcome.campaign?.id ?? null, campaign_created: outcome.campaign?.created ?? null,
            });
        } catch (err) {
            result.refused += 1;
            const reason = refusalText(err);
            // Loud the first time, quiet while the same reason repeats every drain.
            log(reason === row.error ? 'info' : 'warn', 'monteur.auto_refused', {
                clip_id: row.id, creator_id: row.creator_id, status: err instanceof StudioError ? err.status : null, error: reason,
                ...(err instanceof StudioError ? {} : describeError(err)),
            });
            // Only while it is still in review: approved or rejected meanwhile, it is not ours to mark.
            await pool.query(
                `UPDATE clip_drafts SET error = $3, updated_at = NOW()
                  WHERE id = $1 AND creator_id = $2 AND status = 'review'`,
                [row.id, row.creator_id, reason]
            ).catch((e: unknown) => log('warn', 'monteur.auto_refusal_not_saved', { clip_id: row.id, ...describeError(e) }));
        }
    }
    return result;
}
