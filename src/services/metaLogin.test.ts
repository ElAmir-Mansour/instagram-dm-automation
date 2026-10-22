/**
 * Connecting a tenant's own Facebook Page and Instagram account (P26, P27).
 *
 * Every test runs against `FakeDb` and `FakeGraph` (src/services/metaLoginHarness.ts): no database, no network, and a Graph that
 * throws on a path nothing configured, so nothing here can reach Meta whatever `.env` holds. The rules this file pins, in the order
 * it pins them:
 *
 *   - the dialog URL, and the redirect URI (built from the saved public base URL, never a Host header);
 *   - what is asked of Graph, and that a token only ever travels in the Authorization header;
 *   - which Page connects at once and which waits for a choice;
 *   - `completeMetaConnection`: a token that is not a PAGE token, a Page another tenant holds, a connection that is already there,
 *     a reconnect to different ids: all refused before anything is written, and the webhook subscribed before it is;
 *   - the owner's tenant is never touched by any of it;
 *   - no token, code or secret in a log line, a stored row, an audit row, an error or a response.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decryptSecret, isEncrypted } from '../config/crypto.js';
import { setLogSink } from '../utils/log.js';
import { AUDIT_ACTIONS } from './audit.js';
import { FakeDb, FakeGraph, page, type GraphPage } from './metaLoginHarness.js';
import {
    affectedFeatures, buildLoginUrl, canRunPage, classifyPages, completeMetaConnection, CORE_SCOPES, disconnectMeta, exchangeCode,
    extendUserToken, finishLogin, getMetaConnection, listPages, LOGIN_SCOPES, metaRedirectUri, MetaLoginError, pageIdConflict,
    planPages, readIntent, readMetaApp, readPickPayload, readPermissions, replacesConnection, scrubSecrets, subscribePage,
    unsubscribePage, validateSuppliedToken, WEBHOOK_FIELDS, type CompleteInput, type MetaApp,
} from './metaLogin.js';
import { readPick } from './oauthState.js';
import { REQUIRED_SCOPES } from './tokenHealth.js';
import { APP_SETTING_KEYS, tenantSettingKey, TENANT_SETTING_PREFIXES } from './appSettings.js';
import { ADS_SCOPES } from './metaLogin.js';

const NEW_TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const OWNER = '99999999-9999-4999-8999-999999999999';
const USER = '33333333-3333-4333-8333-333333333333';
const APP: MetaApp = { appId: '111222333444555', appSecret: 'the-app-secret-0123456789-never-in-a-log' };
const REDIRECT = 'https://autoreply.example/api/meta/callback';
const CODE = 'AQDauthorizationcodefrommeta0123456789abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKL';
const OWNER_TOKEN_PLAIN = 'OWNER-PAGE-TOKEN-never-touched-0123456789abcdef';

let db: FakeDb;
let graph: FakeGraph;
let logs: string[];
let restoreSink: () => void;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET', 'META_LOGIN_CONFIG_ID', 'PUBLIC_BASE_URL']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'cd'.repeat(32);
    process.env.META_APP_ID = APP.appId;
    process.env.META_APP_SECRET = APP.appSecret;
    delete process.env.META_LOGIN_CONFIG_ID;
    delete process.env.PUBLIC_BASE_URL;
    db = new FakeDb().install();
    graph = new FakeGraph().install();
    graph.appId = APP.appId;
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    restoreSink();
    graph.restore();
    db.restore();
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
});

/** A tenant that holds a Meta connection, as the owner's does: ids and a stored (encrypted) token, none of the v35 columns. */
async function connectedOwner(): Promise<void> {
    const { encryptSecret } = await import('../config/crypto.js');
    db.addCreator(OWNER, {
        name: 'owner', instagram_page_id: '17841499999999991', facebook_page_id: '100000000000001',
        page_access_token: encryptSecret(OWNER_TOKEN_PLAIN), token_status: 'valid',
    });
}

function complete(over: Partial<CompleteInput> & { page?: GraphPage } = {}): CompleteInput {
    const p = over.page ?? page(1);
    return {
        creatorId: NEW_TENANT, userId: USER, metaUserId: '90001',
        choice: { pageId: p.id, name: p.name ?? p.id, accessToken: p.access_token!, igId: p.instagram_business_account?.id ?? null, igUsername: p.instagram_business_account?.username ?? null },
        reconnect: false, confirmPageChange: false,
        ...over,
    };
}

/** Everything a secret could hide in, after a flow: logs, stored rows, statement parameters, audit rows. */
function leaks(secrets: string[]): string[] {
    const haystack = [logs.join('\n'), db.everything()].join('\n');
    return secrets.filter((s) => haystack.includes(s));
}

// ─── Scrubbing ──────────────────────────────────────────────────────────────────────────

describe('scrubSecrets', () => {
    it('removes the secrets it is told about, wherever they sit', () => {
        const out = scrubSecrets('failed for TOKEN-ABCDEFGH and again TOKEN-ABCDEFGH', ['TOKEN-ABCDEFGH']);
        assert.equal(out, 'failed for [redacted] and again [redacted]');
    });

    it('removes name=value pairs for the parameters Meta takes secrets in', () => {
        const out = scrubSecrets('GET /x?client_secret=shh&access_token=abc123&fb_exchange_token=zzz&input_token=yyy&code=AQD123&fields=id');
        assert.equal(out, 'GET /x?client_secret=[redacted]&access_token=[redacted]&fb_exchange_token=[redacted]&input_token=[redacted]&code=[redacted]&fields=id');
    });

    it('removes anything shaped like a Meta access token, and any long opaque run', () => {
        assert.equal(scrubSecrets('bad token EAAGm0PX4ZCpsBAKexample123456 here'), 'bad token [redacted] here');
        assert.equal(scrubSecrets(`code ${'A1b2'.repeat(20)} was used`), 'code [redacted] was used');
    });

    it('leaves an ordinary sentence alone, and ignores a "secret" too short to be one', () => {
        const s = 'Meta could not verify that token: Invalid OAuth access token. (Code: 190)';
        assert.equal(scrubSecrets(s, ['abc']), s);
    });
});

// ─── The dialog ─────────────────────────────────────────────────────────────────────────

