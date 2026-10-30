/**
 * Meta vision's settings (docs/specs/005-muse-sees T037): the `muse` block of `GET /api/settings/ai`, and `POST /api/settings/ai/muse`.
 *
 * Run through each route's WHOLE stack (the role guard, then the handler) against the in-memory `app_settings` and audit ledger of the AI layer's tests,
 * as `salesVariantsSettings.test.ts` does, because the guard and the tenant key are the point: the switches decide whether a customer's photos, reels and
 * voice notes go to Meta's models, so only the OWNER may write them, a body is refused whole before anything is written, and the ledger and the log carry
 * counts and switch states and never a sender id.
 *
 * What is pinned, because a screenshot cannot show it:
 *   - the read: the defaults (everything off, nobody, a $3 cap), what is saved, the people named by the inbox's own handle and name, today's spend, whether
 *     a Meta key can answer, a part that cannot be read being `null` and the rest still there, and a block that cannot be read at all being `null`, never
 *     "everything off" (an owner who pressed Save on that would overwrite what he chose); no key anywhere in the answer; any role may read it;
 *   - the write: the contract's validation (a typo is a 400 that names its field), the merge of the switches, the order the rows are written in (the
 *     switches last), nothing written for a save that changes nothing, the audit row, a 500 with no detail, the session's tenant and no other.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { installAiDb, type AiDb } from '../services/aiProviders/testDb.js';
import { assertNoKey, FAKE_KEYS } from '../services/aiProviders/testKeys.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { allowMode, museAuditDetail, MUSE_ALLOW_SENDERS_MAX, parseMuseInput } from '../services/perception/museSettings.js';
import { gatePerception, MUSE_BUDGET_PURPOSES, type GateArgs } from '../services/perception/gate.js';
import { capabilityOn, readMuseSettings, senderAllowed } from '../services/perception/switches.js';
import { setLogSink } from '../utils/log.js';
import apiRouter from './api.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Role = 'owner' | 'operator' | 'viewer';
type Json = any;

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OWNER = { userId: 'u-owner', role: 'user', tenantId: TENANT };
const SARA = '17841400000000001';
const OMAR = '17841400000000002';
const STRANGER = '17841400000000003';
const K_SWITCHES = `muse.switches.${TENANT}`;
const K_ALLOW = `muse.allow_senders.${TENANT}`;
const K_DAILY = `muse.daily_usd.${TENANT}`;

interface Layer { route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle & { minimumRole?: string } }> } }
const layerFor = (method: string, path: string): Layer => {
    const found = (apiRouter as unknown as { stack: Layer[] }).stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(found, `${method.toUpperCase()} ${path} must be mounted`);
    return found!;
};

function fakeRes() {
    return {
        statusCode: 200,
        body: null as Json,
        status(code: number) { this.statusCode = code; return this; },
        set() { return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function run(method: 'get' | 'post', path: string, opts: { role?: Role; session?: Json; body?: unknown } = {}) {
    const res = fakeRes();
    const req = { session: opts.session ?? OWNER, body: opts.body ?? {}, params: {}, query: {}, headers: {}, tenantRole: opts.role ?? 'owner', originalUrl: `/api${path}` };
    for (const inner of layerFor(method, path).route!.stack) {
        let passed = false;
        await inner.handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'META_MODEL_API_KEY', 'GEMINI_API_KEY'] as const;
let savedEnv: Record<string, string | undefined> = {};
let db: AiDb;
let restoreSink: (() => void) | undefined;
let logged: string[];
let sql: string[];
/** What the stand-ins answer for the statements `installAiDb` does not know. */
let spend: number | Error;
let threads: Array<{ instagram_user_id: string; username: string | null; profile_name: string | null }>;
let writes: Array<{ key: string; value: string }>;
let peopleAsked: Array<{ creatorId: unknown; ids: unknown }>;
let spendAsked: unknown[][];
let agentRow: Json | null;

