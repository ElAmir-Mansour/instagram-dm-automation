/**
 * Modules per workspace (U3, docs/specs/007-company-shell/contract.md §1 and §12.1): the model, the reading, the writing and the gate's own rules.
 *
 * What is pinned, because each is a way a workspace silently loses (or keeps) a screen:
 *
 *   - **The owner sees no change (I1, I3).** The platform owner's workspace has every available module on, whatever its document says, and cannot be
 *     narrowed: `saveModules` answers 409 `OWNER_ALL_MODULES` and writes nothing.
 *   - **Legacy is everything on (I2).** No document reads as every doc module on; so does one that cannot be read, which says so in the log.
 *   - **`ads` and `explainers` are views** of their own switches, never of the document, and a module whose requirement is off is off.
 *   - **The write is one transaction** (the document, the ceiling, the ads switch), never touches `explainers`, and drops this instance's cache.
 *
 * Driven against the in-memory stand-in for the pool (`monteur/testDb.ts`): `app_settings` is a Map, and `BEGIN` / `COMMIT` are recorded with the rest.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { installFakeDb, type FakeDb } from './monteur/testDb.js';
import { invalidateTenantCache } from './tenant.js';
import { setLogSink } from '../utils/log.js';
import {
    invalidateModulesCache, isModuleOn, modulesForNewWorkspace, MODULE_IDS, MODULE_PRESETS, MODULES, MODULES_CACHE_MS, ModulesError, parseModulesDoc, planModules, readModules,
    resolveRequires, saveModules, viewFrom, type ModuleId,
} from './modules.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const ADMIN_USER = '44444444-4444-4444-8444-444444444444';

const ALL_13: ModuleId[] = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results', 'growth', 'studio', 'explainers', 'ads', 'tiktok', 'youtube', 'whatsapp', 'muse'];
const DOC_11: ModuleId[] = ALL_13.filter((id) => id !== 'explainers' && id !== 'ads');
const COMPANY_5: ModuleId[] = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];

let db: FakeDb;
let settings: Map<string, string>;
let logs: { level: string; event: string; [k: string]: unknown }[];
let restoreSink: (() => void) | undefined;

const doc = (on: string[], over: Record<string, unknown> = {}): string => JSON.stringify({ v: 1, on, preset: 'custom', metaConnect: 'self', ...over });

beforeEach(() => {
    invalidateModulesCache();
    invalidateTenantCache();
    logs = [];
    const previous = setLogSink((level, line) => { logs.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
    settings = new Map();
    db = installFakeDb({ platformTenant: OWNER });
    db.routes.push(
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (settings.has(key) ? { rows: [{ value: settings.get(key), is_secret: false }] } : { rows: [] })],
        [/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES /, ([key, value]) => { settings.set(key, value); return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings WHERE key = \$1$/, ([key]) => ({ rows: [], rowCount: settings.delete(key) ? 1 : 0 })],
    );
});

afterEach(() => {
    mock.timers.reset();
    db.restore();
    restoreSink?.();
    invalidateModulesCache();
});

describe('the model', () => {
    it('lists the fourteen ids once, in the contract\'s order, and one definition for each', () => {
        assert.equal(MODULE_IDS.length, 14);
        assert.equal(new Set(MODULE_IDS).size, 14);
        assert.deepEqual(MODULES.map((m) => m.id), [...MODULE_IDS]);
    });

    it('stores `ads` and `explainers` as views, the knowledge base as not available, and Explainers as the owner\'s alone', () => {
        const by = new Map(MODULES.map((m) => [m.id, m]));
        assert.equal(by.get('ads')!.store, 'ads.enabled');
        assert.equal(by.get('explainers')!.store, 'explainers.enabled');
        assert.equal(by.get('explainers')!.ownerOnly, true);
        assert.equal(by.get('knowledge')!.available, false);
        for (const m of MODULES) if (m.id !== 'ads' && m.id !== 'explainers') assert.equal(m.store, 'doc', m.id);
    });

    it('has the two presets of §1.1: the company\'s five, and the creator\'s eleven (no Ads, no Explainers, no knowledge base)', () => {
        assert.deepEqual([...MODULE_PRESETS.company], COMPANY_5);
        assert.deepEqual([...MODULE_PRESETS.creator].sort(), [...DOC_11].sort());
    });

    it('requires what the contract says: dm_assistant and whatsapp need inbox; tiktok and youtube need the scheduler; muse needs dm_assistant; explainers need studio', () => {
        const needs = Object.fromEntries(MODULES.filter((m) => m.requires.length).map((m) => [m.id, [...m.requires]]));
        assert.deepEqual(needs, {
            dm_assistant: ['inbox'], explainers: ['studio'], tiktok: ['scheduler'], youtube: ['scheduler'], whatsapp: ['inbox'], muse: ['dm_assistant'],
        });
    });
});

describe('the owner sees no change (I1, I3)', () => {
    it('reads every available module on with no document, when his ads and explainers switches are on', async () => {
        settings.set(`ads.enabled.${OWNER}`, 'true');
        settings.set(`explainers.enabled.${OWNER}`, 'true');
        const view = await readModules(OWNER);
        assert.deepEqual(view.on, ALL_13);
        assert.equal(view.owner, true);
        assert.equal(view.stored, false);
        assert.equal(view.metaConnect, 'operator', 'his Connect is the operator\'s own token: no Reconnect, ever');
    });

    it('keeps Ads and Explainers following their own switches, as they always did', async () => {
        const view = await readModules(OWNER);
        assert.deepEqual(view.on, DOC_11, 'both switches off: both off, and nothing else moves');
    });

    it('reads all of them whatever a document written by hand says', async () => {
        settings.set(`ads.enabled.${OWNER}`, 'true');
        settings.set(`explainers.enabled.${OWNER}`, 'true');
        settings.set(`tenant.modules.${OWNER}`, doc(['inbox'], { preset: 'company', metaConnect: 'self' }));
        const view = await readModules(OWNER);
        assert.deepEqual(view.on, ALL_13);
        assert.equal(view.owner, true);
        assert.equal(view.metaConnect, 'operator', 'and a stray document cannot hand him a Connect button');
        assert.equal(await isModuleOn(OWNER, 'studio'), true);
    });

    it('cannot be narrowed: saveModules is 409 OWNER_ALL_MODULES and writes nothing', async () => {
        await assert.rejects(
            () => saveModules(OWNER, { preset: 'company' }, { userId: ADMIN_USER }),
            (err: unknown) => err instanceof ModulesError && err.status === 409 && err.code === 'OWNER_ALL_MODULES',
        );
        assert.deepEqual([...settings.keys()], []);
        assert.deepEqual(db.statements.filter((s) => /^(INSERT|DELETE|BEGIN)/.test(s.sql)), []);
    });

    it('is refused by the pure planner too, before it looks at the input at all', () => {
        for (const input of [undefined, {}, { preset: 'creator' }, { on: ['nonsense'] }, 'not even an object']) {
            const plan = planModules(input, { owner: true, hasCeiling: false });
            assert.deepEqual(plan, { ok: false, status: 409, code: 'OWNER_ALL_MODULES', params: {} }, JSON.stringify(input));
        }
    });
});

describe('legacy: a workspace with no modules document has everything (I2)', () => {
    it('reads every doc module on, and Ads and Explainers as their switches say (off)', async () => {
        const view = await readModules(COMPANY);
        assert.deepEqual(view.on, DOC_11);
        assert.equal(view.owner, false);
        assert.equal(view.stored, false);
        assert.equal(view.preset, null);
        assert.equal(view.metaConnect, 'operator');
    });

    it('adds Ads and Explainers when their own switches are on (a stray Explainers row for a non-owner still reads as it did)', async () => {
        settings.set(`ads.enabled.${COMPANY}`, 'true');
        assert.deepEqual((await readModules(COMPANY)).on, ([...DOC_11, 'ads'] as ModuleId[]).sort((a, b) => MODULE_IDS.indexOf(a) - MODULE_IDS.indexOf(b)));
    });

    it('reads a document that cannot be read as legacy, and says so in the log once per read', async () => {
        for (const bad of ['not json', '[]', '"x"', JSON.stringify({ v: 2, on: ['inbox'] }), JSON.stringify({ v: 1 }), JSON.stringify({ v: 1, on: 'inbox' })]) {
            invalidateModulesCache();
            logs = [];
            settings.set(`tenant.modules.${COMPANY}`, bad);
            const view = await readModules(COMPANY);
            assert.deepEqual(view.on, DOC_11, bad);
            assert.equal(view.stored, false, bad);
            assert.equal(logs.filter((l) => l.event === 'modules.doc_unreadable').length, 1, bad);
        }
    });

    it('drops an unknown id and says which, and never lets a document grant Ads, Explainers or the knowledge base', async () => {
        settings.set(`tenant.modules.${COMPANY}`, doc(['inbox', 'teleporter', 'ads', 'explainers', 'knowledge', 'results']));
        const view = await readModules(COMPANY);
        assert.deepEqual(view.on, ['inbox', 'results']);
        assert.deepEqual(logs.filter((l) => l.event === 'modules.doc_unknown_id').map((l) => l['module']), ['teleporter']);
    });

    it('does not mention an unreadable document for a workspace that has none', async () => {
        await readModules(COMPANY);
        assert.deepEqual(logs.filter((l) => l.event.startsWith('modules.')), []);
    });
});

describe('reading a document', () => {
    it('is the company preset\'s five: the Studio, Growth, Ads and the channels are off', async () => {
        settings.set(`tenant.modules.${COMPANY}`, doc(COMPANY_5, { preset: 'company' }));
        const view = await readModules(COMPANY);
        assert.deepEqual(view.on, COMPANY_5);
        assert.equal(view.stored, true);
        assert.equal(view.preset, 'company');
        assert.equal(view.metaConnect, 'self');
    });

    it('defaults metaConnect to the operator and an odd preset to custom', () => {
        const parsed = parseModulesDoc(JSON.stringify({ v: 1, on: ['inbox'], preset: 'weird', metaConnect: 'whatever' }));
        assert.deepEqual(parsed, { v: 1, on: ['inbox'], preset: 'custom', metaConnect: 'operator' });
    });

    it('turns off a module whose requirement is off, to a fixed point (muse needs dm_assistant needs inbox)', async () => {
        settings.set(`tenant.modules.${COMPANY}`, doc(['dm_assistant', 'muse', 'whatsapp', 'scheduler', 'tiktok']));
        assert.deepEqual((await readModules(COMPANY)).on, ['scheduler', 'tiktok']);
        assert.deepEqual(resolveRequires(['muse', 'dm_assistant']), []);
        assert.deepEqual(resolveRequires(['inbox', 'dm_assistant', 'muse']), ['inbox', 'dm_assistant', 'muse']);
        assert.deepEqual(resolveRequires(['explainers']), []);
    });

    it('puts the modules in MODULE_IDS order whatever order they were stored in', () => {
        assert.deepEqual(parseModulesDoc(doc(['results', 'inbox', 'scheduler']))!['on' as never], ['inbox', 'scheduler', 'results']);
    });

    it('is pure: viewFrom gives the same answer for the same facts', () => {
        const a = viewFrom(null, { ads: false, explainers: false }, false);
        const b = viewFrom(null, { ads: false, explainers: false }, false);
        assert.deepEqual(a, b);
        assert.deepEqual(viewFrom(null, { ads: true, explainers: true }, true).on, ALL_13);
    });

    it('treats a workspace id that is not the shape of one as an error, never a read of somebody else\'s row', async () => {
        await assert.rejects(() => readModules('a/b'));
        await assert.rejects(() => readModules(''));
    });
});

describe('the cache', () => {
    it('answers from memory for MODULES_CACHE_MS, then reads again, and saveModules drops it at once', async () => {
        mock.timers.enable({ apis: ['Date'], now: 1_800_000_000_000 });
        settings.set(`tenant.modules.${COMPANY}`, doc(COMPANY_5, { preset: 'company' }));
        const reads = () => db.ran(/FROM app_settings/).length;
        await readModules(COMPANY);
        const first = reads();
        assert.ok(first >= 3, 'the document and the two switches');
        await readModules(COMPANY);
        assert.equal(reads(), first, 'the second read did not touch the database');
        mock.timers.tick(MODULES_CACHE_MS - 1);
        await readModules(COMPANY);
        assert.equal(reads(), first, 'still inside the window');
        mock.timers.tick(2);
        await readModules(COMPANY);
        assert.ok(reads() > first, 'a read after the window asks again');

        const afterWindow = reads();
        await saveModules(COMPANY, { preset: 'creator' }, { userId: ADMIN_USER });
        const reread = reads();
        await readModules(COMPANY);
        assert.ok(reads() > reread, 'a save forgets the cached answer');
        assert.ok(reads() > afterWindow);
    });

    it('keeps one answer per workspace', async () => {
        settings.set(`tenant.modules.${COMPANY}`, doc(['inbox']));
        assert.deepEqual((await readModules(COMPANY)).on, ['inbox']);
        assert.deepEqual((await readModules(OTHER)).on, DOC_11);
    });
});

describe('planModules: what a change is checked against', () => {
    const ctx = { owner: false, hasCeiling: false };
    const refused = (input: unknown, c = ctx) => { const p = planModules(input, c); assert.equal(p.ok, false, JSON.stringify(input)); return p as Extract<typeof p, { ok: false }>; };

    it('is the company preset with Connect on the workspace when the input says nothing', () => {
        for (const input of [undefined, null, {}]) {
            const plan = planModules(input, ctx);
            assert.deepEqual(plan, { ok: true, doc: { v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'self' }, ads: false, ceiling: null }, JSON.stringify(input));
        }
    });

    it('expands the creator preset, and keeps the label a person chose when they also list the modules', () => {
        const creator = planModules({ preset: 'creator' }, ctx);
        assert.ok(creator.ok);
        assert.deepEqual([...creator.doc.on].sort(), [...DOC_11].sort());
        const edited = planModules({ preset: 'company', on: ['inbox', 'results'] }, ctx);
        assert.ok(edited.ok);
        assert.deepEqual(edited.doc, { v: 1, on: ['inbox', 'results'], preset: 'company', metaConnect: 'self' });
        const custom = planModules({ on: ['inbox'], metaConnect: 'operator' }, ctx);
        assert.ok(custom.ok);
        assert.equal(custom.doc.preset, 'custom');
        assert.equal(custom.doc.metaConnect, 'operator');
    });

    it('refuses an unknown module (400 MODULE_UNKNOWN) and names it', () => {
        assert.deepEqual(refused({ on: ['inbox', 'nope'] }), { ok: false, status: 400, code: 'MODULE_UNKNOWN', params: { module: 'nope' } });
        assert.equal(refused({ preset: 'dream' }).code, 'MODULE_UNKNOWN');
        assert.equal(refused({ on: 'inbox' }).code, 'MODULE_UNKNOWN');
        assert.equal(refused({ metaConnect: 'both' }).code, 'MODULE_UNKNOWN');
        assert.equal(refused('x').code, 'MODULE_UNKNOWN');
    });

    it('refuses the knowledge base (400 MODULE_NOT_AVAILABLE)', () => {
        assert.deepEqual(refused({ on: ['inbox', 'knowledge'] }), { ok: false, status: 400, code: 'MODULE_NOT_AVAILABLE', params: { module: 'knowledge' } });
    });

    it('refuses a module without what it needs, and names both (400 MODULE_NEEDS); it checks and never adds', () => {
        assert.deepEqual(refused({ on: ['muse'] }), { ok: false, status: 400, code: 'MODULE_NEEDS', params: { module: 'muse', needs: 'dm_assistant' } });
        assert.deepEqual(refused({ on: ['inbox', 'tiktok'] }), { ok: false, status: 400, code: 'MODULE_NEEDS', params: { module: 'tiktok', needs: 'scheduler' } });
        assert.deepEqual(refused({ on: ['dm_assistant'] }), { ok: false, status: 400, code: 'MODULE_NEEDS', params: { module: 'dm_assistant', needs: 'inbox' } });
        const fine = planModules({ on: ['inbox', 'dm_assistant', 'muse'] }, ctx);
        assert.ok(fine.ok);
        assert.deepEqual(fine.doc.on, ['inbox', 'dm_assistant', 'muse']);
    });

    it('refuses Explainers for a workspace that is not the owner\'s (409 EXPLAINERS_OWNER_ONLY)', () => {
        assert.equal(refused({ on: ['studio', 'explainers'] }).code, 'EXPLAINERS_OWNER_ONLY');
        assert.equal(refused({ on: ['studio', 'explainers'] }).status, 409);
    });

    it('refuses Ads with no ceiling, stored or given (409 CEILING_REQUIRED), and takes the ceiling it is given or the one already stored', () => {
        assert.deepEqual(refused({ on: ['inbox', 'ads'] }), { ok: false, status: 409, code: 'CEILING_REQUIRED', params: { module: 'ads' } });
        assert.equal(refused({ on: ['ads'], adsCeiling: { maxDailyBudget: 50, monthlyCap: 10 } }).code, 'CEILING_REQUIRED', 'a daily limit above the monthly one is no ceiling');
        assert.equal(refused({ on: ['ads'], adsCeiling: { maxDailyBudget: 0, monthlyCap: 10 } }).code, 'CEILING_REQUIRED');
        const given = planModules({ on: ['ads'], adsCeiling: { maxDailyBudget: 20, monthlyCap: 300 } }, ctx);
        assert.ok(given.ok);
        assert.deepEqual(given.ceiling, { maxDailyBudget: 20, monthlyCap: 300 });
        assert.equal(given.ads, true);
        assert.deepEqual(given.doc.on, [], '`ads` is not stored in the document: it is a view of its own switch');
        const stored = planModules({ on: ['ads'] }, { owner: false, hasCeiling: true });
        assert.ok(stored.ok);
        assert.equal(stored.ceiling, null);
        assert.equal(stored.ads, true);
    });
});

describe('saveModules', () => {
    it('writes the document, then (for Ads) the ceiling and the switch, in ONE transaction, and answers the view it wrote', async () => {
        const view = await saveModules(
            COMPANY, { preset: 'custom', on: ['inbox', 'results', 'ads'], metaConnect: 'self', adsCeiling: { maxDailyBudget: 10, monthlyCap: 100 } }, { userId: ADMIN_USER },
        );
        assert.deepEqual(view, { on: ['inbox', 'results', 'ads'], owner: false, stored: true, preset: 'custom', metaConnect: 'self' });
        assert.deepEqual(JSON.parse(settings.get(`tenant.modules.${COMPANY}`)!), { v: 1, on: ['inbox', 'results'], preset: 'custom', metaConnect: 'self' });
        assert.deepEqual(JSON.parse(settings.get(`ads.ceiling.${COMPANY}`)!), { maxDailyBudget: 10, monthlyCap: 100 });
        assert.equal(settings.get(`ads.enabled.${COMPANY}`), 'true');
        const writes = db.statements.filter((s) => /^(BEGIN|COMMIT|ROLLBACK|INSERT INTO app_settings|DELETE FROM app_settings)/.test(s.sql)).map((s) => (/^(BEGIN|COMMIT|ROLLBACK)/.test(s.sql) ? s.sql : String(s.params[0])));
        assert.deepEqual(writes, ['BEGIN', `tenant.modules.${COMPANY}`, `ads.ceiling.${COMPANY}`, `ads.enabled.${COMPANY}`, 'COMMIT']);
    });

    it('switches Ads off by removing its switch row, and never writes the Explainers switch', async () => {
        settings.set(`ads.enabled.${COMPANY}`, 'true');
        settings.set(`ads.ceiling.${COMPANY}`, JSON.stringify({ maxDailyBudget: 10, monthlyCap: 100 }));
        await saveModules(COMPANY, { preset: 'company' }, { userId: ADMIN_USER });
        assert.equal(settings.has(`ads.enabled.${COMPANY}`), false);
        assert.ok(settings.has(`ads.ceiling.${COMPANY}`), 'the ceiling stays: switching Ads on again needs no new one');
        assert.deepEqual(db.statements.filter((s) => /explainers\.enabled/.test(JSON.stringify(s.params)) && /^(INSERT|DELETE)/.test(s.sql)), []);
    });

    it('refuses with the planner\'s refusal and writes nothing at all', async () => {
        await assert.rejects(
            () => saveModules(COMPANY, { on: ['muse'] }, { userId: ADMIN_USER }),
            (err: unknown) => err instanceof ModulesError && err.status === 400 && err.code === 'MODULE_NEEDS' && err.params['module'] === 'muse' && err.params['needs'] === 'dm_assistant',
        );
        await assert.rejects(
            () => saveModules(COMPANY, { on: ['ads'] }, { userId: ADMIN_USER }),
            (err: unknown) => err instanceof ModulesError && err.code === 'CEILING_REQUIRED',
        );
        assert.deepEqual([...settings.keys()], []);
        assert.deepEqual(db.statements.filter((s) => /^(INSERT|DELETE|BEGIN)/.test(s.sql)), []);
    });

    it('keeps what it is not told about: a change of Connect alone leaves the modules exactly as they are (a legacy workspace stays on everything)', async () => {
        const view = await saveModules(COMPANY, { metaConnect: 'self' }, { userId: ADMIN_USER });
        assert.deepEqual(view.on, DOC_11);
        assert.equal(view.metaConnect, 'self');
        assert.deepEqual(JSON.parse(settings.get(`tenant.modules.${COMPANY}`)!).on, DOC_11);
    });

    it('keeps the stored Connect choice when only the modules change', async () => {
        settings.set(`tenant.modules.${COMPANY}`, doc(COMPANY_5, { preset: 'company', metaConnect: 'self' }));
        const view = await saveModules(COMPANY, { preset: 'creator' }, { userId: ADMIN_USER });
        assert.equal(view.metaConnect, 'self');
        assert.equal(view.preset, 'creator');
    });

    it('joins a transaction it is given (so creating a workspace stores them with the workspace), and does not open another', async () => {
        const client = { query: async (sql: string, params?: unknown[]) => { const flat = sql.replace(/\s+/g, ' ').trim(); db.statements.push({ sql: `TX ${flat}`, params: params ?? [] }); settings.set(String(params?.[0]), String(params?.[1])); return { rows: [], rowCount: 1 }; } };
        await saveModules(COMPANY, { preset: 'company' }, { userId: null }, client as never);
        assert.deepEqual(db.statements.filter((s) => s.sql === 'BEGIN'), []);
        assert.ok(db.statements.some((s) => s.sql.startsWith('TX INSERT INTO app_settings') && s.params[0] === `tenant.modules.${COMPANY}`));
    });
});

describe('the platform owner is read from the creators table, case-insensitively', () => {
    it('is the first creator ever made, and nobody else', async () => {
        assert.equal((await readModules(OWNER)).owner, true);
        assert.equal((await readModules(OWNER.toUpperCase())).owner, true);
        assert.equal((await readModules(COMPANY)).owner, false);
    });
});

describe('modulesForNewWorkspace: what a create body\'s `modules` means', () => {
    it('is the company preset that connects its own Meta when there is nothing, and when the body names neither a preset nor a list', () => {
        assert.deepEqual(modulesForNewWorkspace(undefined), { preset: 'company', metaConnect: 'self' });
        assert.deepEqual(modulesForNewWorkspace(null), { preset: 'company', metaConnect: 'self' });
        assert.deepEqual(modulesForNewWorkspace({}), { preset: 'company', metaConnect: 'self' });
        assert.deepEqual(modulesForNewWorkspace({ metaConnect: 'operator' }), { preset: 'company', metaConnect: 'operator' });
    });

    it('keeps what it is given, and never changes the object it was handed', () => {
        const given = { on: ['inbox'] };
        assert.deepEqual(modulesForNewWorkspace(given), { on: ['inbox'], metaConnect: 'self' });
        assert.deepEqual(given, { on: ['inbox'] });
        assert.deepEqual(modulesForNewWorkspace({ preset: 'creator', metaConnect: 'operator' }), { preset: 'creator', metaConnect: 'operator' });
    });

    it('passes anything that is not an object on untouched, for the planner to refuse', () => {
        for (const bad of ['company', 7, true, ['inbox']]) assert.equal(modulesForNewWorkspace(bad), bad);
    });
});
