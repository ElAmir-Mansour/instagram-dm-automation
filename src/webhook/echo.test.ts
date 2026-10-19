/**
 * Echo takeover (`echo.ts`, docs/DM_SALES_PLAN.md §8 and assumption A4, S8): an echo is the account's own message coming back, and the only
 * one worth acting on is a person's own reply, which pauses the bot for that customer.
 *
 * Nothing here touches Postgres, Gemini or Meta: `pool.query` answers on the SQL it is handed (any statement a test did not arrange throws),
 * `axios.post` stands in for Gemini and `metaHttp.post` for the Send API, and every test asserts that NOTHING was sent: this path only ever
 * pauses and records.
 *
 * What is pinned, because each is a way the bot is silenced for a customer who was never answered by a person, or talks over the owner:
 *
 *   - the classification table: `app_id` is the only evidence, our own app wins, and every case it cannot decide is "unknown";
 *   - an UNKNOWN echo does nothing and is logged with what it was classified from (the evidence A4 asks to read);
 *   - the switch is off by default: off, an echo is dropped before it is a job and the handler reads one row and does nothing;
 *   - an owner echo pauses exactly that customer's conversation (tenant and sender scoped), stores his words once (keyed on Meta's id),
 *     sends nothing, and a failed pause is thrown so the runner retries it.
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import { after, before, describe, it } from 'node:test';
import { pool } from '../config/db.js';
import { metaHttp } from '../services/http.js';
import { setJobQueue } from '../jobs/queue.js';
import type { EnqueueInput, JobQueue } from '../jobs/types.js';
import { invalidateTenantCache } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import {
    appIdOf, classifyEcho, echoFromOwnApp, effectiveOwnerAppIds, handleEcho, MAX_OWNER_APP_IDS, ownAppIds, PAGE_INBOX_APP_IDS, parseOwnerAppIds,
} from './echo.js';
import { handleMessagingEvent } from './messaging.js';
import { enqueueWebhookBody, planJobs } from './router.js';

const OURS = '847772258381375';
const PAGE_INBOX = '263902037430900';
const SOMEONE_ELSE = '1517776481860111';
const CUSTOMER = '17841400000000001';

let logged: Array<{ level: string; event: string; [k: string]: unknown }> = [];
let restoreSink: (() => void) | undefined;
let previousLevel: string | undefined;
before(() => {
    // Debug lines are part of what is pinned (an own echo is quiet, a dropped one says so), so they are let through.
    previousLevel = process.env['LOG_LEVEL'];
    process.env['LOG_LEVEL'] = 'debug';
    const previous = setLogSink((level, line) => { logged.push({ level, ...JSON.parse(line) }); });
    restoreSink = () => setLogSink(previous);
});
after(() => {
    restoreSink?.();
    if (previousLevel === undefined) delete process.env['LOG_LEVEL']; else process.env['LOG_LEVEL'] = previousLevel;
});

const logs = (event: string) => logged.filter((l) => l.event === event);

// ─── The classification ─────────────────────────────────────────────────────────────────────

describe('classifyEcho: whose message is this?', () => {
    const known = { ownAppIds: [OURS], ownerAppIds: [...PAGE_INBOX_APP_IDS, '1217981644879628'] };

    /** The table. Each row is a kind of echo, and what must happen to it. */
    const table: Array<[string, string | null, { kind: string; why: string }]> = [
        ['our own Facebook app: our own send',                                  OURS,                 { kind: 'own', why: 'our_app' }],
        ['the Page inbox app (documented): a person replied',                    PAGE_INBOX,           { kind: 'owner', why: 'owner_app_id' }],
        ['the Page inbox app as Meta\'s echo reference prints it',                '26390203743090',     { kind: 'owner', why: 'owner_app_id' }],
        ['an id the owner added after reading the log',                         '1217981644879628',   { kind: 'owner', why: 'owner_app_id' }],
        ['another app (a tool like ManyChat): not us, and not the owner',        SOMEONE_ELSE,         { kind: 'unknown', why: 'other_app' }],
        ['no app_id at all (what an Instagram-app reply may look like: A4)',     null,                 { kind: 'unknown', why: 'no_app_id' }],
    ];

    for (const [name, appId, expected] of table) {
        it(`${name} -> ${expected.kind}`, () => {
            assert.deepEqual(classifyEcho(appId, known), expected);
        });
    }

    it('our own app wins when an id is on both lists: a mistake in the list can only make the bot answer, never silence it', () => {
        assert.deepEqual(classifyEcho(OURS, { ownAppIds: [OURS], ownerAppIds: [OURS, PAGE_INBOX] }), { kind: 'own', why: 'our_app' });
    });

    it('an echo with no app_id is unknown however the lists look, even with the owner list empty or ours unset', () => {
        assert.equal(classifyEcho(null, { ownAppIds: [], ownerAppIds: [] }).kind, 'unknown');
        assert.equal(classifyEcho(null, { ownAppIds: [OURS], ownerAppIds: [PAGE_INBOX] }).kind, 'unknown');
        assert.equal(classifyEcho(SOMEONE_ELSE, { ownAppIds: [], ownerAppIds: [] }).kind, 'unknown');
    });

    it('nothing but an app_id on the owner list ever classifies as the owner', () => {
        const owner = (appId: string | null) => classifyEcho(appId, known).kind === 'owner';
        const noise = [null, '', '0', 'null', 'undefined', 'true', OURS, SOMEONE_ELSE, `${PAGE_INBOX}0`, `${PAGE_INBOX}1`, '-1', '1e15', ' '];
        for (const value of noise) assert.equal(owner(value), false, String(value));
    });
});

