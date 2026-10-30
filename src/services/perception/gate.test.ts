/**
 * The perception gate (`gate.ts`): each refusal and its order, the daily cap read from `ai_usage`, and the owner's notice, once a day.
 * Nothing here reaches Postgres, Telegram, Resend or a model: `pool.query` answers from memory, `telegramHttp.post` and `emailHttp.post` are stubs,
 * and the gate's own dependencies are handed in. Every instant is passed in: a test that spells one out does not read the clock.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { pool } from '../../config/db.js';
import { setLogSink } from '../../utils/log.js';
import { AiError } from '../llm/errors.js';
import { AI_PURPOSES, PURPOSE_PROVIDER_ALLOWLIST } from '../aiProviders/purposes.js';
import { dayStart } from '../aiProviders/usage.js';
import { APP_SETTING_KEYS } from '../appSettings.js';
import { telegramHttp } from '../notify.js';
import { emailHttp } from '../notifyEmail.js';
import {
    buildBudgetNotice, claimBudgetNotice, gatePerception, MUSE_BUDGET_PURPOSES, perceptionRouteReady, spentTodayUsd, tellOwnerBudgetReached,
    type BudgetNotice, type GateArgs, type GateDeps,
} from './gate.js';
import { museSettingsOff, type MuseSettings } from './switches.js';
import { PERCEIVABLE_KINDS } from './types.js';

const TENANT = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';
const SENDER = '17841400000000001';
const NOW = new Date('2026-11-01T09:30:00.000Z');
const TOMORROW = new Date('2026-11-02T00:00:05.000Z');

// ─── The doubles ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const originalQuery = pool.query;
const originalTelegram = telegramHttp.post;
const originalEmail = emailHttp.post;
let logged: { level: string; event: string; [k: string]: unknown }[] = [];
let restoreSink = (): void => undefined;

beforeEach(() => {
    logged = [];
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => { setLogSink(previous); };
});

afterEach(() => {
    (pool as any).query = originalQuery;
    (telegramHttp as any).post = originalTelegram;
    (emailHttp as any).post = originalEmail;
    restoreSink();
});

interface UsageRow { creator_id: string; purpose: string; usd: number; at: Date }

/** An in-memory `app_settings` and `ai_usage`, on the statements the gate and the notice send. */
function installDb(init: { settings?: Record<string, string>; usage?: UsageRow[]; failOn?: RegExp } = {}) {
    const settings = new Map(Object.entries(init.settings ?? {}));
    const usage = init.usage ?? [];
    const statements: { sql: string; params: unknown[] }[] = [];
    (pool as any).query = async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        statements.push({ sql, params });
        if (init.failOn?.test(sql)) throw new Error('connection terminated');
        if (/^SELECT value, is_secret FROM app_settings WHERE key = \$1$/.test(sql)) {
            const v = settings.get(String(params[0]));
            return { rows: v === undefined ? [] : [{ value: v, is_secret: false }], rowCount: v === undefined ? 0 : 1 };
        }
        if (/^SELECT key, value, is_secret FROM app_settings WHERE key = ANY\(\$1::text\[\]\)$/.test(sql)) {
            const rows = (params[0] as string[]).filter((k) => settings.has(k)).map((k) => ({ key: k, value: settings.get(k)!, is_secret: false }));
            return { rows, rowCount: rows.length };
        }
        if (/^INSERT INTO app_settings \(key, value, is_secret, updated_at\) VALUES \(\$1, \$2, FALSE, NOW\(\)\) ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = NOW\(\) WHERE app_settings\.value IS DISTINCT FROM EXCLUDED\.value RETURNING key$/.test(sql)) {
            const [key, value] = params as [string, string];
            if (settings.get(key) === value) return { rows: [], rowCount: 0 };
            settings.set(key, value);
            return { rows: [{ key }], rowCount: 1 };
        }
        if (/^SELECT COALESCE\(SUM\(usd\), 0\)::float8 AS usd FROM ai_usage WHERE creator_id = \$1 AND purpose = ANY\(\$2::text\[\]\) AND at >= \$3$/.test(sql)) {
            const [creator, purposes, since] = params as [string, string[], Date];
            const total = usage.filter((u) => u.creator_id === creator && purposes.includes(u.purpose) && u.at >= since).reduce((sum, u) => sum + u.usd, 0);
            return { rows: [{ usd: total }], rowCount: 1 };
        }
        throw new Error(`unexpected SQL ${sql}`);
    };
    return { settings, statements };
}

