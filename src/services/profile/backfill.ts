/**
 * Backfilling the Creator Profile (docs/onboarding/01 §3, 05 §4): what `scripts/backfill-creator-profiles.mts` does,
 * with every decision in a pure function so a test can run it with no database.
 *
 *   assessTenant   one tenant's LIVE rows: is `profileFromLegacy` of them a valid profile, do both lens laws hold
 *                  against them (and against the profile as it will be READ BACK from storage), and does the profile
 *                  survive being stored? Nothing is written, nothing is printed but paths, lengths and counts.
 *   decideApply    apply, skip or refuse, from an assessment. A tenant that did not pass is refused.
 *   applyBackfill  the write loop's gate: a tenant is written only if its assessment, made in this run, says apply.
 *   backfillTenant the write: one transaction, `INSERT … ON CONFLICT (creator_id) DO NOTHING` and a version-1 history
 *                  row (source `backfill`), the statements `saveProfile`'s step 0 sends. It waits at most 5 s for the
 *                  tenant's lock (`SET LOCAL lock_timeout`, as migration v33 does: a script that queued behind a slow
 *                  settings write would hold the tenant's mutex and everything behind it). It reads the rows again under
 *                  the lock and assesses them again, so the guard is on the data it writes and not on what a dry run saw
 *                  a minute ago.
 *
 * It never mirrors into `studio_settings` / `growth_settings`: the profile it stores is the view those rows already
 * describe (that is what the lens laws checked), so there is nothing to write back. `activated_at` stays NULL.
 *
 * Nothing on a request path imports this.
 */
import { isDeepStrictEqual } from 'node:util';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { clearProfileCache } from './cache.js';
import { readGrowthSettings } from '../growth/settingsRow.js';
import { type Exec, lockTenantSettings, withTransaction } from '../studio/common.js';
import { readStudioSettings } from '../studio/settingsMerge.js';
import { upgradeProfile } from './defaults.js';
import { describeFailure } from './failure.js';
import { scramble, throughJsonb } from './jsonb.js';
import { profileFromLegacy } from './legacy.js';
import { loadStoredProfile } from './store.js';
import type { CreatorProfile } from './types.js';
import { profileBytes, validateProfile } from './validate.js';
import { GROWTH_PROFILE_PATHS, growthView, intoProfile, STUDIO_PROFILE_PATHS, studioView } from './views.js';

// ─── Comparing without printing ─────────────────────────────────────────────────────────────

type Loose = Record<string, unknown>;
const isObj = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How many differences one law reports: enough to find the field, short enough to read. */
const MAX_DIFFS = 12;

/** What kind of value this is, for a message that must not show it. */
const kindOf = (v: unknown): string => (Array.isArray(v) ? 'list' : v === null ? 'null' : typeof v);

/**
 * Where `actual` is not `expected`, as paths, kinds and lengths: never a value, because a live row holds the
 * tenant's guide, links and names. `voice.avoid: list of 2, expected 3` and `product.name: text of 41 characters,
 * expected 38` are enough to find the field; the row itself is one query away for the person who is allowed to see it.
 */
export function diffPaths(expected: unknown, actual: unknown, at = '', out: string[] = []): string[] {
    if (out.length >= MAX_DIFFS || isDeepStrictEqual(expected, actual)) return out;
    const here = at || '(the whole object)';
    if (Array.isArray(expected) && Array.isArray(actual)) {
        if (expected.length !== actual.length) out.push(`${here}: list of ${actual.length}, expected ${expected.length}`);
        for (let i = 0; i < Math.min(expected.length, actual.length); i++) diffPaths(expected[i], actual[i], `${at}[${i}]`, out);
    } else if (isObj(expected) && isObj(actual)) {
        for (const key of Object.keys(expected)) {
            const path = at ? `${at}.${key}` : key;
            if (!(key in actual)) out.push(`${path}: missing`);
            else diffPaths(expected[key], actual[key], path, out);
        }
        for (const key of Object.keys(actual)) if (!(key in expected)) out.push(`${at ? `${at}.` : ''}${key}: not expected`);
    } else if (kindOf(expected) !== kindOf(actual)) {
        out.push(`${here}: ${kindOf(actual)}, expected ${kindOf(expected)}`);
    } else if (typeof expected === 'string' && typeof actual === 'string') {
        out.push(expected.length === actual.length ? `${here}: text differs (${actual.length} characters, as long as expected)` : `${here}: text of ${actual.length} characters, expected ${expected.length}`);
    } else {
        out.push(`${here}: ${kindOf(actual)} differs`);
    }
    return out.slice(0, MAX_DIFFS);
}

