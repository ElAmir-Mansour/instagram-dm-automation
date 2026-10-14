/**
 * Tests only: an in-memory stand-in for the three tables the AI layer touches (`app_settings`, `ai_usage`, `audit_log`) and the owner's
 * lookup, installed over `pool.query` and `pool.connect`. Not a test file itself, so `npm test` does not run it.
 *
 * `ai_usage` behaves like Postgres under READ COMMITTED, which is the whole point of this file for the budget tests:
 *
 *   - a statement sees the rows that were committed when it started, never another transaction's pending ones;
 *   - a row a transaction inserts is pending until its COMMIT (and is dropped by its ROLLBACK);
 *   - `pg_advisory_xact_lock` is a real mutex, held until the holder's COMMIT or ROLLBACK.
 *
 * So two calls that each read the spend and then insert, with no lock between, both see the same total and both pass. With the lock the
 * second waits, and reads the first one's committed reservation. Every `query` yields to the event loop first, so racing calls interleave
 * at each statement as they would against a database.
 */
import { pool } from '../../config/db.js';
import { encryptSecret } from '../../config/crypto.js';
import { invalidateTenantCache } from '../tenant.js';

export interface UsageRow {
    id: string;
    creator_id: string | null;
    purpose: string;
    provider: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    /** v36: Anthropic prompt-cache tokens, apart from `input_tokens`. */
    cache_read_tokens: number;
    cache_write_tokens: number;
    usd: number;
    priced: boolean;
    outcome: string;
    elapsed_ms: number | null;
    at: Date;
}

export interface AiDb {
    /** `app_settings`: key to `{value, is_secret}`, `value` encrypted when `is_secret`. */
    settings: Map<string, { value: string; is_secret: boolean }>;
    /** Committed `ai_usage` rows. */
    usage: UsageRow[];
    audits: { actor_user_id: string | null; action: string; target_type: string | null; target_id: string | null; detail: Record<string, unknown> }[];
    /** Every statement, whitespace collapsed, in the order it ran, with the client it ran on (0 is the pool). */
    statements: { sql: string; params: unknown[]; client: number }[];
    /** The owner `getPlatformOwnerId` finds; null: no creators. */
    owner: string | null;
    /** What `ai_usage.at` and "now" are for rows written from here on. */
    now: Date;
    /** Fails the next `times` statements that match, with `error`. */
    failOn(pattern: RegExp, error?: Error, times?: number): void;
    /** A committed row, for a test that needs spend already on the books. */
    seedUsage(row: Partial<UsageRow> & { usd: number }): UsageRow;
    /** Sets a setting as the app would have saved it. */
    setSetting(key: string, value: string, secret?: boolean): void;
    /** Connections handed out and not yet released: a leak is a test failure. */
    openClients(): number;
    restore(): void;
}