/** Both of the owner's channels on, as Settings saves them. */
const CHANNELS_ON: Record<string, string> = {
    [APP_SETTING_KEYS.notifyTelegramBotToken]: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    [APP_SETTING_KEYS.notifyTelegramChatId]: '42',
    [APP_SETTING_KEYS.notifyTelegramEnabled]: 'true',
    [APP_SETTING_KEYS.notifyEmailApiKey]: 're_AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    [APP_SETTING_KEYS.notifyEmailTo]: 'owner@example.com',
    [APP_SETTING_KEYS.notifyEmailEnabled]: 'true',
};

function stubChannels(opts: { telegram?: 'ok' | 'rejected' | 'throws'; email?: 'ok' | 'rejected' | 'throws' } = {}) {
    const posted: { channel: 'telegram' | 'email'; url: string; body: any }[] = [];
    (telegramHttp as any).post = async (url: string, body: any) => {
        posted.push({ channel: 'telegram', url, body });
        if (opts.telegram === 'throws') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return { data: opts.telegram === 'rejected' ? { ok: false, error_code: 400, description: 'chat not found' } : { ok: true } };
    };
    (emailHttp as any).post = async (url: string, body: any) => {
        posted.push({ channel: 'email', url, body });
        if (opts.email === 'throws') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        return { status: opts.email === 'rejected' ? 403 : 200, data: opts.email === 'rejected' ? { message: 'nope' } : { id: 'x' } };
    };
    return posted;
}

/** The settings of a tenant who switched everything on and opened it to one sender. */
const settingsOn = (over: Partial<MuseSettings> = {}): MuseSettings => ({
    switches: { dm_media: true, voice: true, memory: true }, allowSenders: [SENDER], dailyUsd: 3, ...over,
});

/** Deps whose every answer is "yes, go ahead" unless `over` says otherwise, each one counted, and the owner's notice recorded. */
function deps(over: Pick<GateDeps, 'now' | 'readSettings' | 'routeReady' | 'spentToday'> = {}): { deps: GateDeps; calls: Record<'settings' | 'route' | 'spent' | 'told', number>; told: BudgetNotice[] } {
    const calls = { settings: 0, route: 0, spent: 0, told: 0 };
    const told: BudgetNotice[] = [];
    const readSettings = over.readSettings ?? (async () => settingsOn());
    const routeReady = over.routeReady ?? (async () => true);
    const spentToday = over.spentToday ?? (async () => 0);
    return {
        calls, told,
        deps: {
            now: over.now ?? (() => NOW),
            readSettings: async (c) => { calls.settings++; return readSettings(c); },
            routeReady: async (c) => { calls.route++; return routeReady(c); },
            spentToday: async (c, now) => { calls.spent++; return spentToday(c, now); },
            tellOwner: async (n) => { calls.told++; told.push(n); },
        },
    };
}

const args = (over: Partial<GateArgs> = {}): GateArgs => ({ creatorId: TENANT, senderId: SENDER, kind: 'reel', capability: 'dm_media', ...over });

const skipped = (): string[] => logged.filter((l) => l.event.startsWith('perception.skipped:')).map((l) => l.event);

// ─── The gate: each reason ───────────────────────────────────────────────────────────────────────────────────────────────