before(() => {
    savedEnv['TOKEN_ENCRYPTION_KEY'] = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
});
after(() => {
    if (savedEnv['TOKEN_ENCRYPTION_KEY'] === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = savedEnv['TOKEN_ENCRYPTION_KEY'];
});

beforeEach(() => {
    for (const name of ENV_NAMES) { savedEnv[name] = process.env[name]; delete process.env[name]; }
    logged = [];
    const previous = setLogSink((_level, line) => { logged.push(line); });
    restoreSink = () => setLogSink(previous);
    db = installAiDb({ owner: TENANT });
    sql = [];
    spend = 0;
    threads = [];
    writes = [];
    peopleAsked = [];
    spendAsked = [];
    agentRow = { creator_id: TENANT, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7, is_active: true };

    const underneath = pool.query as unknown as (text: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;
    (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
        const flat = text.replace(/\s+/g, ' ').trim();
        sql.push(flat);
        if (/^SELECT \* FROM ai_agents WHERE creator_id = \$1$/.test(flat)) return { rows: agentRow ? [agentRow] : [], rowCount: agentRow ? 1 : 0 };
        if (/FROM ai_usage WHERE creator_id = \$1 AND purpose = ANY\(\$2::text\[\]\) AND at >= \$3$/.test(flat)) {
            spendAsked.push(params);
            if (spend instanceof Error) throw spend;
            return { rows: [{ usd: spend }], rowCount: 1 };
        }
        if (/FROM conversations WHERE creator_id = \$1 AND instagram_user_id = ANY\(\$2::text\[\]\)$/.test(flat)) {
            peopleAsked.push({ creatorId: params[0], ids: params[1] });
            const ids = params[1] as string[];
            return { rows: threads.filter((t) => ids.includes(t.instagram_user_id)), rowCount: 0 };
        }
        if (/^INSERT INTO app_settings /.test(flat) && String(params[0]).startsWith('muse.')) writes.push({ key: String(params[0]), value: String(params[1]) });
        return underneath(text, params);
    };
});

afterEach(() => {
    db.restore();
    restoreSink?.();
    for (const name of ENV_NAMES) {
        if (savedEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedEnv[name];
    }
});

/** `muse.*` rows as the app would have saved them. */
const store = (rows: Record<string, string>): void => { for (const [key, value] of Object.entries(rows)) db.setSetting(key, value); };
const everything = (): string => `${JSON.stringify(db.audits)}\n${logged.join('\n')}`;

// ─── The read ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('GET /settings/ai — the muse block', () => {
    it('is everything off, nobody, and the default cap for a tenant that has saved nothing, with the limits the card validates against', async () => {
        const res = await run('get', '/settings/ai');
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.muse, {
            switches: { dm_media: false, voice: false, memory: false },
            allowSenders: [],
            dailyUsd: 3,
            spentToday: 0,
            keyReady: false,
            route: null,
            people: [],
            limits: { dailyUsdMax: 50, dailyUsdDefault: 3, allowSendersMax: MUSE_ALLOW_SENDERS_MAX },
        });
        assert.equal(res.body.system_prompt, 'p', 'and the agent\'s own settings are as they were');
    });

    it('is there for a tenant with no agent row yet too: the card does not wait for the agent', async () => {
        agentRow = null;
        const res = await run('get', '/settings/ai');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.is_active, true, 'the defaults path answered');
        assert.equal(res.body.muse.switches.dm_media, false);
        assert.equal(res.body.muse.limits.dailyUsdMax, 50);
    });

    it('reads what the SESSION\'s tenant saved and no other tenant\'s, and names each person by the inbox\'s own handle and name', async () => {
        store({
            [K_SWITCHES]: JSON.stringify({ dm_media: true, voice: false, memory: true }),
            [K_ALLOW]: JSON.stringify([SARA, OMAR, STRANGER]),
            [K_DAILY]: '5.5',
            [`muse.switches.${OTHER}`]: JSON.stringify({ dm_media: true, voice: true, memory: true }),
            [`muse.allow_senders.${OTHER}`]: JSON.stringify(['*']),
        });
        threads = [
            { instagram_user_id: OMAR, username: 'omar.dev', profile_name: 'Omar' },
            { instagram_user_id: SARA, username: '@sara_dev', profile_name: '  Sara Dev  ' },
        ];
        const { muse } = (await run('get', '/settings/ai')).body;
        assert.deepEqual(muse.switches, { dm_media: true, voice: false, memory: true });
        assert.deepEqual(muse.allowSenders, [SARA, OMAR, STRANGER]);
        assert.equal(muse.dailyUsd, 5.5);
        assert.deepEqual(muse.people, [
            { id: SARA, username: 'sara_dev', name: 'Sara Dev' },
            { id: OMAR, username: 'omar.dev', name: 'Omar' },
            { id: STRANGER, username: null, name: null },
        ], 'in the list\'s order, the "@" taken off a handle, an id with no thread kept with no names');
        assert.deepEqual(peopleAsked, [{ creatorId: TENANT, ids: [SARA, OMAR, STRANGER] }], 'the lookup is the tenant\'s own conversations');
    });

    it('answers everyone as ["*"] with no people to name', async () => {
        store({ [K_ALLOW]: JSON.stringify(['*']) });
        const { muse } = (await run('get', '/settings/ai')).body;
        assert.deepEqual(muse.allowSenders, ['*']);
        assert.deepEqual(muse.people, []);
        assert.deepEqual(peopleAsked, [], 'and nothing is looked up');
    });

    it('answers a saved cap of 0, and one that is not a number as 0 too (a typo must not become a bigger cap)', async () => {
        store({ [K_DAILY]: '0' });
        assert.equal((await run('get', '/settings/ai')).body.muse.dailyUsd, 0);
        store({ [K_DAILY]: 'lots' });
        assert.equal((await run('get', '/settings/ai')).body.muse.dailyUsd, 0);
    });

    it('answers today\'s spend on the purposes the gate\'s cap counts, for this tenant', async () => {
        spend = 0.43219;
        const { muse } = (await run('get', '/settings/ai')).body;
        assert.equal(muse.spentToday, 0.4322, 'to four decimals');
        assert.equal(spendAsked.length, 1);
        assert.equal(spendAsked[0]![0], TENANT);
        assert.deepEqual(spendAsked[0]![1], [...MUSE_BUDGET_PURPOSES]);
    });

    it('says a Meta key can answer, and which route, once one is saved, and names no key', async () => {
        process.env.META_MODEL_API_KEY = FAKE_KEYS.meta;
        const res = await run('get', '/settings/ai');
        assert.equal(res.body.muse.keyReady, true);
        assert.deepEqual(res.body.muse.route, { provider: 'meta', model: 'muse-spark-1.3' });
        assertNoKey(JSON.stringify(res.body), 'the settings answer');
        // The key saved on the Operations screen is the other way in, and is encrypted at rest: still no key in the answer.
        delete process.env.META_MODEL_API_KEY;
        db.setSetting('ai.providers.meta.api_key', FAKE_KEYS.meta, true);
        const saved = await run('get', '/settings/ai');
        assert.equal(saved.body.muse.keyReady, true);
        assertNoKey(JSON.stringify(saved.body), 'the settings answer, key saved in Operations');
    });

    it('says there is no key when a route points at a provider that may not answer, and when the Meta route has no key: never a move to another provider', async () => {
        db.setSetting('ai.providers.anthropic.api_key', FAKE_KEYS.anthropic, true);
        db.setSetting('ai.routing', JSON.stringify({ perception_dm: { provider: 'anthropic', model: 'claude-opus-5-5', effort: 'low' } }));
        assert.equal((await run('get', '/settings/ai')).body.muse.keyReady, false, 'a route that names a provider outside the list');
        db.setSetting('ai.routing', JSON.stringify({ perception_dm: { provider: 'meta', model: 'muse-spark-1.3', effort: 'low' } }));
        const none = await run('get', '/settings/ai');
        assert.equal(none.body.muse.keyReady, false, 'a Meta route with no Meta key');
        assert.equal(none.body.muse.route, null);
    });

    it('answers a part it cannot read as null and still answers the rest, logging why: the card says "could not check", never "ready"', async () => {
        spend = new Error('connection terminated unexpectedly');
        db.failOn(/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY/, new Error('connection to db.internal.example failed'), 5);
        const res = await run('get', '/settings/ai');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.muse.spentToday, null);
        assert.equal(res.body.muse.keyReady, null, 'a route check that failed is not "no key"');
        assert.equal(res.body.muse.route, null);
        assert.deepEqual(res.body.muse.switches, { dm_media: false, voice: false, memory: false });
        assert.ok(logged.some((line) => line.includes('muse.spend_unreadable')));
        assert.ok(logged.some((line) => line.includes('muse.route_unreadable')));
    });

    it('answers the people with no names when the lookup fails, so the list is still the list', async () => {
        store({ [K_ALLOW]: JSON.stringify([SARA]) });
        const original = pool.query;
        (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
            if (/FROM conversations WHERE/.test(text.replace(/\s+/g, ' '))) throw new Error('relation does not exist');
            return (original as unknown as (t: string, p: unknown[]) => Promise<unknown>)(text, params);
        };
        const { muse } = (await run('get', '/settings/ai')).body;
        assert.deepEqual(muse.people, [{ id: SARA, username: null, name: null }]);
        assert.ok(logged.some((line) => line.includes('muse.people_unreadable')));
    });

    it('answers `muse: null` when the three settings cannot be read, and the agent\'s settings regardless: it is never "everything off, cap 0" to be saved over his real ones', async () => {
        db.failOn(/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/, new Error('connection terminated unexpectedly'), 3);
        const res = await run('get', '/settings/ai');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.muse, null);
        assert.equal(res.body.system_prompt, 'p');
        assert.ok(logged.some((line) => line.includes('muse.settings_unreadable')));
    });

    it('is open to every role, like the rest of the AI settings: a viewer reads it and cannot write it', async () => {
        for (const role of ['owner', 'operator', 'viewer'] as const) {
            const res = await run('get', '/settings/ai', { role });
            assert.equal(res.statusCode, 200, role);
            assert.ok(res.body.muse, role);
        }
        assert.equal(layerFor('get', '/settings/ai').route!.stack.some((l) => typeof l.handle.minimumRole === 'string'), false, 'no role guard on the read');
    });
});

