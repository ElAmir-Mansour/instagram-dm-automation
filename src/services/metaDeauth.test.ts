/**
 * Meta's Deauthorize Callback (P33): reading a `signed_request`, and disconnecting the tenants the person connected.
 *
 * Two layers. `parseSignedRequest` is pure: every way a request can be wrong is a case here, and the signature is the one thing nothing
 * else is checked before. `disconnectMetaUser` runs against `FakeDb` and `FakeGraph` (metaLoginHarness.ts): no database, no network, and a
 * Graph that throws on a path nothing configured. The owner's tenant is in every one of them, because the rule this file exists to pin is
 * that a request for somebody else's id never moves his Page token:
 *
 *   - his pasted-token connection has `meta_user_id` NULL, which no id equals;
 *   - if he HAS an id on his row (he reconnected through Login), a request for exactly that id is a request for him, and only that id.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { decryptSecret, encryptSecret } from '../config/crypto.js';
import { metaHttp } from './http.js';
import { setLogSink } from '../utils/log.js';
import { AUDIT_ACTIONS } from './audit.js';
import {
    disconnectMetaUser, META_DEAUTHORIZE_ACTOR_EMAIL, parseSignedRequest, SIGNED_REQUEST_MAX_AGE_SECONDS, SIGNED_REQUEST_MAX_CHARS,
} from './metaDeauth.js';
import { FakeDb, FakeGraph } from './metaLoginHarness.js';

const SECRET = 'the-app-secret-0123456789-never-in-a-log';
const OTHER_SECRET = 'the-instagram-app-secret-9876543210-never-in-a-log';
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const NOW_S = Math.floor(NOW / 1000);

const PERSON = '9000100020003000';
const OTHER_PERSON = '9000100020009999';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const BYSTANDER = '33333333-3333-4333-8333-333333333333';
const OWNER = '99999999-9999-4999-8999-999999999999';
const OWNER_TOKEN_PLAIN = 'OWNER-PAGE-TOKEN-never-touched-0123456789abcdef';
const TENANT_TOKEN_PLAIN = 'EAATenantPageToken0123456789abcdefghijklmnopqrstuvwxyz';

const b64 = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

/** A signed request the way Meta builds one: HMAC-SHA256 of the ENCODED payload, both halves URL-safe base64. */
function signedRequest(payload: Record<string, unknown>, secret = SECRET): string {
    const encoded = b64(JSON.stringify(payload));
    return `${b64(crypto.createHmac('sha256', secret).update(encoded).digest())}.${encoded}`;
}

const fresh = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ algorithm: 'HMAC-SHA256', issued_at: NOW_S - 5, user_id: PERSON, ...over });

// ─── parseSignedRequest ─────────────────────────────────────────────────────────────────