describe('gatePerception: what it lets through', () => {
    it('lets a perceivable kind through when the switch is on, the sender is allowed, a Meta route answers and the day is under its cap', async () => {
        for (const kind of PERCEIVABLE_KINDS.filter((k) => k !== 'audio')) {
            const d = deps();
            assert.deepEqual(await gatePerception(args({ kind }), d.deps), { ok: true }, kind);
        }
        assert.deepEqual(await gatePerception(args({ kind: 'audio', capability: 'voice' }), deps().deps), { ok: true });
        assert.deepEqual(skipped(), []);
    });

    it('lets recall through on the memory switch with no media kind', async () => {
        assert.deepEqual(await gatePerception(args({ kind: undefined, capability: 'memory' }), deps().deps), { ok: true });
        assert.deepEqual(await gatePerception(args({ kind: null, capability: 'memory' }), deps().deps), { ok: true });
    });

    it('lets everyone through for ["*"]', async () => {
        const d = deps({ readSettings: async () => settingsOn({ allowSenders: ['*'] }) });
        assert.deepEqual(await gatePerception(args({ senderId: '555555555' }), d.deps), { ok: true });
    });

    it('counts a day under its cap as open, to the cent', async () => {
        const d = deps({ spentToday: async () => 2.99, readSettings: async () => settingsOn({ dailyUsd: 3 }) });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: true });
        assert.equal(d.calls.told, 0);
    });
});

describe('gatePerception: unsupported_kind', () => {
    it('refuses a kind perception does not read, before it reads anything', async () => {
        for (const kind of ['sticker', 'file', 'attachment', 'text', 'ephemeral', '', null, undefined]) {
            const d = deps();
            assert.deepEqual(await gatePerception(args({ kind: kind as string | null | undefined }), d.deps), { ok: false, reason: 'unsupported_kind' }, String(kind));
            assert.deepEqual(d.calls, { settings: 0, route: 0, spent: 0, told: 0 }, `${String(kind)}: nothing was read`);
        }
    });

    it('refuses a capability that does not fit the kind: a voice note is `voice`, anything else is `dm_media`', async () => {
        const d = deps();
        assert.deepEqual(await gatePerception(args({ kind: 'audio', capability: 'dm_media' }), d.deps), { ok: false, reason: 'unsupported_kind' });
        assert.deepEqual(await gatePerception(args({ kind: 'image', capability: 'voice' }), d.deps), { ok: false, reason: 'unsupported_kind' });
        assert.deepEqual(await gatePerception(args({ kind: 'reel', capability: 'voice' }), d.deps), { ok: false, reason: 'unsupported_kind' });
        assert.equal(d.calls.settings, 0);
    });
});

describe('gatePerception: switch_off', () => {
    it('refuses when the capability\'s own switch is off, whichever the others are', async () => {
        for (const [capability, kind, switches] of [
            ['dm_media', 'reel', { dm_media: false, voice: true, memory: true }],
            ['voice', 'audio', { dm_media: true, voice: false, memory: true }],
            ['memory', undefined, { dm_media: true, voice: true, memory: false }],
        ] as const) {
            const d = deps({ readSettings: async () => settingsOn({ switches }) });
            assert.deepEqual(await gatePerception(args({ capability, kind }), d.deps), { ok: false, reason: 'switch_off' }, capability);
        }
    });

    it('is the answer for a tenant with nothing saved, and for a settings read that failed (which reads as everything off)', async () => {
        assert.deepEqual(await gatePerception(args(), deps({ readSettings: async () => museSettingsOff() }).deps), { ok: false, reason: 'switch_off' });
    });

    it('stops there: no key check and no spend read for a tenant who never switched it on', async () => {
        const d = deps({ readSettings: async () => museSettingsOff() });
        await gatePerception(args(), d.deps);
        assert.deepEqual(d.calls, { settings: 1, route: 0, spent: 0, told: 0 });
    });
});

describe('gatePerception: not_allowed_sender', () => {
    it('refuses a sender who is not on the list, and everyone when the list is empty', async () => {
        const other = deps({ readSettings: async () => settingsOn({ allowSenders: ['17841400000000099'] }) });
        assert.deepEqual(await gatePerception(args(), other.deps), { ok: false, reason: 'not_allowed_sender' });
        const nobody = deps({ readSettings: async () => settingsOn({ allowSenders: [] }) });
        assert.deepEqual(await gatePerception(args(), nobody.deps), { ok: false, reason: 'not_allowed_sender' });
        assert.deepEqual(other.calls, { settings: 1, route: 0, spent: 0, told: 0 });
    });

    it('applies to recall too: a refused sender gets no recall', async () => {
        const d = deps({ readSettings: async () => settingsOn({ allowSenders: [] }) });
        assert.deepEqual(await gatePerception(args({ capability: 'memory', kind: undefined }), d.deps), { ok: false, reason: 'not_allowed_sender' });
    });

    it('is checked after the switch: a switch that is off is the reason, not the sender', async () => {
        const d = deps({ readSettings: async () => settingsOn({ switches: { dm_media: false, voice: false, memory: false }, allowSenders: [] }) });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'switch_off' });
    });
});