describe('buildLoginUrl', () => {
    const base = { appId: APP.appId, redirectUri: REDIRECT, state: 'STATE123' };

    it('asks for a code, with the configuration id when there is one, and without scope=', () => {
        const url = new URL(buildLoginUrl({ ...base, configId: '987654321098765' }));
        assert.equal(url.origin + url.pathname, 'https://www.facebook.com/v26.0/dialog/oauth');
        assert.equal(url.searchParams.get('client_id'), APP.appId);
        assert.equal(url.searchParams.get('redirect_uri'), REDIRECT);
        assert.equal(url.searchParams.get('state'), 'STATE123');
        assert.equal(url.searchParams.get('response_type'), 'code');
        assert.equal(url.searchParams.get('config_id'), '987654321098765');
        assert.equal(url.searchParams.get('override_default_response_type'), 'true');
        assert.equal(url.searchParams.get('scope'), null, 'the configuration carries the permissions');
        assert.equal(url.searchParams.get('auth_type'), null);
    });

    it('falls back to a scope= list without a configuration id', () => {
        const url = new URL(buildLoginUrl({ ...base, configId: null }));
        assert.equal(url.searchParams.get('config_id'), null);
        assert.equal(url.searchParams.get('scope'), LOGIN_SCOPES.join(','));
    });

    it('adds the ads permissions only when the operator switched them on (Boost)', () => {
        const off = new URL(buildLoginUrl({ ...base, configId: null })).searchParams.get('scope')!.split(',');
        for (const s of ['ads_read', 'ads_management']) assert.ok(!off.includes(s), `not asked by default: ${s}`);
        const on = new URL(buildLoginUrl({ ...base, configId: null, adsScopes: true })).searchParams.get('scope')!.split(',');
        for (const s of [...LOGIN_SCOPES, ...ADS_SCOPES]) assert.ok(on.includes(s), s);
        assert.equal(new URL(buildLoginUrl({ ...base, configId: '987654321098765', adsScopes: true })).searchParams.get('scope'), null, 'a configuration still carries the permissions');
    });

    it('asks for what the app needs, plus the two insights permissions', () => {
        for (const scope of REQUIRED_SCOPES) assert.ok(LOGIN_SCOPES.includes(scope), scope);
        assert.ok(LOGIN_SCOPES.includes('instagram_manage_insights') && LOGIN_SCOPES.includes('read_insights'));
        assert.equal(new Set(LOGIN_SCOPES).size, LOGIN_SCOPES.length, 'no repeats');
        for (const core of CORE_SCOPES) assert.ok(LOGIN_SCOPES.includes(core), `core: ${core}`);
    });

    it('adds auth_type for a reconnect', () => {
        for (const authType of ['rerequest', 'reauthorize'] as const) {
            assert.equal(new URL(buildLoginUrl({ ...base, configId: '987654321098765', authType })).searchParams.get('auth_type'), authType);
        }
    });

    it('carries no secret: the app id is public, and the app secret is not an input', () => {
        const url = buildLoginUrl({ ...base, configId: null });
        assert.ok(!url.includes(APP.appSecret));
    });
});

describe('metaRedirectUri', () => {
    it('is the saved public base URL plus the callback path', async () => {
        db.settings.set(APP_SETTING_KEYS.publicBaseUrl, 'https://autoreply.example');
        assert.equal(await metaRedirectUri(), REDIRECT);
    });

    it('falls back to PUBLIC_BASE_URL, and to nothing at all: never to a request origin', async () => {
        assert.equal(await metaRedirectUri(), null, 'unset everywhere: no redirect URI can be built');
        process.env.PUBLIC_BASE_URL = 'https://from-env.example';
        assert.equal(await metaRedirectUri(), 'https://from-env.example/api/meta/callback');
    });
});

describe('readMetaApp', () => {
    it('needs both the id and the secret', () => {
        assert.deepEqual(readMetaApp({ META_APP_ID: '1', META_APP_SECRET: 's' } as NodeJS.ProcessEnv), { appId: '1', appSecret: 's' });
        assert.equal(readMetaApp({ META_APP_ID: '1' } as NodeJS.ProcessEnv), null);
        assert.equal(readMetaApp({ META_APP_SECRET: 's' } as NodeJS.ProcessEnv), null);
        assert.equal(readMetaApp({ META_APP_ID: ' ', META_APP_SECRET: 's' } as NodeJS.ProcessEnv), null);
    });
});

// ─── Graph ──────────────────────────────────────────────────────────────────────────────

describe('the exchange and the reads', () => {
    it('trades the code, then the short-lived token for a long-lived one, with the secret in the request and nowhere else', async () => {
        const short = await exchangeCode(APP, CODE, REDIRECT);
        assert.equal(short, graph.shortToken);
        const long = await extendUserToken(APP, short);
        assert.equal(long, graph.longToken);

        const [first, second] = graph.calls;
        assert.deepEqual(first!.params, { client_id: APP.appId, client_secret: APP.appSecret, redirect_uri: REDIRECT, code: CODE });
        assert.deepEqual(second!.params, { grant_type: 'fb_exchange_token', client_id: APP.appId, client_secret: APP.appSecret, fb_exchange_token: short });
        assert.equal(first!.authorization, undefined);
    });

    it('does not retry the code exchange: a code is single-use, so a retry after a timeout would meet "already used"', async () => {
        graph.fail(/GET \/oauth\/access_token/, 500, { message: 'An unexpected error has occurred.', code: 2 }, 5);
        await assert.rejects(exchangeCode(APP, CODE, REDIRECT), (err: any) => err instanceof MetaLoginError && err.reason === 'code_exchange_failed');
        assert.equal(graph.called(/GET \/oauth\/access_token/).length, 1);
    });

    it('wraps a refusal as a MetaLoginError with the reason, the Meta code, and no request config', async () => {
        graph.fail(/GET \/oauth\/access_token/, 400, { message: 'This authorization code has expired.', code: 100, error_subcode: 36007 });
        await assert.rejects(exchangeCode(APP, CODE, REDIRECT), (err: any) => {
            assert.ok(err instanceof MetaLoginError);
            assert.equal(err.reason, 'code_exchange_failed');
            assert.equal(err.metaCode, 100);
            assert.equal(err.metaSubcode, 36007);
            assert.equal(err.httpStatus, 400);
            assert.match(err.message, /authorization code has expired/);
            assert.equal((err as any).response, undefined, 'no response');
            assert.equal((err as any).config, undefined, 'no request config');
            assert.equal(err.cause, undefined, 'no cause to walk into');
            return true;
        });
    });

    it('scrubs a Graph message that echoes the secrets it was sent', async () => {
        graph.fail(/GET \/oauth\/access_token/, 400, { message: `Error validating code ${CODE} for secret ${APP.appSecret}`, code: 100 });
        await assert.rejects(exchangeCode(APP, CODE, REDIRECT), (err: any) => {
            assert.ok(!err.message.includes(CODE));
            assert.ok(!err.message.includes(APP.appSecret));
            assert.match(err.message, /\[redacted\]/);
            return true;
        });
    });

    it('sends the user token in the Authorization header, never in the URL, on every read', async () => {
        graph.pages = [page(1)];
        await listPages(graph.longToken);
        await readPermissions(graph.longToken);
        for (const call of graph.calls) {
            assert.equal(call.authorization, `Bearer ${graph.longToken}`);
            assert.equal(call.params?.access_token, undefined, `${call.path}: no access_token parameter`);
            assert.ok(!call.path.includes('EAA'), call.path);
        }
    });

    it('reads Pages with their token, tasks and linked Instagram account, lower-casing the username', async () => {
        graph.pages = [page(1, { ig: { username: 'MixedCase' } }), page(2, { ig: false, tasks: ['ANALYZE'] })];
        const pages = await listPages(graph.longToken);
        assert.equal(pages.length, 2);
        assert.deepEqual({ ...pages[0]!, accessToken: '…' }, {
            pageId: '200000000000001', name: 'Page 1', accessToken: '…', tasks: ['MANAGE', 'CREATE_CONTENT', 'MODERATE'],
            igId: '17841400000000001', igUsername: 'mixedcase',
        });
        assert.equal(pages[1]!.igId, null);
        assert.deepEqual(graph.called(/GET \/me\/accounts/)[0]!.params, { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: 100 });
    });

    it('follows paging by the cursor, with the header, and never by `paging.next` (a URL with a token in it)', async () => {
        graph.pages = Array.from({ length: 230 }, (_, i) => page(i + 1));
        const pages = await listPages(graph.longToken);
        assert.equal(pages.length, 230);
        const requests = graph.called(/GET \/me\/accounts/);
        assert.equal(requests.length, 3);
        assert.deepEqual(requests.map((r) => r.params?.after), [undefined, '100', '200']);
        assert.ok(!graph.everything().includes('SHOULD-NEVER-BE-FOLLOWED'));
    });

    it('skips a row with no id, and reads a Page with no Instagram account as having none', async () => {
        graph.pages = [{ name: 'no id' } as GraphPage, page(3, { ig: false })];
        const pages = await listPages(graph.longToken);
        assert.deepEqual(pages.map((p) => [p.pageId, p.igId]), [['200000000000003', null]]);
    });

    it('reads which permissions were granted and which declined', async () => {
        graph.granted = ['pages_show_list', 'instagram_basic'];
        graph.declined = ['pages_messaging'];
        assert.deepEqual(await readPermissions(graph.longToken), { granted: ['pages_show_list', 'instagram_basic'], declined: ['pages_messaging'] });
    });

    it('answers a missing token as a failure, not as an undefined that reaches the next call', async () => {
        graph.shortToken = '';
        await assert.rejects(exchangeCode(APP, CODE, REDIRECT), (err: any) => err instanceof MetaLoginError && /without a token/.test(err.message));
    });
});