describe('parseSignedRequest', () => {
    const parse = (raw: unknown, secrets: readonly string[] = [SECRET]) => parseSignedRequest(raw, { secrets, now: NOW });

    it('reads a request Meta signed: who it is about, and when it was issued', () => {
        assert.deepEqual(parse(signedRequest(fresh())), { ok: true, userId: PERSON, issuedAt: NOW_S - 5 });
    });

    it('accepts the extra fields Meta sends (a user object, an expiry that is not yet past) and the payload\'s algorithm in any case', () => {
        const r = parse(signedRequest(fresh({ algorithm: 'hmac-sha256', user: { country: 'sa', locale: 'ar_AR' }, expires: NOW_S + 3600 })));
        assert.equal(r.ok, true);
    });

    it('accepts a request signed with ANY configured app secret: the Facebook app\'s or the Instagram app\'s, like the webhook', () => {
        assert.equal(parse(signedRequest(fresh(), OTHER_SECRET), [SECRET, OTHER_SECRET]).ok, true);
        assert.equal(parse(signedRequest(fresh(), SECRET), [SECRET, OTHER_SECRET]).ok, true);
    });

    it('refuses a signature made with another secret, and says how many secrets it tried', () => {
        const r = parse(signedRequest(fresh(), 'a-different-secret'), [SECRET, OTHER_SECRET]);
        assert.deepEqual(r, { ok: false, reason: 'bad_signature', secretsTried: 2 });
    });

    it('refuses a payload that was changed after it was signed: another person\'s id under the first person\'s signature', () => {
        const genuine = signedRequest(fresh({ user_id: PERSON }));
        const [signature] = genuine.split('.') as [string];
        const forged = `${signature}.${b64(JSON.stringify(fresh({ user_id: OTHER_PERSON })))}`;
        assert.equal(parse(forged).ok, false);
        assert.equal((parse(forged) as { reason: string }).reason, 'bad_signature');
    });

    it('signs the ENCODED payload, not the JSON it decodes to: a re-encoding of the same JSON does not verify', () => {
        const json = JSON.stringify(fresh());
        const encoded = b64(json);
        const signature = b64(crypto.createHmac('sha256', SECRET).update(json).digest());
        assert.equal((parse(`${signature}.${encoded}`) as { reason: string }).reason, 'bad_signature');
    });

    it('refuses with no secret to check it with, instead of trusting it', () => {
        assert.deepEqual(parse(signedRequest(fresh()), []), { ok: false, reason: 'no_secret', secretsTried: 0 });
    });

    it('refuses what is not a signed request at all', () => {
        const valid = signedRequest(fresh());
        const [signature, payload] = valid.split('.') as [string, string];
        const cases: unknown[] = [
            undefined, null, 42, {}, ['a.b'], '', '.', 'nodot', `${signature}`, `${signature}.`, `.${payload}`, `${signature}.${payload}.extra`,
            'not base64!.also not!', `${signature}.${payload}!`, `${signature.slice(0, 10)}.${payload}`, `${signature}AAAA.${payload}`,
            `x`.repeat(SIGNED_REQUEST_MAX_CHARS + 1),
        ];
        for (const raw of cases) {
            const r = parse(raw);
            assert.equal(r.ok, false, JSON.stringify(raw)?.slice(0, 60));
            assert.equal((r as { reason: string }).reason, 'malformed', JSON.stringify(raw)?.slice(0, 60));
        }
    });

    it('refuses a signed payload that is not a JSON object', () => {
        for (const body of ['not json', '"a string"', '[1,2]', 'null', '12']) {
            const encoded = b64(body);
            const raw = `${b64(crypto.createHmac('sha256', SECRET).update(encoded).digest())}.${encoded}`;
            assert.equal((parse(raw) as { reason: string }).reason, 'malformed', body);
        }
    });

    it('refuses a signed payload whose algorithm is not HMAC-SHA256', () => {
        assert.equal((parse(signedRequest(fresh({ algorithm: 'HMAC-SHA1' }))) as { reason: string }).reason, 'bad_algorithm');
        assert.equal((parse(signedRequest(fresh({ algorithm: 256 }))) as { reason: string }).reason, 'bad_algorithm');
        assert.equal((parse(signedRequest(fresh({ algorithm: null }))) as { reason: string }).reason, 'bad_algorithm');
    });

    it('does not turn away a genuine request for lacking an `algorithm` or an `issued_at`: Meta\'s text does not promise either', () => {
        const { algorithm: _a, issued_at: _i, ...bare } = fresh();
        assert.deepEqual(parse(signedRequest(bare)), { ok: true, userId: PERSON, issuedAt: null });
    });

    it('refuses a request issued more than a day ago, and one from the future: a captured request is not good forever', () => {
        assert.equal(parse(signedRequest(fresh({ issued_at: NOW_S - SIGNED_REQUEST_MAX_AGE_SECONDS + 60 }))).ok, true, 'just inside the day');
        assert.equal((parse(signedRequest(fresh({ issued_at: NOW_S - SIGNED_REQUEST_MAX_AGE_SECONDS - 60 }))) as { reason: string }).reason, 'stale');
        assert.equal((parse(signedRequest(fresh({ issued_at: NOW_S - 30 * 86_400 }))) as { reason: string }).reason, 'stale');
        assert.equal(parse(signedRequest(fresh({ issued_at: NOW_S + 60 }))).ok, true, 'a minute of clock skew is fine');
        assert.equal((parse(signedRequest(fresh({ issued_at: NOW_S + 3600 }))) as { reason: string }).reason, 'stale');
    });

    it('refuses a request past its own `expires`, and reads an `expires` of 0 as "does not expire"', () => {
        assert.equal((parse(signedRequest(fresh({ expires: NOW_S - 1 }))) as { reason: string }).reason, 'stale');
        assert.equal(parse(signedRequest(fresh({ expires: 0 }))).ok, true);
    });

    it('refuses a timestamp that is not a number', () => {
        assert.equal((parse(signedRequest(fresh({ issued_at: '1760443200' }))) as { reason: string }).reason, 'malformed');
        assert.equal((parse(signedRequest(fresh({ expires: 'soon' }))) as { reason: string }).reason, 'malformed');
    });

    it('refuses a signed, fresh request that names nobody it could match on: no id, an empty one, a number, an object, free text', () => {
        const { user_id: _u, ...without } = fresh();
        for (const payload of [without, fresh({ user_id: '' }), fresh({ user_id: 9000100020003000 }), fresh({ user_id: { id: PERSON } }), fresh({ user_id: null }), fresh({ user_id: "1'; DROP TABLE creators;--" }), fresh({ user_id: 'x'.repeat(200) }), fresh({ user_id: ' ' })]) {
            assert.equal((parse(signedRequest(payload)) as { reason: string }).reason, 'no_user', JSON.stringify(payload).slice(0, 70));
        }
    });

    it('never throws, whatever it is given', () => {
        for (const raw of ['\u0000.\u0000', '....', '%%.%%', '='.repeat(40), 'a.b', Buffer.alloc(8), Symbol.iterator.toString()]) {
            assert.doesNotThrow(() => parse(raw));
        }
    });
});

