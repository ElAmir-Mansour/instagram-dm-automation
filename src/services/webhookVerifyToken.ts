/**
 * The verify tokens `GET /webhook` accepts, in the order it tries them.
 *
 * Meta checks the verify token when a webhook subscription is created or its callback URL changes: it calls `GET /webhook?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`
 * and expects the challenge back. This app accepts the environment's `META_VERIFY_TOKEN` and the first active creator's `webhook_verify_token` (Settings → Advanced), the
 * database copy existing so a token can be changed with no redeploy. Two callers need the same list and must never disagree about it:
 *
 *   - the handshake itself (`src/index.ts`): the request's token has to be one of them;
 *   - the repair that points the Meta app's subscriptions back at this deployment (`metaWebhooks.ts`): it sends the FIRST one as `verify_token`, which the handshake
 *     then accepts by construction.
 *
 * A database that cannot be read must not make a correct environment token stop working, so a failed read leaves the list with what the environment gave.
 */
import { pool } from '../config/db.js';
import { describeError, log } from '../utils/log.js';

export async function verifyTokenCandidates(): Promise<string[]> {
    const candidates: string[] = [];
    if (process.env.META_VERIFY_TOKEN) candidates.push(process.env.META_VERIFY_TOKEN);
    try {
        const { rows } = await pool.query(
            'SELECT webhook_verify_token FROM creators WHERE is_active = true AND webhook_verify_token IS NOT NULL LIMIT 1'
        );
        const dbToken = rows[0]?.webhook_verify_token;
        if (dbToken) candidates.push(dbToken);
    } catch (err: any) {
        log('error', 'webhook.verify_token_read_failed', describeError(err));
    }
    return candidates;
}