// ─── The write ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('POST /settings/ai/muse — who may, and what is stored', () => {
    it('is behind the OWNER guard: Meta vision decides whether a customer\'s media goes to Meta\'s models, and the cap is his money', () => {
        const guard = layerFor('post', '/settings/ai/muse').route!.stack.map((l) => l.handle.minimumRole).find((m) => typeof m === 'string');
        assert.equal(guard, 'owner');
    });

    it('refuses an operator and a viewer with a 403 and writes nothing, not even the ledger', async () => {
        for (const role of ['operator', 'viewer'] as const) {
            const res = await run('post', '/settings/ai/muse', { role, body: { switches: { dm_media: true } } });
            assert.equal(res.statusCode, 403, role);
        }
        assert.equal(writes.length, 0);
        assert.deepEqual(db.audits, []);
    });

    it('saves all three under the SESSION\'s tenant keys, in the shapes the reply path reads, and answers the card\'s new state', async () => {
        threads = [{ instagram_user_id: SARA, username: 'sara_dev', profile_name: 'Sara' }];
        const res = await run('post', '/settings/ai/muse', {
            body: { switches: { dm_media: true, voice: false, memory: false }, allow_senders: [SARA, OMAR], daily_usd: 5 },
        });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.deepEqual(writes, [
            { key: K_ALLOW, value: JSON.stringify([SARA, OMAR]) },
            { key: K_DAILY, value: '5' },
            { key: K_SWITCHES, value: JSON.stringify({ dm_media: true, voice: false, memory: false }) },
        ], 'the list, then the cap, then the switches LAST: a save that stops half way never leaves a feature on with a list nobody chose');
        assert.deepEqual(res.body.switches, { dm_media: true, voice: false, memory: false });
        assert.deepEqual(res.body.allowSenders, [SARA, OMAR]);
        assert.equal(res.body.dailyUsd, 5);
        assert.deepEqual(res.body.people, [{ id: SARA, username: 'sara_dev', name: 'Sara' }, { id: OMAR, username: null, name: null }]);
        // What was written is what the reply path reads back.
        const read = (await run('get', '/settings/ai')).body.muse;
        assert.deepEqual([read.switches, read.allowSenders, read.dailyUsd], [res.body.switches, res.body.allowSenders, res.body.dailyUsd]);
    });

    it('writes only the tenant it is the session\'s, and refuses a body that names another one', async () => {
        const named = await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, creator_id: OTHER, tenantId: OTHER } });
        assert.equal(named.statusCode, 400);
        assert.equal(writes.length, 0);
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true } } });
        assert.deepEqual(writes.map((w) => w.key), [K_SWITCHES]);
        assert.ok(writes.every((w) => !w.key.includes(OTHER)));
    });

    it('merges the switches it names into the stored ones, and leaves the rest as they are', async () => {
        store({ [K_SWITCHES]: JSON.stringify({ dm_media: true, voice: false, memory: false }) });
        const res = await run('post', '/settings/ai/muse', { body: { switches: { voice: true } } });
        assert.deepEqual(res.body.switches, { dm_media: true, voice: true, memory: false });
        assert.deepEqual(writes, [{ key: K_SWITCHES, value: JSON.stringify({ dm_media: true, voice: true, memory: false }) }]);
    });

    it('stores everyone as ["*"] and nobody as [], and takes the camelCase names the read answers with', async () => {
        const everyone = await run('post', '/settings/ai/muse', { body: { allowSenders: ['*'], dailyUsd: 0 } });
        assert.equal(everyone.statusCode, 200, JSON.stringify(everyone.body));
        assert.deepEqual(writes, [{ key: K_ALLOW, value: '["*"]' }, { key: K_DAILY, value: '0' }]);
        assert.deepEqual(everyone.body.allowSenders, ['*']);
        assert.equal(everyone.body.dailyUsd, 0);
        writes.length = 0;
        const nobody = await run('post', '/settings/ai/muse', { body: { allow_senders: [] } });
        assert.deepEqual(writes, [{ key: K_ALLOW, value: '[]' }]);
        assert.deepEqual(nobody.body.allowSenders, []);
    });

    it('writes nothing, and no ledger row, for a save that changes nothing, and still answers the state', async () => {
        store({ [K_SWITCHES]: JSON.stringify({ dm_media: true, voice: false, memory: false }), [K_ALLOW]: JSON.stringify([SARA]), [K_DAILY]: '5' });
        const res = await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true, voice: false }, allow_senders: [SARA], daily_usd: 5 } });
        assert.equal(res.statusCode, 200);
        assert.equal(writes.length, 0);
        assert.deepEqual(db.audits, []);
        assert.deepEqual(res.body.allowSenders, [SARA]);
        // The default cap saved as itself is no change either: nothing is stored for it.
        const dflt = await run('post', '/settings/ai/muse', { body: { daily_usd: 5 } });
        assert.equal(dflt.statusCode, 200);
        assert.equal(writes.length, 0);
    });

    it('trims and dedupes the ids, and takes a cap in whole cents', async () => {
        const res = await run('post', '/settings/ai/muse', { body: { allow_senders: [` ${SARA} `, SARA, OMAR, ''], daily_usd: 2.5 } });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.body.allowSenders, [SARA, OMAR]);
        assert.equal(res.body.dailyUsd, 2.5);
    });
});