// ─── disconnectMetaUser ─────────────────────────────────────────────────────────────────

let db: FakeDb;
let graph: FakeGraph;
let logs: string[];
let restoreSink: () => void;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const k of ['TOKEN_ENCRYPTION_KEY', 'META_APP_ID', 'META_APP_SECRET']) saved[k] = process.env[k];
    process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.META_APP_ID = '111222333444555';
    process.env.META_APP_SECRET = SECRET;
    db = new FakeDb().install();
    graph = new FakeGraph().install();
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

/** A tenant a person connected with Facebook Login: ids, an encrypted Page token, and the person's id. */
function connectedBy(id: string, person: string | null, n: number, over: Partial<ReturnType<FakeDb['addCreator']>> = {}) {
    return db.addCreator(id, {
        name: `Tenant ${n}`, instagram_page_id: `1784140000000000${n}`, facebook_page_id: `20000000000000${n}`,
        page_access_token: encryptSecret(TENANT_TOKEN_PLAIN + n), token_status: 'valid',
        meta_user_id: person, meta_page_name: `Page ${n}`, meta_connected_at: person ? new Date() : null,
        meta_webhook_subscribed_at: person ? new Date() : null, instagram_username: `page${n}`, ...over,
    });
}

/** The owner as he is in production: a pasted Page token, no `meta_user_id`, and none of the v35 columns. */
function legacyOwner() {
    return db.addCreator(OWNER, {
        name: 'owner', instagram_page_id: '17841499999999991', facebook_page_id: '100000000000001',
        page_access_token: encryptSecret(OWNER_TOKEN_PLAIN), token_status: 'valid',
    });
}

const snapshot = (id: string): string => JSON.stringify(db.creators.get(id));

