/**
 * The 30-day clean-up (U2): what the sweep puts away, for whom, and how it says so.
 *
 * `pool.query` is stubbed, like attention.test.ts: what the statements exclude (a post that is not failed, one already archived, a future-dated
 * placeholder, another tenant, a thread already handled) is decided in SQL, so the clause is pinned as text, and the sweep's behaviour (a tenant that
 * switched it off is skipped, one tenant's failure does not stop the next, every tenant that had something is audited) is run against the stub.
 * The setting's route is run through its whole stack (role guard, validation, audit) in the second half. Nothing here reaches Postgres or Meta.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import apiRouter from '../routes/api.js';
import { setLogSink } from '../utils/log.js';
import { THREADS_NEEDING_PERSON_SQL } from './attention.js';
import {
    ARCHIVE_OLD_FAILED_POSTS_SQL, AUTO_ARCHIVE_ACTOR_EMAIL, AUTO_ARCHIVE_DEFAULT, HANDLE_EXPIRED_THREADS_SQL, parseAutoArchive, runAutoArchiveSweep, validDays,
} from './autoArchive.js';
import { AUDIT_ACTIONS, isAuditAction } from './audit.js';

const flat = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

describe('parseAutoArchive: ON at 30 days unless the owner said otherwise, read strictly', () => {
    it('nothing saved is the default: on, 30 days', () => {
        assert.deepEqual(parseAutoArchive(null), { enabled: true, days: 30 });
        assert.deepEqual(parseAutoArchive(undefined), AUTO_ARCHIVE_DEFAULT);
        assert.deepEqual(parseAutoArchive(''), AUTO_ARCHIVE_DEFAULT);
    });
    it('is off only when it says exactly false', () => {
        assert.deepEqual(parseAutoArchive('{"enabled":false,"days":60}'), { enabled: false, days: 60 });
        assert.equal(parseAutoArchive('{"enabled":"false","days":60}').enabled, true);
        assert.equal(parseAutoArchive('{"days":14}').enabled, true);
    });
    it('a damaged value, or days outside 7-365, is the default, never a guess', () => {
        assert.deepEqual(parseAutoArchive('not json'), AUTO_ARCHIVE_DEFAULT);
        assert.deepEqual(parseAutoArchive('[1,2]'), AUTO_ARCHIVE_DEFAULT);
        assert.equal(parseAutoArchive('{"enabled":true,"days":3}').days, 30);
        assert.equal(parseAutoArchive('{"enabled":true,"days":400}').days, 30);
        assert.equal(parseAutoArchive('{"enabled":true,"days":10.5}').days, 30);
    });
    it('validDays takes a whole number from 7 to 365, as a number or a numeric string', () => {
        assert.equal(validDays(7), 7);
        assert.equal(validDays('45'), 45);
        assert.equal(validDays(365), 365);
        for (const bad of [6, 366, 0, -1, 7.5, '', 'abc', null, undefined, NaN]) assert.equal(validDays(bad), null, String(bad));
    });
});

describe('the statements', () => {
    it('posts: only FAILED, only unarchived, only older than the days, only this tenant; archived, never deleted', () => {
        const sql = flat(ARCHIVE_OLD_FAILED_POSTS_SQL);
        assert.match(sql, /^UPDATE scheduled_posts SET archived_at = NOW\(\)/);
        assert.match(sql, /creator_id = \$1/);
        assert.match(sql, /status = 'FAILED'/);
        assert.match(sql, /archived_at IS NULL/);
        assert.match(sql, /scheduled_time < NOW\(\) - make_interval\(days => \$2::int\)/);
        assert.equal(/DELETE/i.test(sql), false);
    });
    it('threads: the attention summary’s own rule (one text, not a copy), unhandled only, older than the days, this tenant', () => {
        const sql = flat(HANDLE_EXPIRED_THREADS_SQL);
        assert.match(sql, /^UPDATE conversations SET handled_at = NOW\(\)/);
        assert.ok(sql.includes(flat(THREADS_NEEDING_PERSON_SQL)), 'the same inner select the counts use');
        assert.match(sql, /handled_at IS NULL/);
        assert.match(sql, /t\.since < NOW\(\) - make_interval\(days => \$2::int\)/);
        assert.match(sql, /creator_id = \$1/);
    });
});

// ─── the sweep ───────────────────────────────────────────────────────────────────────────────

interface Sent { sql: string; params: unknown[] }
let sent: Sent[];
let audits: Array<{ actor: unknown; action: string; targetId: unknown; detail: any }>;
let restoreSink: () => void;
const originalQuery = pool.query;
type Answers = { creators: string[]; settings: Array<{ key: string; value: string }>; posts?: Record<string, number>; threads?: Record<string, number>; boom?: string };

function arrange(a: Answers) {
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const text = flat(sql);
        sent.push({ sql: text, params });
        if (text === 'SELECT id FROM creators') return { rows: a.creators.map((id) => ({ id })), rowCount: a.creators.length };
        if (/FROM app_settings WHERE key LIKE/.test(text)) return { rows: a.settings, rowCount: a.settings.length };
        if (/INSERT INTO audit_log/.test(text)) {
            audits.push({ actor: params[1], action: String(params[2]), targetId: params[4], detail: JSON.parse(String(params[5])) });
            return { rows: [{ id: 'a' }], rowCount: 1 };
        }
        const tenant = String(params[0]);
        if (a.boom === tenant) throw new Error('db is down');
        const n = text === flat(ARCHIVE_OLD_FAILED_POSTS_SQL) ? (a.posts?.[tenant] ?? 0) : (a.threads?.[tenant] ?? 0);
        const rows = Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
        return { rows, rowCount: rows.length };
    };
}

beforeEach(() => {
    sent = [];
    audits = [];
    const previous = setLogSink(() => {});
    restoreSink = () => setLogSink(previous);
});
afterEach(() => {
    (pool as unknown as { query: unknown }).query = originalQuery;
    restoreSink();
});

describe('runAutoArchiveSweep', () => {
    it('sweeps every tenant at 30 days by default, with the days bound as a parameter, and audits only the tenants that had something', async () => {
        arrange({ creators: [A, B], settings: [], posts: { [A]: 2 }, threads: { [A]: 1 } });
        const out = await runAutoArchiveSweep();
        assert.deepEqual(out, { tenants: 2, posts: 2, threads: 1, failed: 0 });
        const updates = sent.filter((s) => /^UPDATE/.test(s.sql));
        assert.equal(updates.length, 4);
        for (const u of updates) assert.equal(u.params[1], 30);
        assert.deepEqual(updates.map((u) => u.params[0]), [A, A, B, B]);
        assert.equal(audits.length, 1, 'B had nothing: no row');
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.cleanupAutoArchive);
        assert.equal(audits[0]!.actor, AUTO_ARCHIVE_ACTOR_EMAIL);
        assert.equal(audits[0]!.targetId, A);
        assert.deepEqual(audits[0]!.detail, { posts: 2, threads: 1, days: 30 });
    });

    it('skips a tenant that switched it off, and uses the days a tenant chose', async () => {
        arrange({
            creators: [A, B, C],
            settings: [{ key: `cleanup.auto_archive.${A}`, value: '{"enabled":false,"days":30}' }, { key: `cleanup.auto_archive.${B}`, value: '{"enabled":true,"days":90}' }],
            posts: { [A]: 5, [B]: 1, [C]: 1 },
        });
        const out = await runAutoArchiveSweep();
        assert.equal(out.tenants, 2);
        assert.equal(sent.some((s) => /^UPDATE/.test(s.sql) && s.params[0] === A), false, 'the tenant that said no is never touched');
        assert.deepEqual(sent.filter((s) => /^UPDATE/.test(s.sql) && s.params[0] === B).map((s) => s.params[1]), [90, 90]);
        assert.deepEqual(sent.filter((s) => /^UPDATE/.test(s.sql) && s.params[0] === C).map((s) => s.params[1]), [30, 30]);
    });

    it('one tenant failing is counted and does not stop the next', async () => {
        arrange({ creators: [A, B], settings: [], posts: { [B]: 3 }, boom: A });
        const out = await runAutoArchiveSweep();
        assert.deepEqual(out, { tenants: 2, posts: 3, threads: 0, failed: 1 });
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.targetId, B);
    });

    it('an audit detail carries counts and the limit, never a name or a message', async () => {
        arrange({ creators: [A], settings: [], posts: { [A]: 1 }, threads: { [A]: 1 } });
        await runAutoArchiveSweep();
        assert.deepEqual(Object.keys(audits[0]!.detail).sort(), ['days', 'posts', 'threads']);
    });
});

// ─── the setting's route ─────────────────────────────────────────────────────────────────────

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
function stackFor(method: string, path: string): Handle[] {
    const stack = (apiRouter as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }> }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}
const fakeRes = () => ({
    statusCode: 200, body: null as any,
    status(code: number) { this.statusCode = code; return this; }, set() { return this; }, json(p: unknown) { this.body = p; return this; },
});
async function run(method: string, role: 'owner' | 'operator' | 'viewer', body: unknown = {}) {
    const res = fakeRes();
    const req = { query: {}, params: {}, body, session: { userId: 'u-owner', role: 'user', tenantId: A }, tenantRole: role, headers: {}, originalUrl: '/api/settings/auto-archive' };
    for (const handle of stackFor(method, '/settings/auto-archive')) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

function arrangeSettings(stored: string | null) {
    (pool as unknown as { query: unknown }).query = async (sql: string, params: unknown[] = []) => {
        const text = flat(sql);
        sent.push({ sql: text, params });
        if (/FROM users WHERE id = \$1/.test(text)) return { rows: [{ email: 'owner@example.test' }], rowCount: 1 };
        if (/INSERT INTO audit_log/.test(text)) {
            audits.push({ actor: params[1], action: String(params[2]), targetId: params[4], detail: JSON.parse(String(params[5])) });
            return { rows: [{ id: 'a' }], rowCount: 1 };
        }
        if (/SELECT value, is_secret FROM app_settings/.test(text)) return { rows: stored ? [{ value: stored, is_secret: false }] : [], rowCount: stored ? 1 : 0 };
        if (/INSERT INTO app_settings/.test(text)) return { rows: [], rowCount: 1 };
        throw new Error(`unexpected SQL ${text.slice(0, 80)}`);
    };
}

describe('GET and POST /settings/auto-archive', () => {
    it('the owner reads the default when nothing is saved: on, 30 days, with the limits', async () => {
        arrangeSettings(null);
        const res = await run('get', 'owner');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body, { enabled: true, days: 30, minDays: 7, maxDays: 365, defaultDays: 30 });
    });

    it('an operator and a viewer may read it but not change it: the switch is the owner’s', async () => {
        arrangeSettings(null);
        for (const role of ['operator', 'viewer'] as const) {
            assert.equal((await run('get', role)).statusCode, 200, role);
            assert.equal((await run('post', role, { enabled: false, days: 30 })).statusCode, 403, role);
        }
        assert.equal(sent.some((s) => /INSERT INTO app_settings/.test(s.sql)), false);
    });

    it('saves for the session’s tenant only, and audits a change with the two values and no content', async () => {
        arrangeSettings(null);
        const res = await run('post', 'owner', { enabled: false, days: 45 });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.enabled, false);
        assert.equal(res.body.days, 45);
        const write = sent.find((s) => /INSERT INTO app_settings/.test(s.sql))!;
        assert.equal(write.params[0], `cleanup.auto_archive.${A}`);
        assert.deepEqual(JSON.parse(String(write.params[1])), { enabled: false, days: 45 });
        assert.equal(audits.length, 1);
        assert.equal(audits[0]!.action, AUDIT_ACTIONS.settingsAutoArchiveWrite);
        assert.equal(isAuditAction(audits[0]!.action), true);
        assert.deepEqual(audits[0]!.detail, { enabled: false, days: 45, was_enabled: true, was_days: 30 });
    });

    it('a save that changes nothing writes no audit row', async () => {
        arrangeSettings('{"enabled":true,"days":30}');
        const res = await run('post', 'owner', { enabled: true, days: 30 });
        assert.equal(res.statusCode, 200);
        assert.equal(audits.length, 0);
    });

    it('refuses what is not valid, naming the field, and writes nothing', async () => {
        arrangeSettings(null);
        for (const [body, field] of [[{ enabled: 'yes', days: 30 }, 'enabled'], [{ enabled: true, days: 3 }, 'days'], [{ enabled: true }, 'days'], [{ enabled: true, days: 'x' }, 'days'], [{}, 'enabled']] as const) {
            const res = await run('post', 'owner', body);
            assert.equal(res.statusCode, 400, JSON.stringify(body));
            assert.equal(res.body.field, field);
        }
        assert.equal(sent.some((s) => /INSERT INTO app_settings/.test(s.sql)), false);
    });
});