// ─── Which Page ─────────────────────────────────────────────────────────────────────────

describe('which Page', () => {
    const raw = (n: number, over: Partial<{ tasks: string[]; accessToken: string | null; igId: string | null }> = {}) => ({
        pageId: String(n), name: `Page ${n}`, accessToken: 'EAAtoken', tasks: ['MANAGE'], igId: `ig${n}`, igUsername: `u${n}`, ...over,
    });

    it('a Page is usable with MANAGE, or with CREATE_CONTENT and MODERATE together, and with a token', () => {
        assert.ok(canRunPage(raw(1, { tasks: ['MANAGE'] })));
        assert.ok(canRunPage(raw(1, { tasks: ['CREATE_CONTENT', 'MODERATE'] })));
        assert.ok(!canRunPage(raw(1, { tasks: ['CREATE_CONTENT'] })), 'publishing without moderating cannot reply to comments');
        assert.ok(!canRunPage(raw(1, { tasks: ['MODERATE'] })));
        assert.ok(!canRunPage(raw(1, { tasks: ['ANALYZE', 'ADVERTISE'] })));
        assert.ok(!canRunPage(raw(1, { tasks: [] })));
        assert.ok(!canRunPage(raw(1, { accessToken: null })), 'a Page Meta gave no token for');
    });

    it('keeps the token of a usable Page and drops the token of one the user cannot run', () => {
        const [ok, no] = classifyPages([raw(1), raw(2, { tasks: ['ANALYZE'] })]);
        assert.equal(ok!.accessToken, 'EAAtoken');
        assert.equal(no!.accessToken, null, 'never stored');
        assert.deepEqual([ok!.usable, ok!.unusableReason, no!.usable, no!.unusableReason], [true, null, false, 'no_role']);
    });

    it('connects at once only for exactly one usable Page with an Instagram account', () => {
        const one = classifyPages([raw(1)]);
        assert.equal(planPages(one).kind, 'auto');
        assert.equal(planPages(classifyPages([raw(1), raw(2, { tasks: ['ANALYZE'] })])).kind, 'auto', 'a Page the user cannot run is not a choice');
        assert.equal(planPages(classifyPages([raw(1), raw(2)])).kind, 'pick', 'two: the choice is theirs');
        assert.equal(planPages(classifyPages([raw(1, { igId: null })])).kind, 'pick', 'no Instagram account: Facebook-only has to be chosen');
        assert.equal(planPages(classifyPages([raw(1, { tasks: ['ANALYZE'] })])).kind, 'pick', 'nothing usable: the picker says why');
        assert.equal(planPages([]).kind, 'none');
    });

    it('a Page changes the connection when it replaces an id the tenant has, and not when it only adds one', () => {
        const have = { facebookPageId: '100', instagramPageId: '17841' };
        assert.equal(replacesConnection(have, { facebookPageId: '100', instagramPageId: '17841' }), false, 'the same again');
        assert.equal(replacesConnection(have, { facebookPageId: '200', instagramPageId: '17841' }), true);
        assert.equal(replacesConnection(have, { facebookPageId: '100', instagramPageId: '17842' }), true);
        assert.equal(replacesConnection(have, { facebookPageId: '100', instagramPageId: null }), true, 'dropping Instagram is a change');
        assert.equal(replacesConnection({ facebookPageId: null, instagramPageId: '17841' }, { facebookPageId: '100', instagramPageId: '17841' }), false, 'a legacy connection gaining its Facebook id');
    });

    it('names what a missing permission turns off', () => {
        assert.deepEqual(affectedFeatures(['instagram_manage_messages', 'pages_messaging', 'read_insights', 'instagram_manage_insights']), [
            'instagram_dms', 'facebook_dms', 'facebook_insights', 'instagram_insights',
        ]);
        assert.deepEqual(affectedFeatures(['something_new']), []);
    });
});

// ─── Moved from routes/admin.ts ─────────────────────────────────────────────────────────

