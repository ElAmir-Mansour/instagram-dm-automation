/**
 * Where the Creator Profile lives (docs/onboarding/01 §3 and §4): `creator_profiles`, one row per tenant,
 * with every version kept in `creator_profile_versions`.
 *
 *   loadStoredProfile   the stored row, read through `upgradeProfile`, or null. Cached for the request.
 *   loadProfile         the stored profile, else the one the tenant's legacy settings describe (`version: null`).
 *   saveProfile         one transaction: validate, bump the version, keep the history, mirror into the settings.
 *   createProfile       a profile stored as version 1 exactly as given: a tenant's first, at creation (P16). Never over one.
 *
 * The Studio and Growth settings readers overlay the stored profile (`overlayProfile`, `loadScheduleTimezone`) and their
 * writers route a change to a profile-owned field into `saveProfile` (`lockStoredProfile`, `newerSchemaError`): P4.
 *
 * **The mirror.** Until the settings stop being stored at all, every `saveProfile` writes the profile's view back
 * into `studio_settings` and `growth_settings` in the same transaction. A code rollback then finds the settings
 * rows holding what the tenant last saved, instead of a stale copy and a profile it cannot read. Only the sections
 * that hold a profile-owned field are written (the SET lists of `MIRROR_STUDIO_SQL` and `MIRROR_GROWTH_SQL`); every other section, and every
 * field of those sections the profile does not own (`brand.direction`, `brand.palette`, `schedule.slots`…), keeps what
 * the row says.
 *
 * **The mirror is serialised with the settings writers.** A save takes the tenant's `creators` row (`lockTenantSettings`)
 * first, as `updateStudioSettings` and `updateGrowthSettings` do, and reads the settings rows `FOR UPDATE` before it
 * computes what to write; otherwise a settings write that read before the save and wrote after it would put the stale
 * row back over the mirror. One lock order everywhere: creators, creator_profiles, studio_settings, growth_settings.
 *
 * **No import cycle with the settings readers.** P4 makes `getStudioSettings` and `getGrowthSettings` read this
 * store, so the store must not import them. It reads the stored rows itself, with the pure merge and row readers
 * that moved out of those modules (`studio/settingsMerge.ts`, `growth/settingsRow.ts`).
 */
import { pool } from '../../config/db.js';
import type { CreatorProfileRow, GrowthSettings, ProfileSource, StudioSettings } from '../../db/rows.js';
import { describeError, log } from '../../utils/log.js';
import { readGrowthSettings } from '../growth/settingsRow.js';
import { isMissingTable } from '../health.js';
import { type Exec, lockTenantSettings, withTransaction } from '../studio/common.js';
import { readStudioSettings } from '../studio/settingsMerge.js';
import { cachedForRequest, clearProfileCache } from './cache.js';
import { upgradeProfile } from './defaults.js';
import { profileFromLegacy } from './legacy.js';
import type { CreatorProfile } from './types.js';
import { PROFILE_LIMITS, validateProfile } from './validate.js';
import { changedPaths, growthView, scheduleTimezone, studioView } from './views.js';

// ─── Errors ──────────────────────────────────────────────────────────────────────────────────

export type ProfileErrorCode = 'PROFILE_NEWER_SCHEMA' | 'PROFILE_INVALID' | 'PROFILE_VERSION_CONFLICT' | 'PROFILE_STORAGE_MISSING' | 'OWNER_RULE_LOCKED';

/**
 * A refusal a route answers as-is: `status`, `code` and the message. Thrown rather than returned, so a check made
 * inside the transaction rolls everything back on its way out.
 *
 *   PROFILE_NEWER_SCHEMA      409  the stored profile was written by a newer release; saving would delete what it holds
 *   PROFILE_INVALID           400  `problems` says what is wrong
 *   PROFILE_VERSION_CONFLICT  409  another write got there first; `currentVersion` is the one to reload
 *   PROFILE_STORAGE_MISSING   503  migration v33 has not been applied
 *   OWNER_RULE_LOCKED         409  the change removes the platform owner's `no_women_imagery` rule and was not confirmed (`patch.ts`)
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

/**
 * The profile the tenant's own settings rows describe (`profileFromLegacy`): what a tenant with no stored profile
 * is, and what the first save stores as version 1. Reads the rows directly, not through the settings readers.
 */