describe('gatePerception: no_key', () => {
    it('refuses when no Meta route can answer, and reads no spend', async () => {
        const d = deps({ routeReady: async () => false });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'no_key' });
        assert.equal(d.calls.spent, 0);
    });

    it('refuses when the check itself fails: a route that cannot be read is no route, and it says so', async () => {
        const d = deps({ routeReady: async () => { throw new Error('connection terminated'); } });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'no_key' });
        assert.equal(logged.filter((l) => l.event === 'perception.route_unreadable').length, 1);
    });
});

describe('gatePerception: budget', () => {
    it('refuses once today\'s spend has reached the cap (at it, not only past it), and tells the owner with the amounts', async () => {
        const d = deps({ spentToday: async () => 3, readSettings: async () => settingsOn({ dailyUsd: 3 }) });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'budget' });
        assert.deepEqual(d.told, [{ creatorId: TENANT, spentUsd: 3, capUsd: 3, now: NOW }]);
        const over = deps({ spentToday: async () => 7.25, readSettings: async () => settingsOn({ dailyUsd: 3 }) });
        assert.deepEqual(await gatePerception(args(), over.deps), { ok: false, reason: 'budget' });
        assert.deepEqual(over.told, [{ creatorId: TENANT, spentUsd: 7.25, capUsd: 3, now: NOW }]);
    });

    it('a cap of 0 refuses everything, even with nothing spent, and tells the owner nothing: it is his own way to switch perception off by money', async () => {
        const d = deps({ spentToday: async () => 0, readSettings: async () => settingsOn({ dailyUsd: 0 }) });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'budget' });
        assert.equal(d.calls.told, 0);
        assert.deepEqual(skipped(), ['perception.skipped:budget'], 'it is still logged');
    });

    it('does not tell the owner while there is room, and does not tell for any other reason', async () => {
        const open = deps({ spentToday: async () => 1 });
        await gatePerception(args(), open.deps);
        const off = deps({ readSettings: async () => museSettingsOff() });
        await gatePerception(args(), off.deps);
        const nokey = deps({ routeReady: async () => false });
        await gatePerception(args(), nokey.deps);
        assert.deepEqual([open.calls.told, off.calls.told, nokey.calls.told], [0, 0, 0]);
    });

    it('a spend that cannot be read is a refusal, and the owner is NOT told the cap was reached: it was not shown to be', async () => {
        const d = deps({ spentToday: async () => { throw new Error('connection terminated'); } });
        assert.deepEqual(await gatePerception(args(), d.deps), { ok: false, reason: 'budget' });
        assert.equal(d.calls.told, 0);
        assert.equal(logged.filter((l) => l.event === 'perception.budget_unreadable').length, 1);
    });

    it('reads the spend with the instant it was given', async () => {
        let seen: Date | null = null;
        const d = deps({ spentToday: async (_c, now) => { seen = now; return 0; }, now: () => TOMORROW });
        await gatePerception(args(), d.deps);
        assert.equal((seen as Date | null)?.toISOString(), TOMORROW.toISOString());
    });
});