describe('validateSuppliedToken', () => {
    it('accepts a valid PAGE token', async () => {
        const result = await validateSuppliedToken('EAAvalidPageToken0123456789');
        assert.ok(result.ok);
        if (result.ok) assert.equal(result.inspection.type, 'PAGE');
    });

    it('refuses a USER token, which cannot publish or send private replies, and says so', async () => {
        graph.inspections.set('EAAuserToken0123456789', { type: 'USER' });
        const result = await validateSuppliedToken('EAAuserToken0123456789');
        assert.ok(!result.ok);
        if (!result.ok) assert.match(result.error, /Wrong token type: "USER"\. You need a PAGE access token/);
    });

    it('refuses a token Meta says is not valid', async () => {
        graph.inspections.set('EAAexpired0123456789', { is_valid: false });
        const result = await validateSuppliedToken('EAAexpired0123456789');
        assert.ok(!result.ok);
    });

    it('says so when Meta cannot be asked, rather than throwing', async () => {
        graph.fail(/GET \/debug_token/, 500, { message: 'Service unavailable' });
        const result = await validateSuppliedToken('EAAanything0123456789');
        assert.ok(!result.ok);
        if (!result.ok) assert.match(result.error, /Meta could not verify that token: Service unavailable/);
    });
});

describe('pageIdConflict', () => {
    it('names the tenant that holds a Page, and ignores the tenant asking', async () => {
        db.addCreator(OTHER_TENANT, { name: 'Someone Else', facebook_page_id: '555', instagram_page_id: '17841555' });
        db.addCreator(NEW_TENANT);
        assert.deepEqual(await pageIdConflict('facebook_page_id', '555', NEW_TENANT), { id: OTHER_TENANT, name: 'Someone Else' });
        assert.deepEqual(await pageIdConflict('instagram_page_id', '17841555', NEW_TENANT), { id: OTHER_TENANT, name: 'Someone Else' });
        assert.equal(await pageIdConflict('facebook_page_id', '555', OTHER_TENANT), null, 'its own Page is not a conflict');
        assert.equal(await pageIdConflict('facebook_page_id', '999', NEW_TENANT), null);
    });
});

// ─── The webhook subscription ───────────────────────────────────────────────────────────

describe('subscribePage and unsubscribePage', () => {
    const TOKEN = 'EAAsubscribePageToken0123456789abcdef';

    it('subscribes with the three fields and the Page token in the header, then reads the edge back', async () => {
        const result = await subscribePage('200000000000001', TOKEN, APP.appId);
        assert.deepEqual(result, { confirmed: true, warning: null });

        const [post, get] = graph.calls;
        assert.equal(`${post!.method} ${post!.path}`, 'POST /200000000000001/subscribed_apps');
        assert.equal(post!.body, `subscribed_fields=${encodeURIComponent(WEBHOOK_FIELDS.join(','))}`);
        assert.equal(post!.authorization, `Bearer ${TOKEN}`);
        assert.equal(`${get!.method} ${get!.path}`, 'GET /200000000000001/subscribed_apps');
        assert.equal(get!.authorization, `Bearer ${TOKEN}`);
        assert.deepEqual(WEBHOOK_FIELDS, ['feed', 'messages', 'messaging_postbacks']);
    });

    it('a failed POST is a warning, not a throw', async () => {
        graph.fail(/POST \/200000000000001\/subscribed_apps/, 400, { message: '(#200) Requires pages_manage_metadata permission', code: 200 });
        assert.deepEqual(await subscribePage('200000000000001', TOKEN, APP.appId), { confirmed: false, warning: 'subscribe_failed' });
        assert.equal(graph.called(/GET \/200000000000001\/subscribed_apps/).length, 0, 'nothing to read back');
    });

    it('a POST that answered success but left the Page without the fields is not confirmed', async () => {
        graph.dropSubscription = true;
        assert.deepEqual(await subscribePage('200000000000001', TOKEN, APP.appId), { confirmed: false, warning: 'subscribe_unconfirmed' });
    });

    it('a subscription for a different app is not ours', async () => {
        graph.appId = '999';
        assert.deepEqual(await subscribePage('200000000000001', TOKEN, APP.appId), { confirmed: false, warning: 'subscribe_unconfirmed' });
    });

    it('a read-back that fails is not confirmed either', async () => {
        graph.fail(/GET \/200000000000001\/subscribed_apps/, 400, { message: 'no', code: 100 });
        assert.deepEqual(await subscribePage('200000000000001', TOKEN, APP.appId), { confirmed: false, warning: 'subscribe_unconfirmed' });
    });

    it('unsubscribes with a DELETE and the Page token, and a failure is just false', async () => {
        await subscribePage('200000000000001', TOKEN, APP.appId);
        assert.equal(await unsubscribePage('200000000000001', TOKEN), true);
        const del = graph.called(/DELETE \/200000000000001\/subscribed_apps/);
        assert.equal(del.length, 1);
        assert.equal(del[0]!.authorization, `Bearer ${TOKEN}`);

        graph.fail(/DELETE /, 400, { message: 'token dead', code: 190 });
        assert.equal(await unsubscribePage('200000000000001', TOKEN), false);
    });

    it('logs a failure with no token in it', async () => {
        graph.fail(/POST /, 400, { message: `bad token ${TOKEN}`, code: 190 });
        await subscribePage('200000000000001', TOKEN, APP.appId);
        assert.ok(logs.some((l) => /meta\.subscribe_failed/.test(l)));
        assert.deepEqual(leaks([TOKEN]), []);
    });
});

// ─── completeMetaConnection ─────────────────────────────────────────────────────────────