/** The first object whose keys are in another order. `deepStrictEqual` does not see order; the prompts print some of these objects as JSON. */
function orderDiffs(expected: unknown, actual: unknown, at = '', out: string[] = []): string[] {
    if (out.length >= MAX_DIFFS) return out;
    if (Array.isArray(expected) && Array.isArray(actual)) {
        expected.forEach((e, i) => orderDiffs(e, actual[i], `${at}[${i}]`, out));
    } else if (isObj(expected) && isObj(actual)) {
        if (!isDeepStrictEqual(Object.keys(expected), Object.keys(actual))) out.push(`${at || '(the whole object)'}: keys are in another order`);
        else for (const key of Object.keys(expected)) orderDiffs(expected[key], actual[key], at ? `${at}.${key}` : key, out);
    }
    return out;
}

/** `actual` is `expected`, key order included. Empty when it is. */
export function differences(expected: unknown, actual: unknown): string[] {
    const diffs = diffPaths(expected, actual);
    if (diffs.length > 0) return diffs;
    // Equal as values; the same bytes only if the keys come in the same order too.
    return JSON.stringify(expected) === JSON.stringify(actual) ? [] : orderDiffs(expected, actual);
}

// ─── Assessing a tenant ─────────────────────────────────────────────────────────────────────

/** What a read of one tenant's rows found. The settings are the merged rows the app itself sees. */
export interface TenantInput {
    id: string;
    /** The tenant's display name, for the report. */
    label: string;
    active: boolean;
    studio: StudioSettings;
    growth: GrowthSettings;
    /** Whether the row exists: a tenant with none is read as the defaults, which says nothing about who it is. */
    rows: { studio: boolean; growth: boolean };
    /** The stored profile, if there is one: its version, what reading it had to repair, whether a newer release wrote it. */
    stored: { version: number; repaired: string[]; newerSchema: boolean } | null;
}

/** A law that does not hold for a tenant's rows, and where. */
export interface LensFinding {
    law: LawName;
    diffs: string[];
}

export const LAWS = ['studio view', 'growth view', 'profile round trip', 'storage'] as const;
export type LawName = (typeof LAWS)[number];

export interface TenantAssessment {
    id: string;
    label: string;
    active: boolean;
    rows: TenantInput['rows'];
    stored: TenantInput['stored'];
    /** Why the profile these rows describe is not a valid one, and anything the stored profile needed repaired. Paths and rules, never values. */
    problems: string[];
    /** The laws that do not hold. Empty when they all do. */
    lens: LensFinding[];
    /** The size of the profile the rows describe, in the bytes the table's CHECK measures. */
    bytes: number | null;
    /** No problems and every law holds. */
    ok: boolean;
    /** The validated profile that would be stored: present only when the rows describe a valid one. */
    profile: CreatorProfile | null;
}