describe('gatePerception: the order, cheapest first, and the log line of every refusal', () => {
    it('logs perception.skipped:<reason> for each refusal, with the tenant, the capability and the kind, and no sender or media in it', async () => {
        await gatePerception(args({ kind: 'sticker' }), deps().deps);
        await gatePerception(args(), deps({ readSettings: async () => museSettingsOff() }).deps);
        await gatePerception(args(), deps({ readSettings: async () => settingsOn({ allowSenders: [] }) }).deps);
        await gatePerception(args(), deps({ routeReady: async () => false }).deps);
        await gatePerception(args(), deps({ spentToday: async () => 99 }).deps);
        assert.deepEqual(skipped(), [
            'perception.skipped:unsupported_kind', 'perception.skipped:switch_off', 'perception.skipped:not_allowed_sender',
            'perception.skipped:no_key', 'perception.skipped:budget',
        ]);
        const line = logged.find((l) => l.event === 'perception.skipped:switch_off')!;
        assert.equal(line['creator_id'], TENANT);
        assert.equal(line['capability'], 'dm_media');
        assert.equal(line['kind'], 'reel');
        assert.ok(!JSON.stringify(logged).includes(SENDER), 'the sender id is not in a gate line (the pipeline\'s log context carries it)');
    });

    it('the money and the key are the only refusals worth a warning; the rest are the product as configured', async () => {
        await gatePerception(args({ kind: 'sticker' }), deps().deps);
        await gatePerception(args(), deps({ readSettings: async () => museSettingsOff() }).deps);
        await gatePerception(args(), deps({ routeReady: async () => false }).deps);
        await gatePerception(args(), deps({ spentToday: async () => 99 }).deps);
        const level = (event: string): string | undefined => logged.find((l) => l.event === event)?.level;
        assert.equal(level('perception.skipped:unsupported_kind'), 'info');
        assert.equal(level('perception.skipped:switch_off'), 'info');
        assert.equal(level('perception.skipped:no_key'), 'warn');
        assert.equal(level('perception.skipped:budget'), 'warn');
    });

    it('asks for nothing it does not need: each refusal stops at its own check', async () => {
        const a = deps({ readSettings: async () => settingsOn({ allowSenders: [] }) });
        await gatePerception(args(), a.deps);
        const b = deps({ routeReady: async () => false });
        await gatePerception(args(), b.deps);
        const c = deps({ spentToday: async () => 5 });
        await gatePerception(args(), c.deps);
        assert.deepEqual(a.calls, { settings: 1, route: 0, spent: 0, told: 0 }, 'sender refused: no key check, no spend');
        assert.deepEqual(b.calls, { settings: 1, route: 1, spent: 0, told: 0 }, 'no key: no spend');
        assert.deepEqual(c.calls, { settings: 1, route: 1, spent: 1, told: 1 }, 'budget: everything was read');
    });
});

describe('gatePerception: against the real statements', () => {
    const SETTINGS = {
        [`muse.switches.${TENANT}`]: '{"dm_media":true}',
        [`muse.allow_senders.${TENANT}`]: '["*"]',
        [`muse.daily_usd.${TENANT}`]: '3',
    };
    const at = (iso: string): Date => new Date(iso);
    /** What the gate reads from the database itself (settings and spend); the key check and the owner's notice are handed in. */
    const real = (told: BudgetNotice[] = []): GateDeps => ({
        now: () => NOW, routeReady: async () => true, tellOwner: async (n) => { told.push(n); },
    });

    it('reads the three settings and the day\'s spend through the database, and passes when there is room', async () => {
        const db = installDb({
            settings: { ...SETTINGS, [`muse.allow_senders.${TENANT}`]: JSON.stringify([SENDER]), [`muse.daily_usd.${TENANT}`]: '5' },
            usage: [{ creator_id: TENANT, purpose: 'perception_dm', usd: 1.5, at: at('2026-11-01T01:00:00Z') }],
        });
        const told: BudgetNotice[] = [];
        assert.deepEqual(await gatePerception(args(), real(told)), { ok: true });
        assert.deepEqual(told, []);
        assert.ok(db.statements.some((s) => s.sql.includes('FROM ai_usage')));
    });

    it('counts only this tenant\'s four perception purposes since UTC midnight: 2.9 of 3 is open, and the next 0.1 closes the day', async () => {
        const counted = (first: number): UsageRow[] => [
            { creator_id: TENANT, purpose: 'perception_dm', usd: first, at: at('2026-11-01T00:00:00Z') },
            { creator_id: TENANT, purpose: 'perception_voice', usd: 0.5, at: at('2026-11-01T05:00:00Z') },
            { creator_id: TENANT, purpose: 'recall', usd: 0.5, at: at('2026-11-01T06:00:00Z') },
            { creator_id: TENANT, purpose: 'reel_index', usd: 0.9, at: at('2026-11-01T07:00:00Z') },
            // Not counted: the DM reply itself, another tenant, and yesterday.
            { creator_id: TENANT, purpose: 'dm', usd: 50, at: at('2026-11-01T08:00:00Z') },
            { creator_id: OTHER, purpose: 'perception_dm', usd: 50, at: at('2026-11-01T08:00:00Z') },
            { creator_id: TENANT, purpose: 'perception_dm', usd: 50, at: at('2026-10-31T23:59:59Z') },
        ];
        installDb({ settings: SETTINGS, usage: counted(1) });
        const open: BudgetNotice[] = [];
        assert.deepEqual(await gatePerception(args(), real(open)), { ok: true }, '1 + 0.5 + 0.5 + 0.9 = 2.9');
        assert.deepEqual(open, []);

        installDb({ settings: SETTINGS, usage: counted(1.1) });
        const closed: BudgetNotice[] = [];
        assert.deepEqual(await gatePerception(args(), real(closed)), { ok: false, reason: 'budget' }, 'now 3.0: the cap is reached');
        assert.equal(closed.length, 1);
        assert.ok(Math.abs(closed[0]!.spentUsd - 3) < 1e-9);
        assert.equal(closed[0]!.capUsd, 3);
    });

    it('is the product as it was for a tenant with nothing saved: switch_off, and no spend read', async () => {
        const db = installDb();
        assert.deepEqual(await gatePerception(args(), real()), { ok: false, reason: 'switch_off' });
        assert.ok(!db.statements.some((s) => s.sql.includes('FROM ai_usage')));
    });
});