describe('completeMetaConnection', () => {
    beforeEach(() => { db.addCreator(NEW_TENANT, { name: 'New Tenant', instagram_username: 'typedhandle' }); });

    it('writes the connection in one UPDATE: ids, encrypted token, token columns, the user, the names, the times', async () => {
        const p = page(1);
        const result = await completeMetaConnection(complete({ page: p }));

        const row = db.creators.get(NEW_TENANT)!;
        assert.equal(row.facebook_page_id, p.id);
        assert.equal(row.instagram_page_id, p.instagram_business_account!.id);
        assert.ok(isEncrypted(row.page_access_token), 'enc:v1');
        assert.equal(decryptSecret(row.page_access_token!), p.access_token, 'and it decrypts to the Page token');
        assert.equal(row.token_status, 'valid');
        assert.equal(row.token_expires_at, null, 'a Page token with no expiry date');
        assert.ok(row.token_data_access_expires_at, 'data access is recorded');
        assert.equal(row.meta_user_id, '90001');
        assert.equal(row.meta_page_name, 'Page 1');
        assert.equal(row.instagram_username, 'page1', 'the verified handle replaces the typed one');
        assert.ok(row.meta_connected_at);
        assert.ok(row.meta_webhook_subscribed_at);

        assert.equal(db.statements.filter((s) => /^UPDATE creators SET instagram_page_id = \$2/.test(s.sql)).length, 1, 'ONE update');
        assert.deepEqual(result, {
            pageId: p.id, pageName: 'Page 1', instagramId: p.instagram_business_account!.id, instagramUsername: 'page1',
            replaced: false, webhookSubscribed: true, warnings: [], missingScopes: [], affectedFeatures: [],
        });
    });

    it('validates the token, checks the Page is free, THEN subscribes, THEN writes', async () => {
        await completeMetaConnection(complete());
        const validated = graph.calls.find((c) => c.path === '/debug_token')!.at;
        const checkedFree = db.statements.find((s) => /FROM creators WHERE facebook_page_id = \$1/.test(s.sql))!.at;
        const subscribed = graph.calls.find((c) => c.method === 'POST' && /subscribed_apps/.test(c.path))!.at;
        const written = db.statements.find((s) => /^UPDATE creators SET instagram_page_id = \$2/.test(s.sql))!.at;
        assert.ok(validated < checkedFree && checkedFree < subscribed && subscribed < written, `${validated} < ${checkedFree} < ${subscribed} < ${written}`);
    });

    it('never stores the user token: it is not an input', async () => {
        await completeMetaConnection(complete());
        assert.deepEqual(leaks([graph.longToken, graph.shortToken]), []);
    });

    it('keeps the typed handle when the Page is connected Facebook-only', async () => {
        await completeMetaConnection(complete({ page: page(2), facebookOnly: true }));
        const row = db.creators.get(NEW_TENANT)!;
        assert.equal(row.instagram_page_id, null);
        assert.equal(row.instagram_username, 'typedhandle');
        assert.equal(row.facebook_page_id, '200000000000002');
    });

    it('refuses a token that is not a PAGE token, before it subscribes or stores anything', async () => {
        const p = page(1);
        graph.inspections.set(p.access_token!, { type: 'USER' });
        await assert.rejects(completeMetaConnection(complete({ page: p })), (err: any) => err.reason === 'token_invalid' && /PAGE access token/.test(err.message));
        assert.equal(graph.called(/subscribed_apps/).length, 0);
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
    });

    it('refuses a Page another tenant holds, BEFORE Meta is asked to subscribe it, and never names that tenant', async () => {
        const p = page(1);
        db.addCreator(OTHER_TENANT, { name: 'Competitor Inc', facebook_page_id: p.id, instagram_page_id: p.instagram_business_account!.id, page_access_token: 'enc:v1:x:y:z' });
        const before = db.snapshotCreators();
        await assert.rejects(completeMetaConnection(complete({ page: p })), (err: any) => {
            assert.equal(err.reason, 'page_in_use');
            assert.equal(err.httpStatus, 409);
            assert.ok(!/Competitor|2222/.test(err.message), 'the other tenant is not named');
            return true;
        });
        assert.equal(graph.called(/subscribed_apps/).length, 0, 'the other tenant\'s webhook is not touched');
        assert.equal(db.snapshotCreators(), before, 'nothing written');
    });

    it('refuses an Instagram account another tenant holds, even on a different Page', async () => {
        const p = page(1);
        db.addCreator(OTHER_TENANT, { name: 'Other', facebook_page_id: '777', instagram_page_id: p.instagram_business_account!.id, page_access_token: 'enc:v1:x:y:z' });
        await assert.rejects(completeMetaConnection(complete({ page: p })), (err: any) => err.reason === 'page_in_use');
        assert.equal(graph.called(/subscribed_apps/).length, 0);
    });

    it('answers page_in_use when the unique index catches a claim that landed between the check and the write', async () => {
        const p = page(1);
        db.beforeConnectionUpdate = () => {
            // Another tenant's connection commits after our free-check saw nothing, and before our write.
            db.addCreator(OTHER_TENANT, { name: 'Racer', facebook_page_id: p.id, instagram_page_id: p.instagram_business_account!.id, page_access_token: 'enc:v1:x:y:z' });
        };
        await assert.rejects(completeMetaConnection(complete({ page: p })), (err: any) => err.reason === 'page_in_use');
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
    });

    it('refuses to overwrite a connection the owner did not ask to reconnect, and asks Meta nothing', async () => {
        await connectedOwner();
        const before = db.snapshotCreators();
        await assert.rejects(completeMetaConnection(complete({ creatorId: OWNER })), (err: any) => err.reason === 'already_connected' && err.httpStatus === 409);
        assert.equal(graph.calls.length, 0, 'not even debug_token');
        assert.equal(db.snapshotCreators(), before, 'the connection is exactly as it was');
        assert.deepEqual(leaks([OWNER_TOKEN_PLAIN]), []);
    });

    it('refuses a connection that someone else made between the first check and the write', async () => {
        graph.onDebugToken = () => {
            const c = db.creators.get(NEW_TENANT)!;
            c.page_access_token = 'enc:v1:made:by:another-request';
            c.facebook_page_id = '300';
        };
        await assert.rejects(completeMetaConnection(complete()), (err: any) => err.reason === 'already_connected');
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, 'enc:v1:made:by:another-request', 'theirs is untouched');
    });

    it('reconnects to the SAME ids on an explicit reconnect, with no confirmation needed', async () => {
        const p = page(1);
        await completeMetaConnection(complete({ page: p }));
        const again = await completeMetaConnection(complete({ page: p, reconnect: true }));
        assert.equal(again.replaced, false);
        assert.equal(db.creators.get(NEW_TENANT)!.facebook_page_id, p.id);
    });

    it('asks to confirm a reconnect to DIFFERENT ids, and changes nothing until it is confirmed', async () => {
        await completeMetaConnection(complete({ page: page(1) }));
        const connected = db.snapshotCreators();

        await assert.rejects(completeMetaConnection(complete({ page: page(2), reconnect: true })), (err: any) => err.reason === 'page_change_unconfirmed');
        assert.equal(db.snapshotCreators(), connected);

        const confirmed = await completeMetaConnection(complete({ page: page(2), reconnect: true, confirmPageChange: true }));
        assert.equal(confirmed.replaced, true);
        assert.equal(db.creators.get(NEW_TENANT)!.facebook_page_id, '200000000000002');
    });

    it('treats a legacy connection that had no Facebook Page id as gaining one, not as a change', async () => {
        const { encryptSecret } = await import('../config/crypto.js');
        const p = page(1);
        db.addCreator(OWNER, { instagram_page_id: p.instagram_business_account!.id, facebook_page_id: null, page_access_token: encryptSecret('legacy-token-0123456789') });
        const result = await completeMetaConnection(complete({ creatorId: OWNER, page: p, reconnect: true }));
        assert.equal(result.replaced, false);
    });

    it('keeps the connection when the webhook cannot be subscribed, and says so', async () => {
        graph.fail(/POST \/200000000000001\/subscribed_apps/, 400, { message: 'Requires pages_manage_metadata', code: 200 });
        const result = await completeMetaConnection(complete());
        assert.deepEqual(result.warnings, ['subscribe_failed']);
        assert.equal(result.webhookSubscribed, false);
        const row = db.creators.get(NEW_TENANT)!;
        assert.ok(row.page_access_token, 'still connected');
        assert.equal(row.meta_webhook_subscribed_at, null, 'and honest about the subscription');
    });

    it('keeps the connection when permissions are missing, and names what is lost', async () => {
        const p = page(1);
        graph.inspections.set(p.access_token!, { scopes: LOGIN_SCOPES.filter((s) => s !== 'instagram_manage_messages' && s !== 'pages_messaging') });
        const result = await completeMetaConnection(complete({ page: p }));
        assert.deepEqual(result.warnings, ['missing_scopes']);
        assert.deepEqual(result.missingScopes.sort(), ['instagram_manage_messages', 'pages_messaging']);
        assert.deepEqual(result.affectedFeatures, ['instagram_dms', 'facebook_dms']);
        const row = db.creators.get(NEW_TENANT)!;
        assert.equal(row.token_status, 'valid', 'the token works; some features do not');
        assert.match(row.token_error!, /Missing 2 required scope/);
    });

    it('stops before subscribing anything when the token cannot be encrypted', async () => {
        delete process.env.TOKEN_ENCRYPTION_KEY;
        await assert.rejects(completeMetaConnection(complete()), (err: any) => err.reason === 'encryption_unavailable');
        assert.equal(graph.called(/subscribed_apps/).length, 0);
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
    });

    it('refuses a tenant that does not exist', async () => {
        await assert.rejects(completeMetaConnection(complete({ creatorId: OTHER_TENANT })), (err: any) => err.reason === 'tenant_not_found');
        assert.equal(graph.calls.length, 0);
    });

    it('writes an audit row of ids and facts, with no token in it, as the person who connected', async () => {
        await completeMetaConnection(complete());
        assert.equal(db.audit.length, 1);
        const row = db.audit[0]!;
        assert.equal(row.action, AUDIT_ACTIONS.metaConnect);
        assert.equal(row.action, 'meta.connect');
        assert.equal(row.target_type, 'creator');
        assert.equal(row.target_id, NEW_TENANT);
        assert.equal(row.actor_user_id, USER);
        const detail = JSON.parse(row.detail);
        assert.equal(detail.facebook_page_id, '200000000000001');
        assert.equal(detail.webhook_subscribed, true);
        assert.equal(detail.reconnect, false);
        assert.ok(!/EAA|enc:v1|secret/i.test(row.detail), 'nothing token-shaped');
        assert.deepEqual(leaks([page(1).access_token!, graph.longToken]), []);
    });
});

