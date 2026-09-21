/**
 * Noticing that the access token died, at the moment it dies.
 *
 * `creators.token_status` has existed since v12, and until now exactly two things wrote to it:
 * saving a token, and opening the dashboard's token page. Both are things a person does. So a
 * token that Meta revoked on Friday — because the password changed, or the app was
 * uninstalled, or the 60-day window elapsed — read as `valid` until somebody happened to look,
 * while every comment and every DM failed in the meantime. The whole product stops and nothing
 * says so.
 *
 * Meta does say so, on every single call, as code 190 with a subcode naming the reason. This
 * module is the hook that records it: every Meta send path calls `noteMetaFailure` in its catch
 * block, and a token death — and only a token death — flips the row.
 *
 * Deliberately narrow. It does not flip the status on a 10903 (the recipient blocked DMs), a
 * 200 (a missing scope, which is an app-review problem, not a token problem) or a transient
 * 500. Marking a working token invalid would send the operator to regenerate something that
 * was never broken, and there is no automatic path back to `valid` except the daily check.
 */
import { queryCount } from '../db/query.js';
import { describeError, log } from '../utils/log.js';
import { isTokenDeathError, metaErrorSubcode } from './http.js';

/** Why the token is dead, in words an operator can act on. Keyed by Meta's `error_subcode`. */
const SUBCODE_REASONS: Record<number, string> = {
    458: 'The app has been uninstalled or is no longer authorised for this account.',
    459: 'The account must log in to Facebook again (security checkpoint).',
    460: 'The account password was changed, which revokes every token issued before it.',
    463: 'The access token has expired.',
    467: 'The access token is invalid — the account has logged out.',
    492: 'The account is no longer an admin of the Page this token was issued for.',
};

export function tokenDeathReason(err: any): string {
    const subcode = metaErrorSubcode(err);
    const known = subcode !== undefined ? SUBCODE_REASONS[subcode] : undefined;
    const detail = known ?? 'Meta rejected the access token (code 190).';
    return subcode !== undefined ? `${detail} (subcode ${subcode})` : detail;
}

/**
 * Record a Meta failure against the creator's token health. Returns true if it flipped.
 *
 * Never throws: it runs inside catch blocks whose job is to record a *different* failure, and
 * masking that with a bookkeeping error would be strictly worse than not recording this.
 */
export async function noteMetaFailure(creatorId: string, err: any): Promise<boolean> {
    if (!isTokenDeathError(err)) return false;

    const reason = tokenDeathReason(err);

    try {
        // Only from 'valid'/'unknown', so that repeated failures across a batch of sends do not
        // rewrite the row (and its `token_last_checked_at`) once per failed send — the first
        // one is the interesting one, and it is the one that should be alerted on.
        const flipped = await queryCount(
            `UPDATE creators
                SET token_status = 'invalid',
                    token_error = $2,
                    token_last_checked_at = NOW()
              WHERE id = $1 AND token_status IS DISTINCT FROM 'invalid'`,
            [creatorId, reason]
        );

        if (flipped > 0) {
            // Alert on this one. It means the account is down until a human pastes a new token.
            log('error', 'token.death_detected', {
                creator_id: creatorId,
                meta_subcode: metaErrorSubcode(err) ?? null,
                reason,
            });
        }
        return flipped > 0;
    } catch (bookkeepingErr) {
        log('warn', 'token.death_record_failed', describeError(bookkeepingErr));
        return false;
    }
}