describe('disconnectMetaUser: the tenant the person connected', () => {
    it('clears its ids, its token and every meta_ column, and unsubscribes its Page from the webhook with the Page\'s own token', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        graph.subscribed.set('200000000000001', ['feed']);
        const outcome = await disconnectMetaUser(PERSON);
        assert.deepEqual(outcome, { matched: 1, disconnected: 1, failed: 0 });

        const del = graph.called(/DELETE \/200000000000001\/subscribed_apps/);
        assert.equal(del.length, 1);
        assert.equal(del[0]!.authorization, `Bearer ${TENANT_TOKEN_PLAIN}1`, 'the Page token, decrypted');
        assert.equal(graph.subscribed.has('200000000000001'), false, 'the webhook subscription is gone');

        const row = db.creators.get(TENANT_A)!;
        for (const column of ['instagram_page_id', 'facebook_page_id', 'page_access_token', 'meta_user_id', 'meta_page_name', 'meta_connected_at', 'meta_webhook_subscribed_at', 'token_error', 'token_expires_at', 'token_data_access_expires_at'] as const) {
            assert.equal(row[column], null, column);
        }
        assert.equal(row.token_status, 'unknown');
        assert.equal(row.name, 'Tenant 1', 'the tenant itself is kept: its campaigns and posts are the tenant\'s own');
    });

    it('does not revoke the person\'s permissions: that would cut off every other tenant they connected, and they already did it themselves', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        await disconnectMetaUser(PERSON);
        assert.equal(graph.called(/\/permissions/).length, 0);
        assert.equal(graph.calls.filter((c) => c.method === 'DELETE').length, 1, 'only the Page subscription');
    });

    it('disconnects EVERY tenant the person connected, and leaves a tenant somebody else connected', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        connectedBy(TENANT_B, PERSON, 2);
        connectedBy(BYSTANDER, OTHER_PERSON, 3);
        const before = snapshot(BYSTANDER);
        const outcome = await disconnectMetaUser(PERSON);
        assert.deepEqual(outcome, { matched: 2, disconnected: 2, failed: 0 });
        assert.equal(db.creators.get(TENANT_A)!.page_access_token, null);
        assert.equal(db.creators.get(TENANT_B)!.page_access_token, null);
        assert.equal(snapshot(BYSTANDER), before, 'byte for byte');
        assert.equal(graph.calls.some((c) => /\/200000000000003\//.test(c.path)), false, 'nothing was asked of Meta about the bystander');
    });

    it('still disconnects when Meta will not unsubscribe (the token is dead once the person removed the app), and says it could not', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        graph.fail(/DELETE /, 400, { message: 'token dead', code: 190 }, 5);
        const outcome = await disconnectMetaUser(PERSON);
        assert.deepEqual(outcome, { matched: 1, disconnected: 1, failed: 0 });
        assert.equal(db.creators.get(TENANT_A)!.page_access_token, null, 'the stored token is deleted regardless');
        const row = db.audit.find((a) => a.action === AUDIT_ACTIONS.metaDeauthorize)!;
        assert.equal(JSON.parse(row.detail).unsubscribed_from_webhook, false);
    });

    it('still disconnects when the stored token cannot be read', async () => {
        connectedBy(TENANT_A, PERSON, 1, { page_access_token: 'enc:v1:AAAA:BBBB:CCCC' });
        const outcome = await disconnectMetaUser(PERSON);
        assert.equal(outcome.disconnected, 1);
        assert.equal(db.creators.get(TENANT_A)!.page_access_token, null);
        assert.equal(graph.calls.length, 0, 'nothing could be asked of Meta without the token');
    });

    it('writes one audit row per tenant, by the system actor, with the Pages and the outcome: no token, and not the person', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        connectedBy(TENANT_B, PERSON, 2);
        await disconnectMetaUser(PERSON);
        const rows = db.audit.filter((a) => a.action === AUDIT_ACTIONS.metaDeauthorize);
        assert.equal(rows.length, 2);
        assert.deepEqual(rows.map((r) => r.target_id).sort(), [TENANT_A, TENANT_B]);
        for (const r of rows) {
            assert.equal(r.action, 'meta.deauthorize');
            assert.equal(r.actor_user_id, null);
            assert.equal(r.actor_email, META_DEAUTHORIZE_ACTOR_EMAIL, 'not the legacy dashboard-password actor: nobody signed in');
            assert.equal(r.target_type, 'creator');
        }
        assert.deepEqual(JSON.parse(rows.find((r) => r.target_id === TENANT_A)!.detail), {
            facebook_page_id: '200000000000001', instagram_page_id: '17841400000000001', unsubscribed_from_webhook: true, via: 'deauthorize_callback',
        });
        assert.ok(!db.audit.some((a) => a.detail.includes(PERSON)), 'the audit log is never cleared: it must not keep the person\'s id');
    });

    it('keeps no token and no person id in a log line or an audit row, and no token in a statement\'s parameters; the token is only ever in the Authorization header of the one call that needs it', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        await disconnectMetaUser(PERSON);
        const kept = [logs.join('\n'), db.audit.map((a) => [a.actor_email, a.target_id, a.detail].join(' ')).join('\n')].join('\n');
        assert.ok(!kept.includes(PERSON), 'the id is a parameter of the lookup and of the guarded clearing, and is written nowhere that stays');
        assert.ok(!kept.includes(TENANT_TOKEN_PLAIN));
        assert.ok(!JSON.stringify(db.statements.map((s) => s.params)).includes(TENANT_TOKEN_PLAIN));
        assert.equal(graph.calls.filter((c) => c.authorization?.includes(TENANT_TOKEN_PLAIN)).length, 1);
        assert.ok(!graph.calls.some((c) => JSON.stringify(c.params ?? {}).includes(TENANT_TOKEN_PLAIN) || (c.body ?? '').includes(TENANT_TOKEN_PLAIN)), 'never in a query string or a body');
    });

    it('is idempotent: a second delivery finds nothing, because the first cleared what it matches on', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        await disconnectMetaUser(PERSON);
        graph.calls.length = 0;
        const before = db.audit.length;
        assert.deepEqual(await disconnectMetaUser(PERSON), { matched: 0, disconnected: 0, failed: 0 });
        assert.equal(graph.calls.length, 0);
        assert.equal(db.audit.length, before);
    });
});