// ─── finishLogin: the callback's work ───────────────────────────────────────────────────

describe('finishLogin', () => {
    const input = (over: Partial<Parameters<typeof finishLogin>[0]> = {}) => ({
        creatorId: NEW_TENANT, userId: USER, code: CODE, redirectUri: REDIRECT, reconnect: false, returnTo: 'welcome' as const, ...over,
    });

    beforeEach(() => { db.addCreator(NEW_TENANT, { name: 'New Tenant' }); });

    it('connects one usable Page with Instagram at once, in the documented order', async () => {
        graph.pages = [page(1)];
        const outcome = await finishLogin(input());
        assert.equal(outcome.kind, 'connected');
        assert.deepEqual(graph.calls.map((c) => `${c.method} ${c.path}`), [
            'GET /oauth/access_token', 'GET /oauth/access_token',
            'GET /me', 'GET /me/permissions', 'GET /me/accounts',
            'GET /debug_token', 'POST /200000000000001/subscribed_apps', 'GET /200000000000001/subscribed_apps',
        ], 'exchange, extend, the three reads, validate, subscribe, confirm');
        assert.equal(db.creators.get(NEW_TENANT)!.meta_user_id, '90001');
    });

    it('stores two Pages for the picker instead, encrypted, with a token only for a Page the user can run', async () => {
        graph.pages = [page(1), page(2), page(3, { tasks: ['ANALYZE'] })];
        const outcome = await finishLogin(input());
        assert.equal(outcome.kind, 'pick');
        if (outcome.kind !== 'pick') return;

        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null, 'nothing is connected yet');
        assert.equal(graph.called(/subscribed_apps/).length, 0, 'nothing is subscribed yet');

        const stored = db.oauth.find((r) => r.nonce === outcome.pick)!;
        assert.equal(stored.platform, 'meta_pick');
        assert.equal(stored.return_to, 'welcome');
        assert.ok(isEncrypted(stored.payload));

        const read = await readPick(outcome.pick, NEW_TENANT, USER);
        const payload = readPickPayload(read!.payload)!;
        assert.equal(payload.metaUserId, '90001');
        assert.deepEqual(payload.choices.map((c) => [c.pageId, c.usable, c.accessToken !== null]), [
            ['200000000000001', true, true], ['200000000000002', true, true], ['200000000000003', false, false],
        ]);
        assert.deepEqual(leaks([graph.longToken, graph.shortToken, page(1).access_token!, page(2).access_token!]), [], 'in no stored row and no log, in the clear');
    });

    it('asks, and does not connect, when the one Page would REPLACE the connected one on a reconnect', async () => {
        await completeMetaConnection(complete({ page: page(1) }));
        graph.calls.length = 0;
        graph.pages = [page(2)];
        const outcome = await finishLogin(input({ reconnect: true }));
        assert.equal(outcome.kind, 'pick');
        assert.equal(db.creators.get(NEW_TENANT)!.facebook_page_id, '200000000000001', 'still the old Page');
        assert.equal(graph.called(/POST .*subscribed_apps/).length, 0);
    });

    it('reconnects the same Page on a reconnect, at once', async () => {
        await completeMetaConnection(complete({ page: page(1) }));
        graph.pages = [page(1)];
        const outcome = await finishLogin(input({ reconnect: true }));
        assert.equal(outcome.kind, 'connected');
    });

    it('goes to the picker for a Page with no Instagram account: Facebook-only is a choice, never a default', async () => {
        graph.pages = [page(1, { ig: false })];
        assert.equal((await finishLogin(input())).kind, 'pick');
        assert.equal(db.creators.get(NEW_TENANT)!.facebook_page_id, null);
    });

    it('goes to the picker, with every Page disabled, when the user can run none', async () => {
        graph.pages = [page(1, { tasks: ['ANALYZE'] })];
        assert.equal((await finishLogin(input())).kind, 'pick');
    });

    it('says no_pages for a user who manages no Page', async () => {
        graph.pages = [];
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'no_pages');
    });

    it('says not_tester when nothing was granted: the person holds no role on the app', async () => {
        graph.granted = [];
        graph.pages = [page(1)];
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'not_tester' && err.httpStatus === 403);
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
    });

    it('refuses a connection that lost a permission it cannot work without, naming it', async () => {
        graph.granted = LOGIN_SCOPES.filter((s) => s !== 'instagram_manage_comments');
        graph.pages = [page(1)];
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'permissions_missing' && /instagram_manage_comments/.test(err.message));
        assert.equal(graph.called(/subscribed_apps/).length, 0);
    });

    it('connects anyway when only an optional permission was declined', async () => {
        graph.granted = LOGIN_SCOPES.filter((s) => s !== 'read_insights' && s !== 'instagram_manage_insights');
        graph.declined = ['read_insights', 'instagram_manage_insights'];
        graph.pages = [page(1)];
        const outcome = await finishLogin(input());
        assert.equal(outcome.kind, 'connected');
    });

    it('refuses an existing connection before it asks Meta anything', async () => {
        await connectedOwner();
        const before = db.snapshotCreators();
        graph.pages = [page(1)];
        await assert.rejects(finishLogin(input({ creatorId: OWNER })), (err: any) => err.reason === 'already_connected');
        assert.equal(graph.calls.length, 0, 'the code is not even spent');
        assert.equal(db.snapshotCreators(), before);
    });

    it('needs the Meta app: without the id and secret there is no exchange to make', async () => {
        delete process.env.META_APP_SECRET;
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'not_configured');
        assert.equal(graph.calls.length, 0);
    });

    it('turns each way Meta can refuse into a reason, with no secret in the message', async () => {
        graph.pages = [page(1)];
        graph.fail(/GET \/oauth\/access_token/, 400, { message: `Invalid verification code ${CODE}`, code: 100 });
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'code_exchange_failed' && !err.message.includes(CODE));

        graph.fail(/GET \/me\/accounts/, 400, { message: `Error validating access token ${graph.longToken}`, code: 190 });
        await assert.rejects(finishLogin(input()), (err: any) => err.reason === 'graph_failed' && !err.message.includes(graph.longToken));
        assert.deepEqual(leaks([CODE, graph.longToken, graph.shortToken, APP.appSecret]), []);
    });

    it('lets a later connect succeed after a failed one: a failure leaves the tenant exactly as it was', async () => {
        graph.pages = [page(1)];
        graph.fail(/GET \/me\/permissions/, 400, { message: 'nope', code: 190 });
        await assert.rejects(finishLogin(input()));
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
        assert.equal((await finishLogin(input())).kind, 'connected');
    });
});

