/**
 * Tests only: a fake pool for the ads module, on the pattern of src/services/monteur/testDb.ts, that also models what the money rule
 * depends on: `pg_advisory_xact_lock` really waits for the holder's COMMIT or ROLLBACK, and a transaction's writes to `ads_ops` become
 * visible to others only when it commits. Statements are recorded with whitespace collapsed; the first matching route answers the rest.
 */
import { pool } from '../../config/db.js';

export type Rows = { rows: any[]; rowCount?: number };
export interface Statement { sql: string; params: any[]; client: number }
export type Route = [RegExp, (params: any[], sql: string) => Rows];

export interface OpRow {
    id: string;
    creator_id: string;
    ad_account_id: string;
    object_key: string;
    kind: string;
    payload: Record<string, unknown>;
    state: string;
    actor: Record<string, unknown>;
    result: unknown;
    created_at: Date;
    finished_at: Date | null;
}

export interface AdsFakeDb {
    statements: Statement[];
    routes: Route[];
    /** Committed `ads_ops` rows. */
    ops: OpRow[];
    ran(pattern: RegExp): Statement[];
    restore(): void;
}

const ABOUT_TO_RUN = /^SELECT COALESCE\(SUM\(\(payload->>'worst_case_delta'\)::numeric\), 0\)::text AS total FROM ads_ops/;

export function installAdsFakeDb(): AdsFakeDb {
    const original = { query: pool.query, connect: pool.connect };
    const locks = new Map<string, Promise<void>>();
    let clients = 0;
    let ids = 0;
    const db: AdsFakeDb = {
        statements: [],
        routes: [],
        ops: [],
        ran: (pattern) => db.statements.filter((s) => pattern.test(s.sql)),
        restore: () => {
            (pool as unknown as { query: unknown }).query = original.query;
            (pool as unknown as { connect: unknown }).connect = original.connect;
        },
    };

    const sumAboutToRun = (params: any[]): Rows => {
        const [creatorId, since, exclude] = params as [string, Date, string | null];
        const day = Date.now() - 86_400_000;
        const total = db.ops
            .filter((o) => o.creator_id === creatorId && 'worst_case_delta' in o.payload && (exclude === null || o.object_key !== exclude))
            .filter((o) => o.state === 'pending' || o.state === 'running' || (o.state === 'verify' && o.created_at.getTime() > day) || (o.state === 'done' && o.finished_at !== null && o.finished_at.getTime() > since.getTime()))
            .reduce((sum, o) => sum + Number(o.payload['worst_case_delta']), 0);
        return { rows: [{ total: String(total) }] };
    };

    const makeRunner = (client: number, pending: OpRow[] | null, held: Array<() => void>) => async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        db.statements.push({ sql: flat, params, client });
        if (flat === 'COMMIT' || flat === 'ROLLBACK') {
            if (flat === 'COMMIT' && pending) db.ops.push(...pending.splice(0));
            if (pending) pending.length = 0;
            held.splice(0).forEach((release) => release());
            return { rows: [], rowCount: 0 };
        }
        const lock = flat.match(/^SELECT pg_advisory_xact_lock\(hashtextextended\(\$1, 0\)\)$/);
        if (lock) {
            const key = String(params[0]);
            while (locks.has(key)) await locks.get(key);
            let release!: () => void;
            locks.set(key, new Promise<void>((r) => { release = () => { locks.delete(key); r(); }; }));
            held.push(release);
            return { rows: [], rowCount: 1 };
        }
        if (ABOUT_TO_RUN.test(flat)) return { ...sumAboutToRun(params), rowCount: 1 };
        if (/^INSERT INTO ads_ops /.test(flat)) {
            const row: OpRow = {
                id: `op-${++ids}`, creator_id: params[0], ad_account_id: params[1], object_key: params[2], kind: params[3],
                payload: JSON.parse(params[4]), state: 'running', actor: JSON.parse(params[5]), result: null, created_at: new Date(), finished_at: null,
            };
            (pending ?? db.ops).push(row);
            return { rows: [{ id: row.id }], rowCount: 1 };
        }
        const finish = flat.match(/^UPDATE ads_ops SET state = \$2, result = \$3::jsonb, finished_at = NOW\(\) WHERE id = \$1 AND creator_id = \$4/);
        if (finish) {
            const row = db.ops.find((o) => o.id === params[0] && o.creator_id === params[3]);
            if (row) { row.state = params[1]; row.result = params[2] === null ? null : JSON.parse(params[2]); row.finished_at = new Date(); }
            return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
        }
        const route = db.routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params, flat) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };

    (pool as unknown as { query: unknown }).query = makeRunner(0, null, []);
    (pool as unknown as { connect: unknown }).connect = async () => {
        const client = ++clients;
        const pending: OpRow[] = [];
        const held: Array<() => void> = [];
        return { query: makeRunner(client, pending, held), release() { held.splice(0).forEach((r) => r()); } };
    };
    return db;
}