describe('appIdOf: what the event says its app is', () => {
    const of = (app_id: unknown) => appIdOf({ message: { is_echo: true, app_id } });

    it('reads a string of digits, and a JSON number of the same', () => {
        assert.equal(of(PAGE_INBOX), PAGE_INBOX);
        assert.equal(of(` ${OURS} `), OURS);
        assert.equal(of(Number(OURS)), OURS);
    });

    it('is null for anything that is not an id: absent, empty, zero, text, objects, a number too big to be exact', () => {
        for (const value of [undefined, null, '', '0', '000000', 0, 'abc', '12 34', {}, [], true, NaN, 1e30, '1234']) {
            assert.equal(of(value), null, JSON.stringify(value));
        }
        assert.equal(appIdOf({}), null);
        assert.equal(appIdOf(null), null);
        assert.equal(appIdOf({ message: null }), null);
    });
});

describe('the lists', () => {
    it('knows our own apps from the environment: the Facebook app and, when it has one, the Instagram app; nothing malformed', () => {
        assert.deepEqual(ownAppIds({ META_APP_ID: OURS } as NodeJS.ProcessEnv), [OURS]);
        assert.deepEqual(ownAppIds({ META_APP_ID: ` ${OURS} `, INSTAGRAM_APP_ID: '991122334455' } as NodeJS.ProcessEnv), [OURS, '991122334455']);
        assert.deepEqual(ownAppIds({ META_APP_ID: 'not-an-id', INSTAGRAM_APP_ID: '' } as NodeJS.ProcessEnv), []);
        assert.deepEqual(ownAppIds({} as NodeJS.ProcessEnv), []);
    });

    it('the owner list is the documented Page inbox ids plus what the owner added, never one of ours, never twice', () => {
        assert.deepEqual(effectiveOwnerAppIds([], [OURS]), [...PAGE_INBOX_APP_IDS]);
        assert.deepEqual(effectiveOwnerAppIds(['1217981644879628', PAGE_INBOX], [OURS]), [...PAGE_INBOX_APP_IDS, '1217981644879628']);
        assert.deepEqual(effectiveOwnerAppIds([OURS, '1217981644879628'], [OURS]), [...PAGE_INBOX_APP_IDS, '1217981644879628'], 'ours is not "a person"');
    });

    it('reads what a person typed: ids separated by commas, spaces or lines; names a typo, never drops it', () => {
        assert.deepEqual(parseOwnerAppIds('1217981644879628, 99887766\n 99887766'), { ids: ['1217981644879628', '99887766'] });
        assert.deepEqual(parseOwnerAppIds(['12345', 67890]), { ids: ['12345', '67890'] });
        assert.deepEqual(parseOwnerAppIds(''), { ids: [] });
        assert.deepEqual(parseOwnerAppIds(null), { ids: [] });
        assert.match((parseOwnerAppIds('12345, 12ab') as { error: string }).error, /"12ab" is not an app id/);
        assert.match((parseOwnerAppIds('123') as { error: string }).error, /"123" is not an app id/);
        assert.ok('error' in parseOwnerAppIds({}));
        assert.ok('error' in parseOwnerAppIds([{}]));
        assert.match((parseOwnerAppIds(Array.from({ length: MAX_OWNER_APP_IDS + 1 }, (_, i) => String(10000 + i))) as { error: string }).error, /At most/);
    });

    it('recognises an echo that is certainly our own send from the event alone', () => {
        const env = { META_APP_ID: OURS } as NodeJS.ProcessEnv;
        assert.equal(echoFromOwnApp({ message: { is_echo: true, app_id: OURS } }, env), true);
        assert.equal(echoFromOwnApp({ message: { is_echo: true, app_id: PAGE_INBOX } }, env), false);
        assert.equal(echoFromOwnApp({ message: { is_echo: true } }, env), false);
        assert.equal(echoFromOwnApp({ message: { is_echo: true, app_id: OURS } }, {} as NodeJS.ProcessEnv), false, 'with no app id configured, nothing is "ours"');
    });
});