// ─── Disconnect, and the summary ────────────────────────────────────────────────────────

describe('finishLogin: Boost in one click', () => {
    const input = { creatorId: NEW_TENANT, userId: USER, code: CODE, redirectUri: REDIRECT, reconnect: false, returnTo: null };
    const tokenKey = tenantSettingKey(TENANT_SETTING_PREFIXES.adsToken, NEW_TENANT);
    const settingsKey = tenantSettingKey(TENANT_SETTING_PREFIXES.adsSettings, NEW_TENANT);

    beforeEach(() => {
        db.addCreator(NEW_TENANT, { name: 'New Tenant' });
        graph.pages = [page(1)];
    });

    it('stores the ads token, encrypted, and the only active ad account, when the ads permissions were granted', async () => {
        graph.granted = [...LOGIN_SCOPES, ...ADS_SCOPES];
        graph.adAccounts = [
            { account_id: '509787248064459', name: 'Shop', currency: 'USD', account_status: 1 },
            { account_id: '354996612787363', name: 'Old', currency: 'EGP', account_status: 2 },
        ];
        assert.equal((await finishLogin(input)).kind, 'connected', 'the Page connects as before');
        const stored = db.settings.get(tokenKey)!;
        assert.ok(isEncrypted(stored), 'encrypted at rest');
        assert.equal(decryptSecret(stored), graph.longToken, 'the long-lived user token');
        const settings = JSON.parse(db.settings.get(settingsKey)!);
        assert.equal(settings.adAccountId, '509787248064459');
        assert.equal(settings.tokenSource, 'connect');
        assert.equal(settings.maxDailyBudget ?? null, null, 'the money limits are the owner\'s to set, never filled in');
        assert.deepEqual(leaks([graph.longToken, graph.shortToken]), [], 'no token in the clear anywhere');
    });

    it('leaves a real choice of ad accounts to the owner', async () => {
        graph.granted = [...LOGIN_SCOPES, ...ADS_SCOPES];
        graph.adAccounts = [
            { account_id: '509787248064459', name: 'A', currency: 'USD', account_status: 1 },
            { account_id: '354996612787363', name: 'B', currency: 'EGP', account_status: 1 },
        ];
        await finishLogin(input);
        assert.ok(db.settings.get(tokenKey));
        assert.equal(JSON.parse(db.settings.get(settingsKey)!).adAccountId, null);
    });

    it('changes nothing about ads when they were not granted, and asks Meta nothing about them', async () => {
        await finishLogin(input);
        assert.equal(db.settings.get(tokenKey), undefined);
        assert.equal(graph.called(/adaccounts/).length, 0);
    });

    it('never stops the connection when reading the ad accounts fails', async () => {
        graph.granted = [...LOGIN_SCOPES, ...ADS_SCOPES];
        graph.fail(/GET \/me\/adaccounts/, 500, { message: 'boom', code: 2 }, 5);
        assert.equal((await finishLogin(input)).kind, 'connected');
        assert.ok(db.settings.get(tokenKey), 'the token is kept; the card picks the account later');
    });

    it('a Disconnect takes the Connect ads token with it, and leaves a pasted one alone', async () => {
        graph.granted = [...LOGIN_SCOPES, ...ADS_SCOPES];
        graph.adAccounts = [{ account_id: '509787248064459', name: 'Shop', currency: 'USD', account_status: 1 }];
        await finishLogin(input);
        await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.equal(db.settings.get(tokenKey), undefined, 'gone');
        assert.equal(JSON.parse(db.settings.get(settingsKey)!).tokenSource, null);

        db.settings.set(tokenKey, 'pasted-system-user-token-xxxxxxxxxxxx');
        db.settings.set(settingsKey, JSON.stringify({ adAccountId: '509787248064459', tokenSource: 'pasted' }));
        graph.granted = [...LOGIN_SCOPES];
        await finishLogin(input);
        await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.equal(db.settings.get(tokenKey), 'pasted-system-user-token-xxxxxxxxxxxx', 'kept');
    });
});

