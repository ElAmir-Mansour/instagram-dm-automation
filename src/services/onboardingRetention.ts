/**
 * What the daily retention sweep forgets about onboarding (plan P31). Three things, each in the table that holds it, and no other:
 *
 *   events           `onboarding_events` rows older than 180 days. The funnel looks back 90, and a row is only ever a name, a step and
 *                    a number, so this is housekeeping rather than privacy; it stops the table growing for ever.
 *   invites          an invite that was never used and expired more than 30 days ago. Its `email` is the only personal data in the
 *                    table and the link has been dead for a month: nothing can open it, and the operator's card has long shown it as
 *                    expired. The 30 days are the card's grace, so "Regenerate" still has a row to copy while the operator might want
 *                    it. A USED invite stays: it is the record of how a person came to hold their membership.
 *   draft sources    the raw text a draft fetched (the draft table's `sources` column: the bio, captions and site text) is set to NULL 30 days
 *                    after the draft finished. The draft row itself stays: its answers, its status, which sources worked
 *                    (`sources_status`), what it cost. A draft still being made is never touched, because the next step reads its sources.
 *                    The statement is `pruneSources` in the draft store, the one module that names that table.
 *
 * Every cutoff is computed here from one `now` and handed to the statement as a parameter, so the boundaries are decided in
 * TypeScript where a test can see them: a row exactly as old as the limit is KEPT, and one a millisecond older goes.
 *
 * It touches nothing else: not `onboarding`, not `creator_profiles`, not a tenant's own settings, posts or media. The owner's
 * tenant has no invite waiting to expire, no draft and no event, so there is nothing of his for these statements to find.
 * Each statement removes at most `ONBOARDING_PRUNE_BATCH` rows, and the sweep runs daily, so a backlog is cleared over a few days
 * rather than in one statement that could time out. Never throws: it runs ahead of the publishes in the same cron invocation.
 */
import { pool } from '../config/db.js';
import { queryCount } from '../db/query.js';
import { log } from '../utils/log.js';
import { pruneSources } from './onboarding/draftStore.js';

export const EVENT_RETENTION_DAYS = 180;
export const EXPIRED_INVITE_GRACE_DAYS = 30;
export const DRAFT_SOURCE_RETENTION_DAYS = 30;
export const ONBOARDING_PRUNE_BATCH = 2_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OnboardingCutoffs {
    /** An event is pruned when its `at` is strictly before this. */
    events: Date;
    /** An unused invite is pruned when its `expires_at` is strictly before this. */
    invites: Date;
    /** A settled draft's sources are cleared when it finished (or, never finished, was made) strictly before this. */
    draftSources: Date;
}

/** The three cutoffs for a given moment. A row is pruned only when it is STRICTLY older than its cutoff. */
export function onboardingCutoffs(now: number = Date.now()): OnboardingCutoffs {
    return {
        events: new Date(now - EVENT_RETENTION_DAYS * DAY_MS),
        invites: new Date(now - EXPIRED_INVITE_GRACE_DAYS * DAY_MS),
        draftSources: new Date(now - DRAFT_SOURCE_RETENTION_DAYS * DAY_MS),
    };
}

/** `$1` the cutoff, `$2` the batch. The index on `at` makes the inner select a range scan. */
export const PRUNE_EVENTS_SQL = `DELETE FROM onboarding_events
 WHERE id IN (SELECT id FROM onboarding_events WHERE at < $1 ORDER BY at LIMIT $2)`;

/** Never used, and expired before the cutoff. Used and revoked-but-unexpired invites are left: they leave when they expire. */
export const PRUNE_INVITES_SQL = `DELETE FROM invites
 WHERE id IN (SELECT id FROM invites WHERE used_at IS NULL AND expires_at < $1 ORDER BY expires_at LIMIT $2)`;

export interface OnboardingPruneResult {
    eventsDeleted: number;
    invitesDeleted: number;
    draftSourcesCleared: number;
    /** A statement came back full, so there is more behind it than this run cleared. */
    moreRemaining: boolean;
}

async function run(label: string, prune: () => Promise<number>): Promise<number> {
    try {
        return await prune();
    } catch (err) {
        // A database without v34 has none of these tables: that is "nothing to prune", not a failed sweep. Anything else is logged.
        const code = (err as { code?: unknown } | null)?.code;
        if (code !== '42P01') log('error', 'retention.onboarding_prune_failed', { what: label, message: (err as Error)?.message });
        return 0;
    }
}

/** Forget what the onboarding tables are no longer for. Never throws. */
export async function pruneOnboardingData(now: number = Date.now()): Promise<OnboardingPruneResult> {
    const cut = onboardingCutoffs(now);
    const eventsDeleted = await run('events', () => queryCount(PRUNE_EVENTS_SQL, [cut.events, ONBOARDING_PRUNE_BATCH]));
    const invitesDeleted = await run('invites', () => queryCount(PRUNE_INVITES_SQL, [cut.invites, ONBOARDING_PRUNE_BATCH]));
    // The draft table is named in ONE module (the draft store: a test fails if another names it), so its statement lives there.
    const draftSourcesCleared = await run('draft_sources', () => pruneSources(pool, cut.draftSources, ONBOARDING_PRUNE_BATCH));
    const moreRemaining = [eventsDeleted, invitesDeleted, draftSourcesCleared].some((n) => n >= ONBOARDING_PRUNE_BATCH);
    if (eventsDeleted > 0 || invitesDeleted > 0 || draftSourcesCleared > 0) {
        log('info', 'retention.onboarding_pruned', {
            events_deleted: eventsDeleted, invites_deleted: invitesDeleted, draft_sources_cleared: draftSourcesCleared, more_likely: moreRemaining,
        });
    }
    return { eventsDeleted, invitesDeleted, draftSourcesCleared, moreRemaining };
}
