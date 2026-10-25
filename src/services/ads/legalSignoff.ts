/**
 * The legal sign-off that unlocks customer lists and lead ads (Ads Manager phase A8/A10, data-model.md `ads_legal_signoffs`, migration v56).
 *
 * Uploading a customer list, or storing the answers of a lead form, is processing personal data: Egypt's PDPL 151/2020 (compliance
 * deadline 2026-11-01) and Saudi's PDPL apply. So both stay locked for a tenant until the PLATFORM ADMIN records that a legal opinion
 * covers it for the tenant's countries. Only the admin routes (`routes/admin.ts`) write here; a tenant cannot unlock itself.
 *
 *   - a capability is unlocked while a NON-REVOKED row of its scope exists for the tenant (`activeSignoff` returns the newest one);
 *   - revoking sets `revoked_at` and never deletes: the record of who allowed what, and until when, stays;
 *   - `countries` is the set the opinion covers. Callers that know the country of an upload (a customer list's rows) check it with
 *     `coversCountry`; a sign-off for `EG` does not unlock `SA`;
 *   - `note` says who gave the opinion and where it is kept. It is required: a sign-off nobody can trace is not a sign-off.
 */
import { queryCount, queryRows } from '../../db/query.js';

export type LegalScope = 'lead_ads' | 'customer_lists';
export const LEGAL_SCOPES: readonly LegalScope[] = ['lead_ads', 'customer_lists'];

export const MAX_SIGNOFF_COUNTRIES = 20;
export const MAX_SIGNOFF_NOTE = 500;

export interface LegalSignoff {
    id: string;
    creatorId: string;
    scope: LegalScope;
    countries: string[];
    recordedBy: string | null;
    recordedAt: string;
    note: string | null;
    revokedAt: string | null;
}

export interface SignoffInput {
    scope: LegalScope;
    countries: string[];
    note: string | null;
}

/** A refusal of the request body. `field` names the property the dashboard should mark; `code` is always INVALID. */
export class LegalSignoffError extends Error {
    readonly code = 'INVALID' as const;
    constructor(readonly field: 'body' | 'scope' | 'countries' | 'note', message: string) {
        super(message);
        this.name = 'LegalSignoffError';
    }
}

export function isLegalScope(value: unknown): value is LegalScope {
    return typeof value === 'string' && (LEGAL_SCOPES as readonly string[]).includes(value);
}

/**
 * Validate `{ scope, countries[], note }`.
 *
 * Countries are ISO 3166-1 alpha-2 codes: trimmed, upper-cased, de-duplicated (order of first appearance kept), 1 to 20 of them.
 * The note is required and at most 500 characters after trimming.
 */
export function parseSignoffInput(body: unknown): SignoffInput {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new LegalSignoffError('body', 'Send an object with scope, countries and note.');
    }
    const raw = body as Record<string, unknown>;

    if (!isLegalScope(raw.scope)) {
        throw new LegalSignoffError('scope', `scope must be one of: ${LEGAL_SCOPES.join(', ')}.`);
    }

    if (!Array.isArray(raw.countries) || raw.countries.length === 0) {
        throw new LegalSignoffError('countries', 'countries must be a list of at least one two-letter country code.');
    }
    const countries: string[] = [];
    for (const entry of raw.countries) {
        const code = typeof entry === 'string' ? entry.trim().toUpperCase() : '';
        if (!/^[A-Z]{2}$/.test(code)) {
            throw new LegalSignoffError('countries', 'Every country must be a two-letter ISO code such as EG or SA.');
        }
        if (!countries.includes(code)) countries.push(code);
    }
    if (countries.length > MAX_SIGNOFF_COUNTRIES) {
        throw new LegalSignoffError('countries', `At most ${MAX_SIGNOFF_COUNTRIES} countries per sign-off.`);
    }

    const note = typeof raw.note === 'string' ? raw.note.trim() : '';
    if (note === '') {
        throw new LegalSignoffError('note', 'note is required: who gave the legal opinion, and where it is kept.');
    }
    if (note.length > MAX_SIGNOFF_NOTE) {
        throw new LegalSignoffError('note', `note is at most ${MAX_SIGNOFF_NOTE} characters.`);
    }

    return { scope: raw.scope, countries, note };
}

// ─── Reading and writing ─────────────────────────────────────────────────────────────────────────

