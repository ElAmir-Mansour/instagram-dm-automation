/**
 * Test support for the profile store and the settings writers that share its locks: a small in-memory stand-in for the
 * tables they touch. Imported by tests only; production code never reads it.
 *
 * It is deliberately a little more than a recorder: it applies the statements the code sends (`INSERT … ON CONFLICT`,
 * the optimistic `UPDATE … WHERE version`, the upserts with their `SET` lists), and a `BEGIN` takes a snapshot that a
 * `ROLLBACK` restores. So "a refused save leaves nothing behind" and "the mirror never touches a column it does not
 * own" are asserted on the rows, not on the SQL text. Every statement is recorded in order (`db.statements`), which is
 * how the lock order is asserted.
 */
import assert from 'node:assert/strict';
import { pool } from '../../config/db.js';
import type { GrowthSettings, StudioSettings } from '../../db/rows.js';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import { ELAMIR_GROWTH, ELAMIR_SEED_SETTINGS } from '../studio/testFixtures.js';
import { invalidateTenantCache } from '../tenant.js';
import { throughJsonb } from './testSupport.js';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const USER = '33333333-3333-4333-8333-333333333333';

// ─── The stand-in ────────────────────────────────────────────────────────────────────────────

export type Row = Record<string, unknown>;

export interface State {
    profiles: Map<string, { profile: unknown; version: number; activated_at: Date | null; updated_by: string | null }>;
    versions: { creator_id: string; version: number; profile: unknown; source: string; updated_by: string | null }[];
    studio: Map<string, Row>;
    growth: Map<string, Row>;
}

export const STUDIO_COLUMNS = ['brand', 'voice', 'product', 'cta', 'schedule', 'library', 'examples', 'monteur', 'infographic'] as const;
export const GROWTH_COLUMNS = ['keywords', 'hashtag_sets', 'competitors', 'audience', 'goal_followers', 'goal_views'] as const;

export const missingTable = (name: string): Error => Object.assign(new Error(`relation "${name}" does not exist`), { code: '42P01' });

/**
 * Every statement the store sends, answered from `state`. `v33` false is a database without the migration; `failOn`
 * makes a matching statement throw, as the database would, so a test can break a save halfway through.
 */
export interface ProfileDb extends FakeDb {
    /** A statement matching this throws, as the database would: `failWith`, or a plain error. */
    failOn: RegExp | null;
    failWith: Error | null;
    snapshot: State | null;
    /** False is a database without migration v33. */
    v33: boolean;
    /** Runs just before the step-0 insert into creator_profiles: another save's commit, landing in the gap. */
    beforeProfileInsert: (() => void) | null;
    /** Runs before each statement, with its whitespace-collapsed SQL: a write from another connection, landing between two of ours. */
    onStatement: ((sql: string) => void | Promise<void>) | null;
}

/** The statement `getPlatformOwnerId` runs: the owner, the first creator ever made (tenant.ts). */
export const PLATFORM_OWNER_SQL = /^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/;

/**
 * Tells the stand-in who the platform owner is: an id, `null` (no creators at all) or an error (the lookup itself fails).
 * The lookup is cached in the process for 30 s, so the cache is cleared on the way in, and again when the stand-in is put back.
 */
export function setPlatformOwner(db: ProfileDb, owner: string | null | Error): void {
    invalidateTenantCache();
    db.routes = db.routes.filter(([pattern]) => pattern !== PLATFORM_OWNER_SQL);
    db.routes.unshift([PLATFORM_OWNER_SQL, () => {
        if (owner instanceof Error) throw owner;
        return { rows: owner === null ? [] : [{ id: owner }] };
    }]);
    const restore = db.restore;
    db.restore = () => { restore(); invalidateTenantCache(); };
}

