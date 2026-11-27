/**
 * The platform admin's modules API (U3, contract §3.1 and §12.2): `POST /api/admin/tenants` taking `modules` and `owner_email`, and
 * `GET` / `PUT /api/admin/tenants/:id/modules`.
 *
 * What is pinned, because each is a way a workspace gets the wrong parts of the product:
 *
 *   - **No `modules` in a create body stores the company preset**, with Connect on the workspace (`self`): a company is made by name, and gets the five
 *     modules a company needs.
 *   - **A refusal creates nothing.** Modules are validated BEFORE the transaction opens, so `MODULE_NEEDS`, `MODULE_NOT_AVAILABLE` and `CEILING_REQUIRED`
 *     leave no `creators` row behind, no profile, no onboarding row and no setting.
 *   - **A create stores its modules in the creation transaction** (the document, the ceiling, the Ads switch), so there is never a workspace without them.
 *   - **`PUT` writes the document, `ads.enabled.<t>` and the ceiling in ONE transaction**, audits `tenant.modules_changed` with the modules and the Connect
 *     mode before and after, and refuses the platform owner's own workspace (409 `OWNER_ALL_MODULES`) and everything the planner refuses, with the code and
 *     params the dashboard translates (`errors.<CODE>`).
 *   - **`owner_email` is normalised and goes to the creation link**; a bad one is 400 `BAD_EMAIL` before anything is written.
 *
 * Driven through the admin router with a plain request object, against the in-memory stand-in for the profile tables (`profile/testDb.ts`) plus the
 * tables the route writes. Meta is never reached: these are tenants made by name.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { invalidateModulesCache } from '../services/modules.js';
import { installProfileDb, OWNER, type ProfileDb, seededState, setPlatformOwner, type State, USER } from '../services/profile/testDb.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';

const NEW = '55555555-5555-4555-8555-555555555555';
const EXISTING = '66666666-6666-4666-8666-666666666666';
const SESSION = { userId: USER, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };

const COMPANY_5 = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
const DOC_11_IN_ORDER = [...COMPANY_5, 'growth', 'studio', 'tiktok', 'youtube', 'whatsapp', 'muse'];
const DOC_11 = [...DOC_11_IN_ORDER].sort();

interface Reply { status: number; body: any }

function call(method: string, url: string, body?: unknown, session: typeof SESSION | undefined = SESSION): Promise<Reply> {
    return new Promise((resolve) => {
        const params: Record<string, string> = {};
        const m = /\/tenants\/([^/]+)(?:\/|$)/.exec(url);
        if (m) params['id'] = m[1]!;
        const req = { method: method.toUpperCase(), url, originalUrl: url, body, query: {}, params, headers: {}, session } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        adminRouter(req, res, () => resolve({ status: 0, body: null }));
    });
}

let state: State;
let db: ProfileDb;
let settings: Record<string, string>;
let creators: Map<string, Record<string, unknown>>;
let onboarding: Set<string>;
let invites: Array<Record<string, any>>;
let audits: { action: string; targetId: string | null; detail: Record<string, any> }[];
let restoreSink: (() => void) | undefined;
let logs: { event: string }[];

beforeEach(() => {
    state = seededState();
    db = installProfileDb(state);
    setPlatformOwner(db, OWNER);
    invalidateModulesCache();
    settings = { 'app.public_base_url': 'https://app.test' };
    creators = new Map([[EXISTING, { id: EXISTING, name: 'Existing' }]]);
    onboarding = new Set();
    invites = [];
    audits = [];
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(JSON.parse(line)); });
    restoreSink = () => setLogSink(previous);

    let snapshot: { creators: typeof creators; onboarding: typeof onboarding; settings: typeof settings } | null = null;
    db.onStatement = (flat) => {
        if (flat === 'BEGIN') snapshot = { creators: structuredClone(creators), onboarding: structuredClone(onboarding), settings: structuredClone(settings) };
        else if (flat === 'ROLLBACK' && snapshot) { creators = snapshot.creators; onboarding = snapshot.onboarding; settings = snapshot.settings; snapshot = null; }
        else if (flat === 'COMMIT') snapshot = null;
    };
    db.routes.push(
        [/^INSERT INTO creators /, ([name]) => {
            const row = { id: NEW, name, instagram_page_id: null, facebook_page_id: null, instagram_username: null, website_url: null, is_active: true, token_status: 'unknown', created_at: new Date('2026-11-28T10:00:00Z') };
            creators.set(NEW, row);
            return { rows: [row] };
        }],
        [/^INSERT INTO onboarding \(creator_id, status\) VALUES/, ([id]) => { onboarding.add(id); return { rows: [] }; }],
        [/^UPDATE studio_settings SET monteur = COALESCE/, () => ({ rows: [], rowCount: 0 })],
        [/^INSERT INTO ai_agents /, () => ({ rows: [] })],
        [/^SELECT id FROM creators WHERE id = \$1$/, ([id]) => ({ rows: creators.has(id) || id === OWNER ? [{ id }] : [] })],
        [/^SELECT id, name, is_active FROM creators WHERE id = \$1$/, ([id]) => ({ rows: creators.has(id) ? [{ id, name: String(creators.get(id)!['name']), is_active: true }] : [] })],
        [/^INSERT INTO invites \(token_hash,/, ([hash, creatorId, email, role, purpose, userId, createdBy, expiresAt]) => {
            const row = { id: `invite-${invites.length + 1}`, token_hash: hash, creator_id: creatorId, email, membership_role: role, purpose, user_id: userId, created_by: createdBy, created_at: new Date(), expires_at: expiresAt, first_opened_at: null, open_count: 0, used_at: null, revoked_at: null };
            invites.push(row);
            return { rows: [row] };
        }],
        [/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, ([key]) => (settings[key] === undefined ? { rows: [] } : { rows: [{ value: settings[key], is_secret: false }] })],
        [/^INSERT INTO app_settings \(key, value, is_secret, updated_at, updated_by\) VALUES /, ([key, value]) => { settings[key] = value; return { rows: [], rowCount: 1 }; }],
        [/^DELETE FROM app_settings WHERE key = \$1$/, ([key]) => { const had = key in settings; delete settings[key]; return { rows: [], rowCount: had ? 1 : 0 }; }],
        [/^SELECT email FROM users WHERE id = \$1$/, () => ({ rows: [{ email: 'operator@example.com' }] })],
        [/^INSERT INTO audit_log /, ([, , action, , targetId, detail]) => { audits.push({ action, targetId, detail: JSON.parse(detail) }); return { rows: [{ id: 'audit-1' }] }; }],
    );
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    invalidateModulesCache();
});

const doc = (id: string) => JSON.parse(settings[`tenant.modules.${id}`]!);
const nothingCreated = () => {
    assert.equal(creators.has(NEW), false, 'no creators row');
    assert.equal(db.ran(/^INSERT INTO creators /).length, 0, 'no insert was even sent');
    assert.equal(state.profiles.has(NEW), false, 'no profile');
    assert.equal(onboarding.size, 0, 'no onboarding row');
    assert.deepEqual(Object.keys(settings).filter((k) => k !== 'app.public_base_url'), [], 'no setting');
    assert.deepEqual(audits, [], 'nothing audited');
};

describe('POST /api/admin/tenants, by name, with modules', () => {
    it('stores the company preset when the body has no modules, with Connect on the workspace, and answers the view', async () => {
        const reply = await call('POST', '/tenants', { name: 'The Knowledge Hub', lang: 'ar' });
        assert.equal(reply.status, 201);
        assert.deepEqual(doc(NEW), { v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'self' });
        assert.deepEqual(reply.body.modules, { on: COMPANY_5, owner: false, stored: true, preset: 'company', metaConnect: 'self' });
        assert.equal(settings[`ads.enabled.${NEW}`], undefined, 'Ads stays off');
    });

    it('stores what it is given: the creator preset, a custom list, and the operator connecting for them', async () => {
        const creator = await call('POST', '/tenants', { name: 'Creator', modules: { preset: 'creator' } });
        assert.deepEqual(doc(NEW).on.slice().sort(), DOC_11);
        assert.equal(doc(NEW).preset, 'creator');
        assert.equal(creator.body.modules.metaConnect, 'self');

        creators.clear(); state.profiles.clear(); state.versions.length = 0; settings = { 'app.public_base_url': 'https://app.test' }; invalidateModulesCache();
        const custom = await call('POST', '/tenants', { name: 'Custom', modules: { on: ['inbox', 'results'], metaConnect: 'operator' } });
        assert.equal(custom.status, 201);
        assert.deepEqual(doc(NEW), { v: 1, on: ['inbox', 'results'], preset: 'custom', metaConnect: 'operator' });

        creators.clear(); state.profiles.clear(); state.versions.length = 0; settings = { 'app.public_base_url': 'https://app.test' }; invalidateModulesCache();
        const justConnect = await call('POST', '/tenants', { name: 'Only Connect', modules: { metaConnect: 'operator' } });
        assert.equal(justConnect.status, 201);
        assert.deepEqual(doc(NEW), { v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'operator' }, 'a body that names no modules still gets the company preset');
    });

    it('writes the modules inside the creation transaction, after the creators row and before the commit', async () => {
        await call('POST', '/tenants', { name: 'Nour' });
        const order = db.statements.map((s) => s.sql).filter((sql) => /^(BEGIN|COMMIT|INSERT INTO creators|INSERT INTO app_settings|INSERT INTO onboarding)/.test(sql)).map((sql) => sql.split(' (')[0]!);
        assert.deepEqual(order.slice(0, order.indexOf('COMMIT') + 1), ['BEGIN', 'INSERT INTO creators', 'INSERT INTO app_settings', 'INSERT INTO onboarding', 'COMMIT']);
    });

    it('Ads in the creation: stores the ceiling and the switch with the workspace, both in that one transaction', async () => {
        const reply = await call('POST', '/tenants', { name: 'Shop', modules: { preset: 'company', on: [...COMPANY_5, 'ads'], adsCeiling: { maxDailyBudget: 15, monthlyCap: 200 } } });
        assert.equal(reply.status, 201);
        assert.equal(settings[`ads.enabled.${NEW}`], 'true');
        assert.deepEqual(JSON.parse(settings[`ads.ceiling.${NEW}`]!), { maxDailyBudget: 15, monthlyCap: 200 });
        assert.deepEqual(doc(NEW).on, COMPANY_5, 'and `ads` is not in the document');
        assert.ok(reply.body.modules.on.includes('ads'));
        const keys = db.statements.filter((s) => /^(INSERT INTO app_settings|DELETE FROM app_settings)/.test(s.sql)).map((s) => s.params[0]);
        assert.deepEqual(keys, [`tenant.modules.${NEW}`, `ads.ceiling.${NEW}`, `ads.enabled.${NEW}`]);
    });

    it('refuses a module without what it needs: 400 MODULE_NEEDS { module: muse, needs: dm_assistant }, and creates NOTHING', async () => {
        const reply = await call('POST', '/tenants', { name: 'Nour', modules: { on: ['muse'] } });
        assert.equal(reply.status, 400);
        assert.equal(reply.body.code, 'MODULE_NEEDS');
        assert.deepEqual(reply.body.params, { module: 'muse', needs: 'dm_assistant' });
        assert.equal(typeof reply.body.error, 'string');
        assert.equal(reply.body.message, reply.body.error);
        nothingCreated();
    });

    it('refuses the knowledge base (400 MODULE_NOT_AVAILABLE) and an unknown module (400 MODULE_UNKNOWN), creating nothing', async () => {
        const knowledge = await call('POST', '/tenants', { name: 'Nour', modules: { on: ['inbox', 'knowledge'] } });
        assert.equal(knowledge.status, 400);
        assert.equal(knowledge.body.code, 'MODULE_NOT_AVAILABLE');
        assert.deepEqual(knowledge.body.params, { module: 'knowledge' });
        nothingCreated();
        const unknown = await call('POST', '/tenants', { name: 'Nour', modules: { on: ['inbox', 'teleporter'] } });
        assert.equal(unknown.body.code, 'MODULE_UNKNOWN');
        nothingCreated();
    });

    it('refuses Ads without a ceiling (409 CEILING_REQUIRED), and Explainers for a new workspace (409 EXPLAINERS_OWNER_ONLY), creating nothing', async () => {
        const ads = await call('POST', '/tenants', { name: 'Nour', modules: { on: [...COMPANY_5, 'ads'] } });
        assert.equal(ads.status, 409);
        assert.equal(ads.body.code, 'CEILING_REQUIRED');
        nothingCreated();
        const explainers = await call('POST', '/tenants', { name: 'Nour', modules: { on: ['studio', 'explainers'] } });
        assert.equal(explainers.status, 409);
        assert.equal(explainers.body.code, 'EXPLAINERS_OWNER_ONLY');
        nothingCreated();
    });

    it('refuses a `modules` that is not an object, creating nothing', async () => {
        for (const bad of ['company', 7, ['inbox']]) {
            const reply = await call('POST', '/tenants', { name: 'Nour', modules: bad });
            assert.equal(reply.status, 400, JSON.stringify(bad));
            assert.equal(reply.body.code, 'MODULE_UNKNOWN', JSON.stringify(bad));
            nothingCreated();
        }
    });

    it('rolls its modules back if anything later in the transaction fails: a workspace is never left half made', async () => {
        db.routes.unshift([/^INSERT INTO onboarding /, () => { throw new Error('boom'); }]);
        const reply = await call('POST', '/tenants', { name: 'Nour' });
        assert.equal(reply.status, 500);
        assert.deepEqual(Object.keys(settings).filter((k) => k.startsWith('tenant.modules.') || k.startsWith('ads.')), []);
        assert.equal(creators.has(NEW), false);
    });

    it('audits the modules, the preset and the Connect mode on the tenant.create row, not a second row', async () => {
        await call('POST', '/tenants', { name: 'Nour', modules: { preset: 'creator', metaConnect: 'operator' } });
        const rows = audits.filter((a) => a.action === AUDIT_ACTIONS.tenantCreate);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0]!.detail['modules'].slice().sort(), DOC_11);
        assert.equal(rows[0]!.detail['preset'], 'creator');
        assert.equal(rows[0]!.detail['meta_connect'], 'operator');
        assert.equal(audits.some((a) => a.action === AUDIT_ACTIONS.tenantModulesChanged), false, 'creating is not a change');
    });

    it('ignores `modules` for the first creator ever made: it IS the platform owner, with everything and nothing to choose', async () => {
        setPlatformOwner(db, null);
        const reply = await call('POST', '/tenants', { name: 'First', modules: { on: ['inbox'] } });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.modules, null);
        assert.deepEqual(Object.keys(settings).filter((k) => k.startsWith('tenant.modules.')), []);
    });
});

describe('owner_email', () => {
    it('is normalised and goes to the creation link: only that address can use it', async () => {
        const reply = await call('POST', '/tenants', { name: 'Nour', owner_email: '  Sara@Company.EXAMPLE ' });
        assert.equal(reply.status, 201);
        assert.equal(invites.length, 1);
        assert.equal(invites[0]!['email'], 'sara@company.example');
        assert.equal(reply.body.invite.email, 'sara@company.example');
    });

    it('is optional: with none the link works for any address, as it always did', async () => {
        await call('POST', '/tenants', { name: 'Nour' });
        assert.equal(invites[0]!['email'], null);
        await call('POST', '/tenants', { name: 'Nour', owner_email: '' });
    });

    it('a bad one is 400 BAD_EMAIL before anything is written', async () => {
        for (const bad of ['sara', 'sara@', 'a b@c.d', 42]) {
            const reply = await call('POST', '/tenants', { name: 'Nour', owner_email: bad });
            assert.equal(reply.status, 400, JSON.stringify(bad));
            assert.equal(reply.body.code, 'BAD_EMAIL', JSON.stringify(bad));
            nothingCreated();
        }
        assert.equal(invites.length, 0);
    });
});

describe('GET /api/admin/tenants/:id/modules', () => {
    it('is the view plus the ceiling: a workspace with no document is legacy (everything on, nothing stored)', async () => {
        const reply = await call('GET', `/tenants/${EXISTING}/modules`);
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body, {
            tenantId: EXISTING, on: DOC_11_IN_ORDER, owner: false, stored: false, preset: null, metaConnect: 'operator', adsCeiling: null,
        });
    });

    it('reads fresh, not from this instance\'s 30-second cache, and says what the document and the ceiling hold', async () => {
        await call('GET', `/tenants/${EXISTING}/modules`);
        settings[`tenant.modules.${EXISTING}`] = JSON.stringify({ v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'self' });
        settings[`ads.ceiling.${EXISTING}`] = JSON.stringify({ maxDailyBudget: 5, monthlyCap: 50 });
        const reply = await call('GET', `/tenants/${EXISTING}/modules`);
        assert.deepEqual(reply.body.on, COMPANY_5);
        assert.equal(reply.body.preset, 'company');
        assert.equal(reply.body.metaConnect, 'self');
        assert.deepEqual(reply.body.adsCeiling, { maxDailyBudget: 5, monthlyCap: 50 });
    });

    it('says the platform owner\'s workspace is the owner\'s: everything on, read-only', async () => {
        const reply = await call('GET', `/tenants/${OWNER}/modules`);
        assert.equal(reply.body.owner, true);
        assert.equal(reply.body.metaConnect, 'operator');
    });

    it('is 404 for a workspace that does not exist or an id that is not one, and for anybody but a platform admin', async () => {
        assert.equal((await call('GET', `/tenants/${NEW}/modules`)).status, 404);
        assert.equal((await call('GET', '/tenants/not-an-id/modules')).status, 404);
        const member = await call('GET', `/tenants/${EXISTING}/modules`, undefined, { ...SESSION, role: 'user' });
        assert.equal(member.status, 404);
        assert.equal(member.body.code, undefined);
    });
});

describe('PUT /api/admin/tenants/:id/modules', () => {
    it('writes the document, the Ads switch and the ceiling in ONE transaction, and audits one tenant.modules_changed with before and after', async () => {
        settings[`tenant.modules.${EXISTING}`] = JSON.stringify({ v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'self' });
        const reply = await call('PUT', `/tenants/${EXISTING}/modules`, {
            preset: 'custom', on: ['inbox', 'dm_assistant', 'results', 'ads'], metaConnect: 'operator', adsCeiling: { maxDailyBudget: 20, monthlyCap: 400 },
        });
        assert.equal(reply.status, 200);
        assert.deepEqual(reply.body.on, ['inbox', 'dm_assistant', 'results', 'ads']);
        assert.equal(reply.body.preset, 'custom');
        assert.equal(reply.body.metaConnect, 'operator');
        assert.deepEqual(reply.body.adsCeiling, { maxDailyBudget: 20, monthlyCap: 400 });
        assert.deepEqual(doc(EXISTING), { v: 1, on: ['inbox', 'dm_assistant', 'results'], preset: 'custom', metaConnect: 'operator' });
        assert.equal(settings[`ads.enabled.${EXISTING}`], 'true');
        assert.deepEqual(JSON.parse(settings[`ads.ceiling.${EXISTING}`]!), { maxDailyBudget: 20, monthlyCap: 400 });

        const between = db.statements.map((s) => s.sql).filter((sql) => /^(BEGIN|COMMIT|ROLLBACK|INSERT INTO app_settings|DELETE FROM app_settings)/.test(sql)).map((sql) => sql.split(' (')[0]!);
        assert.deepEqual(between, ['BEGIN', 'INSERT INTO app_settings', 'INSERT INTO app_settings', 'INSERT INTO app_settings', 'COMMIT']);

        const rows = audits.filter((a) => a.action === AUDIT_ACTIONS.tenantModulesChanged);
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.targetId, EXISTING);
        assert.deepEqual(rows[0]!.detail, {
            before: COMPANY_5, after: ['inbox', 'dm_assistant', 'results', 'ads'], meta_connect_before: 'self', meta_connect_after: 'operator', preset: 'custom',
        });
        assert.equal(JSON.stringify(rows[0]!.detail).includes('Ceiling'), false, 'no amount in the audit');
    });

    it('switches Ads off with its switch row removed, and leaves the other modules as they are', async () => {
        settings[`ads.enabled.${EXISTING}`] = 'true';
        settings[`ads.ceiling.${EXISTING}`] = JSON.stringify({ maxDailyBudget: 5, monthlyCap: 50 });
        settings[`tenant.modules.${EXISTING}`] = JSON.stringify({ v: 1, on: COMPANY_5, preset: 'company', metaConnect: 'self' });
        const reply = await call('PUT', `/tenants/${EXISTING}/modules`, { on: COMPANY_5 });
        assert.equal(reply.status, 200);
        assert.equal(settings[`ads.enabled.${EXISTING}`], undefined);
        assert.deepEqual(reply.body.on, COMPANY_5);
        assert.deepEqual(reply.body.adsCeiling, { maxDailyBudget: 5, monthlyCap: 50 }, 'the ceiling stays');
    });

    it('a body with only metaConnect changes only that (a legacy workspace stays on everything)', async () => {
        const reply = await call('PUT', `/tenants/${EXISTING}/modules`, { metaConnect: 'self' });
        assert.equal(reply.status, 200);
        assert.equal(reply.body.metaConnect, 'self');
        assert.equal(reply.body.on.length, 11);
        assert.equal(doc(EXISTING).on.length, 11);
    });

    it('refuses the platform owner\'s own workspace: 409 OWNER_ALL_MODULES, nothing written, nothing audited', async () => {
        const reply = await call('PUT', `/tenants/${OWNER}/modules`, { preset: 'company' });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'OWNER_ALL_MODULES');
        assert.deepEqual(Object.keys(settings).filter((k) => k !== 'app.public_base_url'), []);
        assert.deepEqual(audits, []);
    });

    it('refuses what the planner refuses, with the code and params, and writes and audits nothing', async () => {
        const cases: Array<[unknown, number, string, Record<string, string>]> = [
            [{ on: ['muse'] }, 400, 'MODULE_NEEDS', { module: 'muse', needs: 'dm_assistant' }],
            [{ on: ['knowledge'] }, 400, 'MODULE_NOT_AVAILABLE', { module: 'knowledge' }],
            [{ on: ['teleporter'] }, 400, 'MODULE_UNKNOWN', { module: 'teleporter' }],
            [{ on: ['ads'] }, 409, 'CEILING_REQUIRED', { module: 'ads' }],
            [{ on: ['studio', 'explainers'] }, 409, 'EXPLAINERS_OWNER_ONLY', { module: 'explainers' }],
        ];
        for (const [body, status, code, params] of cases) {
            const reply = await call('PUT', `/tenants/${EXISTING}/modules`, body);
            assert.equal(reply.status, status, JSON.stringify(body));
            assert.equal(reply.body.code, code, JSON.stringify(body));
            assert.deepEqual(reply.body.params, params, JSON.stringify(body));
        }
        assert.deepEqual(Object.keys(settings).filter((k) => k !== 'app.public_base_url'), []);
        assert.deepEqual(audits, []);
        assert.equal(db.statements.filter((s) => s.sql === 'BEGIN').length, 0);
    });

    it('takes a ceiling already stored: Ads can be switched on again without sending one', async () => {
        settings[`ads.ceiling.${EXISTING}`] = JSON.stringify({ maxDailyBudget: 5, monthlyCap: 50 });
        const reply = await call('PUT', `/tenants/${EXISTING}/modules`, { on: [...COMPANY_5, 'ads'] });
        assert.equal(reply.status, 200);
        assert.equal(settings[`ads.enabled.${EXISTING}`], 'true');
    });

    it('is 404 for a workspace that does not exist, and for a session that is not a platform admin', async () => {
        assert.equal((await call('PUT', `/tenants/${NEW}/modules`, { preset: 'company' })).status, 404);
        assert.equal((await call('PUT', `/tenants/${EXISTING}/modules`, { preset: 'company' }, { ...SESSION, role: 'user' })).status, 404);
        assert.deepEqual(Object.keys(settings).filter((k) => k.startsWith('tenant.modules.')), []);
    });

    it('answers the view it wrote, whatever another instance has cached', async () => {
        await call('GET', `/tenants/${EXISTING}/modules`);
        const put = await call('PUT', `/tenants/${EXISTING}/modules`, { preset: 'company' });
        assert.deepEqual(put.body.on, COMPANY_5);
        const get = await call('GET', `/tenants/${EXISTING}/modules`);
        assert.deepEqual(get.body.on, COMPANY_5);
    });
});

describe('the Ads switch route answers CEILING_REQUIRED in the registry\'s envelope', () => {
    it('POST /ads/tenants/:id/enabled with no ceiling: 409 { code, params, error, message }', async () => {
        const reply = await call('POST', `/ads/tenants/${EXISTING}/enabled`, { enabled: true });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'CEILING_REQUIRED');
        assert.deepEqual(reply.body.params, { module: 'ads' });
        assert.equal(typeof reply.body.error, 'string');
        assert.equal(reply.body.message, reply.body.error);
    });
});