interface SignoffRow {
    id: string;
    creator_id: string;
    scope: LegalScope;
    countries: string[];
    recorded_by: string | null;
    recorded_at: Date | string;
    note: string | null;
    revoked_at: Date | string | null;
    [column: string]: unknown;
}

const COLUMNS = 'id, creator_id, scope, countries, recorded_by, recorded_at, note, revoked_at';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : new Date(value).toISOString());

function toSignoff(row: SignoffRow): LegalSignoff {
    return {
        id: row.id,
        creatorId: row.creator_id,
        scope: row.scope,
        countries: [...row.countries],
        recordedBy: row.recorded_by,
        recordedAt: iso(row.recorded_at),
        note: row.note,
        revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
    };
}

export const LIST_SIGNOFFS_SQL = `SELECT ${COLUMNS} FROM ads_legal_signoffs WHERE creator_id = $1 ORDER BY recorded_at DESC, id`;
export const LIST_ACTIVE_SIGNOFFS_SQL = `SELECT ${COLUMNS} FROM ads_legal_signoffs WHERE creator_id = $1 AND revoked_at IS NULL ORDER BY recorded_at DESC, id`;
export const ACTIVE_SIGNOFF_SQL = `SELECT ${COLUMNS} FROM ads_legal_signoffs WHERE creator_id = $1 AND scope = $2 AND revoked_at IS NULL ORDER BY recorded_at DESC, id LIMIT 1`;
export const INSERT_SIGNOFF_SQL = `INSERT INTO ads_legal_signoffs (creator_id, scope, countries, recorded_by, note) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`;
export const REVOKE_SIGNOFF_SQL = 'UPDATE ads_legal_signoffs SET revoked_at = NOW() WHERE id = $1 AND creator_id = $2 AND revoked_at IS NULL';

/** A tenant's sign-offs, newest first. Revoked ones only when asked: the admin card shows the history, the gate never does. */
export async function listSignoffs(creatorId: string, opts: { includeRevoked?: boolean } = {}): Promise<LegalSignoff[]> {
    const rows = await queryRows<SignoffRow>(opts.includeRevoked ? LIST_SIGNOFFS_SQL : LIST_ACTIVE_SIGNOFFS_SQL, [creatorId]);
    return rows.map(toSignoff);
}

/** The newest non-revoked sign-off of this scope, or null: the capability is locked. */
export async function activeSignoff(creatorId: string, scope: LegalScope): Promise<LegalSignoff | null> {
    const rows = await queryRows<SignoffRow>(ACTIVE_SIGNOFF_SQL, [creatorId, scope]);
    return rows[0] ? toSignoff(rows[0]) : null;
}

/** Record a sign-off. `input` is the output of `parseSignoffInput`; `recordedBy` the platform admin's user id. */
export async function recordSignoff(creatorId: string, input: SignoffInput, recordedBy: string | null): Promise<LegalSignoff> {
    const rows = await queryRows<SignoffRow>(INSERT_SIGNOFF_SQL, [creatorId, input.scope, input.countries, recordedBy, input.note]);
    const row = rows[0];
    if (!row) throw new Error('ads_legal_signoffs insert returned no row');
    return toSignoff(row);
}

/** Revoke one sign-off of this tenant. False when it does not exist (or belongs to another tenant) or was already revoked. */
export async function revokeSignoff(creatorId: string, id: string): Promise<boolean> {
    if (!UUID_PATTERN.test(id)) return false;
    return (await queryCount(REVOKE_SIGNOFF_SQL, [id, creatorId])) > 0;
}

// ─── What the screens and gates read ─────────────────────────────────────────────────────────────

export interface LockView {
    locked: boolean;
    countries: string[];
    recordedAt: string | null;
    /** Stable keys the dashboard maps to a sentence and a next step; empty when unlocked. */
    needed: string[];
}

/** The lock as a screen reads it: locked unless `s` is a sign-off that has not been revoked. */
export function lockView(s: LegalSignoff | null): LockView {
    if (!s || s.revokedAt !== null) return { locked: true, countries: [], recordedAt: null, needed: ['legal_signoff'] };
    return { locked: false, countries: [...s.countries], recordedAt: s.recordedAt, needed: [] };
}

/** Whether an unlocked sign-off covers this country (ISO-2, any case). A locked view covers nothing. */
export function coversCountry(view: LockView, country: string): boolean {
    return !view.locked && view.countries.includes(country.trim().toUpperCase());
}