/**
 * One tenant's live rows against the two lens laws (views.test.ts holds them on the fixtures; this holds them on
 * what is actually in the database) and the validator. The profile is `profileFromLegacy` of the rows, the one a
 * tenant with no stored profile is read as, and the one the backfill would store:
 *
 *   studio view          studioView(scramble(studio), p) ≡ studio    every owned field comes from the profile, none from the row
 *   growth view          growthView(scramble(growth), p) ≡ growth
 *                        Both are held a second time against `upgradeProfile(throughJsonb(p))`, the profile as it is READ BACK
 *                        once stored (keys reordered as jsonb does, read through the upgrade): that is the profile P4's readers
 *                        will lay over the rows, so a dry run that passes predicts parity after `--apply`. Reported as `as stored:`.
 *   profile round trip   intoProfile(p, studioView(studio, p), growthView(growth, p)) ≡ p
 *   storage              p survives the trip a stored profile makes (serialised, its keys reordered as jsonb does, read
 *                        through upgradeProfile) with nothing repaired
 *
 * A law that throws (a live row of a shape the code never saw) is a finding too, not a crash that hides the other
 * tenants.
 */
export function assessTenant(input: TenantInput): TenantAssessment {
    const { id, label, active, rows, stored, studio, growth } = input;
    const problems: string[] = [];
    const lens: LensFinding[] = [];
    let bytes: number | null = null;
    let profile: CreatorProfile | null = null;

    if (stored?.newerSchema) problems.push('the stored profile was written by a newer release');
    for (const path of stored?.repaired ?? []) problems.push(`the stored profile needed repair at ${path}`);

    let described: CreatorProfile | null = null;
    try {
        described = profileFromLegacy(studio, growth);
    } catch (err) {
        problems.push(`profileFromLegacy failed: ${describeFailure(err)}`);
    }

    if (described) {
        const p = described;
        const check = (law: LawName, run: () => string[]): void => {
            try {
                const diffs = run();
                if (diffs.length > 0) lens.push({ law, diffs });
            } catch (err) {
                lens.push({ law, diffs: [`threw ${describeFailure(err)}`] });
            }
        };
        /** The view law for one row: against the profile as built, and then, if that holds, against the profile as read back from storage. */
        const viewLaw = <T extends object>(row: T, paths: readonly string[], view: (stale: T, profile: CreatorProfile) => T): string[] => {
            const stale = scramble(row, paths);
            const direct = differences(row, view(stale, p));
            if (direct.length > 0) return direct;
            return differences(row, view(stale, upgradeProfile(throughJsonb(p)).profile)).map((d) => `as stored: ${d}`);
        };
        check('studio view', () => viewLaw(studio, STUDIO_PROFILE_PATHS, studioView));
        check('growth view', () => viewLaw(growth, GROWTH_PROFILE_PATHS, growthView));
        check('profile round trip', () => differences(p, intoProfile(p, studioView(studio, p), growthView(growth, p))));
        check('storage', () => {
            const back = upgradeProfile(throughJsonb(p));
            return [...back.repaired.map((path) => `${path}: repaired on the way back`), ...(back.newerSchema ? ['read as a newer schema'] : []), ...diffPaths(p, back.profile)];
        });

        const checked = validateProfile(p);
        if ('problems' in checked) problems.push(...checked.problems);
        else profile = checked.profile;
        try {
            bytes = profileBytes(p);
        } catch {
            bytes = null;
        }
    }

    return { id, label, active, rows, stored, problems, lens, bytes, ok: problems.length === 0 && lens.length === 0, profile };
}

// ─── Deciding ───────────────────────────────────────────────────────────────────────────────

export type ApplyDecision = { action: 'apply' } | { action: 'skip'; reason: string } | { action: 'refuse'; reason: string };

/**
 * What `--apply` does with a tenant. A stored profile is left alone (the backfill never overwrites one). A tenant with
 * no `studio_settings` row is left virtual: there is nothing to describe, and a profile stored now would freeze the
 * legacy assumptions (`legacy.ts`) onto a tenant that never had them; a new tenant is given the neutral default at
 * creation instead (P16). Anything that did not pass the dry run is refused.
 */
