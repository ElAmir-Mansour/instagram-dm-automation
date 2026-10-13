/**
 * Where the Creator Profile lives (docs/onboarding/01 §3 and §4): `creator_profiles`, one row per tenant,
 * with every version kept in `creator_profile_versions`.
 *
 *   loadStoredProfile   the stored row, read through `upgradeProfile`, or null. Cached for the request.
 *   loadProfile         the stored profile, else the one the tenant's legacy settings describe (`version: null`).
 *   saveProfile         one transaction: validate, bump the version, keep the history, mirror into the settings.
 *
 * Nothing reads these yet (P4 wires the Studio and Growth readers), so this changes no request's behaviour.
 *
 * **The mirror.** Until the settings stop being stored at all, every `saveProfile` writes the profile's view back
 * into `studio_settings` and `growth_settings` in the same transaction. A code rollback then finds the settings
 * rows holding what the tenant last saved, instead of a stale copy and a profile it cannot read. Only the sections
 * that hold a profile-owned field are written (`STUDIO_MIRRORED`, `GROWTH_MIRRORED`); every other section, and every
 * field of those sections the profile does not own (`brand.direction`, `brand.palette`, `schedule.slots`…), keeps what
 * the row says.
 *
 * **No import cycle with the settings readers.** P4 makes `getStudioSettings` and `getGrowthSettings` read this
 * store, so the store must not import them. It reads the stored rows itself, with the pure merge and row readers
 * that moved out of those modules (`studio/settingsMerge.ts`, `growth/settingsRow.ts`).
 */
