/**
 * Test support for the `profile_version` stamp (P7): what the six sites' tests share. Imported by tests only;
 * production code never reads it.
 *
 * Every site reads the stamp through `loadStoredProfile`, which asks `SELECT profile, version, activated_at FROM
 * creator_profiles`, so a site's test needs one pool route for that statement. `profileReads` is that route: a
 * stored profile at `versions[tenant]` for the tenants it names, no row for the rest, every read recorded, and one
 * read that can be made to fail (`reads.failAt`).
 *
 * Why "the Nth read" and not "the stamp's read": the settings reader every generation calls first asks for the same
 * profile, and a site's test cannot tell the two statements apart by their SQL. It does know the order, so it says
 * "the first read is the settings' own, the second is the stamp's" with `failAt = 2`, and asserts that the stamp
 * really did read (`reads.creators.length`), so a stamp that never asked cannot pass as one that failed.
 */
import { defaultProfile } from './defaults.js';
import { throughJsonb } from './jsonb.js';

/** A pool route that takes the parameters only, so it fits the fake databases of the sites' test files, whose route types differ. */
export type ProfileRoute = [RegExp, (params: any[]) => { rows: any[] }];

export const PROFILE_READ = /^SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = \$1$/;

export interface ProfileReads {
    /** The tenant of every profile read the code made, in order. */
    creators: string[];
    /** The read with this number (1 is the first) throws, as a dropped connection would; the others answer. */
    failAt: number | null;
}

export function profileReads(versions: Record<string, number>): { reads: ProfileReads; route: ProfileRoute } {
    const reads: ProfileReads = { creators: [], failAt: null };
    const route: ProfileRoute = [PROFILE_READ, ([creatorId]) => {
        reads.creators.push(creatorId);
        if (reads.creators.length === reads.failAt) throw new Error('Connection terminated unexpectedly');
        const version = versions[creatorId];
        return { rows: version === undefined ? [] : [{ profile: throughJsonb(defaultProfile()), version, activated_at: null }] };
    }];
    return { reads, route };
}