export function decideApply(a: TenantAssessment): ApplyDecision {
    if (a.stored) return { action: 'skip', reason: `a profile is already stored (version ${a.stored.version})` };
    if (!a.rows.studio) return { action: 'skip', reason: 'no studio_settings row: left virtual' };
    if (!a.ok) {
        const parts = [a.problems.length ? `${a.problems.length} invalid` : '', a.lens.length ? `${a.lens.length} lens law${a.lens.length === 1 ? '' : 's'} broken` : ''].filter(Boolean);
        return { action: 'refuse', reason: `the dry run does not pass (${parts.join(', ')})` };
    }
    return { action: 'apply' };
}

// ─── Reading the tenants ────────────────────────────────────────────────────────────────────

interface TenantListRow { id: string; name: string | null; is_active: boolean | null; has_studio: boolean; has_growth: boolean }

/**
 * Every tenant (or the one named), with its Studio and Growth rows read as the app reads them and its stored profile.
 * `exec` is the read-only connection: this only SELECTs. A tenant's token and secrets are never selected.
 */
export async function readTenants(exec: Exec, only?: string): Promise<TenantInput[]> {
    const { rows } = await exec.query<TenantListRow>(
        `SELECT c.id, c.name, c.is_active, (s.creator_id IS NOT NULL) AS has_studio, (g.creator_id IS NOT NULL) AS has_growth
           FROM creators c
           LEFT JOIN studio_settings s ON s.creator_id = c.id
           LEFT JOIN growth_settings g ON g.creator_id = c.id
          ${only ? 'WHERE c.id = $1' : ''}
          ORDER BY c.created_at, c.id`,
        only ? [only] : []
    );
    const tenants: TenantInput[] = [];
    for (const row of rows) {
        const stored = await loadStoredProfile(row.id, exec);
        tenants.push({
            id: row.id,
            label: row.name ?? '',
            active: row.is_active !== false,
            studio: await readStudioSettings(exec, row.id),
            growth: await readGrowthSettings(exec, row.id),
            rows: { studio: row.has_studio, growth: row.has_growth },
            stored: stored ? { version: stored.version, repaired: stored.repaired, newerSchema: stored.newerSchema } : null,
        });
    }
    return tenants;
}

// ─── Writing ────────────────────────────────────────────────────────────────────────────────

/** Thrown inside the transaction, so a tenant that does not pass leaves nothing behind. */
class BackfillRefused extends Error {
    constructor(message: string, readonly assessment: TenantAssessment) {
        super(message);
        this.name = 'BackfillRefused';
    }
}

export type BackfillOutcome =
    | { id: string; status: 'created'; version: 1 }
    | { id: string; status: 'exists'; version: number }
    | { id: string; status: 'skipped' | 'refused'; reason: string; assessment: TenantAssessment };

const json = (value: unknown): string => JSON.stringify(value);

/**
 * Store version 1 for a tenant that has no profile yet, in one transaction on the pool; a no-op for one that has.
 * The lock is `saveProfile`'s, taken first, and the rows are read `FOR UPDATE` under it, so neither a settings write nor
 * a first save can slip in between the check and the insert (the order everywhere: creators, creator_profiles,
 * studio_settings, growth_settings). The assessment is made again on those rows: `refused` writes nothing.
 */
export async function backfillTenant(creatorId: string): Promise<BackfillOutcome> {
    try {
        return await withTransaction((tx) => backfillIn(creatorId, tx));
    } catch (err) {
        if (err instanceof BackfillRefused) return { id: creatorId, status: 'refused', reason: err.message, assessment: err.assessment };
        throw err;
    } finally {
        clearProfileCache(creatorId);
    }
}