import { pool } from '../../config/db.js';
import type { CreatorProfileRow, GrowthSettings, ProfileSource, StudioSettings, StudioSettingsRow } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { fromRow as growthFromRow } from '../growth/settingsRow.js';
import { isMissingTable } from '../health.js';
import { type Exec, withTransaction } from '../studio/common.js';
import { overDefaults } from '../studio/settingsMerge.js';
import { cachedForRequest, clearProfileCache } from './cache.js';
import { upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import type { CreatorProfile } from './types.js';
import { validateProfile } from './validate.js';
import { growthView, studioView } from './views.js';

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────

export type ProfileErrorCode = 'PROFILE_NEWER_SCHEMA' | 'PROFILE_INVALID' | 'PROFILE_VERSION_CONFLICT' | 'PROFILE_STORAGE_MISSING';

/**
 * A refusal a route answers as-is: `status`, `code` and the message. Thrown rather than returned, so a check made
 * inside the transaction rolls everything back on its way out.
 *
 *   PROFILE_NEWER_SCHEMA      409  the stored profile was written by a newer release; saving would delete what it holds
 *   PROFILE_INVALID           400  `problems` says what is wrong
 *   PROFILE_VERSION_CONFLICT  409  another write got there first; `currentVersion` is the one to reload
 *   PROFILE_STORAGE_MISSING   503  migration v33 has not been applied
 */
export class ProfileError extends Error {
    constructor(
        readonly code: ProfileErrorCode,
        readonly status: number,
        message: string,
        readonly detail: { problems?: string[]; currentVersion?: number } = {}
    ) {
        super(message);
        this.name = 'ProfileError';
    }
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────

/** A stored profile, as `upgradeProfile` reads it. */
export interface StoredProfile {
    profile: CreatorProfile;
    version: number;
    activated_at: Date | null;
    /** Stored paths that could not be kept as stored (`UpgradedProfile.repaired`). Empty for a profile this release wrote. */
    repaired: string[];
    /** The stored `schema` is newer than this release knows. `saveProfile` refuses to write over it. */
    newerSchema: boolean;
}

/** What `loadProfile` answers: a stored profile, or the virtual one (`version: null`) with nothing repaired. */
export interface LoadedProfile {
    profile: CreatorProfile;
    version: number | null;
    activated_at: Date | null;
    repaired: string[];
    newerSchema: boolean;
}

/** A database that has not had v33 applied yet: `relation "creator_profiles" does not exist` (or the versions table). */
const isProfileTableMissing = (err: unknown): boolean => isMissingTable(err, 'creator_profile');

/** Only a pool call may be cached; a transaction client sees its own writes and must not publish what it has not committed. */
const isPool = (exec: Exec): boolean => (exec as unknown) === pool;

/** Logged once per process: every reader asks, so a warning per call would be noise. */
let tableMissingWarned = false;

/** Test hook: forget that the missing-v33 warning was logged. */
export function resetProfileTableWarning(): void {
    tableMissingWarned = false;
}

/**
 * The stored row. A database that has not had v33 applied yet reads as no row, logged once: production deploys on
 * merge, and a read that threw would fail every request that asks for a profile for the minutes until
 * `npm run migrate` ran (the pattern of `getGrowthSettings` and the v25 columns). Inside a transaction a failed
 * statement aborts the transaction, so there the tolerance only helps a caller that has not begun one.
 */
async function readStored(creatorId: string, exec: Exec): Promise<StoredProfile | null> {
    let row: Pick<CreatorProfileRow, 'profile' | 'version' | 'activated_at'> | undefined;
    try {
        const result = await exec.query<Pick<CreatorProfileRow, 'profile' | 'version' | 'activated_at'>>(
            'SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = $1', [creatorId]
        );
        row = result.rows[0];
    } catch (err) {
        if (!isProfileTableMissing(err)) throw err;
        if (!tableMissingWarned) {
            tableMissingWarned = true;
            log('warn', 'profile.table_missing', { ...describeError(err), fix: 'npm run migrate (migration_v33_creator_profiles.sql)' });
        }
        return null;
    }
    return row ? upgraded(row) : null;
}

function upgraded(row: Pick<CreatorProfileRow, 'profile' | 'version' | 'activated_at'>): StoredProfile {
    const read = upgradeProfile(row.profile);
    return { profile: read.profile, version: row.version, activated_at: row.activated_at ?? null, repaired: read.repaired, newerSchema: read.newerSchema };
}

/** Each caller gets its own copy: the cached promise is shared, and a caller that edits its profile must not edit anyone else's. */
const copyOf = (stored: StoredProfile | null): StoredProfile | null => (stored ? structuredClone(stored) : null);

/**
 * The tenant's stored profile, or null when it has none (or the table is not there yet). Read once per request
 * (`cache.ts`) when `exec` is the pool; a transaction client always reads the database.
 */
export async function loadStoredProfile(creatorId: string, exec: Exec = pool): Promise<StoredProfile | null> {
    if (!isPool(exec)) return readStored(creatorId, exec);
    return copyOf(await cachedForRequest(creatorId, () => readStored(creatorId, exec)));
}

/** The stored Studio settings, over the defaults. The statement `getStudioSettings` runs, read here so the store never imports it. */
async function readStudio(creatorId: string, exec: Exec): Promise<StudioSettings> {
    const { rows } = await exec.query<Omit<StudioSettingsRow, 'creator_id' | 'updated_at'>>(
        'SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings WHERE creator_id = $1',
        [creatorId]
    );
    return overDefaults(rows[0] ?? {});
}

/** The stored Growth settings, over the defaults. The v25 goal columns are assumed: `getGrowthSettings` keeps its fallback for a database without them, and a migration run in order cannot reach v33 without them. */
async function readGrowth(creatorId: string, exec: Exec): Promise<GrowthSettings> {
    const { rows } = await exec.query<GrowthSettings>(
        'SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = $1',
        [creatorId]
    );
    return growthFromRow(rows[0] ?? null);
}

/**
 * The profile the tenant's own settings rows describe (`profileFromLegacy`): what a tenant with no stored profile
 * is, and what the first save stores as version 1. Reads the rows directly, not through the settings readers.
 */
export async function loadLegacyProfile(creatorId: string, exec: Exec = pool): Promise<CreatorProfile> {
    const studio = await readStudio(creatorId, exec);
    const growth = await readGrowth(creatorId, exec);
    return profileFromLegacy(studio, growth);
}

/**
 * The tenant's profile: the stored one, else the virtual profile its legacy settings describe, with `version: null`.
 * Every tenant has one (01 §0.2), so a reader never has to ask whether it exists.
 */
export async function loadProfile(creatorId: string, exec: Exec = pool): Promise<LoadedProfile> {
    const stored = await loadStoredProfile(creatorId, exec);
    if (stored) return stored;
    return { profile: await loadLegacyProfile(creatorId, exec), version: null, activated_at: null, repaired: [], newerSchema: false };
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────

// What the mirror writes is exactly the SET list of each statement below, and `store.test.ts` holds those lists
// equal to the sections of `STUDIO_PROFILE_PATHS` / `GROWTH_PROFILE_PATHS`: a field the profile comes to own in
// another section fails there until the mirror covers it.
// `cta` and `library` are NOT NULL, so a tenant with no row needs a value for them (the defaults it reads as);
// they are in the VALUES and never in the SET: an existing row keeps its own.
const MIRROR_STUDIO_SQL = `INSERT INTO studio_settings (creator_id, brand, voice, product, cta, schedule, library, infographic, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, NOW())
         ON CONFLICT (creator_id) DO UPDATE
            SET brand = EXCLUDED.brand, voice = EXCLUDED.voice, product = EXCLUDED.product,
                schedule = EXCLUDED.schedule, infographic = EXCLUDED.infographic, updated_at = NOW()`;

// The keywords, hashtag sets and competitors are NOT NULL with defaults: left out of the VALUES, an insert takes
// the defaults and an update keeps what the row has.
const MIRROR_GROWTH_SQL = `INSERT INTO growth_settings (creator_id, audience, goal_followers, goal_views, updated_at)
         VALUES ($1, $2::jsonb, $3::integer, $4::bigint, NOW())
         ON CONFLICT (creator_id) DO UPDATE
            SET audience = EXCLUDED.audience, goal_followers = EXCLUDED.goal_followers, goal_views = EXCLUDED.goal_views, updated_at = NOW()`;

export interface SaveProfileOptions {
    /**
     * The version the caller read. `null` means it read the virtual profile (`loadProfile` answered `version: null`):
     * the save then matches only if no profile has been stored since, and loses to one that has.
     */
    expectVersion: number | null;
    source: ProfileSource;
    /** The signed-in user, or null for the system (a script). */
    userId: string | null;
}

export interface SavedProfile {
    profile: CreatorProfile;
    version: number;
}

const json = (value: unknown): string => JSON.stringify(value);

const problemsMessage = (problems: string[]): string => (problems.length === 1 ? problems[0]! : `${problems.length} problems with this profile.`);

/**
 * Store `next` as the tenant's profile, in one transaction (a caller already inside one passes its client as `exec`
 * and commits it itself, then calls `clearProfileCache`):
 *
 *  0. With no stored row, version 1 is inserted from the legacy settings first (source `backfill`), so a save never
 *     fails on a tenant the backfill has not reached. If the save is then refused, that insert rolls back with it.
 *  1. A stored profile from a newer release is refused (`PROFILE_NEWER_SCHEMA`): it would lose what that release stored.
 *  2. `validateProfile(next)`: every problem, or `PROFILE_INVALID`.
 *  3. `UPDATE … WHERE version = expectVersion`: no row is `PROFILE_VERSION_CONFLICT`.
 *  4. The history row.
 *  5. The mirror: the view of `next` over the stored settings rows, written back (see the top of the file).
 *
 * `activated_at` is not touched: finishing the wizard sets it, not saving.
 */
export async function saveProfile(creatorId: string, next: unknown, options: SaveProfileOptions, exec: Exec = pool): Promise<SavedProfile> {
    try {
        return isPool(exec) ? await withTransaction((tx) => write(creatorId, next, options, tx)) : await write(creatorId, next, options, exec);
    } catch (err) {
        if (isProfileTableMissing(err)) {
            throw new ProfileError('PROFILE_STORAGE_MISSING', 503, 'The profile tables are missing: apply migration v33 (npm run migrate).');
        }
        throw err;
    } finally {
        clearProfileCache(creatorId);
    }
}

async function write(creatorId: string, next: unknown, { expectVersion, source, userId }: SaveProfileOptions, tx: Exec): Promise<SavedProfile> {
    // 0. The row, locked for this transaction; or version 1 from the legacy settings. ON CONFLICT DO NOTHING: when
    // another save created the row first, the insert waits for it and yields nothing, and the row is read again.
    let current = await selectForUpdate(creatorId, tx);
    let created = false;
    if (!current) {
        const legacy = await loadLegacyProfile(creatorId, tx);
        const { rows } = await tx.query<{ version: number }>(
            `INSERT INTO creator_profiles (creator_id, profile, version, updated_by, updated_at)
             VALUES ($1, $2::jsonb, 1, NULL, NOW())
             ON CONFLICT (creator_id) DO NOTHING
             RETURNING version`,
            [creatorId, json(legacy)]
        );
        created = rows.length > 0;
        if (created) await insertVersion(creatorId, 1, legacy, 'backfill', null, tx);
        current = await selectForUpdate(creatorId, tx);
        if (!current) throw new Error(`creator_profiles has no row for ${creatorId} after inserting one`);
    }

    // 1. Never write over a profile this release cannot fully read.
    if (upgradeProfile(current.profile).newerSchema) {
        throw new ProfileError(
            'PROFILE_NEWER_SCHEMA', 409,
            'This profile was saved by a newer version of the app. Saving it from this one would delete part of it.',
            { currentVersion: current.version }
        );
    }

    // 2. Everything wrong with it, in one answer.
    const checked = validateProfile(next);
    if ('problems' in checked) throw new ProfileError('PROFILE_INVALID', 400, problemsMessage(checked.problems), { problems: checked.problems });
    const profile = checked.profile;

    // 3. The version the caller read must still be the one stored. A caller that read the virtual profile has no
    // version: it matches only the row this very save just created from the same settings.
    if (expectVersion === null && !created) throw conflict(current.version);
    const { rows } = await tx.query<{ version: number }>(
        `UPDATE creator_profiles
            SET profile = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW()
          WHERE creator_id = $1 AND version = $4
      RETURNING version`,
        [creatorId, json(profile), userId, expectVersion ?? 1]
    );
    const saved = rows[0];
    if (!saved) throw conflict(current.version);

    // 4. The history.
    await insertVersion(creatorId, saved.version, profile, source, userId, tx);

    // 5. The mirror: the same facts, in the rows the settings readers still read.
    const studio = studioView(await readStudio(creatorId, tx), profile);
    await tx.query(MIRROR_STUDIO_SQL, [
        creatorId, json(studio.brand), json(studio.voice), json(studio.product), json(studio.cta), json(studio.schedule), json(studio.library), json(studio.infographic),
    ]);
    const growth = growthView(await readGrowth(creatorId, tx), profile);
    await tx.query(MIRROR_GROWTH_SQL, [creatorId, json(growth.audience), growth.goal_followers, growth.goal_views]);

    log('info', 'profile.saved', { creator_id: creatorId, version: saved.version, source, backfilled: created });
    return { profile, version: saved.version };
}

const conflict = (currentVersion: number): ProfileError =>
    new ProfileError('PROFILE_VERSION_CONFLICT', 409, 'The profile changed since you opened it. Reload it and try again.', { currentVersion });

/** The row, locked until the transaction ends so a second save for the tenant waits instead of interleaving its mirror with ours. */
async function selectForUpdate(creatorId: string, tx: Exec): Promise<Pick<CreatorProfileRow, 'profile' | 'version'> | null> {
    const { rows } = await tx.query<Pick<CreatorProfileRow, 'profile' | 'version'>>(
        'SELECT profile, version FROM creator_profiles WHERE creator_id = $1 FOR UPDATE', [creatorId]
    );
    return rows[0] ?? null;
}

async function insertVersion(creatorId: string, version: number, profile: CreatorProfile, source: ProfileSource, userId: string | null, tx: Exec): Promise<void> {
    await tx.query(
        `INSERT INTO creator_profile_versions (creator_id, version, profile, source, updated_by, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW())`,
        [creatorId, version, json(profile), source, userId]
    );
}