class Lock {
    #held = false;
    #waiters: (() => void)[] = [];
    async acquire(): Promise<void> {
        if (!this.#held) {
            this.#held = true;
            return;
        }
        await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    release(): void {
        const next = this.#waiters.shift();
        if (next) next();
        else this.#held = false;
    }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function installAiDb(opts: { owner?: string | null } = {}): AiDb {
    const original = { query: pool.query, connect: pool.connect };
    invalidateTenantCache();
    let nextId = 1;
    let nextClient = 1;
    let open = 0;
    const lock = new Lock();
    const failures: { pattern: RegExp; error: Error; times: number }[] = [];

    const db: AiDb = {
        settings: new Map(),
        usage: [],
        audits: [],
        statements: [],
        owner: opts.owner === undefined ? null : opts.owner,
        now: new Date(),
        failOn: (pattern, error = new Error('connection terminated unexpectedly'), times = 1) => { failures.push({ pattern, error, times }); },
        seedUsage: (row) => {
            const full: UsageRow = {
                id: String(nextId++), creator_id: null, purpose: 'onboarding_draft', provider: 'anthropic', model: 'claude-opus-5-5',
                input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, priced: true, outcome: 'ok', elapsed_ms: 1, at: new Date(db.now), ...row,
            };
            db.usage.push(full);
            return full;
        },
        setSetting: (key, value, secret = false) => { db.settings.set(key, { value: secret ? encryptSecret(value) : value, is_secret: secret }); },
        openClients: () => open,
        restore: () => {
            (pool as unknown as { query: unknown }).query = original.query;
            (pool as unknown as { connect: unknown }).connect = original.connect;
            invalidateTenantCache();
        },
    };

    /** One connection's state: its pending rows and whether it holds the lock. */
    const session = (id: number) => {
        let pending: UsageRow[] = [];
        let inTransaction = false;
        let holdsLock = false;

        const end = (commit: boolean) => {
            if (commit) db.usage.push(...pending);
            pending = [];
            inTransaction = false;
            if (holdsLock) {
                holdsLock = false;
                lock.release();
            }
        };

        const run = async (sql: string, params: unknown[] = []) => {
            await tick();
            const flat = sql.replace(/\s+/g, ' ').trim();
            db.statements.push({ sql: flat, params, client: id });
            const failure = failures.find((f) => f.times > 0 && f.pattern.test(flat));
            if (failure) {
                failure.times -= 1;
                throw failure.error;
            }
            const ok = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount });
            const target = (): UsageRow[] => (inTransaction ? pending : db.usage);

            if (flat === 'BEGIN') { inTransaction = true; return ok(); }
            if (flat === 'COMMIT') { end(true); return ok(); }
            if (flat === 'ROLLBACK') { end(false); return ok(); }

            if (/^SELECT pg_advisory_xact_lock\(/.test(flat)) {
                await lock.acquire();
                holdsLock = true;
                return ok([{ pg_advisory_xact_lock: '' }]);
            }

            // ── ai_usage ──
            if (/^SELECT COALESCE\(SUM\(usd\) FILTER \(WHERE at >= \$1\), 0\)::float8 AS day,/.test(flat)) {
                const [dayStart, monthStart, creatorId] = params as [Date, Date, string | null];
                const inMonth = db.usage.filter((r) => r.at >= monthStart);
                const sum = (rows: UsageRow[]) => rows.reduce((n, r) => n + r.usd, 0);
                const mine = inMonth.filter((r) => creatorId !== null && r.creator_id === creatorId);
                return ok([{
                    day: sum(inMonth.filter((r) => r.at >= dayStart)), month: sum(inMonth),
                    tenant_day: sum(mine.filter((r) => r.at >= dayStart)), tenant_month: sum(mine),
                }]);
            }
            let m = /^INSERT INTO ai_usage \(creator_id, purpose, provider, model, usd, priced, outcome\) VALUES \(\$1, \$2, \$3, \$4, (\$5|0), (\$6|TRUE), '(reserved|budget)'\)/.exec(flat);
            if (m) {
                const [creator, purpose, provider, model] = params as [string | null, string, string, string];
                const row: UsageRow = {
                    id: String(nextId++), creator_id: creator, purpose, provider, model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
                    usd: m[1] === '$5' ? (params[4] as number) : 0, priced: m[2] === '$6' ? (params[5] as boolean) : true,
                    outcome: m[3]!, elapsed_ms: null, at: new Date(db.now),
                };
                target().push(row);
                return ok(/RETURNING id$/.test(flat) ? [{ id: row.id }] : [], 1);
            }
            if (/^INSERT INTO ai_usage \(creator_id, purpose, provider, model, input_tokens, output_tokens, usd, priced, outcome, elapsed_ms\)/.test(flat)) {
                const [creator, purpose, provider, model, tin, tout, usd, priced, outcome, elapsed] = params as [string | null, string, string, string, number, number, number, boolean, string, number | null];
                target().push({ id: String(nextId++), creator_id: creator, purpose, provider, model, input_tokens: tin, output_tokens: tout, cache_read_tokens: 0, cache_write_tokens: 0, usd, priced, outcome, elapsed_ms: elapsed, at: new Date(db.now) });
                return ok([], 1);
            }
            if (/^UPDATE ai_usage SET provider = \$2, model = \$3,/.test(flat)) {
                const [id, provider, model, tin, tout, usd, priced, outcome, elapsed, cacheRead, cacheWrite] = params as [string, string, string, number, number, number, boolean, string, number | null, number, number];
                const row = [...db.usage, ...pending].find((r) => r.id === id);
                if (!row) return ok([], 0);
                Object.assign(row, { provider, model, input_tokens: tin, output_tokens: tout, cache_read_tokens: cacheRead, cache_write_tokens: cacheWrite, usd, priced, outcome, elapsed_ms: elapsed });
                return ok([], 1);
            }
            if (/^SELECT COUNT\(\*\) FILTER \(WHERE at >= \$1\)::int AS day_calls/.test(flat)) {
                const [dayStart, monthStart] = params as [Date, Date];
                const inMonth = db.usage.filter((r) => r.at >= monthStart);
                const day = inMonth.filter((r) => r.at >= dayStart);
                const failed = (rows: UsageRow[]) => rows.filter((r) => r.outcome !== 'ok' && r.outcome !== 'reserved').length;
                const sum = (rows: UsageRow[]) => rows.reduce((n, r) => n + r.usd, 0);
                return ok([{
                    day_calls: day.length, day_failed: failed(day), day_unpriced: day.filter((r) => !r.priced).length, day_usd: sum(day),
                    month_calls: inMonth.length, month_failed: failed(inMonth), month_unpriced: inMonth.filter((r) => !r.priced).length, month_usd: sum(inMonth),
                }]);
            }
            if (/^SELECT purpose, provider, COUNT\(\*\)::int AS calls,/.test(flat)) {
                const from = params[0] as Date;
                const groups = new Map<string, UsageRow[]>();
                for (const r of db.usage.filter((x) => x.at >= from)) groups.set(`${r.purpose}|${r.provider}`, [...(groups.get(`${r.purpose}|${r.provider}`) ?? []), r]);
                return ok([...groups.values()].map((rows) => ({
                    purpose: rows[0]!.purpose, provider: rows[0]!.provider, calls: rows.length,
                    failed: rows.filter((r) => r.outcome !== 'ok' && r.outcome !== 'reserved').length,
                    usd: rows.reduce((n, r) => n + r.usd, 0), tokens_in: rows.reduce((n, r) => n + r.input_tokens, 0), tokens_out: rows.reduce((n, r) => n + r.output_tokens, 0),
                })));
            }
            if (/^SELECT u\.creator_id, c\.name, COUNT\(\*\)::int AS calls/.test(flat)) {
                const from = params[0] as Date;
                const groups = new Map<string | null, UsageRow[]>();
                for (const r of db.usage.filter((x) => x.at >= from)) groups.set(r.creator_id, [...(groups.get(r.creator_id) ?? []), r]);
                return ok([...groups.entries()].map(([creator, rows]) => ({ creator_id: creator, name: creator ? `Tenant ${creator.slice(0, 4)}` : null, calls: rows.length, usd: rows.reduce((n, r) => n + r.usd, 0) })));
            }
            if (/^SELECT CASE WHEN outcome = 'reserved' AND at < \$2 THEN 'abandoned'/.test(flat)) {
                const [from, abandonedBefore] = params as [Date, Date];
                const counts = new Map<string, number>();
                for (const r of db.usage.filter((x) => x.at >= from)) {
                    const outcome = r.outcome === 'reserved' && r.at < abandonedBefore ? 'abandoned' : r.outcome;
                    counts.set(outcome, (counts.get(outcome) ?? 0) + 1);
                }
                return ok([...counts.entries()].map(([outcome, calls]) => ({ outcome, calls })));
            }

            // ── app_settings ──
            if (/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY\(\$1::text\[\]\)$/.test(flat)) {
                const keys = params[0] as string[];
                return ok(keys.flatMap((key) => (db.settings.has(key) ? [{ key, ...db.settings.get(key)! }] : [])));
            }
            if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(flat)) {
                const row = db.settings.get(params[0] as string);
                return ok(row ? [row] : []);
            }
            if (/^INSERT INTO app_settings /.test(flat)) {
                db.settings.set(params[0] as string, { value: params[1] as string, is_secret: params[2] as boolean });
                return ok([], 1);
            }
            if (/^DELETE FROM app_settings WHERE key = \$1$/.test(flat)) {
                return ok([], db.settings.delete(params[0] as string) ? 1 : 0);
            }

            // ── the owner, the audit ledger ──
            if (/^SELECT id FROM creators ORDER BY created_at, id LIMIT 1$/.test(flat)) return ok(db.owner ? [{ id: db.owner }] : []);
            if (/^SELECT email FROM users WHERE id = \$1$/.test(flat)) return ok([]);
            if (/^INSERT INTO audit_log /.test(flat)) {
                const [actor, , action, targetType, targetId, detail] = params as [string | null, unknown, string, string | null, string | null, string];
                db.audits.push({ actor_user_id: actor, action, target_type: targetType, target_id: targetId, detail: JSON.parse(detail) });
                return ok([{ id: String(db.audits.length) }], 1);
            }
            return ok();
        };
        return { run, end };
    };

    const poolSession = session(0);
    (pool as unknown as { query: unknown }).query = poolSession.run;
    (pool as unknown as { connect: unknown }).connect = async () => {
        const s = session(nextClient++);
        open += 1;
        let released = false;
        return {
            query: s.run,
            release() {
                if (released) return;
                released = true;
                open -= 1;
                // A client given back mid-transaction drops its work and its lock, as the pooler's reset does.
                s.end(false);
            },
        };
    };
    return db;
}