describe('disconnectMetaUser: nobody else\'s tenant, and above all not the owner\'s', () => {
    it('does nothing at all for an id no tenant was connected with: no write, no call to Meta, no audit row', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        legacyOwner();
        const before = db.snapshotCreators();
        assert.deepEqual(await disconnectMetaUser('1234567890'), { matched: 0, disconnected: 0, failed: 0 });
        assert.equal(db.snapshotCreators(), before);
        assert.equal(graph.calls.length, 0);
        assert.equal(db.audit.length, 0);
        assert.equal(db.statements.some((s) => /^UPDATE creators/.test(s.sql)), false, 'not even an UPDATE that matched nothing');
    });

    it('never touches the owner\'s pasted-token connection: his meta_user_id is NULL, and no id equals NULL', async () => {
        legacyOwner();
        const before = snapshot(OWNER);
        for (const id of [PERSON, '1', '0', 'null', 'NULL', 'undefined', 'None', '1000000000000001']) {
            assert.deepEqual(await disconnectMetaUser(id), { matched: 0, disconnected: 0, failed: 0 }, id);
        }
        assert.equal(snapshot(OWNER), before, 'byte for byte, token included');
        assert.equal(decryptOwnerToken(), OWNER_TOKEN_PLAIN);
        assert.equal(graph.calls.length, 0);
    });

    it('does not let an empty, missing or odd id reach the database at all', async () => {
        legacyOwner();
        connectedBy(TENANT_A, PERSON, 1);
        for (const id of ['', ' ', '%', "9000100020003000' OR '1'='1", 'x'.repeat(300)]) {
            assert.deepEqual(await disconnectMetaUser(id), { matched: 0, disconnected: 0, failed: 0 });
        }
        assert.equal(db.statements.length, 0, 'not one statement was issued');
        assert.equal(db.creators.get(TENANT_A)!.page_access_token !== null, true);
    });

    it('does not match an id that merely contains or starts like the stored one', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        const before = snapshot(TENANT_A);
        for (const id of [PERSON.slice(0, -1), PERSON + '0', '0' + PERSON, PERSON.slice(1), PERSON.toUpperCase() + 'a']) {
            assert.equal((await disconnectMetaUser(id)).matched, 0, id);
        }
        assert.equal(snapshot(TENANT_A), before);
    });

    it('treats the owner as any other person IF his row carries an id (he reconnected through Login) and the request is for exactly that id', async () => {
        legacyOwner();
        db.creators.get(OWNER)!.meta_user_id = '1000000000000001';
        connectedBy(TENANT_A, PERSON, 1);
        const tenantBefore = snapshot(TENANT_A);

        assert.equal((await disconnectMetaUser(PERSON)).matched, 1, 'another person: only their tenant');
        assert.equal(db.creators.get(OWNER)!.page_access_token !== null, true, 'the owner is untouched by another person\'s request');
        assert.equal(db.creators.get(OWNER)!.meta_user_id, '1000000000000001');

        const outcome = await disconnectMetaUser('1000000000000001');
        assert.deepEqual(outcome, { matched: 1, disconnected: 1, failed: 0 });
        assert.equal(db.creators.get(OWNER)!.page_access_token, null, 'his own request, for his own id, does disconnect him');
        assert.notEqual(snapshot(TENANT_A), tenantBefore, 'and the first person\'s tenant was handled by the first request');
    });

    it('leaves a tenant that somebody else reconnected between the lookup and the clearing exactly as it is', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        // The unsubscribe is the step between "found it" and "cleared it": here another person's Login completes in that gap.
        const realDelete = (metaHttp as any).delete;
        (metaHttp as any).delete = async (url: string, cfg: any) => {
            const row = db.creators.get(TENANT_A)!;
            row.meta_user_id = OTHER_PERSON;
            row.page_access_token = encryptSecret('EAA-the-new-owners-token-0123456789');
            return realDelete(url, cfg);
        };
        try {
            const outcome = await disconnectMetaUser(PERSON);
            assert.deepEqual(outcome, { matched: 1, disconnected: 0, failed: 0 });
        } finally {
            (metaHttp as any).delete = realDelete;
        }
        const row = db.creators.get(TENANT_A)!;
        assert.equal(row.meta_user_id, OTHER_PERSON, 'still the new connection');
        assert.notEqual(row.page_access_token, null, 'its token was not deleted');
        assert.equal(row.facebook_page_id, '200000000000001');
        assert.equal(db.audit.some((a) => a.action === AUDIT_ACTIONS.metaDeauthorize), false, 'nothing was disconnected, so nothing is recorded as such');
    });

    it('counts a database failure as failed, keeps going with the other tenants, and records nothing for the one it could not clear', async () => {
        connectedBy(TENANT_A, PERSON, 1);
        connectedBy(TENANT_B, PERSON, 2);
        const realQuery = db.failOn;
        db.failOn = /^SELECT facebook_page_id, instagram_page_id, \(page_access_token IS NOT NULL\) AS connected FROM creators WHERE id = \$1$/;
        try {
            const outcome = await disconnectMetaUser(PERSON);
            assert.deepEqual(outcome, { matched: 2, disconnected: 0, failed: 2 });
        } finally {
            db.failOn = realQuery;
        }
        assert.equal(db.creators.get(TENANT_A)!.meta_user_id, PERSON, 'untouched, so the retry Meta makes finds it');
        assert.equal(db.audit.length, 0);
        assert.deepEqual(await disconnectMetaUser(PERSON), { matched: 2, disconnected: 2, failed: 0 }, 'and the retry works');
    });
});

/** The owner's stored token, decrypted: his row must still hold the very ciphertext of the token he pasted. */
function decryptOwnerToken(): string {
    return decryptSecret(db.creators.get(OWNER)!.page_access_token!);
}
