/**
 * Changing the profile by a patch (`PATCH /api/profile {version, patch}`, docs/onboarding/01 §4; P5).
 *
 * A client reads the profile (`GET /api/profile`: the profile and its `version`), edits what it means to change and
 * sends back only that. This module merges the patch into the profile as it is now and stores the result through
 * `saveProfile`, which validates the whole thing, keeps the history and mirrors the settings rows. So everything a
 * stored profile must satisfy is decided in one place (`validateProfile`); what is decided here is how a *patch*
 * means a change, and that a patch can only land on the version its author saw.
 *
 *   mergePatch(current, patch)       pure: the profile `patch` describes (deep merge; see below)
 *   changedSections(before, after)   pure: the top-level sections two profiles differ in
 *   patchProfile(creatorId, body)    read, check the version, merge, validate, then lock, read again and save
 *
 * **How a patch merges.** Objects merge key by key, recursively. Everything else is replaced: a list (`offers`,
 * `content.pillars`…) by the list sent, a scalar by the scalar, `null` by `null` (a field that is null by default,
 * `identity.kind` or `dm.handoff`, is cleared that way), and an object where the profile holds `null` or a scalar (the
 * `presenter` of a profile that has none). The exceptions are the places a merge alone could never take something away,
 * where a `null` *removes* the entry instead: the objects keyed by name rather than by field (`language.surfaces`, one
 * surface's override, `socials.links`: `{ language: { surfaces: { dm: null } } }` drops the DM override) and
 * `audience.timezone`, the heatmap override that is absent when there is none (the Growth settings' PUT clears it with
 * `null` too).
 * A patch with a key the profile has no field for merges in like any other and is refused by the validator.
 * A patch nested deeper than any profile (`MAX_PATCH_DEPTH`) is refused outright, so nothing downstream (the clone, the
 * comparison, the validator, the JSON) ever recurses as deep as a hostile body is.
 *
 * **The version.** `version` is what `GET` answered (null: it answered the virtual profile of a tenant with none
 * stored). A patch whose version is not the stored one is refused with 409 before anything is merged, because it was
 * written against a profile that has changed.
 *
 * **Two reads: one without a lock, one with.** The first read decides everything that needs no lock, so a refusal never
 * takes the tenant's mutex: a stale version or a newer-schema profile (409), a merge that is not a valid profile (400)
 * and a patch that changes nothing. A patch that passes is then made again, from the beginning, in one transaction that
 * takes `lockTenantSettings` first (creators, creator_profiles, studio_settings, growth_settings: the order every
 * settings writer takes) and reads the profile *after* it. That is what makes the merge sound: for a tenant with no
 * stored profile it is merged onto the legacy settings rows, and a Studio or Growth settings write that landed between
 * the first read and the lock is in them; one that comes later waits for the mutex. Without it the stale rows would
 * be saved over that write as the profile's next version, and mirrored back.
 *
 * **A tenant whose legacy rows are not a valid profile** (a colour that is no colour) can still be repaired: the merged
 * result is what is validated, and when the legacy profile cannot be version 1 itself, the merged result is stored as
 * version 1 (`SaveProfileOptions.startFromCaller`). When it can, it is version 1 (source `backfill`) as always, and the
 * patch is version 2.
 *
 * **A patch that changes nothing is not a write.** It answers with the profile as it is: no version, no history row,
 * no audit entry (`changed` is empty). A retried request does not make a second version.
 */
import { isDeepStrictEqual } from 'node:util';
import { pool } from '../../config/db.js';
import { type Exec, lockTenantSettings, withTransaction } from '../studio/common.js';
import { clearProfileCache } from './cache.js';
import { invalidProfile, loadLegacyProfile, loadProfile, lockStoredProfile, newerSchemaError, ProfileError, saveProfile, versionConflict } from './store.js';
import { PROFILE_SECTIONS, type CreatorProfile } from './types.js';
import { activationMissing, validateProfile } from './validate.js';

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * How deep a patch may nest. The deepest thing a profile holds is `offers[].campaign.keywords[]`, five levels down
 * from the patch's own object; this leaves room and stops a body built to overflow the stack.
 */
