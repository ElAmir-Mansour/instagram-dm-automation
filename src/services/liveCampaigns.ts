/**
 * The campaigns a comment is matched against: the tenant's live ones, most specific first.
 *
 * One query, two readers. The comment webhook (src/webhook/comments.ts) matches a real comment
 * with it, and the dry run (`POST /api/campaigns/try`, src/services/campaignTry.ts) matches a
 * typed one. A dry run that loaded its own list could say "fires" about a campaign the webhook
 * never sees, so the filter (active, tenant-scoped) and the order live here, once.
 */
import { queryRows } from '../db/query.js';
import type { CampaignRow as CampaignTableRow } from '../db/rows.js';

/**
 * Exactly the campaign columns the pipeline selects.
 *
 * Derived from the table's row type rather than redeclared, so a column rename shows up here
 * as a compile error instead of as a campaign that silently stops matching.
 */
export type LiveCampaign = Pick<
    CampaignTableRow,
    'id' | 'trigger_keyword' | 'dm_template' | 'public_reply_template' | 'post_id' | 'is_active'
    | 'created_at' | 'match_mode'
>;

/**
 * ORDER BY is not cosmetic: without it Postgres returns heap order, so a generic campaign
 * could shadow a post-specific one on the same keyword and the winner could change after
 * a VACUUM. Most specific first, then longest keyword, then newest.
 *
 * `match_mode` is v14 and NOT NULL DEFAULT 'substring', so selecting it can only ever
 * narrow a campaign's matching — never widen it — for a campaign whose owner asked.
 */
export const LIVE_CAMPAIGNS_SQL = `SELECT id, trigger_keyword, dm_template, public_reply_template, post_id, is_active,
                created_at, match_mode
           FROM campaigns
          WHERE creator_id = $1 AND is_active = true
          ORDER BY (post_id IS NOT NULL) DESC, length(trigger_keyword) DESC, created_at DESC`;

/** The live campaigns of one tenant. */
export function loadLiveCampaigns(creatorId: string): Promise<LiveCampaign[]> {
    return queryRows<LiveCampaign>(LIVE_CAMPAIGNS_SQL, [creatorId]);
}