describe('POST /settings/ai/muse — the ledger and the log hold no sender id', () => {
    it('writes one `muse.settings_changed` row: what changed, the switches, who it answers, HOW MANY people and the cap, targeted at the tenant', async () => {
        threads = [{ instagram_user_id: SARA, username: 'sara_dev', profile_name: 'Sara' }];
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: [SARA, OMAR], daily_usd: 4 } });
        assert.equal(db.audits.length, 1);
        const [row] = db.audits;
        assert.equal(row!.action, AUDIT_ACTIONS.museSettingsChanged);
        assert.equal(row!.action, 'muse.settings_changed');
        assert.equal(row!.target_type, 'tenant');
        assert.equal(row!.target_id, TENANT);
        assert.deepEqual(row!.detail, {
            changed: ['switches.dm_media', 'allow_senders', 'daily_usd'],
            switches: { dm_media: true, voice: false, memory: false },
            allow: 'list',
            allow_count: 2,
            daily_usd: 4,
        });
    });

    it('holds no sender id, no handle and no name, in the ledger or in any log line, for a list, for everyone and for nobody', async () => {
        threads = [{ instagram_user_id: SARA, username: 'sara_dev', profile_name: 'Sara Developer' }];
        await run('post', '/settings/ai/muse', { body: { allow_senders: [SARA, OMAR] } });
        await run('post', '/settings/ai/muse', { body: { allow_senders: ['*'] } });
        await run('post', '/settings/ai/muse', { body: { allow_senders: [STRANGER] } });
        await run('post', '/settings/ai/muse', { body: { allow_senders: [] } });
        assert.equal(db.audits.length, 4);
        const text = everything();
        for (const secret of [SARA, OMAR, STRANGER, 'sara_dev', 'Sara Developer']) assert.ok(!text.includes(secret), `${secret} is not in the ledger or the log`);
        assert.deepEqual(db.audits.map((a) => [a.detail['allow'], a.detail['allow_count']]), [['list', 2], ['everyone', 0], ['list', 1], ['nobody', 0]]);
    });

    it('logs the change by count and state, and a refused body by field, never echoing a list', async () => {
        await run('post', '/settings/ai/muse', { body: { switches: { voice: true }, daily_usd: 2 } });
        const line = logged.find((l) => l.includes('muse.settings_set'));
        assert.ok(line, 'the change is logged');
        assert.match(line!, /"changed":\["switches\.voice","daily_usd"\]/);
        assert.ok(!/\[REDACTED\]|redacted/i.test(line!), 'no field of it is blanked by the logger: each is named for what it holds');
    });

    it('does not write the ledger when the write failed, and answers 500 with nothing from the error', async () => {
        const underneath = pool.query as unknown as (t: string, p?: unknown[]) => Promise<unknown>;
        (pool as unknown as { query: unknown }).query = async (text: string, params: unknown[] = []) => {
            if (/^\s*INSERT INTO app_settings/.test(text)) throw new Error('connection to db.internal.example failed, password=hunter2');
            return underneath(text, params);
        };
        const res = await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true } } });
        assert.equal(res.statusCode, 500);
        assert.deepEqual(res.body, { error: 'Failed to save the Meta vision settings.' });
        assert.deepEqual(db.audits, []);
        assert.ok(!JSON.stringify(res.body).includes('hunter2'));
    });
});