// ─── The spend ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('spentTodayUsd', () => {
    it('sums the tenant\'s usd for the four perception purposes since UTC midnight, and names the tenant in the statement', async () => {
        const db = installDb({ usage: [{ creator_id: TENANT, purpose: 'recall', usd: 0.25, at: new Date('2026-11-01T02:00:00Z') }] });
        assert.equal(await spentTodayUsd(TENANT, NOW), 0.25);
        const q = db.statements[0]!;
        assert.match(q.sql, /creator_id = \$1/);
        assert.deepEqual(q.params, [TENANT, ['perception_dm', 'perception_voice', 'recall', 'reel_index'], dayStart(NOW)]);
        assert.equal((q.params[2] as Date).toISOString(), '2026-11-01T00:00:00.000Z');
    });

    it('is the four purposes the data model lists, and the two phases the build cut are not among them', () => {
        assert.deepEqual([...MUSE_BUDGET_PURPOSES], ['perception_dm', 'perception_voice', 'recall', 'reel_index']);
    });

    it('is 0 for a tenant with no rows, and a number that is not one is an error rather than a free day', async () => {
        installDb();
        assert.equal(await spentTodayUsd(TENANT, NOW), 0);
        (pool as any).query = async () => ({ rows: [{ usd: 'not a number' }], rowCount: 1 });
        await assert.rejects(() => spentTodayUsd(TENANT, NOW), /not a number/);
        (pool as any).query = async () => ({ rows: [], rowCount: 0 });
        assert.equal(await spentTodayUsd(TENANT, NOW), 0);
    });

    it('rolls over at UTC midnight: yesterday\'s spend is not today\'s', async () => {
        installDb({ usage: [{ creator_id: TENANT, purpose: 'perception_dm', usd: 9, at: new Date('2026-11-01T23:59:59Z') }] });
        assert.equal(await spentTodayUsd(TENANT, NOW), 9);
        assert.equal(await spentTodayUsd(TENANT, TOMORROW), 0);
    });
});

// ─── The key check ───────────────────────────────────────────────────────────────────────────────────────────────────────

describe('perceptionRouteReady', () => {
    it('reads a failure that is not "no provider" as a failure to tell, never as "no key"', async () => {
        // No settings at all: the providers layer finds no key and answers `no_provider`; a database that fails is another error, which the gate treats as no route.
        (pool as any).query = async () => { throw new Error('connection terminated'); };
        await assert.rejects(() => perceptionRouteReady(TENANT), (err) => !(err instanceof AiError && err.kind === 'no_provider'));
    });

    it('asks the providers layer on a purpose that layer routes to Meta only', () => {
        for (const purpose of ['perception_dm', 'recall', 'reel_index']) assert.ok((AI_PURPOSES as readonly string[]).includes(purpose), purpose);
        assert.deepEqual((PURPOSE_PROVIDER_ALLOWLIST as Record<string, readonly string[] | undefined>)['perception_dm'], ['meta']);
    });
});

