/**
 * Tenant isolation for the ads module (tasks T189, research R18, spec Story 9 scenario 2): every op and every read re-checks `creator_id`
 * and `ad_account_id`; another tenant's object id gives NOT_OWN_OBJECT, and the refusal is logged and audited.
 *
 * Two halves:
 *   - ownership.ts against a fake pool holding two tenants' rows;
 *   - a scan of the source: every SQL statement on an `ads_*` table names `creator_id`, the queue checks each op's target before it
 *     is sent, and every `:id` route resolves its object through `ownObject`. A new statement or route that forgets fails here.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { AdsObjectNotFoundError, assertOpTarget, NotOwnObjectError, ownObject } from './ownership.js';
import { ownObject as routeOwnObject } from './actions.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const OWNER_ACC = '509787248064459';
const CLIENT_ACC = '700000000000001';

const ROWS = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', creator_id: OWNER, ad_account_id: OWNER_ACC, meta_id: '120000000000001', level: 'campaign' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', creator_id: CLIENT, ad_account_id: CLIENT_ACC, meta_id: '120000000000002', level: 'campaign' },
    // The client's object in an account it used before: still the client's, but not what its current token may touch.
    { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', creator_id: CLIENT, ad_account_id: '700000000000009', meta_id: '120000000000003', level: 'adset' },
    // The same Meta id under both tenants (Meta ids are unique per account, but the mirror's unique key is per tenant).
    { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', creator_id: OWNER, ad_account_id: OWNER_ACC, meta_id: '120000000000004', level: 'ad' },
    { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', creator_id: CLIENT, ad_account_id: CLIENT_ACC, meta_id: '120000000000004', level: 'ad' },
];

describe('ownObject and assertOpTarget', () => {
    let statements: Array<{ sql: string; params: any[] }>;
    let logs: string[];
    let restoreSink: (() => void) | null = null;
    const original = pool.query;

    beforeEach(() => {
        statements = [];
        logs = [];
        (pool as any).query = async (sql: string, params: any[] = []) => {
            const flat = sql.replace(/\s+/g, ' ').trim();
            statements.push({ sql: flat, params });
            if (/FROM ads_objects WHERE id = \$1/.test(flat)) return { rows: ROWS.filter((r) => r.id === params[0]), rowCount: 1 };
            if (/FROM ads_objects WHERE meta_id = \$1/.test(flat)) {
                const hits = ROWS.filter((r) => r.meta_id === params[0]).sort((a, b) => Number(b.creator_id === params[1]) - Number(a.creator_id === params[1]));
                return { rows: hits.slice(0, 1), rowCount: hits.length ? 1 : 0 };
            }
            if (/^INSERT INTO audit_log/.test(flat)) return { rows: [{ id: 'audit-1' }], rowCount: 1 };
            // mirror.getObject (the routes' fast path), keyed by the tenant: never another tenant's row.
            if (/FROM ads_objects WHERE (id = \$2::uuid|meta_id = \$2) AND creator_id = \$1/.test(flat)) return { rows: [], rowCount: 0 };
            throw new Error(`unexpected SQL: ${flat}`);
        };
        const prev = setLogSink((_level, line) => logs.push(line));
        restoreSink = () => setLogSink(prev);
    });
    afterEach(() => {
        (pool as any).query = original;
        restoreSink?.();
    });

    const audits = () => statements.filter((s) => s.sql.startsWith('INSERT INTO audit_log'));

    it("returns this tenant's own object in its current account, by our id or Meta's", async () => {
        const byUuid = await ownObject(OWNER, OWNER_ACC, ROWS[0]!.id);
        assert.equal(byUuid.metaId, '120000000000001');
        const byMeta = await ownObject(OWNER, `act_${OWNER_ACC}`, '120000000000001');
        assert.equal(byMeta.id, ROWS[0]!.id);
        assert.equal(audits().length, 0);
    });

    it("refuses another tenant's object with NOT_OWN_OBJECT, logs it and audits it, both ways round", async () => {
        for (const [who, acc, target, owner] of [[CLIENT, CLIENT_ACC, ROWS[0]!.id, OWNER], [OWNER, OWNER_ACC, '120000000000002', CLIENT]] as const) {
            statements = [];
            logs = [];
            await assert.rejects(ownObject(who, acc, target), (err: unknown) => err instanceof NotOwnObjectError && err.code === 'NOT_OWN_OBJECT' && err.status === 403);
            const line = logs.find((l) => l.includes('ads.not_own_object'));
            assert.ok(line, 'the refusal is logged');
            assert.match(line!, new RegExp(owner));
            const [row] = audits();
            assert.ok(row, 'the refusal is audited');
            assert.equal(row!.params[2], 'ads.not_own_object');
            assert.equal(row!.params[4], who);
            assert.match(row!.params[5], /other_tenant/);
        }
    });

    it('never says whose object it was in the error the client sees', async () => {
        await assert.rejects(ownObject(CLIENT, CLIENT_ACC, ROWS[0]!.id), (err: Error) => !err.message.includes(OWNER) && !err.message.includes(OWNER_ACC));
    });

    it("refuses the tenant's own object from an ad account it no longer uses", async () => {
        await assert.rejects(ownObject(CLIENT, CLIENT_ACC, ROWS[2]!.id), NotOwnObjectError);
        assert.match(audits()[0]!.params[5], /other_account/);
        await assert.rejects(ownObject(CLIENT, null, ROWS[1]!.id), NotOwnObjectError, 'no account configured: nothing is in it');
    });

    it("finds its own row when another tenant has the same Meta id", async () => {
        assert.equal((await ownObject(CLIENT, CLIENT_ACC, '120000000000004')).id, ROWS[4]!.id);
        assert.equal((await ownObject(OWNER, OWNER_ACC, '120000000000004')).id, ROWS[3]!.id);
    });

    it("gives the routes 403 NOT_OWN_OBJECT for another tenant's id, through the ownObject every :id route uses", async () => {
        await assert.rejects(routeOwnObject(CLIENT, CLIENT_ACC, ROWS[0]!.id), (err: any) => err.status === 403 && err.code === 'NOT_OWN_OBJECT');
        assert.equal(audits().length, 1);
        assert.ok(logs.some((l) => l.includes('ads.not_own_object')));
        await assert.rejects(routeOwnObject(CLIENT, CLIENT_ACC, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), (err: any) => err.status === 404 && err.code === 'NOT_FOUND');
        assert.equal(audits().length, 1, 'an id nobody has is not a refusal');
    });

    it('answers NOT_FOUND for an id no tenant has, and for garbage without touching the database', async () => {
        await assert.rejects(ownObject(OWNER, OWNER_ACC, 'ffffffff-ffff-4fff-8fff-ffffffffffff'), AdsObjectNotFoundError);
        statements = [];
        for (const bad of ["1 OR 1=1", '', 'act_509787248064459', '../me']) {
            await assert.rejects(ownObject(OWNER, OWNER_ACC, bad), AdsObjectNotFoundError, bad);
        }
        assert.equal(statements.length, 0);
    });

    it("lets an op through only to the tenant's own account and its own stored objects", async () => {
        await assertOpTarget(OWNER, OWNER_ACC, { path: `act_${OWNER_ACC}/campaigns` });
        await assertOpTarget(OWNER, OWNER_ACC, { path: '120000000000001' });
        await assertOpTarget(CLIENT, CLIENT_ACC, { path: '/120000000000002' });

        await assert.rejects(assertOpTarget(CLIENT, CLIENT_ACC, { path: `act_${OWNER_ACC}/campaigns` }), NotOwnObjectError, "the owner's account");
        await assert.rejects(assertOpTarget(CLIENT, CLIENT_ACC, { path: '120000000000001' }), NotOwnObjectError, "the owner's campaign");
        await assert.rejects(assertOpTarget(CLIENT, CLIENT_ACC, { path: '120000000000003' }), NotOwnObjectError, 'an old account');
        await assert.rejects(assertOpTarget(OWNER, OWNER_ACC, { path: 'me/adaccounts' }), NotOwnObjectError, 'not an object path');
        await assert.rejects(assertOpTarget(OWNER, null, { path: `act_${OWNER_ACC}/campaigns` }), NotOwnObjectError, 'no account configured');
        await assert.rejects(assertOpTarget(CLIENT, CLIENT_ACC, { path: '120000000000002' }, '700000000000009'), NotOwnObjectError, 'an op queued for the old account');
        assert.equal(audits().length, 6, 'every refusal is audited');
    });

    it('lets an op reach an object the stored copy has not seen yet, and logs it (a pause must not wait for the sync)', async () => {
        await assertOpTarget(OWNER, OWNER_ACC, { path: '129999999999999' }, OWNER_ACC);
        assert.equal(audits().length, 0);
        assert.ok(logs.some((l) => l.includes('ads.op_target_unmirrored') && l.includes('129999999999999')));
    });
});

// ─── The source scan ──────────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ADS_DIR = join(ROOT, 'src', 'services', 'ads');
const ROUTES_DIR = join(ROOT, 'src', 'routes');

/** Tables keyed by tenant. `ads_pacer` is keyed by ad account (Meta's limits are per account) and holds no tenant data to leak. */
const TENANT_TABLE = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(ads_(?!pacer\b)[a-z_]+)/i;

