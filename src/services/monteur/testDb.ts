/**
 * Tests only: the pool answers by SQL, as in src/services/studio/*.test.ts. Every statement is
 * recorded with whitespace collapsed; the first route whose pattern matches answers it, anything
 * else gets no rows. `pool.connect()` hands out the same fake, so a transaction's statements are
 * recorded in order with everything else.
 */
import { pool } from '../../config/db.js';

export type Rows = { rows: any[]; rowCount?: number };
export interface Statement { sql: string; params: any[] }
export type Route = [RegExp, (params: any[], sql: string) => Rows];

export interface FakeDb {
    statements: Statement[];
    routes: Route[];
    ran(pattern: RegExp): Statement[];
    restore(): void;
}

export function installFakeDb(): FakeDb {
    const original = { query: pool.query, connect: pool.connect };
    const db: FakeDb = {
        statements: [],
        routes: [],
        ran: (pattern) => db.statements.filter((s) => pattern.test(s.sql)),
        restore: () => {
            (pool as unknown as { query: unknown }).query = original.query;
            (pool as unknown as { connect: unknown }).connect = original.connect;
        },
    };
    const run = async (sql: string, params: any[] = []) => {
        const flat = sql.replace(/\s+/g, ' ').trim();
        db.statements.push({ sql: flat, params });
        const route = db.routes.find(([pattern]) => pattern.test(flat));
        const r = route ? route[1](params, flat) : { rows: [] };
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
    };
    (pool as unknown as { query: unknown }).query = run;
    (pool as unknown as { connect: unknown }).connect = async () => ({ query: run, release() {} });
    return db;
}