// ─── The notice ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buildBudgetNotice', () => {
    it('says the amounts and what to do, Arabic first, then English', () => {
        const { subject, text } = buildBudgetNotice(3.0412, 3);
        const [ar, en] = text.split('\n\n');
        assert.match(ar!, /^AutoReply · /);
        assert.ok(/[\u0600-\u06ff]/.test(ar!), 'the first part is Arabic');
        assert.ok(!/[\u0600-\u06ff]/.test(en!), 'the second part is English');
        assert.ok(ar!.includes('$3.04') && ar!.includes('$3.00'));
        assert.ok(en!.includes('$3.04') && en!.includes('$3.00'));
        assert.match(en!, /raise the daily cap/);
        assert.match(subject, /daily cap reached/);
    });

    it('holds no customer, no tenant and no id, and none of the words the product never says', () => {
        const { subject, text } = buildBudgetNotice(3, 3);
        const all = `${subject}\n${text}`;
        assert.ok(!all.includes(TENANT) && !all.includes(SENDER));
        for (const banned of [/\bbot\b/i, /بوت/, /ذكي/, /\binstant/i, /\bguaranteed/i, /\bAI-powered/i]) assert.doesNotMatch(all, banned);
    });
});

describe('claimBudgetNotice: one per tenant per UTC day, decided by one statement', () => {
    it('is true for the first claim of a day and false for every other that day', async () => {
        const db = installDb();
        assert.equal(await claimBudgetNotice(TENANT, NOW), true);
        assert.equal(await claimBudgetNotice(TENANT, new Date('2026-11-01T23:59:59Z')), false);
        assert.equal(await claimBudgetNotice(TENANT, NOW), false);
        assert.equal(db.settings.get(`muse.budget_notice.${TENANT}`), '2026-11-01');
    });

    it('is true again on the next UTC day', async () => {
        installDb();
        assert.equal(await claimBudgetNotice(TENANT, NOW), true);
        assert.equal(await claimBudgetNotice(TENANT, TOMORROW), true);
        assert.equal(await claimBudgetNotice(TENANT, TOMORROW), false);
    });

    it('is per tenant: one tenant\'s claim leaves another\'s open', async () => {
        installDb();
        assert.equal(await claimBudgetNotice(TENANT, NOW), true);
        assert.equal(await claimBudgetNotice(OTHER, NOW), true);
    });

    it('of two claims at the same instant, exactly one wins', async () => {
        installDb();
        const results = await Promise.all([claimBudgetNotice(TENANT, NOW), claimBudgetNotice(TENANT, NOW), claimBudgetNotice(TENANT, NOW)]);
        assert.deepEqual(results.filter(Boolean).length, 1);
    });

    it('is ONE statement that writes only when the stored day differs, so the database and not a read decides it', async () => {
        const db = installDb();
        await claimBudgetNotice(TENANT, NOW);
        assert.equal(db.statements.length, 1);
        assert.match(db.statements[0]!.sql, /ON CONFLICT \(key\) DO UPDATE SET value = EXCLUDED\.value, updated_at = NOW\(\) WHERE app_settings\.value IS DISTINCT FROM EXCLUDED\.value RETURNING key/);
        assert.deepEqual(db.statements[0]!.params, [`muse.budget_notice.${TENANT}`, '2026-11-01']);
    });
});

