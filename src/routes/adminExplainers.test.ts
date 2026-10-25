/**
 * The platform admin's Explainers card (T050, contracts/http-api.md "Settings"): `GET`/`PUT /api/admin/explainers/provider`, `PUT .../enabled` and
 * `POST .../provider/test`, driven through the real admin router (its gate included) against a fake pool, with Cloudflare answered by an injected
 * `fetch`. What is pinned: platform admin only; the token stored encrypted, shown as its last four characters and in no answer, no audit row and
 * no log line; an omitted token left alone; the owner-only switch; and a Test that draws one 256×256 picture against the allowance.
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Request as ExpressRequest, Response as ExpressResponse, Router } from 'express';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { resumeAt, utcDay } from '../services/explainers/pictures/allowance.js';
import { TEST_PROMPT, TEST_SIZE } from '../services/explainers/pictures/prompt.js';
import { setImageProviderFetch } from '../services/explainers/pictures/provider.js';
import { installAllowanceTable, installSettings, PNG_1X1, type AllowanceTableRow } from '../services/explainers/pictures/testSupport.js';
import { installFakeDb, type FakeDb } from '../services/monteur/testDb.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';
import { leaksSecret } from './adminExplainers.js';

const OWNER = 'aaaaaaaa-1111-4111-8111-111111111111'; // with letters, so a test of upper case is a test
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-test-token-Zk3Qw9Lm2Xp7Vb5Nc8Rt1Yh4Ud6Sg0Jf';
const KEY = 'explainers.image_provider';

const ADMIN = { userId: null, role: 'platform_admin', tenantId: OWNER, tokenVersion: 0 };
const NOT_ADMIN = { userId: 'u-1', role: 'user', tenantId: OTHER, tokenVersion: 1 };

interface Reply { status: number; body: any; fellThrough?: boolean }

function call(router: Router, method: string, url: string, opts: { session?: unknown; body?: unknown } = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = { method, url, originalUrl: url, body: opts.body ?? {}, query: {}, params: {}, headers: {}, session: opts.session } as unknown as ExpressRequest;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as ExpressResponse;
        router(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

const get = () => call(adminRouter, 'GET', '/explainers', { session: ADMIN });
const putProvider = (body: unknown) => call(adminRouter, 'PUT', '/explainers/provider', { session: ADMIN, body });
const putEnabled = (body: unknown) => call(adminRouter, 'PUT', '/explainers/enabled', { session: ADMIN, body });
const test = () => call(adminRouter, 'POST', '/explainers/provider/test', { session: ADMIN });

let savedKey: string | undefined;
let logLines: string[] = [];
let restoreSink: (() => void) | undefined;
before(() => {
    savedKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    const previous = setLogSink((_level, line) => { logLines.push(line); });
    restoreSink = () => setLogSink(previous);
});
after(() => {
    if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY; else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    restoreSink?.();
});

describe('/api/admin/explainers', () => {
    let db: FakeDb;
    let settings: Map<string, string>;
    let table: AllowanceTableRow[];
    let audits: { action: string; targetType: string | null; targetId: string | null; detail: Record<string, unknown> }[];
    let fetches: { url: string; init: RequestInit }[];
    let answer: () => Response | Promise<Response>;

    const cloudflareOk = (): Response => new Response(JSON.stringify({ result: { image: PNG_1X1.toString('base64') }, success: true, errors: [] }), { status: 200 });
    const saved = (over: Record<string, unknown> = {}) => ({
        provider: 'cloudflare', account_id: ACCOUNT, token_enc: encryptSecret(TOKEN), model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 80, units_per_picture: 110, ...over,
    });
    const stored = () => JSON.parse(settings.get(KEY)!);
    const everything = (reply: Reply): string => JSON.stringify(reply.body);

    beforeEach(() => {
        logLines = [];
        audits = [];
        fetches = [];
        answer = cloudflareOk;
        db = installFakeDb({ platformTenant: OWNER });
        settings = installSettings(db);
        table = installAllowanceTable(db);
        db.routes.push(
            [/^SELECT id FROM creators ORDER BY created_at, id$/, () => ({ rows: [{ id: OWNER }, { id: OTHER }] })],
            [/^SELECT key, value FROM app_settings WHERE key LIKE \$1$/, (p) => ({
                rows: [...settings.entries()].filter(([key]) => key.startsWith(String(p[0]).replace(/%$/, ''))).map(([key, value]) => ({ key, value })),
            })],
            [/^INSERT INTO audit_log/, (p) => { audits.push({ action: p[2], targetType: p[3], targetId: p[4], detail: JSON.parse(p[5]) }); return { rows: [{ id: 'audit-1' }], rowCount: 1 }; }],
        );
        setImageProviderFetch(async (url, init) => { fetches.push({ url, init }); return answer(); });
    });
    afterEach(() => { db.restore(); setImageProviderFetch(undefined); });

    describe('who may use it', () => {
        it('is for the platform admin only: everyone else, and nobody, gets the 404 every admin route gives, and nothing is read or written', async () => {
            for (const session of [NOT_ADMIN, undefined, { ...ADMIN, role: 'owner' }]) {
                for (const [method, url] of [['GET', '/explainers'], ['PUT', '/explainers/provider'], ['PUT', '/explainers/enabled'], ['POST', '/explainers/provider/test']] as const) {
                    const reply = await call(adminRouter, method, url, { session, body: { account_id: ACCOUNT, token: TOKEN, tenant_id: OWNER, enabled: true } });
                    assert.equal(reply.status, 404, `${method} ${url}`);
                    assert.deepEqual(reply.body, { error: 'Not found.' });
                }
            }
            assert.equal(db.statements.length, 0);
            assert.equal(fetches.length, 0);
        });
    });

    describe('GET /explainers', () => {
        it('says nothing is configured: no provider, and no tenant switched on', async () => {
            const reply = await get();
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body, { enabled: { [OWNER]: false, [OTHER]: false }, provider: null });
        });

        it('shows every tenant with its switch, and the provider with the token as its last four characters', async () => {
            settings.set(KEY, JSON.stringify(saved({ daily_cap: 60, units_per_picture: 120 })));
            settings.set(`explainers.enabled.${OWNER}`, 'true');
            settings.set(`explainers.enabled.${OTHER}`, 'false');
            const reply = await get();
            assert.equal(reply.status, 200);
            assert.deepEqual(reply.body, {
                enabled: { [OWNER]: true, [OTHER]: false },
                provider: { provider: 'cloudflare', account_id: ACCOUNT, token_last4: TOKEN.slice(-4), model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 60, units_per_picture: 120 },
            });
        });

        it('carries neither the token nor its encrypted form anywhere in the answer', async () => {
            const config = saved();
            settings.set(KEY, JSON.stringify(config));
            const text = everything(await get());
            assert.equal(text.includes(TOKEN), false);
            assert.equal(text.includes(config.token_enc), false);
            assert.equal(text.includes('enc:v1'), false);
            assert.equal(text.includes('token_enc'), false);
        });

        it('says no last four, rather than failing, when the saved token cannot be read', async () => {
            settings.set(KEY, JSON.stringify(saved({ token_enc: 'enc:v1:aaaa:bbbb:cccc' })));
            const reply = await get();
            assert.equal(reply.status, 200);
            assert.equal(reply.body.provider.token_last4, null);
        });
    });

    describe('PUT /explainers/provider', () => {
        it('saves the account and the token on the first save: the token encrypted in the row, the answer showing only its last four', async () => {
            const reply = await putProvider({ account_id: ACCOUNT, token: TOKEN, daily_cap: 60 });
            assert.equal(reply.status, 200, JSON.stringify(reply.body));
            assert.deepEqual(reply.body.provider, {
                provider: 'cloudflare', account_id: ACCOUNT, token_last4: TOKEN.slice(-4), model: '@cf/black-forest-labs/flux-2-klein-4b', daily_cap: 60, units_per_picture: 110,
            });
            assert.equal(settings.get(KEY)!.includes(TOKEN), false, 'the plaintext is not in the row');
            assert.match(stored().token_enc, /^enc:v1:/);
            assert.equal(decryptSecret(stored().token_enc), TOKEN);
            assert.equal(everything(reply).includes(TOKEN), false);
            assert.equal(everything(reply).includes('enc:v1'), false);
        });

        it('answers as GET does, so the card shows what is saved after the save', async () => {
            settings.set(`explainers.enabled.${OWNER}`, 'true');
            const reply = await putProvider({ account_id: ACCOUNT, token: TOKEN });
            assert.deepEqual(Object.keys(reply.body).sort(), ['enabled', 'provider']);
            assert.deepEqual(reply.body.enabled, { [OWNER]: true, [OTHER]: false });
        });

        it('leaves the saved token exactly as it is when the save sends none, and changes only what it sends', async () => {
            const before = saved();
            settings.set(KEY, JSON.stringify(before));
            const reply = await putProvider({ account_id: ACCOUNT, daily_cap: 40 });
            assert.equal(reply.status, 200);
            assert.equal(stored().token_enc, before.token_enc, 'the same ciphertext');
            assert.equal(stored().daily_cap, 40);
            assert.equal(reply.body.provider.token_last4, TOKEN.slice(-4));
        });

        it('treats a token sent as blank, or null, as left out', async () => {
            const before = saved();
            settings.set(KEY, JSON.stringify(before));
            for (const token of ['', '   ', null]) {
                const reply = await putProvider({ account_id: ACCOUNT, token, daily_cap: 41 });
                assert.equal(reply.status, 200, String(token));
                assert.equal(stored().token_enc, before.token_enc);
            }
        });

        it('replaces the token when a new one is sent', async () => {
            settings.set(KEY, JSON.stringify(saved()));
            const fresh = 'a-brand-new-token-0123456789abcdef';
            const reply = await putProvider({ token: fresh });
            assert.equal(decryptSecret(stored().token_enc), fresh);
            assert.equal(reply.body.provider.token_last4, fresh.slice(-4));
        });

        it('records who changed what in the audit log: the fields, and never the token', async () => {
            await putProvider({ account_id: ACCOUNT, token: TOKEN, daily_cap: 60 });
            assert.equal(audits.length, 1);
            assert.equal(audits[0]!.action, AUDIT_ACTIONS.explainersProviderUpdated);
            assert.equal(audits[0]!.action, 'explainers.provider_updated');
            assert.deepEqual(audits[0]!.detail, { changed: ['account_id', 'token', 'daily_cap'] });
            assert.equal(JSON.stringify(audits).includes(TOKEN), false);
            assert.equal(JSON.stringify(db.statements.map((s) => s.params)).includes(TOKEN), false, 'the token is not a parameter of any statement either');
        });

        it('says what is wrong, every problem at once, with 400, and writes and audits nothing', async () => {
            const reply = await putProvider({ account_id: '../../x', token: 'two words in here that are long enough', daily_cap: -1 });
            assert.equal(reply.status, 400);
            assert.equal(reply.body.problems.length, 3);
            assert.match(reply.body.error, /3 problems/);
            assert.equal(settings.has(KEY), false);
            assert.equal(audits.length, 0);
        });

        it('wants the token the first time, and says a single problem in its own words', async () => {
            const reply = await putProvider({ account_id: ACCOUNT });
            assert.equal(reply.status, 400);
            assert.match(reply.body.error, /token is required the first time/);
            assert.equal(reply.body.problems.length, 1);
            assert.equal(settings.has(KEY), false);
        });

        it('does not write, or audit, a save that changes nothing', async () => {
            settings.set(KEY, JSON.stringify(saved()));
            db.statements.length = 0;
            const reply = await putProvider({ account_id: ACCOUNT, daily_cap: 80, units_per_picture: 110 });
            assert.equal(reply.status, 200);
            assert.equal(db.ran(/^INSERT INTO app_settings/).length, 0);
            assert.equal(audits.length, 0);
        });

        it('never logs the token', async () => {
            await putProvider({ account_id: ACCOUNT, token: TOKEN });
            await putProvider({ account_id: 'bad id', token: TOKEN });
            await get();
            assert.equal(logLines.some((line) => line.includes(TOKEN) || line.includes('enc:v1')), false);
        });

        it('is a 500 that says nothing of the request when the encryption key is missing, and writes nothing', async () => {
            delete process.env.TOKEN_ENCRYPTION_KEY;
            try {
                const reply = await putProvider({ account_id: ACCOUNT, token: TOKEN });
                assert.equal(reply.status, 500);
                assert.equal(everything(reply).includes(TOKEN), false);
                assert.equal(settings.has(KEY), false);
            } finally {
                process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
            }
        });
    });

    describe('PUT /explainers/enabled', () => {
        it('switches Explainers on for the owner: the setting is written, the switch audited, and the answer shows it', async () => {
            const reply = await putEnabled({ tenant_id: OWNER, enabled: true });
            assert.equal(reply.status, 200, JSON.stringify(reply.body));
            assert.equal(settings.get(`explainers.enabled.${OWNER}`), 'true');
            assert.deepEqual(reply.body.enabled, { [OWNER]: true, [OTHER]: false });
            assert.equal(audits.length, 1);
            assert.equal(audits[0]!.action, AUDIT_ACTIONS.explainersEnabledChanged);
            assert.equal(audits[0]!.action, 'explainers.enabled_changed');
            assert.deepEqual([audits[0]!.targetType, audits[0]!.targetId], ['tenant', OWNER]);
            assert.deepEqual(audits[0]!.detail, { tenant_id: OWNER, enabled: true });
        });

        it('switches it off again by removing the setting, so off is the default and not a stored value', async () => {
            settings.set(`explainers.enabled.${OWNER}`, 'true');
            const reply = await putEnabled({ tenant_id: OWNER, enabled: false });
            assert.equal(reply.status, 200);
            assert.equal(settings.has(`explainers.enabled.${OWNER}`), false);
            assert.deepEqual(reply.body.enabled, { [OWNER]: false, [OTHER]: false });
            assert.deepEqual(audits[0]!.detail, { tenant_id: OWNER, enabled: false });
        });

        it('refuses to switch it on for a tenant that is not the owner: 409 EXPLAINERS_OWNER_ONLY in the app’s error envelope, nothing written, nothing audited', async () => {
            const reply = await putEnabled({ tenant_id: OTHER, enabled: true });
            assert.equal(reply.status, 409);
            assert.equal(reply.body.code, 'EXPLAINERS_OWNER_ONLY');
            assert.equal(typeof reply.body.error, 'string', 'error stays the sentence every client reads');
            assert.equal(reply.body.message, reply.body.error);
            assert.match(reply.body.error, /only for the platform owner/);
            assert.deepEqual(reply.body.params, {});
            assert.equal(settings.has(`explainers.enabled.${OTHER}`), false);
            assert.equal(audits.length, 0);
        });

        it('lets a stray switch of another tenant be switched OFF', async () => {
            settings.set(`explainers.enabled.${OTHER}`, 'true');
            const reply = await putEnabled({ tenant_id: OTHER, enabled: false });
            assert.equal(reply.status, 200);
            assert.equal(settings.has(`explainers.enabled.${OTHER}`), false);
        });

        it('takes a tenant id in either case', async () => {
            const reply = await putEnabled({ tenant_id: OWNER.toUpperCase(), enabled: true });
            assert.equal(reply.status, 200);
            assert.equal(settings.get(`explainers.enabled.${OWNER}`), 'true');
        });

        it('is 400 for a tenant id that is not one and for an enabled that is not true or false, and writes nothing', async () => {
            for (const body of [{ enabled: true }, { tenant_id: 'not-a-uuid', enabled: true }, { tenant_id: OWNER }, { tenant_id: OWNER, enabled: 'yes' }, { tenant_id: OWNER, enabled: 1 }, null]) {
                const reply = await putEnabled(body);
                assert.equal(reply.status, 400, JSON.stringify(body));
            }
            assert.equal(db.ran(/app_settings/).length, 0);
            assert.equal(audits.length, 0);
        });
    });

    describe('POST /explainers/provider/test', () => {
        beforeEach(() => { settings.set(KEY, JSON.stringify(saved())); });

        it('draws one 256×256 picture with the saved account and token, and says it worked and how long it took', async () => {
            const reply = await test();
            assert.equal(reply.status, 200, JSON.stringify(reply.body));
            assert.equal(reply.body.ok, true);
            assert.equal(typeof reply.body.ms, 'number');
            assert.ok(reply.body.ms >= 0);
            assert.equal(reply.body.error, undefined);
            assert.equal(fetches.length, 1);
            assert.equal(fetches[0]!.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
            const form = fetches[0]!.init.body as FormData;
            assert.deepEqual([form.get('width'), form.get('height'), form.get('prompt')], [String(TEST_SIZE.width), String(TEST_SIZE.height), TEST_PROMPT]);
            assert.deepEqual(TEST_SIZE, { width: 256, height: 256 });
        });

        it('sends the token in the Authorization header and nowhere else', async () => {
            await test();
            assert.equal(new Headers(fetches[0]!.init.headers).get('authorization'), `Bearer ${TOKEN}`);
            assert.equal(fetches[0]!.url.includes(TOKEN), false);
        });

        it('counts against the allowance: one picture of today, and keeps it', async () => {
            await test();
            const today = table.find((row) => row.day === utcDay());
            assert.deepEqual([today?.units, today?.pictures], [110, 1]);
        });

        it('when Cloudflare refuses: answers 200 with ok false and Cloudflare’s words, and gives the units back', async () => {
            answer = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }), { status: 401 });
            const reply = await test();
            assert.equal(reply.status, 200);
            assert.equal(reply.body.ok, false);
            assert.equal(reply.body.error, 'Cloudflare refused the picture: Authentication error');
            assert.equal(typeof reply.body.ms, 'number');
            const today = table.find((row) => row.day === utcDay());
            assert.deepEqual([today?.units, today?.pictures], [0, 0]);
        });

        it('never puts the token in the answer, even when Cloudflare echoes it', async () => {
            answer = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `Invalid token ${TOKEN}` }] }), { status: 401 });
            const reply = await test();
            assert.equal(everything(reply).includes(TOKEN), false);
            assert.equal(reply.body.ok, false);
            assert.match(reply.body.error, /\[redacted\]/);
            assert.equal(logLines.some((line) => line.includes(TOKEN)), false);
        });

        it('when Cloudflare says the allowance is used up (4006): says so, marks the day, keeps the units, and the next test is refused with 429 until the reset', async () => {
            answer = () => new Response(JSON.stringify({ success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation' }] }), { status: 400 });
            const first = await test();
            assert.equal(first.status, 200);
            assert.equal(first.body.ok, false);
            assert.match(first.body.error, /allowance is used up/);
            const today = table.find((row) => row.day === utcDay());
            assert.ok(today?.exhausted_at);
            assert.equal(today?.units, 110);

            const second = await test();
            assert.equal(second.status, 429);
            assert.equal(second.body.code, 'EXPLAINER_ALLOWANCE_PAUSED');
            assert.ok([resumeAt(new Date(Date.now() - 2000)).toISOString(), resumeAt(new Date()).toISOString()].includes(second.body.params.retryAt));
            assert.equal(fetches.length, 1, 'Cloudflare was not asked again');
        });

        it('is 429 with retryAt, and asks nobody, when today’s cap is reached', async () => {
            table.push({ provider: 'cloudflare', day: utcDay(), units: 8_800, pictures: 80, exhausted_at: null });
            const reply = await test();
            assert.equal(reply.status, 429);
            assert.equal(reply.body.code, 'EXPLAINER_ALLOWANCE_PAUSED');
            assert.match(reply.body.error, /limit of 80 pictures/);
            assert.equal(fetches.length, 0);
        });

        it('is 409 EXPLAINER_NO_PROVIDER when nothing is saved: there is nothing to test', async () => {
            settings.delete(KEY);
            const reply = await test();
            assert.equal(reply.status, 409);
            assert.equal(reply.body.code, 'EXPLAINER_NO_PROVIDER');
            assert.equal(fetches.length, 0);
        });

        it('is 502 EXPLAINER_PROVIDER_ERROR, saying to save the token again, when the saved token cannot be read', async () => {
            settings.set(KEY, JSON.stringify(saved({ token_enc: 'enc:v1:aaaa:bbbb:cccc' })));
            const reply = await test();
            assert.equal(reply.status, 502);
            assert.equal(reply.body.code, 'EXPLAINER_PROVIDER_ERROR');
            assert.match(reply.body.error, /Save the token again/);
            assert.equal(fetches.length, 0);
        });

        it('says ok false when the network fails, and gives the units back', async () => {
            setImageProviderFetch(async () => { throw new TypeError('fetch failed'); });
            const reply = await test();
            assert.equal(reply.status, 200);
            assert.equal(reply.body.ok, false);
            assert.match(reply.body.error, /could not be reached/);
            assert.equal(table.find((row) => row.day === utcDay())?.units, 0);
        });
    });
});

describe('leaksSecret', () => {
    it('is true when the text holds one of the secrets whole, and false for a four-character tail or an empty list', () => {
        assert.equal(leaksSecret({ a: `x ${TOKEN} y` }, [TOKEN]), true);
        assert.equal(leaksSecret({ token_last4: TOKEN.slice(-4) }, [TOKEN]), false);
        assert.equal(leaksSecret({ a: 'fine' }, []), false);
        assert.equal(leaksSecret({ a: 'fine' }, ['']), false);
    });

    it('ignores a "secret" too short to be told from the words around it', () => {
        assert.equal(leaksSecret({ a: 'the cat sat' }, ['cat']), false);
    });
});