export const MAX_PATCH_DEPTH = 8;

/** Does `value` hold an object or list nested `MAX_PATCH_DEPTH` deep? It never descends further than that, so it cannot itself overflow. */
export function nestedTooDeep(value: unknown, depth = 0): boolean {
    if (typeof value !== 'object' || value === null) return false;
    if (depth >= MAX_PATCH_DEPTH) return true;
    return Object.values(value).some((v) => nestedTooDeep(v, depth + 1));
}

/** The path of an object that is keyed by name, where `null` takes the entry away (see the top of the file). */
const isKeyedMap = (path: string): boolean => path === 'language.surfaces' || path === 'socials.links' || /^language\.surfaces\.[^.]+$/.test(path);

/** Fields that are absent, not null, when they have no value: a `null` for one takes it away. */
const REMOVABLE: ReadonlySet<string> = new Set(['audience.timezone']);

/**
 * `patch` merged into `current`, as the top of the file describes. Neither argument is changed, and what comes back
 * shares nothing with the patch. The result is built from entries, never by assigning to a key, so a patch key
 * named `__proto__` becomes an ordinary key, which the validator then refuses as unknown, instead of changing a prototype.
 * It recurses only where `current` has an object too, so its depth is the profile's, never the patch's.
 */
export function mergePatch(current: unknown, patch: unknown, path = ''): unknown {
    if (!isObj(current) || !isObj(patch)) return structuredClone(patch);
    const entries = new Map<string, unknown>(Object.entries(structuredClone(current)));
    for (const [key, value] of Object.entries(patch)) {
        const at = path ? `${path}.${key}` : key;
        if (value === null && (isKeyedMap(path) || REMOVABLE.has(at))) entries.delete(key);
        else entries.set(key, mergePatch(entries.get(key), value, at));
    }
    return Object.fromEntries(entries);
}

/**
 * The top-level sections (`identity`, `offers`…) in which `after` differs from `before`: the profile's own sections in
 * their order, then any other key either has (an unknown section a patch invented). Names only, never values, which
 * is what the audit trail records.
 */
export function changedSections(before: object, after: object): string[] {
    const a = before as Loose;
    const b = after as Loose;
    const known: readonly string[] = PROFILE_SECTIONS;
    const others = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !known.includes(k)).sort();
    return [...known, ...others].filter((key) => !isDeepStrictEqual(a[key], b[key]));
}

/** What `GET` and `PATCH /api/profile` answer. */
export interface ProfileState {
    profile: CreatorProfile;
    /** The stored version, or null for the virtual profile of a tenant that has none. A patch must send it back. */
    version: number | null;
    stored: boolean;
    /** What is still missing before the wizard can finish (`activationMissing`). */
    activationMissing: string[];
}

export interface PatchOutcome extends ProfileState {
    /** The top-level sections the patch changed: empty when it changed nothing and so wrote nothing. */
    changed: string[];
}

/** The profile as `GET /api/profile` answers it. */
export async function readProfileState(creatorId: string, exec: Exec = pool): Promise<ProfileState> {
    const { profile, version } = await loadProfile(creatorId, exec);
    return { profile, version, stored: version !== null, activationMissing: activationMissing(profile) };
}

/** A request that is not the shape `{ version, patch }`: a 400 with the one problem. */
const badRequest = (message: string): ProfileError => new ProfileError('PROFILE_INVALID', 400, message, { problems: [message] });

/** The profile as a patch finds it: the stored one, or the virtual one (`version: null`). */
interface Found {
    profile: CreatorProfile;
    version: number | null;
    newerSchema: boolean;
}

type Plan = { noop: true } | { noop: false; profile: CreatorProfile; changed: string[] };