describe('tellOwnerBudgetReached', () => {
    const notice = (over: Partial<BudgetNotice> = {}): BudgetNotice => ({ creatorId: TENANT, spentUsd: 3.2, capUsd: 3, now: NOW, ...over });

    it('sends one message to Telegram and one email, the first time that day', async () => {
        installDb({ settings: CHANNELS_ON });
        const posted = stubChannels();
        await tellOwnerBudgetReached(notice());
        assert.deepEqual(posted.map((p) => p.channel).sort(), ['email', 'telegram']);
        const tg = posted.find((p) => p.channel === 'telegram')!;
        assert.equal(tg.body.chat_id, '42');
        assert.ok(String(tg.body.text).includes('$3.20') && String(tg.body.text).includes('$3.00'));
        const mail = posted.find((p) => p.channel === 'email')!;
        assert.deepEqual(mail.body.to, ['owner@example.com']);
        assert.match(String(mail.body.subject), /daily cap reached/);
        assert.equal(logged.find((l) => l.event === 'perception.budget_notice')?.['telegram'], 'sent');
        assert.equal(logged.find((l) => l.event === 'perception.budget_notice')?.['email'], 'sent');
    });

    it('sends nothing the second time that day, and again the next day', async () => {
        installDb({ settings: CHANNELS_ON });
        const posted = stubChannels();
        await tellOwnerBudgetReached(notice());
        await tellOwnerBudgetReached(notice({ spentUsd: 4 }));
        await tellOwnerBudgetReached(notice({ now: new Date('2026-11-01T22:00:00Z') }));
        assert.equal(posted.length, 2, 'one message on each channel, for the whole day');
        await tellOwnerBudgetReached(notice({ now: TOMORROW }));
        assert.equal(posted.length, 4, 'and the next day starts again');
    });

    it('sends one message, not several, when the cap is reached by many refusals at once', async () => {
        installDb({ settings: CHANNELS_ON });
        const posted = stubChannels();
        await Promise.all(Array.from({ length: 6 }, () => tellOwnerBudgetReached(notice())));
        assert.equal(posted.filter((p) => p.channel === 'telegram').length, 1);
        assert.equal(posted.filter((p) => p.channel === 'email').length, 1);
    });

    it('uses whichever channel is on: a deployment with only email, or with none, is not an error', async () => {
        installDb({ settings: { [APP_SETTING_KEYS.notifyEmailApiKey]: CHANNELS_ON[APP_SETTING_KEYS.notifyEmailApiKey]!, [APP_SETTING_KEYS.notifyEmailTo]: 'owner@example.com', [APP_SETTING_KEYS.notifyEmailEnabled]: 'true' } });
        const emailOnly = stubChannels();
        await tellOwnerBudgetReached(notice());
        assert.deepEqual(emailOnly.map((p) => p.channel), ['email']);

        installDb({ settings: {} });
        const none = stubChannels();
        await tellOwnerBudgetReached(notice({ creatorId: OTHER }));
        assert.deepEqual(none, []);
        const line = logged.filter((l) => l.event === 'perception.budget_notice').at(-1)!;
        assert.equal(line.level, 'warn', 'nobody could be told, and the log says so');
        assert.deepEqual([line['telegram'], line['email']], ['off', 'off']);
    });

    it('never throws and never retries: a channel that refuses or drops is a logged outcome, and the day is still claimed', async () => {
        installDb({ settings: CHANNELS_ON });
        const posted = stubChannels({ telegram: 'rejected', email: 'throws' });
        await tellOwnerBudgetReached(notice());
        assert.equal(posted.length, 2);
        const line = logged.find((l) => l.event === 'perception.budget_notice')!;
        assert.deepEqual([line['telegram'], line['email']], ['failed', 'failed']);
        assert.equal(line.level, 'warn');
        await tellOwnerBudgetReached(notice());
        assert.equal(posted.length, 2, 'not tried again the same day');
    });

    it('a database that fails is a logged warning, not a throw, and nothing is sent', async () => {
        installDb({ settings: CHANNELS_ON, failOn: /INSERT INTO app_settings/ });
        const posted = stubChannels();
        await tellOwnerBudgetReached(notice());
        assert.deepEqual(posted, []);
        assert.equal(logged.filter((l) => l.event === 'perception.budget_notice_failed').length, 1);
    });

    it('puts no secret in the message or the log: neither the bot token nor the email key', async () => {
        installDb({ settings: CHANNELS_ON });
        const posted = stubChannels();
        await tellOwnerBudgetReached(notice());
        const token = CHANNELS_ON[APP_SETTING_KEYS.notifyTelegramBotToken]!;
        const key = CHANNELS_ON[APP_SETTING_KEYS.notifyEmailApiKey]!;
        for (const p of posted) {
            assert.ok(!JSON.stringify(p.body).includes(token) && !JSON.stringify(p.body).includes(key), p.channel);
        }
        assert.ok(!JSON.stringify(logged).includes(token) && !JSON.stringify(logged).includes(key));
    });
});