export function installProfileDb(state: State, options: { v33?: boolean } = {}): ProfileDb {
    const db = installFakeDb() as ProfileDb;
    db.failOn = null;
    db.failWith = null;
    db.snapshot = null;
    db.v33 = options.v33 ?? true;
    db.beforeProfileInsert = null;
    db.onStatement = null;

    const copy = (s: State): State => structuredClone(s);
    const restore = (from: State): void => {
        state.profiles = from.profiles;
        state.versions = from.versions;
        state.studio = from.studio;
        state.growth = from.growth;
    };
    /** What `pg` hands back for a jsonb column: parsed, with its keys in Postgres's order. */
    const jsonb = <T>(value: T): T => throughJsonb(value);

    const entries = (list: string): string[] => list.split(',').map((s) => s.trim()).filter(Boolean);

    /** `INSERT INTO t (cols) VALUES (…) ON CONFLICT (creator_id) DO UPDATE SET …`, applied to `table`. */
    const upsert = (table: Map<string, Row>, sql: string, params: unknown[]): Row[] => {
        const columns = entries(/INSERT INTO \w+ \(([^)]*)\)/.exec(sql)![1]!);
        const tuple = entries(/VALUES \((.*)\) ON CONFLICT/.exec(sql)![1]!);
        assert.equal(columns.length, tuple.length, 'a value for every column');
        const inserted: Row = {};
        columns.forEach((column, i) => {
            const slot = tuple[i]!;
            const param = /^\$(\d+)(?:::([\w[\]]+))?$/.exec(slot);
            if (!param) inserted[column] = slot === 'NOW()' ? new Date() : slot;
            else if (param[2] === 'jsonb') inserted[column] = JSON.parse(params[Number(param[1]) - 1] as string);
            else inserted[column] = params[Number(param[1]) - 1];
        });
        const id = inserted.creator_id as string;
        const existing = table.get(id);
        if (!existing) {
            table.set(id, inserted);
            return [];
        }
        const set = entries(/DO UPDATE SET (.*)$/.exec(sql)![1]!);
        for (const assignment of set) {
            const [column, value] = assignment.split('=').map((s) => s.trim()) as [string, string];
            existing[column] = value === 'NOW()' ? new Date() : inserted[value.replace('EXCLUDED.', '')];
        }
        return [];
    };

    const route = (pattern: RegExp, answer: (params: any[], sql: string) => { rows: any[]; rowCount?: number }): void => {
        db.routes.push([pattern, answer]);
    };

    // Anything that fails on purpose, and anything that needs a table this database lacks, answers before the routes do.
    const guard = (pool as unknown as { query: (sql: string, params?: any[]) => Promise<unknown> }).query;
    const guarded = async (sql: string, params: any[] = []): Promise<unknown> => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        await db.onStatement?.(flat);
        if (db.failOn?.test(flat)) {
            db.statements.push({ sql: flat, params });
            throw db.failWith ?? new Error(`injected failure on: ${flat.slice(0, 60)}`);
        }
        if (!db.v33 && /creator_profile/.test(flat)) {
            db.statements.push({ sql: flat, params });
            throw missingTable(/creator_profile_versions/.test(flat) ? 'creator_profile_versions' : 'creator_profiles');
        }
        return guard(sql, params);
    };
    (pool as unknown as { query: unknown }).query = guarded;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: guarded, release() {} });

    route(/^BEGIN$/, () => { db.snapshot = copy(state); return { rows: [] }; });
    route(/^COMMIT$/, () => { db.snapshot = null; return { rows: [] }; });
    route(/^ROLLBACK$/, () => { if (db.snapshot) restore(db.snapshot); db.snapshot = null; return { rows: [] }; });

    route(/^SELECT profile, version, activated_at FROM creator_profiles WHERE creator_id = \$1$/, ([id]) => {
        const row = state.profiles.get(id);
        return { rows: row ? [{ profile: jsonb(row.profile), version: row.version, activated_at: row.activated_at }] : [] };
    });
    route(/^SELECT profile, version FROM creator_profiles WHERE creator_id = \$1 FOR UPDATE$/, ([id]) => {
        const row = state.profiles.get(id);
        return { rows: row ? [{ profile: jsonb(row.profile), version: row.version }] : [] };
    });
    // The Monteur's narrow read: only the two values the timezone is read from, as Postgres hands a jsonb value back.
    route(/^SELECT profile->'schema' AS profile_schema, profile->'identity'->'timezone' AS identity_timezone FROM creator_profiles WHERE creator_id = \$1$/, ([id]) => {
        const row = state.profiles.get(id);
        if (!row) return { rows: [] };
        const stored = jsonb(row.profile) as { schema?: unknown; identity?: { timezone?: unknown } } | null;
        return { rows: [{ profile_schema: stored?.schema ?? null, identity_timezone: stored?.identity?.timezone ?? null }] };
    });
    route(/^SELECT id FROM creators WHERE id = \$1 FOR NO KEY UPDATE$/, ([id]) => ({ rows: [{ id }] }));
    route(/^INSERT INTO creator_profiles .* ON CONFLICT \(creator_id\) DO NOTHING RETURNING version$/, ([id, profile, by]) => {
        db.beforeProfileInsert?.();
        if (state.profiles.has(id)) return { rows: [] };
        // `updated_by` is the third parameter: null for the backfill baseline, the caller for a profile that is version 1 itself.
        state.profiles.set(id, { profile: JSON.parse(profile), version: 1, activated_at: null, updated_by: by ?? null });
        return { rows: [{ version: 1 }] };
    });
    route(/^UPDATE creator_profiles SET profile = \$2::jsonb, version = version \+ 1, updated_by = \$3, updated_at = NOW\(\) WHERE creator_id = \$1 AND version = \$4 RETURNING version$/, ([id, profile, by, expect]) => {
        const row = state.profiles.get(id);
        if (!row || row.version !== expect) return { rows: [] };
        row.profile = JSON.parse(profile);
        row.version += 1;
        row.updated_by = by;
        return { rows: [{ version: row.version }] };
    });
    route(/^INSERT INTO creator_profile_versions /, ([id, version, profile, source, by]) => {
        if (state.versions.some((v) => v.creator_id === id && v.version === version)) {
            throw Object.assign(new Error('duplicate key value violates unique constraint "creator_profile_versions_pkey"'), { code: '23505' });
        }
        state.versions.push({ creator_id: id, version, profile: JSON.parse(profile), source, updated_by: by });
        return { rows: [] };
    });

    route(/^SELECT brand, voice, product, cta, schedule, library, examples, monteur, infographic FROM studio_settings WHERE creator_id = \$1( FOR UPDATE)?$/, ([id]) => {
        const row = state.studio.get(id);
        return { rows: row ? [Object.fromEntries(STUDIO_COLUMNS.map((c) => [c, jsonb(row[c] ?? null)]))] : [] };
    });
    route(/^SELECT monteur, schedule FROM studio_settings WHERE creator_id = \$1$/, ([id]) => {
        const row = state.studio.get(id);
        return { rows: row ? [{ monteur: jsonb(row.monteur ?? null), schedule: jsonb(row.schedule ?? null) }] : [] };
    });
    route(/^SELECT keywords, hashtag_sets, competitors, audience, goal_followers, goal_views FROM growth_settings WHERE creator_id = \$1( FOR UPDATE)?$/, ([id]) => {
        const row = state.growth.get(id);
        // BIGINT arrives as a string, as `pg` returns it.
        return { rows: row ? [{ ...Object.fromEntries(GROWTH_COLUMNS.map((c) => [c, jsonb(row[c] ?? null)])), goal_views: String(row.goal_views) }] : [] };
    });
    // A lock and nothing else: the Growth writer takes the Studio row before the Growth row (the global order).
    route(/^SELECT creator_id FROM studio_settings WHERE creator_id = \$1 FOR UPDATE$/, ([id]) => ({ rows: state.studio.has(id) ? [{ creator_id: id }] : [] }));
    route(/^INSERT INTO studio_settings /, (params, sql) => ({ rows: upsert(state.studio, sql, params) }));
    route(/^INSERT INTO growth_settings /, (params, sql) => ({ rows: upsert(state.growth, sql, params) }));

    return db;
}

export const emptyState = (): State => ({ profiles: new Map(), versions: [], studio: new Map(), growth: new Map() });

/** A tenant's stored settings rows as Postgres holds them: one JSON column per section. */
export function studioRow(settings: StudioSettings): Row {
    return Object.fromEntries(STUDIO_COLUMNS.map((c) => [c, structuredClone(settings[c])]));
}
export function growthRow(settings: GrowthSettings): Row {
    return Object.fromEntries(GROWTH_COLUMNS.map((c) => [c, structuredClone(settings[c])]));
}

/** The owner's tenant: an Arabic row set LEFT to right, which the profile must not undo. */
export const OWNER_STUDIO: StudioSettings = {
    ...ELAMIR_SEED_SETTINGS,
    brand: { ...ELAMIR_SEED_SETTINGS.brand, direction: 'ltr' },
    examples: [],
};

export function seededState(): State {
    const state = emptyState();
    state.studio.set(OWNER, studioRow(OWNER_STUDIO));
    state.growth.set(OWNER, growthRow(ELAMIR_GROWTH));
    return state;
}
