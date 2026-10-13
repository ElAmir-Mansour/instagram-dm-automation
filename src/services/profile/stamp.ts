/**
 * `profile_version`: which version of the tenant's Creator Profile a generated row was written under
 * (docs/onboarding/01 §3, migration v33). Stamped on `carousel_drafts`, `clip_drafts`, `infographics` and
 * `studio_lessons`, so a later "this draft predates the profile's current version" is a column, not a guess.
 *
 * What the stamp means, and so where it is written:
 *   - **A generation stamps the version read when it started.** `createDraft`, the Monteur's pick, `createInfographic`
 *     and the Analyst's run each read it once, before any model call, and every row that generation inserts carries
 *     that one value (the pick's clips share it; no read per row). A profile saved while the model is writing does not
 *     reach back into rows already on their way.
 *   - **A copy takes its source's stamp, not a fresh read.** `copyInfographic` and the "both themes" copy are the same
 *     words in another theme; the profile current at the moment of copying did not write them. A source with no stamp
 *     (written before v33, or by a tenant with no profile) gives a copy with none.
 *   - **A rewrite restamps.** Claude writing an infographic again is a new generation (`rerenderInfographic`).
 *     A re-render of the same spec, and an owner's edit, keep the stamp: nothing was generated.
 *
 * `null` is a real value: the tenant has no stored profile (the virtual one its legacy settings describe has no
 * version), or the read failed. Nothing reads the column to refuse anything, so a missing stamp costs a hint and
 * a failed draft would cost the owner's work: this helper never throws into a generation path.
 */
import { pool } from '../../config/db.js';
import { log } from '../../utils/log.js';
import { loadStoredProfile } from './store.js';

/**
 * The stored profile's `version` for the tenant, or null when it has none (or v33 is not applied yet: `readStored`
 * already reads that as no row). A database error is logged once, `profile.version_stamp_failed` with the tenant
 * and nothing else, and answers null.
 *
 * It reads through `loadStoredProfile`, so with the pool it shares the request's or the job's cache (`cache.ts`):
 * a generation that already read its settings (every one of them does, and the settings reader asks for the
 * profile) pays no query for this.
 *
 * It always reads on the pool, never a transaction client, and takes no `exec` on purpose: a plain SELECT takes no
 * row lock, so it cannot disturb the lock order (creators, creator_profiles, studio_settings, growth_settings), and
 * a statement that fails inside a transaction aborts it, which would turn "no stamp" into a lost row. Read before
 * the transaction opens, hand the number in.
 *
 * A slide rewrite (`rewriteDraftSlide`) keeps its draft's stamp: it edits one slide of a generation, it is not one.
 */
export async function profileVersionFor(creatorId: string): Promise<number | null> {
    try {
        const stored = await loadStoredProfile(creatorId, pool);
        return stored ? stored.version : null;
    } catch {
        // The tenant and nothing else: one line per failed read, which is one row left unstamped, never a thrown error.
        log('warn', 'profile.version_stamp_failed', { creator_id: creatorId });
        return null;
    }
}
