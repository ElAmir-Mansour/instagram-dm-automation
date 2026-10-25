/**
 * The legal sign-off (ads_legal_signoffs, v56): the input rules, the lock a screen reads, and the SQL that reads and writes it.
 *
 * The pure functions are tested directly. The SQL runs against the pool stand-in (`monteur/testDb.ts`), answering by statement:
 * what is pinned is that the gate reads only NON-REVOKED rows of the right scope and tenant, that revoking is scoped to the
 * tenant and only touches a row that is still active, and that nothing here ever DELETEs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installFakeDb, type FakeDb } from '../monteur/testDb.js';
import {
    activeSignoff, coversCountry, LEGAL_SCOPES, LegalSignoffError, listSignoffs, lockView, parseSignoffInput, recordSignoff, revokeSignoff,
    type LegalSignoff,
} from './legalSignoff.js';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = '99999999-9999-4999-8999-999999999999';

const signoff = (over: Partial<LegalSignoff> = {}): LegalSignoff => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', creatorId: T1, scope: 'customer_lists', countries: ['EG', 'SA'], recordedBy: ADMIN,
    recordedAt: '2026-10-22T10:00:00.000Z', note: 'Opinion from counsel, filed in Drive/legal', revokedAt: null, ...over,
});

const valid = { scope: 'customer_lists', countries: ['eg'], note: 'Counsel opinion 2026-10-20' };

function refusal(body: unknown): LegalSignoffError {
    try { parseSignoffInput(body); } catch (err) { assert.ok(err instanceof LegalSignoffError, `${err}`); return err; }
    assert.fail('expected a refusal');
}

describe('parseSignoffInput', () => {
    it('accepts a valid body and upper-cases the countries', () => {
        assert.deepEqual(parseSignoffInput(valid), { scope: 'customer_lists', countries: ['EG'], note: 'Counsel opinion 2026-10-20' });
    });

    it('knows exactly the two scopes', () => {
        assert.deepEqual([...LEGAL_SCOPES], ['lead_ads', 'customer_lists']);
        for (const scope of LEGAL_SCOPES) assert.equal(parseSignoffInput({ ...valid, scope }).scope, scope);
    });

    it('refuses anything that is not an object, with field body', () => {
        for (const body of [null, undefined, 'x', 7, [], [valid]]) {
            const err = refusal(body);
            assert.equal(err.field, 'body');
            assert.equal(err.code, 'INVALID');
        }
    });

    it('refuses an unknown or missing scope, with field scope', () => {
        for (const scope of ['', 'leads', 'LEAD_ADS', null, 3, undefined]) assert.equal(refusal({ ...valid, scope }).field, 'scope');
    });

    it('trims, upper-cases and de-duplicates countries, keeping first-seen order', () => {
        const out = parseSignoffInput({ ...valid, countries: [' sa', 'EG', 'sa', 'Eg', 'AE'] });
        assert.deepEqual(out.countries, ['SA', 'EG', 'AE']);
    });

    it('needs 1 to 20 countries', () => {
        assert.equal(refusal({ ...valid, countries: [] }).field, 'countries');
        assert.equal(refusal({ ...valid, countries: undefined }).field, 'countries');
        assert.equal(refusal({ ...valid, countries: 'EG' }).field, 'countries');
        const twenty = Array.from({ length: 20 }, (_, i) => String.fromCharCode(65 + Math.floor(i / 26), 65 + (i % 26)));
        assert.equal(parseSignoffInput({ ...valid, countries: twenty }).countries.length, 20);
        const twentyOne = [...twenty, 'ZZ'];
        assert.equal(refusal({ ...valid, countries: twentyOne }).field, 'countries');
    });

    it('counts countries after de-duplication, so 25 repeats of one code are one', () => {
        assert.deepEqual(parseSignoffInput({ ...valid, countries: Array(25).fill('eg') }).countries, ['EG']);
    });

    it('refuses an entry that is not two letters', () => {
        for (const bad of ['EGY', 'E', '', '1A', 'E G', 'é', 12, null, {}]) {
            assert.equal(refusal({ ...valid, countries: ['EG', bad] }).field, 'countries', JSON.stringify(bad));
        }
    });

    it('requires a note: missing, blank and non-string are refused with field note', () => {
        for (const note of [undefined, null, '', '   \n', 5, ['x']]) assert.equal(refusal({ ...valid, note }).field, 'note');
    });

    it('trims the note and caps it at 500 characters', () => {
        assert.equal(parseSignoffInput({ ...valid, note: '  ref 12  ' }).note, 'ref 12');
        assert.equal(parseSignoffInput({ ...valid, note: 'x'.repeat(500) }).note?.length, 500);
        assert.equal(refusal({ ...valid, note: 'x'.repeat(501) }).field, 'note');
        // The cap is on the trimmed text: padding does not count against it.
        assert.equal(parseSignoffInput({ ...valid, note: `  ${'x'.repeat(500)}  ` }).note?.length, 500);
    });

    it('checks the scope before the countries and the countries before the note', () => {
        assert.equal(refusal({}).field, 'scope');
        assert.equal(refusal({ scope: 'lead_ads' }).field, 'countries');
        assert.equal(refusal({ scope: 'lead_ads', countries: ['EG'] }).field, 'note');
    });
});

describe('lockView', () => {
    it('is locked, with the key to ask for, when there is no sign-off', () => {
        assert.deepEqual(lockView(null), { locked: true, countries: [], recordedAt: null, needed: ['legal_signoff'] });
    });

    it('is unlocked, naming the countries and when, for an active sign-off', () => {
        assert.deepEqual(lockView(signoff()), { locked: false, countries: ['EG', 'SA'], recordedAt: '2026-10-22T10:00:00.000Z', needed: [] });
    });

    it('is locked again for a revoked sign-off, even if a caller hands one over', () => {
        assert.deepEqual(lockView(signoff({ revokedAt: '2026-10-23T00:00:00.000Z' })), { locked: true, countries: [], recordedAt: null, needed: ['legal_signoff'] });
    });

    it('does not share the sign-off\'s countries array', () => {
        const s = signoff();
        const view = lockView(s);
        view.countries.push('AE');
        assert.deepEqual(s.countries, ['EG', 'SA']);
    });
});

describe('coversCountry', () => {
    it('is true only for a listed country on an unlocked view, in any case', () => {
        const view = lockView(signoff());
        assert.equal(coversCountry(view, 'eg'), true);
        assert.equal(coversCountry(view, ' SA '), true);
        assert.equal(coversCountry(view, 'AE'), false);
        assert.equal(coversCountry(lockView(null), 'EG'), false);
    });
});

// ─── The SQL ─────────────────────────────────────────────────────────────────────────────────────

let db: FakeDb;
let rows: Array<Record<string, any>>;
let nextId: number;

beforeEach(() => {
    rows = [];
    nextId = 1;
    db = installFakeDb();
    db.routes.push(
        [/^SELECT .* FROM ads_legal_signoffs WHERE creator_id = \$1 AND scope = \$2 AND revoked_at IS NULL ORDER BY recorded_at DESC, id LIMIT 1$/, ([creator, scope]) => ({
            rows: rows.filter((r) => r.creator_id === creator && r.scope === scope && r.revoked_at === null).sort(newest).slice(0, 1),
        })],
        [/^SELECT .* FROM ads_legal_signoffs WHERE creator_id = \$1 AND revoked_at IS NULL ORDER BY/, ([creator]) => ({
            rows: rows.filter((r) => r.creator_id === creator && r.revoked_at === null).sort(newest),
        })],
        [/^SELECT .* FROM ads_legal_signoffs WHERE creator_id = \$1 ORDER BY/, ([creator]) => ({
            rows: rows.filter((r) => r.creator_id === creator).sort(newest),
        })],
        [/^INSERT INTO ads_legal_signoffs \(creator_id, scope, countries, recorded_by, note\) VALUES \(\$1, \$2, \$3, \$4, \$5\) RETURNING /, ([creator, scope, countries, by, note]) => {
            const row = {
                id: `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`, creator_id: creator, scope, countries, recorded_by: by,
                recorded_at: new Date(Date.parse('2026-10-22T10:00:00Z') + nextId * 1000), note, revoked_at: null,
            };
            rows.push(row);
            return { rows: [row] };
        }],
        [/^UPDATE ads_legal_signoffs SET revoked_at = NOW\(\) WHERE id = \$1 AND creator_id = \$2 AND revoked_at IS NULL$/, ([id, creator]) => {
            const hit = rows.filter((r) => r.id === id && r.creator_id === creator && r.revoked_at === null);
            for (const r of hit) r.revoked_at = new Date('2026-10-25T00:00:00Z');
            return { rows: [], rowCount: hit.length };
        }],
    );
});
afterEach(() => db.restore());

const newest = (a: Record<string, any>, b: Record<string, any>): number => b.recorded_at.getTime() - a.recorded_at.getTime();

describe('recordSignoff', () => {
    it('inserts for the tenant in the PATH, with the admin as recorder, and maps the row', async () => {
        const out = await recordSignoff(T1, { scope: 'customer_lists', countries: ['EG', 'SA'], note: 'Counsel' }, ADMIN);
        assert.equal(out.creatorId, T1);
        assert.equal(out.scope, 'customer_lists');
        assert.deepEqual(out.countries, ['EG', 'SA']);
        assert.equal(out.recordedBy, ADMIN);
        assert.equal(out.note, 'Counsel');
        assert.equal(out.revokedAt, null);
        assert.match(out.recordedAt, /^\d{4}-\d\d-\d\dT.*Z$/);
        assert.deepEqual(db.ran(/^INSERT INTO ads_legal_signoffs/)[0]!.params, [T1, 'customer_lists', ['EG', 'SA'], ADMIN, 'Counsel']);
    });

    it('accepts a null recorder', async () => {
        const out = await recordSignoff(T1, { scope: 'lead_ads', countries: ['EG'], note: 'x' }, null);
        assert.equal(out.recordedBy, null);
    });
});

describe('activeSignoff', () => {
    it('is null with nothing recorded: the capability is locked', async () => {
        assert.equal(await activeSignoff(T1, 'customer_lists'), null);
    });

    it('returns the newest non-revoked one of that scope for that tenant only', async () => {
        const older = await recordSignoff(T1, { scope: 'customer_lists', countries: ['EG'], note: 'old' }, ADMIN);
        const newer = await recordSignoff(T1, { scope: 'customer_lists', countries: ['EG', 'SA'], note: 'new' }, ADMIN);
        await recordSignoff(T1, { scope: 'lead_ads', countries: ['AE'], note: 'other scope' }, ADMIN);
        await recordSignoff(T2, { scope: 'customer_lists', countries: ['AE'], note: 'other tenant' }, ADMIN);

        assert.equal((await activeSignoff(T1, 'customer_lists'))?.id, newer.id);
        assert.equal(await revokeSignoff(T1, newer.id), true);
        // With the newest revoked, the older one is what still unlocks.
        assert.equal((await activeSignoff(T1, 'customer_lists'))?.id, older.id);
        assert.equal(await revokeSignoff(T1, older.id), true);
        assert.equal(await activeSignoff(T1, 'customer_lists'), null);
        assert.equal((await activeSignoff(T1, 'lead_ads'))?.countries[0], 'AE', 'revoking one scope leaves the other');
    });

    it('asks the database for non-revoked rows only', async () => {
        await activeSignoff(T1, 'lead_ads');
        const sql = db.ran(/^SELECT/)[0]!.sql;
        assert.match(sql, /revoked_at IS NULL/);
        assert.deepEqual(db.ran(/^SELECT/)[0]!.params, [T1, 'lead_ads']);
    });
});

describe('listSignoffs', () => {
    it('hides revoked rows by default and shows them with includeRevoked, newest first', async () => {
        const a = await recordSignoff(T1, { scope: 'customer_lists', countries: ['EG'], note: 'a' }, ADMIN);
        const b = await recordSignoff(T1, { scope: 'lead_ads', countries: ['SA'], note: 'b' }, ADMIN);
        await revokeSignoff(T1, a.id);
        assert.deepEqual((await listSignoffs(T1)).map((s) => s.id), [b.id]);
        const all = await listSignoffs(T1, { includeRevoked: true });
        assert.deepEqual(all.map((s) => s.id), [b.id, a.id]);
        assert.match(all[1]!.revokedAt ?? '', /^2026-10-25T/);
        assert.equal(all[0]!.revokedAt, null);
    });

    it('never lists another tenant\'s rows', async () => {
        await recordSignoff(T2, { scope: 'lead_ads', countries: ['SA'], note: 'b' }, ADMIN);
        assert.deepEqual(await listSignoffs(T1, { includeRevoked: true }), []);
    });
});

describe('revokeSignoff', () => {
    it('revokes once: a second call and an unknown id are false', async () => {
        const s = await recordSignoff(T1, { scope: 'lead_ads', countries: ['EG'], note: 'x' }, ADMIN);
        assert.equal(await revokeSignoff(T1, s.id), true);
        assert.equal(await revokeSignoff(T1, s.id), false);
        assert.equal(await revokeSignoff(T1, '33333333-3333-4333-8333-333333333333'), false);
    });

    it('cannot revoke another tenant\'s row through a guessed id', async () => {
        const s = await recordSignoff(T2, { scope: 'lead_ads', countries: ['EG'], note: 'x' }, ADMIN);
        assert.equal(await revokeSignoff(T1, s.id), false);
        assert.equal((await activeSignoff(T2, 'lead_ads'))?.id, s.id);
    });

    it('answers false for a non-uuid without asking the database', async () => {
        assert.equal(await revokeSignoff(T1, 'not-a-uuid'), false);
        assert.equal(db.ran(/^UPDATE/).length, 0);
    });

    it('never deletes: nothing in this module runs a DELETE', async () => {
        const s = await recordSignoff(T1, { scope: 'lead_ads', countries: ['EG'], note: 'x' }, ADMIN);
        await revokeSignoff(T1, s.id);
        await listSignoffs(T1, { includeRevoked: true });
        assert.equal(db.ran(/DELETE/i).length, 0);
    });
});
