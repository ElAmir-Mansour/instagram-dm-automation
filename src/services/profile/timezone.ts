/**
 * The tenant's one time zone (dashboard UX overhaul, research R-09).
 *
 * It is the profile's `identity.timezone`, which is already mirrored to `studio_settings.schedule.timezone` (`scheduleTimezone`,
 * `views.ts`). Every "when" the dashboard shows and every day it buckets is read in this zone, so there is exactly one answer to
 * "what time is that for him", instead of the browser's (wrong when travelling, or on a phone set to UTC) and the three separate
 * zones the code used before.
 *
 * `unset` is the honest part. A tenant that never chose a zone is read in UTC so nothing breaks, but the dashboard must be able to
 * say so ("Set your time zone") rather than show UTC times as if they were his own (constitution I: every time shown makes its zone
 * unambiguous). `unset` is true when:
 *   - the profile's `identity.timezone` is empty, which is what a new profile holds until the wizard or Settings sets it;
 *   - there is no stored profile and the settings row holds nothing but UTC, which is the row's default and not a choice anyone made
 *     (a stored profile that says UTC was written by a person, or copied from such a row: it counts as set);
 *   - the stored value is not a zone this runtime knows, since an `AT TIME ZONE` over it would throw.
 */
import { pool } from '../../config/db.js';
import type { Exec } from '../studio/common.js';
import { loadIdentityTimezone } from './store.js';
import { isTimeZone } from './validate.js';

export interface TenantTimezone {
    /** An IANA zone name. 'UTC' when the tenant has not chosen one. */
    tz: string;
    /** True when `tz` is the UTC fallback, not the tenant's choice. */
    unset: boolean;
}

/** What an unset tenant is read in. */
export const FALLBACK_TIMEZONE = 'UTC';

function resolved(raw: unknown, fromSettingsRow: boolean): TenantTimezone {
    const tz = typeof raw === 'string' ? raw.trim() : '';
    if (!tz || !isTimeZone(tz)) return { tz: FALLBACK_TIMEZONE, unset: true };
    // The settings row's default is UTC. Nobody chose it, so it must not read as a choice.
    if (fromSettingsRow && tz === FALLBACK_TIMEZONE) return { tz, unset: true };
    return { tz, unset: false };
}

/**
 * The tenant's time zone, and whether it chose one.
 *
 * Reads the stored profile's `identity.timezone` (two values, never the profile: `loadIdentityTimezone`). A tenant with no stored
 * profile, or one written by a newer release that this one overlays nothing from, answers from its Studio settings row, which is
 * what `getStudioSettings` shows it. No row at all is unset.
 */
export async function tenantTimezone(creatorId: string, exec: Exec = pool): Promise<TenantTimezone> {
    const identity = await loadIdentityTimezone(creatorId, exec);
    if (identity !== null) return resolved(identity, false);

    const { rows } = await exec.query<{ timezone: string | null }>(
        `SELECT schedule->>'timezone' AS timezone FROM studio_settings WHERE creator_id = $1`, [creatorId]
    );
    return resolved(rows[0]?.timezone, true);
}