async function backfillIn(creatorId: string, tx: Exec): Promise<BackfillOutcome> {
    // First, before any lock: `SET LOCAL` ends with the transaction, so nothing outlives it on a pooled connection. Without
    // a bound, a settings write that is slow to finish would leave this transaction holding the tenant's mutex while it waits
    // on the next lock, and every other writer for the tenant queues behind both. A timeout is an error for this tenant, not a hang.
    await tx.query("SET LOCAL lock_timeout = '5s'");
    await lockTenantSettings(tx, creatorId);

    const existing = await tx.query<{ version: number }>('SELECT profile, version FROM creator_profiles WHERE creator_id = $1 FOR UPDATE', [creatorId]);
    if (existing.rows[0]) return { id: creatorId, status: 'exists', version: existing.rows[0].version };

    const studio = await readStudioSettings(tx, creatorId, true);
    const growth = await readGrowthSettings(tx, creatorId, true);
    const present = await tx.query<{ studio: boolean; growth: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM studio_settings WHERE creator_id = $1) AS studio,
                EXISTS (SELECT 1 FROM growth_settings WHERE creator_id = $1) AS growth`,
        [creatorId]
    );
    const assessment = assessTenant({
        id: creatorId, label: '', active: true, studio, growth,
        rows: { studio: present.rows[0]?.studio ?? false, growth: present.rows[0]?.growth ?? false }, stored: null,
    });

    const decision = decideApply(assessment);
    if (decision.action === 'skip') return { id: creatorId, status: 'skipped', reason: decision.reason, assessment };
    if (decision.action === 'refuse') throw new BackfillRefused(decision.reason, assessment);
    // `ok` means the rows describe a valid profile, so there is one; this is for the compiler, and for a decision that changes.
    if (!assessment.profile) throw new BackfillRefused('the rows describe no valid profile', assessment);

    // The same two statements `saveProfile`'s step 0 sends: the row (never over one that exists), and its history.
    const inserted = await tx.query<{ version: number }>(
        `INSERT INTO creator_profiles (creator_id, profile, version, updated_by, updated_at)
         VALUES ($1, $2::jsonb, 1, NULL, NOW())
         ON CONFLICT (creator_id) DO NOTHING
         RETURNING version`,
        [creatorId, json(assessment.profile)]
    );
    if (!inserted.rows[0]) return { id: creatorId, status: 'exists', version: 1 };
    await tx.query(
        `INSERT INTO creator_profile_versions (creator_id, version, profile, source, updated_by, created_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW())`,
        [creatorId, 1, json(assessment.profile), 'backfill', null]
    );
    return { id: creatorId, status: 'created', version: 1 };
}

/**
 * The write loop. The gate is here and not in the script: a tenant is written only when `decideApply` says so of the
 * assessment made for it in THIS run (so one that did not pass the dry run is refused, one with a profile or no settings row
 * is skipped, and a tenant that was never assessed cannot be written at all), and `write` is called for no other. A write that
 * throws (a lock timeout, a dropped connection) is that tenant's `error`, and the loop goes on: the report says which,
 * and `hasProblems` makes the run exit 1. `onOutcome` is told each as it happens, for progress.
 *
 * `write` is `backfillTenant`, which assesses the rows again under the tenant's lock; the tests hand in their own.
 */
export async function applyBackfill(
    assessments: readonly TenantAssessment[],
    write: (creatorId: string) => Promise<BackfillOutcome> = backfillTenant,
    onOutcome: (outcome: AppliedOutcome) => void = () => {}
): Promise<AppliedOutcome[]> {
    const outcomes: AppliedOutcome[] = [];
    for (const a of assessments) {
        const decision = decideApply(a);
        let outcome: AppliedOutcome;
        if (decision.action === 'apply') {
            try {
                outcome = await write(a.id);
            } catch (err) {
                outcome = { id: a.id, status: 'error', reason: describeFailure(err) };
            }
        } else {
            outcome = { id: a.id, status: decision.action === 'skip' ? 'skipped' : 'refused', reason: decision.reason, assessment: a };
        }
        outcomes.push(outcome);
        onOutcome(outcome);
    }
    return outcomes;
}

// ─── The report ─────────────────────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What `--apply` did, by tenant, for the report. */
export type AppliedOutcome = BackfillOutcome | { id: string; status: 'error'; reason: string };

export interface ReportOptions {
    mode: 'dry-run' | 'apply';
    /** `host/database`, no credentials. */
    target: string;
    outcomes?: readonly AppliedOutcome[];
}

/**
 * The report: one block per tenant, then a summary line. Only ids, names, paths, counts and lengths. A line that
 * could carry a value (a validator message names a rule and a length, never the field's content) is the validator's
 * own, and is printed as it says it.
 */
export function formatBackfillReport(assessments: readonly TenantAssessment[], { mode, target, outcomes = [] }: ReportOptions): string {
    const lines: string[] = [`profile backfill (${mode}) · ${target} · ${plural(assessments.length, 'tenant')}`, ''];
    const outcomeOf = (id: string): AppliedOutcome | undefined => outcomes.find((o) => o.id === id);

    for (const a of assessments) {
        lines.push(`tenant ${a.id}${a.label ? ` "${a.label.slice(0, 40)}"` : ''}${a.active ? '' : ' (inactive)'}`);
        lines.push(`  rows       studio_settings ${a.rows.studio ? 'yes' : 'NO (read as the defaults)'} · growth_settings ${a.rows.growth ? 'yes' : 'NO (read as the defaults)'}`);
        lines.push(`  profile    ${a.stored ? `stored, version ${a.stored.version}` : 'none stored'}`);
        lines.push(`  valid      ${a.problems.length === 0 ? `yes${a.bytes === null ? '' : ` (${a.bytes} bytes)`}` : `NO (${plural(a.problems.length, 'problem')})`}`);
        const broken = new Set(a.lens.map((f) => f.law));
        lines.push(`  lens laws  ${LAWS.map((law) => `${law} ${broken.has(law) ? 'BROKEN' : 'ok'}`).join(' · ')}`);
        for (const problem of a.problems) lines.push(`  problem    ${problem}`);
        for (const finding of a.lens) for (const diff of finding.diffs) lines.push(`  lens       ${finding.law}: ${diff}`);
        const decision = decideApply(a);
        const outcome = outcomeOf(a.id);
        let result: string;
        if (outcome) {
            result = outcome.status === 'created' ? 'CREATED version 1 (source backfill)'
                : outcome.status === 'exists' ? `left alone: a profile exists (version ${outcome.version})`
                : outcome.status === 'skipped' ? `skipped: ${outcome.reason}`
                : outcome.status === 'refused' ? `REFUSED: ${outcome.reason}`
                : `ERROR: ${outcome.reason}`;
        } else if (decision.action === 'apply') result = 'would insert version 1 (source backfill)';
        else result = decision.action === 'skip' ? `would skip: ${decision.reason}` : `would REFUSE: ${decision.reason}`;
        lines.push(`  result     ${a.ok ? 'ok' : 'PROBLEMS'} · ${result}`, '');
    }

    const ok = assessments.filter((a) => a.ok).length;
    const stored = assessments.filter((a) => a.stored).length;
    const created = outcomes.filter((o) => o.status === 'created').length;
    const refused = outcomes.filter((o) => o.status === 'refused' || o.status === 'error').length;
    lines.push([
        `summary: ${plural(assessments.length, 'tenant')} · ${ok} ok · ${assessments.length - ok} with problems · ${stored} already stored`,
        ...(mode === 'apply' ? [`${created} created`, `${refused} refused or failed`] : [`${assessments.filter((a) => decideApply(a).action === 'apply').length} would be written`]),
    ].join(' · '));
    return lines.join('\n');
}

/** Whether the run should exit non-zero: any tenant with a problem, and under `--apply` any that was refused or failed. */
export function hasProblems(assessments: readonly TenantAssessment[], outcomes: readonly AppliedOutcome[] = []): boolean {
    return assessments.some((a) => !a.ok) || outcomes.some((o) => o.status === 'refused' || o.status === 'error');
}
