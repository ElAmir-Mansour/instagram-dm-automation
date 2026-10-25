/**
 * Tests only: the fake pool of src/services/monteur/testDb.ts, plus what the paced queue's tests need on top of it.
 *
 * The queue's one structural promise is that no Graph call is made inside a database transaction (the pooler would hold a connection and
 * a row lock for up to 40 s of Graph retries). A test proves it by calling `db.mark('graph')` from its stubbed Graph function: the mark lands
 * in the same ordered list as BEGIN / COMMIT, and `db.markedInsideTransaction('graph')` says whether one fell between them.
 */
import { installFakeDb as installPoolFake, type FakeDb as PoolFake, type Route, type Rows, type Statement } from '../../monteur/testDb.js';

export type { Route, Rows, Statement };

export interface AdsFakeDb extends PoolFake {
    /** Put a named marker into the ordered statement list (a stubbed Graph call does this). */
    mark(label: string): void;
    /** True when a marker with this label was recorded between a BEGIN and its COMMIT / ROLLBACK. */
    markedInsideTransaction(label: string): boolean;
    /** The statements, in order, with markers as `-- label`; handy for asserting "A happened, then B". */
    timeline(): string[];
    /** Answer the first statement matching `pattern` ahead of every other route (later calls win over earlier ones). */
    on(pattern: RegExp, answer: (params: any[], sql: string) => Rows): void;
}

const MARK = '-- ';

export function installFakeDb(opts: { platformTenant?: string } = {}): AdsFakeDb {
    const db = installPoolFake(opts) as AdsFakeDb;
    db.mark = (label) => { db.statements.push({ sql: `${MARK}${label}`, params: [] }); };
    db.markedInsideTransaction = (label) => {
        let depth = 0;
        for (const s of db.statements) {
            if (s.sql === 'BEGIN') depth++;
            else if (s.sql === 'COMMIT' || s.sql === 'ROLLBACK') depth = Math.max(0, depth - 1);
            else if (s.sql === `${MARK}${label}` && depth > 0) return true;
        }
        return false;
    };
    db.timeline = () => db.statements.map((s) => s.sql);
    db.on = (pattern, answer) => { db.routes.unshift([pattern, answer]); };
    return db;
}
