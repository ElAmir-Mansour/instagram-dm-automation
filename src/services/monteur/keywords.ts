/**
 * The comment keywords reels in flight already ask for (MONTEUR.md §6.1): a clip rendering, in
 * review or failed has no campaign yet, so nothing in `campaigns` says its keyword is taken. The
 * Monteur's pick, a clip's PATCH and the Studio's writer all read this, so none of them hands a
 * second reel or carousel a keyword that will collide once both are live.
 */
import type { Exec } from '../studio/common.js';

export interface InFlightTriggers {
    keywords: string[];
    variants: string[];
}

export async function inFlightTriggers(exec: Exec, creatorId: string, exceptClipId: string | null = null): Promise<InFlightTriggers> {
    const { rows } = await exec.query<{ keyword: string | null; variants: unknown }>(
        `SELECT copy->>'keyword' AS keyword, copy->'variants' AS variants FROM clip_drafts
          WHERE creator_id = $1 AND status IN ('rendering', 'review', 'failed')
            AND ($2::uuid IS NULL OR id <> $2::uuid)`,
        [creatorId, exceptClipId]
    );
    const keywords = new Set<string>();
    const variants = new Set<string>();
    for (const r of rows) {
        if (r.keyword?.trim()) keywords.add(r.keyword.trim());
        for (const v of Array.isArray(r.variants) ? r.variants : []) if (typeof v === 'string' && v.trim()) variants.add(v.trim());
    }
    return { keywords: [...keywords], variants: [...variants] };
}