describe('POST /settings/ai/muse — a body is refused whole, naming the field, and nothing is written', () => {
    const bad = async (body: unknown) => {
        const res = await run('post', '/settings/ai/muse', { body });
        assert.equal(res.statusCode, 400, JSON.stringify(body));
        assert.equal(res.body.code, 'MUSE_INVALID');
        assert.equal(typeof res.body.error, 'string');
        assert.equal(writes.length, 0, `nothing written for ${JSON.stringify(body)}`);
        assert.deepEqual(db.audits, [], 'no ledger row either');
        return res.body as { error: string; field: string | null };
    };

    it('an empty body, a body that is not an object, and an unknown key (a typo must not be a field quietly not saved)', async () => {
        assert.equal((await bad({})).error, 'Nothing to save.');
        for (const body of [null, [], 'switches', 7]) assert.equal((await bad(body)).field, null);
        const typo = await bad({ switches: { dm_media: true }, allow_sender: ['17841400000000001'] });
        assert.equal(typo.field, 'allow_sender');
        assert.match(typo.error, /"allow_sender" is not a Meta vision setting/);
    });

    it('switches: an object of booleans, at least one, from the three the build has (comment intent and offer cards were cut)', async () => {
        assert.equal((await bad({ switches: 'on' })).field, 'switches');
        assert.equal((await bad({ switches: [true] })).field, 'switches');
        assert.equal((await bad({ switches: {} })).field, 'switches');
        const cut = await bad({ switches: { comments: true } });
        assert.equal(cut.field, 'switches.comments');
        assert.match(cut.error, /choose dm_media, voice, memory/);
        assert.equal((await bad({ switches: { cards: true } })).field, 'switches.cards');
        for (const value of ['true', 1, null, 'yes']) assert.equal((await bad({ switches: { voice: value } })).field, 'switches.voice', JSON.stringify(value));
    });

    it('allow_senders: a list of digit strings, or ["*"] alone; a number, a letter, a short id, both spellings, both everyone and an id, too many', async () => {
        assert.equal((await bad({ allow_senders: SARA })).field, 'allow_senders');
        assert.equal((await bad({ allow_senders: { 0: SARA } })).field, 'allow_senders');
        const number = await bad({ allow_senders: [17841400000000001] });
        assert.match(number.error, /a number loses digits/);
        const letters = await bad({ allow_senders: ['17841400000000001', 'sara_dev'] });
        assert.match(letters.error, /"sara_dev" is not a sender id: they are numbers only \(5 to 32 digits\)\./);
        assert.equal((await bad({ allow_senders: ['1234'] })).field, 'allow_senders', 'four digits is not an id');
        assert.equal((await bad({ allow_senders: ['1'.repeat(33)] })).field, 'allow_senders', 'nor is thirty-three');
        assert.match((await bad({ allow_senders: ['*', SARA] })).error, /Use \["\*"\] alone/);
        assert.match((await bad({ allow_senders: [SARA], allowSenders: [SARA] })).error, /Send allow_senders once/);
        const many = Array.from({ length: MUSE_ALLOW_SENDERS_MAX + 1 }, (_, i) => String(10000 + i));
        assert.match((await bad({ allow_senders: many })).error, new RegExp(`At most ${MUSE_ALLOW_SENDERS_MAX} people`));
        assert.equal((await bad({ allow_senders: ['**'] })).field, 'allow_senders', 'only a lone * is everyone');
    });

    it('daily_usd: a number from 0 to 50 with at most two decimals', async () => {
        for (const value of ['3', null, true, [3], {}]) assert.equal((await bad({ daily_usd: value })).field, 'daily_usd', JSON.stringify(value));
        for (const value of [-0.01, 50.01, 1e9]) assert.match((await bad({ daily_usd: value })).error, /from 0 to 50/, String(value));
        assert.match((await bad({ daily_usd: 1.005 })).error, /at most two decimals/);
        assert.match((await bad({ daily_usd: 0.001 })).error, /at most two decimals/);
        assert.match((await bad({ daily_usd: 3, dailyUsd: 3 })).error, /Send daily_usd once/);
    });

    it('is checked whole: a good field beside a bad one saves neither', async () => {
        await bad({ switches: { dm_media: true }, allow_senders: ['x'], daily_usd: 4 });
        await bad({ switches: { dm_media: true }, daily_usd: 99 });
    });

    it('takes the limits at their edges: a 0 and a 50 cap, a five-digit and a thirty-two-digit id, exactly the most people', async () => {
        for (const body of [
            { daily_usd: 0 }, { daily_usd: 50 }, { daily_usd: 0.01 }, { allow_senders: ['12345'] }, { allow_senders: ['9'.repeat(32)] },
            { allow_senders: Array.from({ length: MUSE_ALLOW_SENDERS_MAX }, (_, i) => String(10000 + i)) },
        ]) {
            const res = await run('post', '/settings/ai/muse', { body });
            assert.equal(res.statusCode, 200, JSON.stringify(body).slice(0, 80));
        }
    });
});