/** Files whose cross-tenant reads are the point: the ownership check itself and the platform admin's overview. */
const CROSS_TENANT_OK = new Set(['ownership.ts', 'tenantsOverview.ts']);

/**
 * Statements that may miss `creator_id`, each for a stated reason. Keep this short: an entry is a decision, not a loophole.
 *   - retention sweeps (health.ts): delete rows older than a fixed age for every tenant at once; they read nothing out;
 *   - mirror.ts listObjects: builds its WHERE from an array that starts as `['creator_id = $1']`, which the scan cannot see through.
 */
const RETENTION_SWEEP = /^["'`]DELETE FROM ads_[a-z_]+ WHERE (created_at|day|ran_at) < /;
const DYNAMIC_WHERE_OK = new Set(['src/services/ads/mirror.ts']);

function exempt(file: string, sql: string, text: string): boolean {
    if (RETENTION_SWEEP.test(sql)) return true;
    const rel = file.slice(ROOT.length + 1);
    return DYNAMIC_WHERE_OK.has(rel) && sql.includes("${where.join(' AND ')}") && text.includes("const where = ['creator_id = $1']");
}

function sourceFiles(): string[] {
    const ads = readdirSync(ADS_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testDb.ts' && !CROSS_TENANT_OK.has(f)).map((f) => join(ADS_DIR, f));
    const routes = readdirSync(ROUTES_DIR).filter((f) => /^ads.*\.ts$/.test(f) && !f.endsWith('.test.ts')).map((f) => join(ROUTES_DIR, f));
    return [...ads, ...routes];
}

/** Every string or template literal in a file that reads like SQL on an ads table. */
function sqlStatements(text: string): string[] {
    const out: string[] = [];
    const literal = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;
    for (const m of text.matchAll(literal)) {
        if (TENANT_TABLE.test(m[0]) && /\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(m[0])) out.push(m[0]);
    }
    return out;
}

describe('the ads source keeps every read and write inside one tenant', () => {
    it('finds the files it scans (a scan of nothing proves nothing)', () => {
        assert.ok(sourceFiles().some((f) => f.endsWith('money.ts')), 'money.ts is scanned');
        assert.ok(sqlStatements(readFileSync(join(ADS_DIR, 'money.ts'), 'utf8')).length > 0, 'money.ts has ads SQL to check');
    });

    it('names creator_id in every SQL statement on a tenant ads table', () => {
        const missing: string[] = [];
        for (const file of sourceFiles()) {
            const text = readFileSync(file, 'utf8');
            for (const sql of sqlStatements(text)) {
                if (!/\bcreator_id\b/.test(sql) && !exempt(file, sql, text)) missing.push(`${file.slice(ROOT.length + 1)}: ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
            }
        }
        assert.deepEqual(missing, []);
    });

    it('checks every queued op target before it is sent (ops.ts, once phase A2 has landed)', (t) => {
        const ops = join(ADS_DIR, 'ops.ts');
        if (!existsSync(ops)) return t.skip('ops.ts arrives with phase A2');
        const text = readFileSync(ops, 'utf8');
        const send = text.slice(text.indexOf('export async function sendExec('));
        assert.ok(send.length < text.length, 'sendExec, the one function every send goes through, exists');
        const body = send.slice(0, send.indexOf('\n}\n'));
        assert.ok(body.indexOf('deps.checkTarget(') > 0 && body.indexOf('deps.checkTarget(') < body.indexOf('deps.post('), 'the check runs before the send');
        // The real deps carry the real check, and the check is required by the type (a stub cannot silently omit it).
        assert.match(text, /const realGraph: GraphDeps = \{[^}]*\bcheckTarget\b[^}]*\}/);
        assert.match(text, /\n    checkTarget\(op: [^)]*\): Promise<void>;/);
        const real = text.slice(text.indexOf('async function checkTarget('));
        assert.match(real.slice(0, real.indexOf('\n}\n')), /assertOpTarget\(op\.creatorId, current, \{ path \}, op\.adAccountId\)/);
    });

    it('resolves every :id route through ownObject (adsObjects.ts, once phase A2 has landed)', (t) => {
        const routes = join(ROUTES_DIR, 'adsObjects.ts');
        if (!existsSync(routes)) return t.skip('adsObjects.ts arrives with phase A2');
        assert.match(readFileSync(routes, 'utf8'), /\bownObject\(/);
        // ...and that ownObject is the A11 check, not a lookup of its own.
        const actions = readFileSync(join(ADS_DIR, 'actions.ts'), 'utf8');
        const fn = actions.slice(actions.indexOf('export async function ownObject('));
        const body = fn.slice(0, fn.indexOf('\n}\n'));
        // Its own fast path names the tenant (getObject is keyed by creator_id) and the account; every miss goes through the A11 check.
        assert.match(body, /getObject\(creatorId, id\)/);
        assert.match(body, /row\.adAccountId === adAccountId\) return row;/);
        assert.match(body, /checkOwnObject\(creatorId, adAccountId, id\)/);
        assert.match(body, /NOT_OWN_OBJECT/);
    });
});
