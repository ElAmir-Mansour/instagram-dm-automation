/**
 * `ads_studies` (migration v58) for studies.ts: the Postgres side of `StudyStore`. Every read and write is keyed by the tenant; `open()`
 * lists the (tenant, study) pairs the results poll looks at, then reads each inside its tenant.
 */
import { queryOne, queryRows } from '../../db/query.js';
import type { NewStudyRow, StudyPatch, StudyRow, StudyStore } from './studies.js';

interface Row {
    id: string;
    creator_id: string;
    ad_account_id: string;
    business_id: string;
    meta_id: string | null;
    type: StudyRow['type'];
    name: string;
    cells: StudyRow['cells'];
    daily_budget: string;
    currency: string;
    start_time: Date;
    end_time: Date;
    state: StudyRow['state'];
    result: StudyRow['result'];
    op_id: string | null;
    proposal_id: string | null;
    error: string | null;
    created_by: string | null;
    results_checked_at: Date | null;
    created_at: Date;
}

const COLUMNS = `id, creator_id, ad_account_id, business_id, meta_id, type, name, cells, daily_budget, currency, start_time, end_time, state,
    result, op_id, proposal_id, error, created_by, results_checked_at, created_at`;

export function fromRow(r: Row): StudyRow {
    return {
        id: r.id,
        creatorId: r.creator_id,
        adAccountId: r.ad_account_id,
        businessId: r.business_id,
        metaId: r.meta_id,
        type: r.type,
        name: r.name,
        cells: r.cells,
        dailyBudget: Number(r.daily_budget),
        currency: r.currency,
        startTime: r.start_time,
        endTime: r.end_time,
        state: r.state,
        result: r.result,
        opId: r.op_id,
        proposalId: r.proposal_id,
        error: r.error,
        createdBy: r.created_by,
        resultsCheckedAt: r.results_checked_at,
        createdAt: r.created_at,
    };
}

/** The patch's columns, in a fixed order, so the statement text never depends on the caller. */
const PATCH_COLUMNS: Array<[keyof StudyPatch, string, string]> = [
    ['metaId', 'meta_id', ''],
    ['state', 'state', ''],
    ['result', 'result', '::jsonb'],
    ['opId', 'op_id', ''],
    ['proposalId', 'proposal_id', ''],
    ['error', 'error', ''],
    ['resultsCheckedAt', 'results_checked_at', ''],
];

export const pgStudyStore: StudyStore = {
    async insert(row: NewStudyRow): Promise<StudyRow> {
        const r = await queryOne<Row>(
            `INSERT INTO ads_studies (id, creator_id, ad_account_id, business_id, type, name, cells, daily_budget, currency, start_time, end_time, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
             RETURNING ${COLUMNS}`,
            [row.id, row.creatorId, row.adAccountId, row.businessId, row.type, row.name, JSON.stringify(row.cells), row.dailyBudget, row.currency,
                row.startTime, row.endTime, row.createdBy],
        );
        return fromRow(r!);
    },

    async update(creatorId: string, id: string, patch: StudyPatch): Promise<StudyRow | null> {
        const sets: string[] = [];
        const params: Array<string | number | Date | null> = [creatorId, id];
        for (const [key, column, cast] of PATCH_COLUMNS) {
            if (!(key in patch)) continue;
            const value = patch[key];
            params.push(cast === '::jsonb' ? (value === null || value === undefined ? null : JSON.stringify(value)) : (value as string | Date | null));
            sets.push(`${column} = $${params.length}${cast}`);
        }
        const r = await queryOne<Row>(
            `UPDATE ads_studies SET ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE creator_id = $1 AND id = $2 RETURNING ${COLUMNS}`,
            params,
        );
        return r ? fromRow(r) : null;
    },

    async list(creatorId: string): Promise<StudyRow[]> {
        const rows = await queryRows<Row>(`SELECT ${COLUMNS} FROM ads_studies WHERE creator_id = $1 ORDER BY created_at DESC LIMIT 100`, [creatorId]);
        return rows.map(fromRow);
    },

    async get(creatorId: string, id: string): Promise<StudyRow | null> {
        const r = await queryOne<Row>(`SELECT ${COLUMNS} FROM ads_studies WHERE creator_id = $1 AND id = $2`, [creatorId, id]);
        return r ? fromRow(r) : null;
    },

    async open(limit: number): Promise<StudyRow[]> {
        // The one read across tenants: which (tenant, study) pairs can still change. Each is then read inside its tenant.
        const keys = await queryRows<{ creator_id: string; id: string }>(
            `SELECT creator_id, id FROM ads_studies WHERE state IN ('creating', 'ready', 'running')
             ORDER BY results_checked_at ASC NULLS FIRST, created_at ASC LIMIT $1`,
            [limit],
        );
        const rows = await Promise.all(keys.map((k) => pgStudyStore.get(k.creator_id, k.id)));
        return rows.filter((r): r is StudyRow => r !== null);
    },
};
