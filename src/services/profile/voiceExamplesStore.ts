/**
 * `voiceExamplesFor`: the examples a tenant confirmed, read for a prompt (docs/onboarding/03 §5, plan P25). The rules are
 * `voiceExamples.ts`'s; this is the one place that reads the table for a prompt.
 *
 * **It can only ever make a prompt longer for a tenant who went through onboarding and confirmed something.** Five things keep that true
 * for the owner, whose prompts must stay byte-identical to his goldens:
 *
 *   1. There is no way to write a row for him. The rows come from the proof samples (`onboarding/proof.ts`), whose routes refuse a tenant
 *      whose onboarding is completed, and his has been since v34. With no rows this returns an empty list and the prompt has no section
 *      at all (`captionExamplesSection([])` is the empty string), so his prompt is the one it always was.
 *   2. And a row written some other way would still not be read for him: the statement requires that the tenant's onboarding row says
 *      somebody filled it in (`onboarding.filled_by IS NOT NULL`: the wizard sets it on its first save, and v34 inserted the owner's
 *      row, and every other existing tenant's, without one). "New tenants only" is a fact the database answers.
 *   3. It does not look up who the owner is. The Studio's context deliberately depends on no such lookup (`buildGenContext`), so a
 *      lookup that failed could never change what he is written.
 *   4. It never throws. A database without v34, a read that fails, a row that is not what it should be: the answer is "no examples",
 *      logged. Examples are an improvement to a prompt, never a reason a caption, a DM or a reel is not written.
 *   5. It reads only rows the tenant confirmed (`tenant_confirmed_at IS NOT NULL`) and judged `approved` or `edited`. The SQL says so
 *      and `selectVoiceExamples` says so again, so neither is the only guard.
 *
 * The tenant's own id is the first condition of every statement: nobody is shown another tenant's words.
 */
import { pool } from '../../config/db.js';
import { describeError, log } from '../../utils/log.js';
import { isMissingTable } from '../health.js';
import type { Exec } from '../studio/common.js';
import { isVoiceExampleKind, selectVoiceExamples, VOICE_EXAMPLES_MAX, type VoiceExample, type VoiceExampleKind, type VoiceExampleRow } from './voiceExamples.js';

/** The rows that may be used, newest first, with the edited ones leading: `selectVoiceExamples` makes the final choice. */
export const VOICE_EXAMPLES_SQL = `SELECT model_output, final_text, verdict, tenant_confirmed_at, created_at FROM voice_examples
     WHERE creator_id = $1 AND kind = $2 AND verdict IN ('approved', 'edited') AND tenant_confirmed_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM onboarding WHERE onboarding.creator_id = $1 AND onboarding.filled_by IS NOT NULL)
     ORDER BY (verdict = 'edited') DESC, created_at DESC LIMIT $3`;

/**
 * The newest examples of `kind` the tenant confirmed, at most `limit` (three by default), edited ones first, as "you wrote → they
 * changed it to" pairs. Empty for a tenant that confirmed nothing, for one that never went through the wizard (the owner), and for
 * anything that cannot be read.
 */
export async function voiceExamplesFor(creatorId: string, kind: VoiceExampleKind, limit: number = VOICE_EXAMPLES_MAX, exec: Exec = pool): Promise<VoiceExample[]> {
    if (typeof creatorId !== 'string' || creatorId === '' || !isVoiceExampleKind(kind)) return [];
    const cap = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10) : VOICE_EXAMPLES_MAX;
    try {
        const { rows } = await exec.query<VoiceExampleRow>(VOICE_EXAMPLES_SQL, [creatorId, kind, cap]);
        return selectVoiceExamples(Array.isArray(rows) ? rows : [], cap);
    } catch (err) {
        // v34 not applied yet (production deploys on merge), or a read that failed: the prompt is written without examples.
        if (!isMissingTable(err, 'voice_examples')) log('warn', 'voice_examples.unreadable', { creator_id: creatorId, kind, ...describeError(err) });
        return [];
    }
}