// ─── The handler ────────────────────────────────────────────────────────────────────────────

interface Executed { sql: string; params: any[] }

interface World {
    /** `app_settings` as saved. Takeover is ON unless a test says otherwise. */
    settings?: Record<string, string>;
    /** Whether the customer has a conversation: the id the pause finds, or null for none. */
    conversation?: string | null;
    creator?: Record<string, unknown> | null;
    /** The pause (or the insert) throws, as a database that has gone away would. */
    pauseFails?: boolean;
    insertFails?: boolean;
    env?: Record<string, string | undefined>;
}

const CREATOR = { id: 'creator-1', instagram_page_id: 'ig-page-1', facebook_page_id: 'fb-page-1', page_access_token: 'EAAGplaintext' };
const echo = (over: Record<string, unknown> = {}, event: Record<string, unknown> = {}) => ({
    sender: { id: 'ig-page-1' }, recipient: { id: CUSTOMER }, timestamp: 1_760_000_000_000,
    message: { mid: 'm_echo_1', text: 'Hi, this is Sami. I will answer you myself.', is_echo: true, ...over },
    ...event,
});

async function runEcho(event: any, world: World = {}): Promise<{ executed: Executed[]; sends: unknown[]; gemini: number; error: any }> {
    const settings = world.settings ?? { 'dm.echo_takeover': 'true' };
    const conversation = world.conversation === undefined ? 'conv-1' : world.conversation;
    const executed: Executed[] = [];
    const sends: unknown[] = [];
    let gemini = 0;
    const routes: Array<[RegExp, (sql: string, params: any[]) => { rows?: any[]; rowCount?: number }]> = [
        [/FROM app_settings WHERE key/, (_sql, params) => {
            const keys: string[] = Array.isArray(params[0]) ? params[0] : [params[0]];
            return { rows: keys.filter((k) => k in settings).map((key) => ({ key, value: settings[key], is_secret: false })) };
        }],
        [/FROM creators\s+WHERE is_active/, () => ({ rows: world.creator === null ? [] : [world.creator ?? CREATOR] })],
        [/UPDATE conversations SET is_bot_active = false/, () => {
            if (world.pauseFails) throw new Error('connection terminated');
            return { rows: conversation ? [{ id: conversation }] : [] };
        }],
        [/INSERT INTO messages/, () => {
            if (world.insertFails) throw new Error('connection terminated');
            return { rowCount: 1 };
        }],
    ];
    invalidateTenantCache();

    const originalQuery = pool.query;
    const originalAxios = axios.post;
    const originalMeta = metaHttp.post;
    const originalEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(world.env ?? { META_APP_ID: OURS })) {
        originalEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    (pool as any).query = async (sql: string, params: any[] = []) => {
        executed.push({ sql, params });
        const route = routes.find(([pattern]) => pattern.test(sql));
        if (!route) throw new Error(`no result arranged for SQL:\n${sql}`);
        const { rows = [], rowCount } = route[1](sql, params);
        return { rows, rowCount: rowCount ?? rows.length };
    };
    (axios as any).post = async () => { gemini++; return { data: {} }; };
    (metaHttp as any).post = async (url: string, body: unknown) => { sends.push({ url, body }); return { data: {} }; };

    let error: any = null;
    logged = [];
    try {
        await handleMessagingEvent(event, 'ig-page-1', { lastAttempt: false });
    } catch (err) {
        error = err;
    } finally {
        (pool as any).query = originalQuery;
        (axios as any).post = originalAxios;
        (metaHttp as any).post = originalMeta;
        for (const [k, v] of Object.entries(originalEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        invalidateTenantCache();
    }
    return { executed, sends, gemini, error };
}

const pauses = (r: { executed: Executed[] }) => r.executed.filter((e) => /UPDATE conversations SET is_bot_active = false/.test(e.sql));
const inserts = (r: { executed: Executed[] }) => r.executed.filter((e) => /INSERT INTO messages/.test(e.sql));

describe('handleEcho: off (the default)', () => {
    it('reads the one switch and does nothing else: no creator lookup, no pause, no row, nothing sent, and the old debug line', async () => {
        for (const settings of [{}, { 'dm.echo_takeover': 'false' }, { 'dm.echo_takeover': 'TRUE' }, { 'dm.echo_takeover': '1' }] as Array<Record<string, string>>) {
            const r = await runEcho(echo({ app_id: PAGE_INBOX }), { settings });
            assert.equal(r.error, null);
            assert.equal(r.executed.length, 1, JSON.stringify(settings));
            assert.match(r.executed[0]!.sql, /FROM app_settings WHERE key/);
            assert.equal(r.sends.length, 0);
            assert.equal(r.gemini, 0);
            assert.equal(logs('dm.skipped_echo').length, 1);
            assert.equal(logs('dm.echo_classified').length, 0, 'not even classified');
        }
    });
});

describe('handleEcho: on', () => {
    it('an echo from the Page inbox app pauses that customer\'s conversation, scoped to the tenant and the sender, and sends nothing', async () => {
        const r = await runEcho(echo({ app_id: PAGE_INBOX }));

        assert.equal(r.error, null);
        assert.equal(pauses(r).length, 1);
        assert.deepEqual(pauses(r)[0]!.params, ['creator-1', CUSTOMER], 'this tenant, this customer, and nobody else');
        assert.match(pauses(r)[0]!.sql, /WHERE creator_id = \$1 AND instagram_user_id = \$2/);
        assert.equal(r.sends.length, 0, 'it never sends');
        assert.equal(r.gemini, 0);
        const taken = logs('dm.echo_takeover')[0]!;
        assert.deepEqual([taken.conversation_id, taken.why], ['conv-1', 'owner_app_id']);
    });

    it('an owner echo leaves "Mark handled" alone: only a message FROM the customer clears it, not the owner\'s own reply', async () => {
        const r = await runEcho(echo({ app_id: PAGE_INBOX }));
        assert.equal(pauses(r).length, 1);
        assert.doesNotMatch(pauses(r)[0]!.sql, /handled_at/);
    });

    it('stores his words as an operator row keyed on Meta\'s message id, so a redelivery or a retry stores them once', async () => {
        const r = await runEcho(echo({ app_id: PAGE_INBOX }));

        assert.equal(inserts(r).length, 1);
        const insert = inserts(r)[0]!;
        assert.match(insert.sql, /'outbound', 'text', \$3, \$4, 'operator', \$5\)/);
        assert.match(insert.sql, /ON CONFLICT \(meta_message_id\) WHERE meta_message_id IS NOT NULL DO NOTHING/);
        assert.deepEqual([insert.params[0], insert.params[1], insert.params[2], insert.params[4]], ['conv-1', 'creator-1', 'Hi, this is Sami. I will answer you myself.', 'm_echo_1']);
        assert.deepEqual(JSON.parse(insert.params[3]), { text: 'Hi, this is Sami. I will answer you myself.', via: 'instagram_app_echo' });
        const pauseAt = r.executed.indexOf(pauses(r)[0]!);
        assert.ok(pauseAt < r.executed.indexOf(insert), 'the pause is the first thing done');
    });

    it('a message with no text (an image) is stored as an attachment, and one with no mid is not stored at all: nothing would make a retry safe', async () => {
        const image = await runEcho(echo({ app_id: PAGE_INBOX, text: undefined, attachments: [{ type: 'image' }] }));
        assert.equal(inserts(image)[0]!.params[2], '[Attachment]');
        const noMid = await runEcho(echo({ app_id: PAGE_INBOX, mid: undefined }));
        assert.equal(pauses(noMid).length, 1, 'still paused');
        assert.equal(inserts(noMid).length, 0);
    });

    it('an id the owner added from Settings is the owner too', async () => {
        const r = await runEcho(echo({ app_id: '1217981644879628' }), { settings: { 'dm.echo_takeover': 'true', 'dm.echo_owner_app_ids': '1217981644879628' } });
        assert.equal(pauses(r).length, 1);
    });

    it('an echo of our own app is left alone: nothing is paused, nothing stored, and it is not worth a line above debug', async () => {
        const r = await runEcho(echo({ app_id: OURS }));
        assert.equal(pauses(r).length + inserts(r).length, 0);
        assert.equal(r.sends.length, 0);
        const line = logs('dm.echo_classified')[0]!;
        assert.deepEqual([line.verdict, line.why, line.level], ['own', 'our_app', 'debug']);
    });

    it('an id on both lists is ours: the bot is not silenced by a mistake in the list', async () => {
        const r = await runEcho(echo({ app_id: OURS }), { settings: { 'dm.echo_takeover': 'true', 'dm.echo_owner_app_ids': OURS } });
        assert.equal(pauses(r).length, 0);
    });

    it('an echo with NO app_id, the case A4 has not proven, does nothing and is logged with what it was classified from', async () => {
        const r = await runEcho(echo({ app_id: undefined }));

        assert.equal(r.error, null);
        assert.equal(pauses(r).length + inserts(r).length, 0, 'uncertain: nothing happens');
        assert.equal(r.executed.length, 1, 'not even the customer\'s conversation is looked up');
        assert.equal(r.sends.length, 0);
        const line = logs('dm.echo_classified')[0]!;
        assert.deepEqual(
            [line.verdict, line.why, line.app_id, line.has_text, line.level],
            ['unknown', 'no_app_id', null, true, 'info'],
            'the evidence the owner reads after replying once from the Instagram app'
        );
        assert.equal(logs('dm.echo_takeover').length, 0);
    });

    it('an echo from another app, and an app_id that is not an id, are unknown too', async () => {
        const other = await runEcho(echo({ app_id: SOMEONE_ELSE }));
        assert.equal(pauses(other).length, 0);
        assert.deepEqual([logs('dm.echo_classified')[0]!.verdict, logs('dm.echo_classified')[0]!.why, logs('dm.echo_classified')[0]!.app_id], ['unknown', 'other_app', SOMEONE_ELSE]);
        for (const app_id of ['', 0, 'abc', null]) {
            assert.equal(pauses(await runEcho(echo({ app_id }))).length, 0, JSON.stringify(app_id));
        }
    });

    it('a customer who has no conversation is not given one, and a creator that is not found is logged: neither pauses anything', async () => {
        const none = await runEcho(echo({ app_id: PAGE_INBOX }), { conversation: null });
        assert.equal(none.error, null);
        assert.equal(inserts(none).length, 0);
        assert.equal(logs('dm.echo_no_conversation').length, 1);

        const noCreator = await runEcho(echo({ app_id: PAGE_INBOX }), { creator: null });
        assert.equal(pauses(noCreator).length, 0);
        assert.equal(logs('dm.echo_unresolved').length, 1);

        const noRecipient = await runEcho(echo({ app_id: PAGE_INBOX }, { recipient: undefined }));
        assert.equal(pauses(noRecipient).length, 0);
        assert.equal(logs('dm.echo_unresolved').length, 1);
    });

    it('a pause that fails is thrown, so the job runner retries it; so is a row that fails after the pause', async () => {
        const pause = await runEcho(echo({ app_id: PAGE_INBOX }), { pauseFails: true });
        assert.match(String(pause.error?.message), /connection terminated/);
        const row = await runEcho(echo({ app_id: PAGE_INBOX }), { insertFails: true });
        assert.ok(row.error, 'the pause is idempotent and the row is keyed on the mid, so the retry repeats nothing harmful');
        assert.equal(pauses(row).length, 1);
    });

    it('is the same for a Messenger echo: the sender is the Page, the recipient the customer\'s PSID', async () => {
        const r = await runEcho(echo({ app_id: PAGE_INBOX }, { sender: { id: 'fb-page-1' }, recipient: { id: '5001234567' } }));
        assert.deepEqual(pauses(r)[0]!.params, ['creator-1', '5001234567']);
    });

    it('handleEcho on its own answers what it did', async () => {
        // (the outcome is what the log lines above are built from)
        const original = pool.query;
        const originalApp = process.env['META_APP_ID'];
        process.env['META_APP_ID'] = OURS;
        (pool as any).query = async (sql: string) => {
            if (/FROM app_settings WHERE key/.test(sql)) return { rows: [{ key: 'dm.echo_takeover', value: 'true', is_secret: false }], rowCount: 1 };
            throw new Error('nothing else should be asked of the database for an unknown echo');
        };
        try {
            assert.equal(await handleEcho(echo({ app_id: SOMEONE_ELSE }), 'ig-page-1'), 'unclassified');
            assert.equal(await handleEcho(echo({ app_id: OURS }), 'ig-page-1'), 'own');
        } finally {
            (pool as any).query = original;
            if (originalApp === undefined) delete process.env['META_APP_ID']; else process.env['META_APP_ID'] = originalApp;
        }
    });
});

// ─── The queue ──────────────────────────────────────────────────────────────────────────────

describe('the queue: echoes become jobs only when takeover is on', () => {
    const delivery = (messaging: unknown[]) => ({ object: 'instagram', entry: [{ id: 'ig-page-1', messaging }] });
    const customerDm = { sender: { id: CUSTOMER }, recipient: { id: 'ig-page-1' }, message: { mid: 'm_in_1', text: 'hello' } };
    const dedupeKeys = (jobs: EnqueueInput[]) => jobs.map((j) => j.dedupeKey);

    function recordingQueue(): JobQueue & { calls: EnqueueInput[] } {
        const calls: EnqueueInput[] = [];
        return {
            calls,
            enqueue: async (input: EnqueueInput) => { calls.push(input); return `job-${calls.length}`; },
        } as unknown as JobQueue & { calls: EnqueueInput[] };
    }

    /** `enqueueWebhookBody` against a stubbed settings table; `reads` counts how often the switch was asked. */
    async function enqueue(body: unknown, value: string | null | Error, env: Record<string, string | undefined> = { META_APP_ID: OURS }) {
        const queue = recordingQueue();
        const previous = setJobQueue(queue);
        const original = pool.query;
        const originalEnv: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(env)) { originalEnv[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        let reads = 0;
        (pool as any).query = async (sql: string) => {
            if (!/FROM app_settings WHERE key/.test(sql)) throw new Error(`no result arranged for SQL: ${sql}`);
            reads++;
            if (value instanceof Error) throw value;
            return { rows: value === null ? [] : [{ value, is_secret: false }], rowCount: value === null ? 0 : 1 };
        };
        logged = [];
        try {
            const result = await enqueueWebhookBody(body);
            return { result, queue, reads };
        } finally {
            (pool as any).query = original;
            setJobQueue(previous);
            for (const [k, v] of Object.entries(originalEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        }
    }

    it('planJobs drops every echo unless asked otherwise, as the queue always did', () => {
        const body = delivery([customerDm, { sender: { id: 'ig-page-1' }, recipient: { id: CUSTOMER }, message: { mid: 'm_echo_1', is_echo: true, text: 'x', app_id: PAGE_INBOX } }]);
        assert.deepEqual(dedupeKeys(planJobs(body)), ['dm:m_in_1']);
        assert.deepEqual(dedupeKeys(planJobs(body, {})), ['dm:m_in_1']);
        assert.deepEqual(dedupeKeys(planJobs(body, { echoes: false })), ['dm:m_in_1']);
    });

    it('with echoes on, a person\'s echo is a dm.process job like any message, keyed on its mid; our own app\'s is still dropped; so is none of the rest', () => {
        const echoOf = (mid: string, app_id?: string) => ({ sender: { id: 'ig-page-1' }, recipient: { id: CUSTOMER }, message: { mid, is_echo: true, text: 'x', ...(app_id ? { app_id } : {}) } });
        const env = process.env['META_APP_ID'];
        process.env['META_APP_ID'] = OURS;
        try {
            const jobs = planJobs(delivery([customerDm, echoOf('m_e1', PAGE_INBOX), echoOf('m_e2', OURS), echoOf('m_e3'), echoOf('m_e4', SOMEONE_ELSE)]), { echoes: true });
            assert.deepEqual(dedupeKeys(jobs), ['dm:m_in_1', 'dm:m_e1', 'dm:m_e3', 'dm:m_e4']);
            assert.ok(jobs.every((j) => j.kind === 'dm.process'));
            assert.equal(jobs[1]!.tenantKey, 'ig-page-1');
        } finally {
            if (env === undefined) delete process.env['META_APP_ID']; else process.env['META_APP_ID'] = env;
        }
    });

    it('asks whether takeover is on only for a delivery that holds an echo, and enqueues the echo only when the answer is yes', async () => {
        const withEcho = delivery([customerDm, { sender: { id: 'ig-page-1' }, recipient: { id: CUSTOMER }, message: { mid: 'm_e1', is_echo: true, text: 'x' } }]);

        const on = await enqueue(withEcho, 'true');
        assert.equal(on.reads, 1);
        assert.deepEqual(dedupeKeys(on.queue.calls), ['dm:m_in_1', 'dm:m_e1']);

        const off = await enqueue(withEcho, 'false');
        assert.deepEqual(dedupeKeys(off.queue.calls), ['dm:m_in_1']);
        const unset = await enqueue(withEcho, null);
        assert.deepEqual(dedupeKeys(unset.queue.calls), ['dm:m_in_1']);

        const plain = await enqueue(delivery([customerDm]), 'true');
        assert.equal(plain.reads, 0, 'a delivery with no echo costs no read: the common case is unchanged');
        assert.deepEqual(dedupeKeys(plain.queue.calls), ['dm:m_in_1']);
    });

    it('a switch that cannot be read is OFF: the queue behaves as it always did, and says so', async () => {
        const withEcho = delivery([customerDm, { sender: { id: 'ig-page-1' }, recipient: { id: CUSTOMER }, message: { mid: 'm_e1', is_echo: true, text: 'x' } }]);
        const broken = await enqueue(withEcho, new Error('connection terminated'));
        assert.deepEqual(dedupeKeys(broken.queue.calls), ['dm:m_in_1']);
        assert.equal(logs('webhook.echo_setting_unreadable').length, 1);
    });
});