// ─── The pure parts ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe('parseMuseInput, museAuditDetail and allowMode', () => {
    it('hands back exactly what a good body said, normalised', () => {
        const parsed = parseMuseInput({ switches: { voice: true }, allow_senders: [` ${SARA}`, SARA], daily_usd: 7.25 });
        assert.deepEqual(parsed, { ok: true, input: { switches: { voice: true }, allowSenders: [SARA], dailyUsd: 7.25 } });
        assert.deepEqual(parseMuseInput({ allow_senders: [' * ', '*'] }), { ok: true, input: { allowSenders: ['*'] } });
    });

    it('names who it answers by a word', () => {
        assert.equal(allowMode([]), 'nobody');
        assert.equal(allowMode([SARA]), 'list');
        assert.equal(allowMode(['*']), 'everyone');
    });

    it('builds a detail of counts and states with no id, for every kind of list, and nothing a ledger redaction would blank', () => {
        const after = { switches: { dm_media: true, voice: false, memory: true }, allowSenders: [SARA, OMAR], dailyUsd: 3 };
        const detail = museAuditDetail(after, ['allow_senders']);
        assert.deepEqual(detail, { changed: ['allow_senders'], switches: after.switches, allow: 'list', allow_count: 2, daily_usd: 3 });
        assert.ok(!JSON.stringify(detail).includes(SARA));
        assert.equal(JSON.stringify(detail).includes('[redacted]'), false);
        assert.deepEqual(museAuditDetail({ ...after, allowSenders: ['*'] }, []), { changed: [], switches: after.switches, allow: 'everyone', allow_count: 0, daily_usd: 3 });
    });
});