/**
 * What `patch` makes of `found`, or why it cannot: a newer-schema profile (409), a version that is not `found`'s (409), a
 * merge that is not a valid profile (400, every problem), or nothing at all. The merged result is what is validated, so
 * a patch can repair a profile whose legacy rows are not valid on their own. Pure: it is made once without the lock
 * (to refuse early) and once under it (to decide).
 */
function plan(found: Found, version: number | null, patch: Loose): Plan {
    // A profile this release cannot fully read takes no write: it would delete what the newer release stored.
    if (found.newerSchema) throw newerSchemaError(found.version ?? 0);
    if (found.version !== version) throw versionConflict(found.version);
    const merged = mergePatch(found.profile, patch) as Loose;
    const changed = changedSections(found.profile, merged);
    if (changed.length === 0) return { noop: true };
    const checked = validateProfile(merged);
    if ('problems' in checked) throw invalidProfile(checked.problems);
    return { noop: false, profile: checked.profile, changed };
}

const unchanged = (found: Found): PatchOutcome => ({
    profile: found.profile, version: found.version, stored: found.version !== null, activationMissing: activationMissing(found.profile), changed: [],
});

/**
 * Apply `body` (`{ version, patch }`) to the tenant's profile. `actor.userId` is who is writing: the profile version
 * records it as `updated_by`. Throws `ProfileError` for every refusal (`PROFILE_INVALID` 400, `PROFILE_VERSION_CONFLICT`
 * and `PROFILE_NEWER_SCHEMA` 409, `PROFILE_STORAGE_MISSING` 503); the route answers each as it is.
 *
 * Always on the pool: the write is its own transaction (see the top of the file for why the second read is in it).
 */
export async function patchProfile(creatorId: string, body: unknown, actor: { userId: string | null }): Promise<PatchOutcome> {
    if (!isObj(body)) throw badRequest('Send { "version": …, "patch": { … } }.');
    const { version, patch } = body;
    if (version === undefined) {
        throw badRequest('version is required: send the version GET /api/profile returned, or null when it returned no stored profile.');
    }
    if (version !== null && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) {
        throw badRequest('version must be the whole number GET /api/profile returned, or null when it returned no stored profile.');
    }
    if (!isObj(patch) || Object.keys(patch).length === 0) {
        throw badRequest('patch must be an object with the fields to change, e.g. { "identity": { "niche": "…" } }.');
    }
    if (nestedTooDeep(patch)) throw badRequest(`patch is nested too deeply: a profile has no field more than ${MAX_PATCH_DEPTH} levels down.`);

    // Without the lock: everything that refuses, or that has nothing to write, is decided here.
    const early = await loadProfile(creatorId, pool);
    if (plan(early, version, patch).noop) return unchanged(early);

    // With it: the mutex first, then the profile (or, for a tenant with none, the legacy rows) read again, so the merge is
    // of what is there now and nothing can change it until the commit. `lockStoredProfile` rather than `loadProfile`: a
    // database without v33 must be the 503 here, and a failed read would abort the transaction.
    type Done = { kind: 'unchanged'; found: Found } | { kind: 'saved'; saved: Awaited<ReturnType<typeof saveProfile>>; changed: string[] };
    const done = await withTransaction<Done>(async (tx) => {
        await lockTenantSettings(tx, creatorId);
        const locked = await lockStoredProfile(creatorId, tx);
        const found: Found = locked ?? { profile: await loadLegacyProfile(creatorId, tx), version: null, newerSchema: false };
        const again = plan(found, version, patch);
        if (again.noop) return { kind: 'unchanged', found };
        const saved = await saveProfile(creatorId, again.profile, { expectVersion: version, source: 'user', userId: actor.userId, startFromCaller: true }, tx);
        return { kind: 'saved', saved, changed: again.changed };
    }).finally(() => clearProfileCache(creatorId));

    if (done.kind === 'unchanged') return unchanged(done.found);
    return { profile: done.saved.profile, version: done.saved.version, stored: true, activationMissing: activationMissing(done.saved.profile), changed: done.changed };
}