describe('disconnectMeta', () => {
    beforeEach(async () => {
        db.addCreator(NEW_TENANT, { name: 'New Tenant' });
        graph.pages = [page(1)];
        await finishLogin({ creatorId: NEW_TENANT, userId: USER, code: CODE, redirectUri: REDIRECT, reconnect: false, returnTo: null });
        graph.calls.length = 0;
    });

    it('unsubscribes the Page, then clears the ids, the token and every meta_ column', async () => {
        const result = await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.deepEqual(result, { unsubscribed: true });

        const del = graph.called(/DELETE \/200000000000001\/subscribed_apps/);
        assert.equal(del.length, 1);
        assert.equal(del[0]!.authorization, `Bearer ${page(1).access_token}`, 'the Page token, decrypted');

        const row = db.creators.get(NEW_TENANT)!;
        for (const column of ['instagram_page_id', 'facebook_page_id', 'page_access_token', 'meta_user_id', 'meta_page_name', 'meta_connected_at', 'meta_webhook_subscribed_at', 'token_error', 'token_expires_at', 'token_data_access_expires_at'] as const) {
            assert.equal(row[column], null, column);
        }
        assert.equal(row.token_status, 'unknown');
        assert.equal(row.name, 'New Tenant', 'the tenant itself, and what it made, are kept');
    });

    it('does not revoke the Facebook user\'s permissions: that would cut off every other tenant the same person connected', async () => {
        await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.equal(graph.called(/\/permissions/).length, 0);
        assert.equal(graph.calls.filter((c) => c.method === 'DELETE').length, 1, 'only the Page subscription');
    });

    it('still disconnects when Meta will not unsubscribe, and says it could not', async () => {
        graph.fail(/DELETE /, 400, { message: 'token dead', code: 190 }, 5);
        const result = await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.deepEqual(result, { unsubscribed: false });
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null, 'the token is deleted regardless');
    });

    it('still disconnects when the stored token cannot be read', async () => {
        db.creators.get(NEW_TENANT)!.page_access_token = 'enc:v1:AAAA:BBBB:CCCC';
        const result = await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.deepEqual(result, { unsubscribed: false });
        assert.equal(db.creators.get(NEW_TENANT)!.page_access_token, null);
        assert.equal(graph.calls.length, 0, 'nothing could be asked of Meta without the token');
    });

    it('writes an audit row with the ids it removed and whether Meta unsubscribed, and no token', async () => {
        await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        const row = db.audit.find((a) => a.action === AUDIT_ACTIONS.metaDisconnect)!;
        assert.equal(row.action, 'meta.disconnect');
        assert.equal(row.target_id, NEW_TENANT);
        assert.deepEqual(JSON.parse(row.detail), { facebook_page_id: '200000000000001', instagram_page_id: '17841400000000001', unsubscribed_from_webhook: true });
    });

    it('says there is nothing to disconnect, and touches nothing, for a tenant that was never connected', async () => {
        db.addCreator(OTHER_TENANT);
        await assert.rejects(disconnectMeta({ creatorId: OTHER_TENANT, userId: USER }), (err: any) => err.reason === 'not_connected' && err.httpStatus === 404);
        assert.equal(graph.calls.length, 0);
        await assert.rejects(disconnectMeta({ creatorId: '00000000-0000-4000-8000-000000000000', userId: USER }), (err: any) => err.reason === 'tenant_not_found');
    });

    it('leaves another tenant\'s connection alone', async () => {
        await connectedOwner();
        const before = JSON.stringify(db.creators.get(OWNER));
        await disconnectMeta({ creatorId: NEW_TENANT, userId: USER });
        assert.equal(JSON.stringify(db.creators.get(OWNER)), before);
    });
});

describe('getMetaConnection', () => {
    it('is nothing for a tenant that does not exist, and "not connected" for one with no token', async () => {
        assert.equal(await getMetaConnection(NEW_TENANT), null);
        db.addCreator(NEW_TENANT);
        const summary = await getMetaConnection(NEW_TENANT);
        assert.equal(summary?.connected, false);
        assert.equal(summary?.via, null);
        assert.equal(summary?.reconnectDue, false);
    });

    it('never carries the token, and says how the connection was made', async () => {
        await connectedOwner();
        const legacy = await getMetaConnection(OWNER);
        assert.equal(legacy?.connected, true);
        assert.equal(legacy?.via, 'token', 'a pasted token');
        assert.equal(legacy?.pageName, null);
        assert.ok(!JSON.stringify(legacy).includes('enc:v1') && !JSON.stringify(legacy).includes(OWNER_TOKEN_PLAIN));

        db.addCreator(NEW_TENANT);
        await completeMetaConnection(complete());
        const login = await getMetaConnection(NEW_TENANT);
        assert.equal(login?.via, 'login');
        assert.equal(login?.pageName, 'Page 1');
        assert.equal(login?.webhookSubscribed, true);
        assert.equal(login?.instagramUsername, 'page1');
        assert.ok(!JSON.stringify(login).includes('EAA'));
    });

    it('flags a reconnect as due when Instagram data access lapses within 14 days, or already has', async () => {
        db.addCreator(NEW_TENANT);
        await completeMetaConnection(complete());
        const row = db.creators.get(NEW_TENANT)!;
        row.token_data_access_expires_at = new Date(Date.now() + 20 * 86_400_000);
        assert.equal((await getMetaConnection(NEW_TENANT))?.reconnectDue, false);
        row.token_data_access_expires_at = new Date(Date.now() + 10 * 86_400_000);
        assert.equal((await getMetaConnection(NEW_TENANT))?.reconnectDue, true);
        row.token_data_access_expires_at = new Date(Date.now() - 86_400_000);
        assert.equal((await getMetaConnection(NEW_TENANT))?.reconnectDue, true);
    });
});

describe('the intent a state carries', () => {
    it('is a reconnect only when the payload says exactly so; anything else refuses to overwrite', () => {
        assert.deepEqual(readIntent({ v: 1, reconnect: true }), { v: 1, reconnect: true });
        for (const bad of [null, undefined, {}, { reconnect: 'true' }, { reconnect: 1 }, 'x', []]) {
            assert.equal(readIntent(bad).reconnect, false, JSON.stringify(bad));
        }
    });

    it('reads a pick payload only when it is one of ours', () => {
        assert.equal(readPickPayload(null), null);
        assert.equal(readPickPayload({ v: 2, metaUserId: '1', choices: [] }), null);
        assert.equal(readPickPayload({ v: 1, choices: [] }), null);
        assert.ok(readPickPayload({ v: 1, metaUserId: '1', choices: [] }));
    });
});