// ─── The whole path: what the card saves is what the reply path decides on ──────────────────────────────────────────────────

describe('POST /settings/ai/muse — what it saves is what the reply path reads and the gate decides on', () => {
    // The gate with nothing but its settings real: the settings are read through `readMuseSettings` from the rows the route wrote.
    const gate = (senderId: string, kind: string, capability: GateArgs['capability'], spent = 0) => gatePerception(
        { creatorId: TENANT, senderId, kind, capability },
        { routeReady: async () => true, spentToday: async () => spent, tellOwner: async () => {}, now: () => new Date('2026-11-01T09:00:00Z') },
    );

    it('is read back by the reply path\'s own reader, and only the people on the list, with the switch on, get through the gate', async () => {
        const res = await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: [SARA, OMAR], daily_usd: 4.5 } });
        assert.equal(res.statusCode, 200);
        const settings = await readMuseSettings(TENANT);
        assert.deepEqual(settings, { switches: { dm_media: true, voice: false, memory: false }, allowSenders: [SARA, OMAR], dailyUsd: 4.5 });
        assert.equal(capabilityOn(settings, 'dm_media'), true);
        assert.equal(capabilityOn(settings, 'voice'), false);
        assert.deepEqual([SARA, OMAR, STRANGER].map((id) => senderAllowed(settings.allowSenders, id)), [true, true, false]);
        // The gate, on a reel and on a voice note, from the people the card saved and from a stranger.
        assert.deepEqual(await gate(SARA, 'reel', 'dm_media'), { ok: true });
        assert.deepEqual(await gate(OMAR, 'story_mention', 'dm_media'), { ok: true });
        assert.deepEqual(await gate(STRANGER, 'reel', 'dm_media'), { ok: false, reason: 'not_allowed_sender' });
        assert.deepEqual(await gate(SARA, 'audio', 'voice'), { ok: false, reason: 'switch_off' }, 'voice is stored and off');
    });

    it('opens to everyone with ["*"], and the cap the card saved is the cap the gate holds: 4.5 refuses at 4.5, and 0 refuses always', async () => {
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: ['*'], daily_usd: 4.5 } });
        assert.deepEqual(await gate(STRANGER, 'image', 'dm_media', 4.49), { ok: true });
        assert.deepEqual(await gate(STRANGER, 'image', 'dm_media', 4.5), { ok: false, reason: 'budget' });
        await run('post', '/settings/ai/muse', { body: { daily_usd: 0 } });
        assert.deepEqual(await gate(STRANGER, 'image', 'dm_media', 0), { ok: false, reason: 'budget' }, 'a cap of 0 keeps it off by money');
    });

    it('is switched off again by the card, and the gate says so: the switch is the first thing it asks', async () => {
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: ['*'] } });
        assert.deepEqual(await gate(SARA, 'reel', 'dm_media'), { ok: true });
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: false } } });
        assert.deepEqual(await gate(SARA, 'reel', 'dm_media'), { ok: false, reason: 'switch_off' });
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: [] } });
        assert.deepEqual(await gate(SARA, 'reel', 'dm_media'), { ok: false, reason: 'not_allowed_sender' }, 'and an empty list is nobody, switch on or not');
    });

    it('leaves another tenant\'s gate exactly as it was: the rows are the session\'s tenant\'s', async () => {
        await run('post', '/settings/ai/muse', { body: { switches: { dm_media: true }, allow_senders: ['*'] } });
        const other = await gatePerception(
            { creatorId: OTHER, senderId: SARA, kind: 'reel', capability: 'dm_media' },
            { routeReady: async () => true, spentToday: async () => 0, tellOwner: async () => {} },
        );
        assert.deepEqual(other, { ok: false, reason: 'switch_off' });
    });
});