export async function loadLegacyProfile(creatorId: string, exec: Exec = pool): Promise<CreatorProfile> {
    const studio = await readStudioSettings(exec, creatorId);
    const growth = await readGrowthSettings(exec, creatorId);
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

// ─── Reading for the settings (P4) ───────────────────────────────────────────────────────────

/** Logged once per tenant per process: every reader asks, so a warning per call would be noise. */
const newerSchemaWarned = new Set<string>();
const repairedWarned = new Set<string>();
/** Keyed by tenant and settings (`<id>:studio`, `<id>:growth`): the two readers drift independently, and one should not hide the other. */
const driftWarned = new Set<string>();

/** Test hook: forget which tenants' newer-schema, repaired-profile and row-drift warnings were logged. */
export function resetProfileWarnings(): void {
    newerSchemaWarned.clear();
    repairedWarned.clear();
    driftWarned.clear();
}

/**
 * Says, once per tenant and settings, that the settings row differs from what the profile says: the fields of
 * `paths` where `row` and `view` disagree. The readers show the view, so nothing is wrong for the tenant; the row is
 * what a code rollback would read, and a row that has drifted (an SQL edit, a write that bypassed the mirror) is healed
 * silently by the next write, so without this line the drift is invisible until a rollback shows it.
 */
export function warnRowDrift(creatorId: string, settings: 'studio' | 'growth', row: object, view: object, paths: readonly string[]): void {
    const key = `${creatorId}:${settings}`;
    if (driftWarned.has(key)) return;
    const drifted = changedPaths(row, view, paths);
    if (drifted.length === 0) return;
    driftWarned.add(key);
    log('warn', 'profile.row_drift', {
        creator_id: creatorId,
        settings,
        paths: drifted,
        effect: 'readers show the profile\'s values; the row, which a rollback would read, says something else',
        fix: 'the next write to these settings rewrites the row from the profile; edit them in the dashboard, never in SQL',
    });
}

/** Who is writing a settings change: the signed-in user, or null for the shared-password login and for a job. It is `updated_by` of the profile version the write makes. */
export interface SettingsActor {
    userId: string | null;
}

/** No one in particular: a job, a script, a caller that does not know. */
export const SYSTEM_ACTOR: SettingsActor = Object.freeze({ userId: null });

/** A stored profile some of whose fields could not be read as stored: they read as defaults, so the settings views carry those. The drift signal. */
function warnRepaired(creatorId: string, repaired: readonly string[]): void {
    if (repairedWarned.has(creatorId)) return;
    repairedWarned.add(creatorId);
    log('warn', 'profile.repaired', {
        creator_id: creatorId,
        count: repaired.length,
        paths: repaired.slice(0, 20),
        effect: 'these fields read as their defaults in the Studio and Growth settings',
        fix: 'save the profile again with valid values, or restore an earlier version of it',
    });
}

function warnNewerSchema(creatorId: string): void {
    if (newerSchemaWarned.has(creatorId)) return;
    newerSchemaWarned.add(creatorId);
    log('warn', 'profile.newer_schema', {
        creator_id: creatorId,
        effect: 'the Studio and Growth settings are read from their own rows, without the profile',
        fix: 'deploy the release that wrote this profile, or restore an earlier version of it',
    });
}

/**
 * The profile a settings reader overlays on the stored row, or null when the row speaks for itself: the tenant has
 * no stored profile (a tenant without one reads its rows exactly as before: no virtual overlay), or the profile was
 * written by a newer release. That one is read as far as this release can (`upgradeProfile` keeps what it does not
 * know), but a view over it would present half a profile as the tenant's, so the rows answer instead, logged once.
 * A profile with fields that had to be repaired when it was read (`repaired`) is overlaid, and says so once.
 */
export function overlayProfile(creatorId: string, stored: Pick<StoredProfile, 'profile' | 'newerSchema'> & { repaired?: readonly string[] } | null): CreatorProfile | null {
    if (!stored) return null;
    if (stored.newerSchema) {
        warnNewerSchema(creatorId);
        return null;
    }
    if (stored.repaired?.length) warnRepaired(creatorId, stored.repaired);
    return stored.profile;
}

/** The profile to overlay for this tenant, read once per request when `exec` is the pool (`loadStoredProfile`). */
export async function loadOverlayProfile(creatorId: string, exec: Exec = pool): Promise<CreatorProfile | null> {
    return overlayProfile(creatorId, await loadStoredProfile(creatorId, exec));
}

/**
 * `schedule.timezone` as the profile gives it (`identity.timezone`, UTC when empty), for a reader that needs the
 * timezone and nothing else: the Monteur's run reads this on every poll, so it does not fetch the profile, which can
 * be 128 KB. null means the settings row's own timezone applies (no stored profile, a newer-schema one, or no v33).
 *
 * The two values it selects are read by `upgradeProfile` itself, over a profile that holds only them, so what a
 * missing, empty or wrongly typed timezone reads as is decided in one place, and `readers.test.ts` holds this equal
 * to `getStudioSettings(...).schedule.timezone` across those cases.
 */
export async function loadScheduleTimezone(creatorId: string, exec: Exec = pool): Promise<string | null> {
    let row: { profile_schema: unknown; identity_timezone: unknown } | undefined;
    try {
        const result = await exec.query<{ profile_schema: unknown; identity_timezone: unknown }>(
            `SELECT profile->'schema' AS profile_schema, profile->'identity'->'timezone' AS identity_timezone FROM creator_profiles WHERE creator_id = $1`, [creatorId]
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
    if (!row) return null;
    const read = upgradeProfile({ schema: row.profile_schema, identity: { timezone: row.identity_timezone } });
    // Only the two values were read, so what `repaired` lists is about the stand-in, not the stored profile: not passed on.
    const profile = overlayProfile(creatorId, { profile: read.profile, newerSchema: read.newerSchema });
    return profile ? scheduleTimezone(profile) : null;
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
     * the save then matches only if no profile has been stored since, and loses to one that has. A number means it
     * read a stored profile, so it loses when the tenant had none (this save would have had to create it).
     */
    expectVersion: number | null;
    source: ProfileSource;
    /** The signed-in user, or null for the system (a script). */
    userId: string | null;
    /**
     * For a tenant with no stored profile whose legacy settings are not a valid profile themselves (a colour that is no
     * colour, say): store the caller's own profile as version 1, if it is valid, instead of refusing. The caller is
     * repairing exactly that (`patchProfile`), and a baseline that cannot exist is not a reason to refuse the repair.
     * Left off, the legacy profile must be valid (the default, and what a script that never looked at it wants).
     */
    startFromCaller?: boolean;
}

export interface SavedProfile {
    profile: CreatorProfile;
    version: number;
}

const json = (value: unknown): string => JSON.stringify(value);

const problemsMessage = (problems: string[]): string => (problems.length === 1 ? problems[0]! : `${problems.length} problems with this profile.`);

/** The refusal for a profile that does not validate: every problem, as one sentence when there is one and a count otherwise. */
export const invalidProfile = (problems: string[]): ProfileError => new ProfileError('PROFILE_INVALID', 400, problemsMessage(problems), { problems });

/** Postgres `check_violation` on the size cap: the profile is bigger than the table allows, however it got past the validator. */
const isSizeViolation = (err: unknown): boolean => {
    const e = err as { code?: unknown; constraint?: unknown; message?: unknown } | null;
    return e?.code === '23514' && (e.constraint === 'creator_profiles_size' || (typeof e.message === 'string' && e.message.includes('creator_profiles_size')));
};

/**
 * Store `next` as the tenant's profile, in one transaction (a caller already inside one passes its client as `exec`
 * and commits it itself, then calls `clearProfileCache`). Locks are taken in one order, here and in the settings
 * writers: the tenant's `creators` row (`lockTenantSettings`), then `creator_profiles`, then `studio_settings`, then
 * `growth_settings`.
 *
 *  0. With no stored row, version 1 is inserted from the legacy settings first (source `backfill`), so a save never
 *     fails on a tenant the backfill has not reached. Those settings must make a valid profile themselves
 *     (`PROFILE_INVALID` if not), unless the caller says `startFromCaller`: then, if they do not, `next` itself is
 *     stored as version 1 (source and user the caller's, nothing before it in the history) when it is valid, and the
 *     steps below it are done. If the save is refused, the insert rolls back with it.
 *  1. A stored profile from a newer release is refused (`PROFILE_NEWER_SCHEMA`): it would lose what that release stored.
 *  2. `validateProfile(next)`: every problem, or `PROFILE_INVALID`.
 *  3. `UPDATE … WHERE version = expectVersion`: no row is `PROFILE_VERSION_CONFLICT`.
 *  4. The history row.
 *  5. The mirror: the view of `next` over the settings rows, read `FOR UPDATE` first, and written back (see the top of the file).
 *
 * `activated_at` is not touched: finishing the wizard sets it, not saving.
 */
export async function saveProfile(creatorId: string, next: unknown, options: SaveProfileOptions, exec: Exec = pool): Promise<SavedProfile> {
    try {
        return isPool(exec) ? await withTransaction((tx) => write(creatorId, next, options, tx)) : await write(creatorId, next, options, exec);
    } catch (err) {
        if (isProfileTableMissing(err)) throw storageMissing();
        if (isSizeViolation(err)) {
            const problems = [`the profile is larger than the ${PROFILE_LIMITS.profileBytes} bytes the database stores`];
            throw new ProfileError('PROFILE_INVALID', 400, problemsMessage(problems), { problems });
        }
        throw err;
    } finally {
        clearProfileCache(creatorId);
    }
}

export interface CreateProfileOptions {
    source: ProfileSource;
    /** The signed-in user, or null for the system (a script). */
    userId: string | null;
    /**
     * The Studio's text direction for this tenant. Not a profile field (`brand.direction` stays a Studio setting: it is not
     * derived from the language, P2 review), so it rides with the mirror into `studio_settings`, where it lives. Left out, the
     * Studio's own default stands.
     */
    direction?: 'rtl' | 'ltr';
}

/**
 * A tenant's FIRST profile, stored as version 1 exactly as given, in one transaction (a caller already inside one passes its
 * client as `exec` and commits it itself, then calls `clearProfileCache`): the row, its history row, and the mirror into the
 * Studio and Growth settings that `saveProfile` keeps, so the settings rows and the profile agree from the first moment.
 * Null when the tenant already has a profile: nothing is written, and nothing is ever overwritten.
 *
 * Not `saveProfile`: with no stored row that inserts the profile the tenant's LEGACY settings describe as version 1, and a
 * tenant that has no settings is described as the owner (`legacy.ts`). A new tenant's version 1 must be the neutral one the
 * caller built (`defaultProfile`), with no owner role, domain or pronouns anywhere in its history.
 *
 * Lock order is `saveProfile`'s: the tenant's `creators` row, `creator_profiles`, `studio_settings`, `growth_settings`.
 * `activated_at` stays NULL: finishing the wizard sets it.
 */
export async function createProfile(creatorId: string, profile: unknown, options: CreateProfileOptions, exec: Exec = pool): Promise<SavedProfile | null> {
    try {
        return isPool(exec) ? await withTransaction((tx) => insertFirst(creatorId, profile, options, tx)) : await insertFirst(creatorId, profile, options, exec);
    } catch (err) {
        if (isProfileTableMissing(err)) throw storageMissing();
        if (isSizeViolation(err)) {
            const problems = [`the profile is larger than the ${PROFILE_LIMITS.profileBytes} bytes the database stores`];
            throw new ProfileError('PROFILE_INVALID', 400, problemsMessage(problems), { problems });
        }
        throw err;
    } finally {
        clearProfileCache(creatorId);
    }
}

async function insertFirst(creatorId: string, given: unknown, { source, userId, direction }: CreateProfileOptions, tx: Exec): Promise<SavedProfile | null> {
    await lockTenantSettings(tx, creatorId);

    const checked = validateProfile(given);
    if ('problems' in checked) throw invalidProfile(checked.problems);
    const profile = checked.profile;

    const { rows } = await tx.query<{ version: number }>(
        `INSERT INTO creator_profiles (creator_id, profile, version, updated_by, updated_at)
         VALUES ($1, $2::jsonb, 1, $3, NOW())
         ON CONFLICT (creator_id) DO NOTHING
         RETURNING version`,
        [creatorId, json(profile), userId]
    );
    if (rows.length === 0) return null;
    await insertVersion(creatorId, 1, profile, source, userId, tx);

    // The mirror, as `write` step 5 does it, over the settings the tenant has (none: the defaults).
    const studioBase = await readStudioSettings(tx, creatorId, true);
    const studio = studioView(direction ? { ...studioBase, brand: { ...studioBase.brand, direction } } : studioBase, profile);
    await tx.query(MIRROR_STUDIO_SQL, [
        creatorId, json(studio.brand), json(studio.voice), json(studio.product), json(studio.cta), json(studio.schedule), json(studio.library), json(studio.infographic),
    ]);
    const growth = growthView(await readGrowthSettings(tx, creatorId, true), profile);
    await tx.query(MIRROR_GROWTH_SQL, [creatorId, json(growth.audience), growth.goal_followers, growth.goal_views]);

    log('info', 'profile.created', { creator_id: creatorId, source });
    return { profile, version: 1 };
}

async function write(creatorId: string, next: unknown, { expectVersion, source, userId, startFromCaller }: SaveProfileOptions, tx: Exec): Promise<SavedProfile> {
    // The mutex first, before any row: a Studio or Growth settings write holds it while it reads, changes and writes
    // its row, so it can neither read before this save's mirror and write after it, nor interleave with it.
    await lockTenantSettings(tx, creatorId);

    // The settings rows are read FOR UPDATE, once, the first time they are needed (step 0 or the mirror), and always
    // before a view is computed from them. Studio, then Growth: the order the mirror writes them in.
    let studioRow: StudioSettings | undefined;
    let growthRow: GrowthSettings | undefined;
    const studioSettings = async (): Promise<StudioSettings> => (studioRow ??= await readStudioSettings(tx, creatorId, true));
    const growthSettings = async (): Promise<GrowthSettings> => (growthRow ??= await readGrowthSettings(tx, creatorId, true));

    // 0. The row, locked for this transaction; or version 1 from the legacy settings. ON CONFLICT DO NOTHING: when
    // another save created the row first (the concurrent first save), the insert waits for it and yields nothing, and
    // the row is read again: `created` is then false, and a caller that read the virtual profile has lost.
    let current = await selectForUpdate(creatorId, tx);
    let created = false;
    // Set when the caller's own profile was stored as version 1 (`startFromCaller`): there is then nothing to validate,
    // bump or record again.
    let first: CreatorProfile | null = null;
    if (!current) {
        const legacy = profileFromLegacy(await studioSettings(), await growthSettings());
        const legacyChecked = validateProfile(legacy);
        let baseline: CreatorProfile;
        let own = false;
        if ('problems' in legacyChecked) {
            if (!startFromCaller) {
                // Not the caller's profile: the tenant's present settings, which cannot be stored as version 1. Say so.
                throw new ProfileError(
                    'PROFILE_INVALID', 400,
                    `The settings this profile starts from are not a valid profile yet: ${problemsMessage(legacyChecked.problems)}`,
                    { problems: legacyChecked.problems }
                );
            }
            // The caller is repairing those settings: their profile is version 1, if it is valid. A caller that holds a
            // version cannot have read a row that does not exist.
            const callers = validateProfile(next);
            if ('problems' in callers) throw invalidProfile(callers.problems);
            if (expectVersion !== null) throw versionConflict(null);
            baseline = callers.profile;
            own = true;
        } else {
            baseline = legacyChecked.profile;
        }
        const { rows } = await tx.query<{ version: number }>(
            `INSERT INTO creator_profiles (creator_id, profile, version, updated_by, updated_at)
             VALUES ($1, $2::jsonb, 1, $3, NOW())
             ON CONFLICT (creator_id) DO NOTHING
             RETURNING version`,
            [creatorId, json(baseline), own ? userId : null]
        );
        created = rows.length > 0;
        if (created) {
            await insertVersion(creatorId, 1, baseline, own ? source : 'backfill', own ? userId : null, tx);
            if (own) first = baseline;
        }
        current = await selectForUpdate(creatorId, tx);
        if (!current) throw new Error(`creator_profiles has no row for ${creatorId} after inserting one`);
    }

    let profile: CreatorProfile;
    let version: number;
    if (first) {
        profile = first;
        version = 1;
    } else {
        // 1. Never write over a profile this release cannot fully read.
        if (upgradeProfile(current.profile).newerSchema) {
            throw newerSchemaError(current.version);
        }

        // 2. Everything wrong with it, in one answer.
        const checked = validateProfile(next);
        if ('problems' in checked) throw invalidProfile(checked.problems);
        profile = checked.profile;

        // 3. The version the caller read must still be the one stored. A caller that read the virtual profile has no
        // version, and matches only the row this very save just created from the same settings; a caller that has a
        // version cannot have read a row that did not exist until now. Either mismatch is a conflict.
        if ((expectVersion === null) !== created) throw versionConflict(current.version);
        const { rows } = await tx.query<{ version: number }>(
            `UPDATE creator_profiles
                SET profile = $2::jsonb, version = version + 1, updated_by = $3, updated_at = NOW()
              WHERE creator_id = $1 AND version = $4
          RETURNING version`,
            [creatorId, json(profile), userId, expectVersion ?? current.version]
        );
        const saved = rows[0];
        if (!saved) throw versionConflict(current.version);
        version = saved.version;

        // 4. The history.
        await insertVersion(creatorId, version, profile, source, userId, tx);
    }

    // 5. The mirror: the same facts, in the rows the settings readers still read.
    const studio = studioView(await studioSettings(), profile);
    await tx.query(MIRROR_STUDIO_SQL, [
        creatorId, json(studio.brand), json(studio.voice), json(studio.product), json(studio.cta), json(studio.schedule), json(studio.library), json(studio.infographic),
    ]);
    const growth = growthView(await growthSettings(), profile);
    await tx.query(MIRROR_GROWTH_SQL, [creatorId, json(growth.audience), growth.goal_followers, growth.goal_views]);

    log('info', 'profile.saved', { creator_id: creatorId, version, source, backfilled: created && first === null });
    return { profile, version };
}

/**
 * The refusal for a write that started from a version that is no longer the stored one (`write` step 3, and `patchProfile`'s
 * early check). `currentVersion` is the one to reload, and is left out when the tenant has no stored profile (null).
 */
export const versionConflict = (currentVersion: number | null): ProfileError =>
    new ProfileError('PROFILE_VERSION_CONFLICT', 409, 'The profile changed since you opened it. Reload it and try again.', currentVersion === null ? {} : { currentVersion });

const storageMissing = (): ProfileError =>
    new ProfileError('PROFILE_STORAGE_MISSING', 503, 'The profile tables are missing: apply migration v33 (npm run migrate).');

/** The refusal for a write that would have to land in a profile this release cannot fully read (`write` step 1, and the settings writers). */
export const newerSchemaError = (currentVersion: number): ProfileError =>
    new ProfileError(
        'PROFILE_NEWER_SCHEMA', 409,
        'This profile was saved by a newer version of the app. Saving it from this one would delete part of it.',
        { currentVersion }
    );

/** The row, locked until the transaction ends so a second save for the tenant waits instead of interleaving its mirror with ours. */
async function selectForUpdate(creatorId: string, tx: Exec): Promise<Pick<CreatorProfileRow, 'profile' | 'version'> | null> {
    const { rows } = await tx.query<Pick<CreatorProfileRow, 'profile' | 'version'>>(
        'SELECT profile, version FROM creator_profiles WHERE creator_id = $1 FOR UPDATE', [creatorId]
    );
    return rows[0] ?? null;
}

/** What a settings writer holds after `lockStoredProfile`: the profile as read, and the version a save must expect. */
export interface LockedProfile {
    profile: CreatorProfile;
    version: number;
    repaired: string[];
    newerSchema: boolean;
}

/**
 * The tenant's stored profile, read `FOR UPDATE` inside the writer's transaction: the second lock of the global order
 * (creators, creator_profiles, studio_settings, growth_settings), taken after `lockTenantSettings` and before any settings
 * row. `version` is what the writer then passes to `saveProfile` as `expectVersion`. null is no stored profile, and a
 * row that does not exist locks nothing, which is why the creators mutex, held by every writer, is what serialises a
 * tenant's first save. A database without v33 cannot be tolerated here as a reader tolerates it (a failed statement
 * aborts the transaction), so it is `PROFILE_STORAGE_MISSING`.
 */
export async function lockStoredProfile(creatorId: string, tx: Exec): Promise<LockedProfile | null> {
    let row: Pick<CreatorProfileRow, 'profile' | 'version'> | null;
    try {
        row = await selectForUpdate(creatorId, tx);
    } catch (err) {
        if (isProfileTableMissing(err)) throw storageMissing();
        throw err;
    }
    if (!row) return null;
    const read = upgradeProfile(row.profile);
    return { profile: read.profile, version: row.version, repaired: read.repaired, newerSchema: read.newerSchema };
}

/**
 * The tenant's `studio_settings` row, locked, for a writer that is not going to read it (the Growth writer) but whose
 * `saveProfile` mirrors into it: the lock order puts it before `growth_settings`, which the writer reads next.
 */
export async function lockStudioRow(creatorId: string, tx: Exec): Promise<void> {
    await tx.query('SELECT creator_id FROM studio_settings WHERE creator_id = $1 FOR UPDATE', [creatorId]);
}

async function insertVersion(creatorId: string, version: number, profile: CreatorProfile, source: ProfileSource, userId: string | null, tx: Exec): Promise<void> {
    await tx.query(
        `INSERT INTO creator_profile_versions (creator_id, version, profile, source, updated_by, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW())`,
        [creatorId, version, json(profile), source, userId]
    );
}
