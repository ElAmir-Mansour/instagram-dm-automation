/**
 * Tenant invites (P17): the admin card's routes and the two public ones a link opens.
 *
 * Driven through the real routers with a plain request object, against the in-memory stand-in for the invite tables
 * (`services/invites/testDb.ts`), whose single-use claim reads its predicates out of the SQL: take `AND used_at IS NULL` out of
 * the production statement and "a link works once" fails here, which is the mutation this file was verified against.
 *
 * What is pinned, because each is a way a link becomes a skeleton key:
 *   - the token is 32 random bytes in the URL FRAGMENT and only its sha256 is stored;
 *   - a link works once, expires, can be revoked, and regenerating revokes the old one in the same step;
 *   - every way a link can be unusable answers the same 410, and an address with an account answers 409 without being touched;
 *   - a reset replaces the password and bumps `token_version`, which ends every session the account held;
 *   - the two public routes share the login's per-IP throttle;
 *   - no audit row, log line or response (other than the one that makes the link) carries a token;
 *   - only a platform admin reaches the admin routes, and a link goes to the tenant in its PATH, never one named in a body.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { createLegacySession, createSession, verifySession } from '../middleware/auth.js';
import { AUDIT_ACTIONS } from '../services/audit.js';
import { hashInviteToken } from '../services/invites.js';
import { installInviteWorld, uuid, type InviteRec, type InviteWorld } from '../services/invites/testDb.js';
import { clearLoginFailures, LOGIN_FREE_ATTEMPTS, recordLoginFailure, resetLoginThrottle } from '../services/loginThrottle.js';
import { checkSessionValidity } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import adminRouter from './admin.js';
import apiRouter from './api.js';
import invitesRouter from './invites.js';

interface Reply { status: number; body: any; headers: Record<string, string> }
interface CallOptions { body?: unknown; session?: Record<string, unknown>; bearer?: string; ip?: string }

const HOST = 'app.example.test';

/** Call a router as Express would, with nothing mounted above it. */
function call(router: unknown, method: string, url: string, options: CallOptions = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const headers: Record<string, string> = { host: HOST, 'x-forwarded-proto': 'https' };
        if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
        if (options.ip) headers['x-forwarded-for'] = options.ip;
        const req = {
            method: method.toUpperCase(), url, originalUrl: url, body: options.body, query: {}, params: {}, headers,
            session: options.session, socket: { remoteAddress: '203.0.113.9' },
        } as unknown as Request;
        const sent: Record<string, string> = {};
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers: sent }); return this; },
            setHeader(name: string, value: string) { sent[name.toLowerCase()] = String(value); return this; },
        } as unknown as Response;
        (router as (r: Request, s: Response, n: () => void) => void)(req, res, () => resolve({ status: 0, body: { fellThrough: true }, headers: sent }));
    });
}

const ADMIN_SESSION = { userId: uuid(1), role: 'platform_admin', tenantId: uuid(100), tokenVersion: 1 };
const USER_SESSION = { userId: uuid(2), role: 'user', tenantId: uuid(100), tokenVersion: 1 };

let world: InviteWorld;
let logs: string[];
let restoreSink: (() => void) | undefined;
const saved: Record<string, string | undefined> = {};

before(() => {
    for (const key of ['DASHBOARD_PASSWORD', 'META_APP_SECRET', 'PUBLIC_BASE_URL', 'TOKEN_ENCRYPTION_KEY']) saved[key] = process.env[key];
    process.env.DASHBOARD_PASSWORD = 'dashboard-password';
    process.env.META_APP_SECRET = 'meta-app-secret';
    delete process.env.PUBLIC_BASE_URL;
});
after(() => {
    for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

beforeEach(() => {
    world = installInviteWorld();
    world.addCreator(100, 'Nour Shop');
    world.addCreator(101, 'Other Co');
    world.onboarding.set(uuid(100), { status: 'invited', started_at: null });
    world.addUser(1, 'admin@example.com', { role: 'platform_admin' });
    world.addUser(2, 'owner-of-a@example.com');
    world.addMember(uuid(2), uuid(100));
    resetLoginThrottle();
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    world.restore();
    restoreSink?.();
    resetLoginThrottle();
});

const TENANT = uuid(100);
const OTHER_TENANT = uuid(101);
const PASSWORD = 'a-long-enough-password';

// ─── Helpers ─────────────────────────────────────────────────────────────────────────────────────

/** The raw token out of a link: it is in the fragment, which is the point. */
function tokenOf(url: string): string {
    const hash = new URL(url).hash;
    return new URLSearchParams(hash.slice(hash.indexOf('?') + 1)).get('t')!;
}

interface Made { id: string; url: string; token: string; reply: Reply }

async function makeInvite(body: Record<string, unknown> = {}, tenant = TENANT): Promise<Made> {
    const reply = await call(adminRouter, 'POST', `/tenants/${tenant}/invites`, { body, session: ADMIN_SESSION });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return { id: reply.body.invite.id, url: reply.body.invite.url, token: tokenOf(reply.body.invite.url), reply };
}

const peek = (token: unknown, options: CallOptions = {}) => call(invitesRouter, 'POST', '/peek', { body: { token }, ...options });
const accept = (body: Record<string, unknown>, options: CallOptions = {}) => call(invitesRouter, 'POST', '/accept', { body, ...options });
const join = (token: string, email = 'nour@example.com', extra: Record<string, unknown> = {}) => accept({ token, email, password: PASSWORD, ...extra });
const usersNamed = (email: string) => [...world.users.values()].filter((u) => u.email.toLowerCase() === email.toLowerCase());
const decode = (token: string): Record<string, any> => JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));

// ─── The token ───────────────────────────────────────────────────────────────────────────────────

describe('the token', () => {
    it('is 32 random bytes, and the link carries it in the URL fragment, not the query string', async () => {
        const made = await makeInvite();
        assert.match(made.token, /^[A-Za-z0-9_-]{43}$/, '32 bytes, base64url, no padding');
        assert.equal(Buffer.from(made.token, 'base64url').length, 32);
        const url = new URL(made.url);
        assert.equal(url.origin, `https://${HOST}`);
        assert.equal(url.pathname, '/dashboard');
        assert.equal(url.search, '', 'nothing in the query string: a query is sent to the server and written to its logs');
        assert.ok(url.hash.startsWith('#/invite?t='), 'the page reads it from the hash');
        assert.equal(url.hash.includes(made.token), true);
        assert.equal(url.pathname.includes(made.token), false);
    });

    it('never repeats: a hundred links, a hundred different tokens', async () => {
        const seen = new Set<string>();
        for (let i = 0; i < 100; i += 1) seen.add((await makeInvite()).token);
        assert.equal(seen.size, 100);
    });

    it('is stored only as its sha256: the raw token is in no column, and not in any statement but the response', async () => {
        const made = await makeInvite({ email: 'person@example.com' });
        const row = world.invites.find((r) => r.id === made.id)!;
        assert.equal(row.token_hash, createHash('sha256').update(made.token).digest('hex'));
        assert.match(row.token_hash, /^[0-9a-f]{64}$/);
        assert.equal(JSON.stringify(row).includes(made.token), false, 'not in the stored row');
        for (const statement of world.db.statements) {
            assert.equal(JSON.stringify(statement.params).includes(made.token), false, `not a parameter of: ${statement.sql.slice(0, 60)}`);
        }
        assert.equal(logs.some((line) => line.includes(made.token)), false, 'not in a log line');
    });

    it('is not returned by listing a tenant\'s invites: no token, no hash, no link', async () => {
        const made = await makeInvite();
        const listed = await call(adminRouter, 'GET', `/tenants/${TENANT}/invites`, { session: ADMIN_SESSION });
        assert.equal(listed.status, 200);
        assert.equal(listed.body.invites.length, 1);
        const text = JSON.stringify(listed.body);
        assert.equal(text.includes(made.token), false);
        assert.equal(text.includes(hashInviteToken(made.token)), false);
        assert.equal(text.includes('token'), false, 'no field of that name');
        assert.equal(text.includes('url'), false, 'no link: the token is not stored, so one cannot be remade');
        assert.equal(listed.body.invites[0].status, 'pending');
    });

    it('is found by a malformed value as nothing at all, without a query', async () => {
        const before = world.db.statements.length;
        const malformed = [undefined, null, 42, '', 'short', 'x'.repeat(44), `${'a'.repeat(42)}!`, { $ne: 1 }, ['a'.repeat(43)]];
        for (const [i, token] of malformed.entries()) {
            const reply = await peek(token as unknown, { ip: `198.51.100.${100 + i}` });
            assert.equal(reply.status, 410, JSON.stringify(token));
            assert.equal(reply.body.code, 'INVITE_INVALID');
        }
        assert.equal(world.db.statements.length, before, 'a value that cannot be a token never reaches the database');
    });
});

// ─── peek ────────────────────────────────────────────────────────────────────────────────────────

describe('peek', () => {
    it('shows the tenant, the role, the address and the expiry, without using the link up', async () => {
        const made = await makeInvite({ email: 'Person@Example.com', role: 'operator' });
        const first = await peek(made.token);
        assert.equal(first.status, 200);
        assert.equal(first.body.tenantName, 'Nour Shop');
        assert.equal(first.body.role, 'operator');
        assert.equal(first.body.email, 'person@example.com', 'as the operator typed it, normalised');
        assert.equal(first.body.purpose, 'join');
        assert.ok(new Date(first.body.expiresAt).getTime() > Date.now());
        assert.equal(first.body.viewer, null);
        assert.equal(first.headers['cache-control'], 'no-store');

        await peek(made.token);
        await peek(made.token);
        assert.equal(world.invites[0]!.used_at, null, 'peeking never consumes');
        assert.equal((await join(made.token, 'person@example.com')).status, 201, 'and the link still works');
    });

    it('does not hand out ids: not the tenant\'s, not the invite\'s, not the hash', async () => {
        const made = await makeInvite();
        const text = JSON.stringify((await peek(made.token)).body);
        for (const secret of [TENANT, made.id, hashInviteToken(made.token), made.token]) assert.equal(text.includes(secret), false);
    });

    it('counts the opening: that is what "Opened 2h ago" on the operator\'s card says', async () => {
        const made = await makeInvite();
        await peek(made.token);
        await peek(made.token);
        const row = world.invites[0]!;
        assert.equal(row.open_count, 2);
        assert.ok(row.first_opened_at instanceof Date);
        const listed = await call(adminRouter, 'GET', `/tenants/${TENANT}/invites`, { session: ADMIN_SESSION });
        assert.equal(listed.body.invites[0].status, 'opened');
        assert.equal(listed.body.invites[0].open_count, 2);
    });

    it('shows the inviter the operator named, and never an email', async () => {
        const made = await makeInvite();
        assert.equal((await peek(made.token)).body.inviter, null, 'nothing set: nobody is named');
        const saved = await call(adminRouter, 'PUT', '/onboarding-settings', { body: { inviterName: 'Amir' }, session: ADMIN_SESSION });
        assert.equal(saved.status, 200);
        assert.equal((await peek(made.token)).body.inviter, 'Amir');
        const refused = await call(adminRouter, 'PUT', '/onboarding-settings', { body: { inviterName: 'amir@example.com' }, session: ADMIN_SESSION });
        assert.equal(refused.status, 400);
        assert.equal(refused.body.field, 'inviterName');
    });

    it('tells the page who is signed in, so it can offer to add the tenant to that account', async () => {
        const made = await makeInvite({ email: 'owner-of-a@example.com' });
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: null, tokenVersion: 1 });
        const same = await peek(made.token, { bearer: mine });
        assert.deepEqual(same.body.viewer, { signedIn: true, platformAdmin: false, email: 'owner-of-a@example.com', emailMatches: true });

        world.addUser(3, 'someone-else@example.com');
        const other = createSession({ userId: uuid(3), role: 'user', tenantId: null, tokenVersion: 1 });
        assert.equal((await peek(made.token, { bearer: other })).body.viewer.emailMatches, false, 'a link for one address, a different account');

        const open = await makeInvite();
        assert.equal((await peek(open.token, { bearer: other })).body.viewer.emailMatches, null, 'a link for nobody in particular has nothing to match');
    });

    it('reports a platform admin as such (the legacy shared-password session too), never as a user to add', async () => {
        const made = await makeInvite();
        const legacy = await peek(made.token, { bearer: createLegacySession(TENANT) });
        assert.deepEqual(legacy.body.viewer, { signedIn: true, platformAdmin: true, email: null, emailMatches: null });
        const adminUser = createSession({ userId: uuid(1), role: 'platform_admin', tenantId: TENANT, tokenVersion: 1 });
        assert.equal((await peek(made.token, { bearer: adminUser })).body.viewer.platformAdmin, true);
    });

    it('treats a dead session as no session: a stale token in localStorage must not stand between a person and their link', async () => {
        const made = await makeInvite();
        const revoked = createSession({ userId: uuid(2), role: 'user', tenantId: null, tokenVersion: 0 });
        assert.equal((await peek(made.token, { bearer: revoked })).body.viewer, null, 'token_version moved on');
        world.users.get(uuid(2))!.is_active = false;
        const disabled = createSession({ userId: uuid(2), role: 'user', tenantId: null, tokenVersion: 1 });
        assert.equal((await peek(made.token, { bearer: disabled })).body.viewer, null, 'account switched off');
        assert.equal((await peek(made.token, { bearer: 'not-a-token' })).body.viewer, null, 'garbage');
    });
});

// ─── accept ──────────────────────────────────────────────────────────────────────────────────────

describe('accept: a new person', () => {
    it('creates the account and its membership, and answers a session for that tenant', async () => {
        const made = await makeInvite();
        const reply = await join(made.token, 'Nour@Example.com');
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        const user = usersNamed('nour@example.com')[0]!;
        assert.equal(user.email, 'nour@example.com');
        assert.match(user.password_hash, /^$|^scrypt:/, 'hashed with the existing scrypt, never stored as typed');
        assert.notEqual(user.password_hash, PASSWORD);
        assert.deepEqual(world.memberships.filter((m) => m.user_id === user.id), [{ user_id: user.id, creator_id: TENANT, role: 'owner' }]);
        assert.equal(reply.body.tenantId, TENANT);
        assert.equal(reply.body.created, true);
        assert.equal(reply.body.expiresIn, '24h');
        const session = verifySession(reply.body.token)!;
        assert.deepEqual([session.userId, session.role, session.tenantId, session.tokenVersion], [user.id, 'user', TENANT, user.token_version]);
        assert.equal('exp' in session, false, 'an ordinary 24-hour session unless "keep me signed in"');
        assert.equal(world.invites[0]!.used_by, user.id);
        assert.equal(reply.headers['cache-control'], 'no-store');
    });

    it('moves the tenant from invited to in_progress, and never moves one backwards', async () => {
        const made = await makeInvite();
        await join(made.token);
        assert.equal(world.onboarding.get(TENANT)!.status, 'in_progress');
        world.onboarding.get(TENANT)!.status = 'completed';
        const second = await makeInvite({ email: 'second@example.com' });
        const reply = await join(second.token, 'second@example.com');
        assert.equal(world.onboarding.get(TENANT)!.status, 'completed', 'a later member does not reopen the wizard');
        assert.equal(reply.body.onboarding.status, 'completed');
    });

    it('takes the tenant, the role and the account type from the link, never from the body', async () => {
        const made = await makeInvite({ role: 'viewer' });
        const reply = await accept({
            token: made.token, email: 'nour@example.com', password: PASSWORD,
            tenantId: OTHER_TENANT, creator_id: OTHER_TENANT, creatorId: OTHER_TENANT, role: 'owner', membership_role: 'owner', platform_role: 'platform_admin', userId: uuid(1),
        });
        assert.equal(reply.status, 201);
        const user = usersNamed('nour@example.com')[0]!;
        assert.equal(user.role, 'user', 'never a platform admin');
        assert.deepEqual(world.memberships.filter((m) => m.user_id === user.id).map((m) => [m.creator_id, m.role]), [[TENANT, 'viewer']]);
        assert.equal(reply.body.tenantId, TENANT);
    });

    it('uses the link\'s own address when the operator gave one, whatever the form says', async () => {
        const made = await makeInvite({ email: 'intended@example.com' });
        const reply = await join(made.token, 'someone-sneakier@example.com');
        assert.equal(reply.status, 201);
        assert.equal(reply.body.email, 'intended@example.com');
        assert.equal(usersNamed('someone-sneakier@example.com').length, 0);
    });

    it('asks for an address when the link has none, and for a real password', async () => {
        const made = await makeInvite();
        const noEmail = await accept({ token: made.token, password: PASSWORD });
        assert.equal(noEmail.status, 400);
        assert.equal(noEmail.body.code, 'BAD_EMAIL');
        const badEmail = await accept({ token: made.token, email: 'not an email', password: PASSWORD });
        assert.equal(badEmail.status, 400);
        const short = await join(made.token, 'nour@example.com', { password: 'short' });
        assert.equal(short.status, 400);
        assert.equal(short.body.code, 'WEAK_PASSWORD');
        const huge = await join(made.token, 'nour@example.com', { password: 'x'.repeat(2000) });
        assert.equal(huge.status, 400);
        assert.equal(world.invites[0]!.used_at, null, 'a refused attempt does not burn the link');
        assert.equal(world.users.size, 2, 'and made no account');
        assert.equal((await join(made.token)).status, 201, 'the same link then works');
    });

    it('keeps a session 30 days when asked to, 24 hours when not, and the number of days is a setting', async () => {
        const made = await makeInvite();
        const reply = await join(made.token, 'nour@example.com', { keepSignedIn: true });
        assert.equal(reply.body.expiresIn, '30d');
        const payload = decode(reply.body.token);
        assert.equal(payload.exp - payload.iat, 30 * 24 * 60 * 60 * 1000);

        await call(adminRouter, 'PUT', '/onboarding-settings', { body: { sessionDays: 10 }, session: ADMIN_SESSION });
        const second = await makeInvite({ email: 'two@example.com' });
        const tenDays = decode((await join(second.token, 'two@example.com', { keepSignedIn: true })).body.token);
        assert.equal(tenDays.exp - tenDays.iat, 10 * 24 * 60 * 60 * 1000);

        const third = await makeInvite({ email: 'three@example.com' });
        assert.equal('exp' in decode((await join(third.token, 'three@example.com', { keepSignedIn: false })).body.token), false);
        const fourth = await makeInvite({ email: 'four@example.com' });
        assert.equal('exp' in decode((await join(fourth.token, 'four@example.com', { keepSignedIn: 'yes' })).body.token), false, 'only a real true counts');
    });
});

describe('accept: a link works once', () => {
    it('answers the second attempt with the same 410, and makes no second account', async () => {
        const made = await makeInvite();
        assert.equal((await join(made.token, 'first@example.com')).status, 201);
        const again = await join(made.token, 'second@example.com');
        assert.equal(again.status, 410);
        assert.equal(again.body.code, 'INVITE_INVALID');
        assert.equal(usersNamed('second@example.com').length, 0);
        assert.equal((await peek(made.token)).status, 410, 'and it no longer opens at all');
    });

    it('lets exactly one of two simultaneous attempts in', async () => {
        const made = await makeInvite();
        const [a, b] = await Promise.all([join(made.token, 'a@example.com'), join(made.token, 'b@example.com')]);
        assert.deepEqual([a.status, b.status].sort(), [201, 410]);
        assert.equal([...world.users.values()].filter((u) => /^[ab]@example\.com$/.test(u.email)).length, 1);
        assert.equal(world.memberships.filter((m) => m.creator_id === TENANT).length, 2, 'the owner of A, and exactly one new member');
    });

    it('does not burn the link when a later step fails: the claim rolls back with the rest', async () => {
        const made = await makeInvite();
        world.failNext = { pattern: /^INSERT INTO memberships /, error: new Error('the database went away') };
        const failed = await join(made.token);
        assert.equal(failed.status, 500);
        assert.equal(world.invites[0]!.used_at, null, 'unused again');
        assert.equal(usersNamed('nour@example.com').length, 0, 'and no half-made account');
        assert.equal((await join(made.token)).status, 201);
    });
});

/**
 * The checks before the transaction (`loadUsableInvite`) are a courtesy: they let a person see "this link is no longer valid"
 * without hashing a password first. What actually makes a link single-use is the claim, ONE `UPDATE … WHERE used_at IS NULL
 * AND revoked_at IS NULL AND expires_at > NOW()`, because between the check and the claim another request can get in. Each
 * test here makes that happen, deterministically, by changing the link just before the claim is answered; deleting a predicate
 * from the claim lets the loser in, and these fail.
 */
describe('accept: the claim is what makes a link single-use', () => {
    const beforeClaim = (change: (row: InviteRec) => void): void => {
        world.before.push({ pattern: /^UPDATE invites SET used_at = NOW\(\)/, run: () => change(world.invites[0]!) });
    };
    const lostRace = async (made: Made): Promise<void> => {
        const reply = await join(made.token, 'loser@example.com');
        assert.equal(reply.status, 410);
        assert.equal(reply.body.code, 'INVITE_INVALID');
        assert.equal(usersNamed('loser@example.com').length, 0, 'no account for the one that lost');
        assert.deepEqual(world.memberships.filter((m) => m.creator_id === TENANT).map((m) => m.user_id), [uuid(2)], 'and no membership');
    };

    it('is lost to a request that used the link between the check and the claim', async () => {
        const made = await makeInvite();
        beforeClaim((row) => { row.used_at = new Date(); row.used_by = uuid(2); });
        await lostRace(made);
        assert.equal(world.invites[0]!.used_by, uuid(2), 'the winner is still the one recorded');
    });

    it('is lost to a revoke that landed between the check and the claim', async () => {
        const made = await makeInvite();
        beforeClaim((row) => { row.revoked_at = new Date(); });
        await lostRace(made);
        assert.equal(world.invites[0]!.used_at, null, 'a revoked link is never marked used');
    });

    it('is lost to the clock running out between the check and the claim', async () => {
        const made = await makeInvite();
        beforeClaim((row) => { row.expires_at = new Date(Date.now() - 1); });
        await lostRace(made);
        assert.equal(world.invites[0]!.used_at, null);
    });

    it('is the same for a reset: the password is not replaced for the loser', async () => {
        const made = await makeInvite({ purpose: 'reset', user_id: uuid(2) });
        const before = world.users.get(uuid(2))!.password_hash;
        beforeClaim((row) => { row.used_at = new Date(); });
        const reply = await accept({ token: made.token, password: 'a-brand-new-password' });
        assert.equal(reply.status, 410);
        assert.equal(world.users.get(uuid(2))!.password_hash, before);
        assert.equal(world.users.get(uuid(2))!.token_version, 1, 'and nobody was signed out');
    });

    it('is the same for a signed-in account being attached: no membership for the loser', async () => {
        const made = await makeInvite({}, OTHER_TENANT);
        beforeClaim((row) => { row.used_at = new Date(); });
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const reply = await accept({ token: made.token }, { bearer: mine });
        assert.equal(reply.status, 410);
        assert.equal(world.memberships.some((m) => m.creator_id === OTHER_TENANT), false);
    });
});

describe('accept: a link that cannot be used', () => {
    it('expires: after its time it neither opens nor accepts', async () => {
        const made = await makeInvite();
        world.invites[0]!.expires_at = new Date(Date.now() - 1000);
        assert.equal((await peek(made.token)).status, 410);
        const reply = await join(made.token);
        assert.equal(reply.status, 410);
        assert.equal(reply.body.error, 'This link is no longer valid.');
        assert.equal(usersNamed('nour@example.com').length, 0);
    });

    it('lasts 7 days by default, the setting changes it for the next link, and a request may choose', async () => {
        const week = (await makeInvite()).reply.body.invite;
        const days = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);
        assert.equal(days(week.expires_at), 7);
        await call(adminRouter, 'PUT', '/onboarding-settings', { body: { inviteTtlDays: 3 }, session: ADMIN_SESSION });
        assert.equal(days((await makeInvite()).reply.body.invite.expires_at), 3);
        assert.equal(days((await makeInvite({ ttl_days: 14 })).reply.body.invite.expires_at), 14);
        assert.equal(days(week.expires_at), 7, 'a link already out keeps the lifetime it was made with');
        assert.equal((await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: { ttl_days: 400 }, session: ADMIN_SESSION })).status, 400);
        assert.equal((await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: { ttl_days: 0 }, session: ADMIN_SESSION })).status, 400);
    });

    it('is refused once the tenant is switched off', async () => {
        const made = await makeInvite();
        world.creators.get(TENANT)!.is_active = false;
        assert.equal((await peek(made.token)).status, 410);
        assert.equal((await join(made.token)).status, 410);
    });

    it('answers the same thing for an unknown token, a used one, a revoked one and an expired one', async () => {
        const used = await makeInvite();
        await join(used.token);
        const revoked = await makeInvite();
        await call(adminRouter, 'DELETE', `/invites/${revoked.id}`, { session: ADMIN_SESSION });
        const expired = await makeInvite();
        world.invites.find((r) => r.id === expired.id)!.expires_at = new Date(Date.now() - 1);
        const replies = [];
        for (const token of ['A'.repeat(43), used.token, revoked.token, expired.token]) replies.push(await peek(token));
        for (const reply of replies) {
            assert.equal(reply.status, 410);
            assert.deepEqual(reply.body, { error: 'This link is no longer valid.', code: 'INVITE_INVALID' });
        }
    });
});

describe('accept: an address that already has an account', () => {
    it('answers 409 with the way in, never touches that account, and does not use the link up', async () => {
        world.addUser(7, 'Existing@Example.com', { password_hash: 'scrypt:theirs:theirs' });
        const made = await makeInvite();
        const reply = await join(made.token, 'existing@example.com');
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'EMAIL_EXISTS');
        assert.match(reply.body.error, /Sign in/);
        assert.equal(reply.body.tenantName, 'Nour Shop');
        assert.equal(world.users.get(uuid(7))!.password_hash, 'scrypt:theirs:theirs', 'an existing password is never overwritten');
        assert.equal(world.users.get(uuid(7))!.token_version, 1);
        assert.equal(world.invites[0]!.used_at, null);
        assert.deepEqual(world.memberships.filter((m) => m.user_id === uuid(7)), [], 'and no membership was granted to somebody who did not sign in');
        assert.equal(world.db.ran(/^BEGIN$/).length, 0, 'answered before any transaction began: nothing was claimed, and no password was hashed for it');
    });

    it('catches the same address taken between the check and the insert, and rolls the link back', async () => {
        const made = await makeInvite();
        world.failNext = {
            pattern: /^INSERT INTO users /,
            error: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
        };
        const reply = await join(made.token);
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'EMAIL_EXISTS');
        assert.equal(world.invites[0]!.used_at, null);
    });
});

describe('accept: somebody who is already signed in', () => {
    it('adds the tenant to that account with the link\'s role, creating nothing', async () => {
        const made = await makeInvite({ role: 'operator' }, OTHER_TENANT);
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const usersBefore = world.users.size;
        const reply = await accept({ token: made.token }, { bearer: mine });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        assert.equal(reply.body.attached, true);
        assert.equal(reply.body.created, false);
        assert.equal(world.users.size, usersBefore);
        assert.ok(world.memberships.some((m) => m.user_id === uuid(2) && m.creator_id === OTHER_TENANT && m.role === 'operator'));
        const session = verifySession(reply.body.token)!;
        assert.deepEqual([session.userId, session.tenantId], [uuid(2), OTHER_TENANT]);
        assert.equal(world.users.get(uuid(2))!.token_version, 1, 'no one is signed out');
    });

    it('carries a long session\'s expiry over instead of restarting it', async () => {
        const made = await makeInvite({}, OTHER_TENANT);
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 }, { ttlMs: 30 * 86_400_000 });
        const reply = await accept({ token: made.token }, { bearer: mine });
        assert.equal(decode(reply.body.token).exp, decode(mine).exp);
    });

    it('does not downgrade or duplicate a membership that already exists', async () => {
        const made = await makeInvite({ role: 'viewer' }, TENANT);
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const reply = await accept({ token: made.token }, { bearer: mine });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.alreadyMember, true);
        assert.deepEqual(world.memberships.filter((m) => m.user_id === uuid(2)).map((m) => m.role), ['owner']);
    });

    it('refuses a link made for another address, without using it up', async () => {
        const made = await makeInvite({ email: 'intended@example.com' });
        const mine = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const reply = await accept({ token: made.token }, { bearer: mine });
        assert.equal(reply.status, 403);
        assert.equal(reply.body.code, 'EMAIL_MISMATCH');
        assert.equal(world.invites[0]!.used_at, null);
    });

    it('refuses a platform admin\'s session before touching the link, so testing your own link does not spend it', async () => {
        const made = await makeInvite();
        for (const bearer of [createLegacySession(TENANT), createSession({ userId: uuid(1), role: 'platform_admin', tenantId: TENANT, tokenVersion: 1 })]) {
            const reply = await accept({ token: made.token, email: 'nour@example.com', password: PASSWORD }, { bearer });
            assert.equal(reply.status, 403);
            assert.equal(reply.body.code, 'ADMIN_SESSION');
        }
        assert.equal(world.invites[0]!.used_at, null);
        assert.equal((await join(made.token)).status, 201, 'signed out, the same link works');
    });

    it('ignores a dead session and makes the account: the stale-token case', async () => {
        const made = await makeInvite({ email: 'fresh@example.com' });
        const stale = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 99 });
        const reply = await accept({ token: made.token, password: PASSWORD }, { bearer: stale });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.created, true, 'a new account, not an attachment to the dead session\'s user');
        assert.equal(usersNamed('fresh@example.com').length, 1);
    });
});

// ─── reset ───────────────────────────────────────────────────────────────────────────────────────

describe('a reset link', () => {
    async function makeReset(userId = uuid(2)): Promise<Made> {
        return makeInvite({ purpose: 'reset', user_id: userId, lang: 'en' });
    }

    it('replaces the password and bumps token_version, which ends every session the account held', async () => {
        const staleSession = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const before = world.users.get(uuid(2))!;
        const oldHash = before.password_hash;
        const made = await makeReset();
        const reply = await accept({ token: made.token, password: 'a-brand-new-password' });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        const after = world.users.get(uuid(2))!;
        assert.notEqual(after.password_hash, oldHash);
        assert.equal(after.token_version, 2);
        assert.equal(checkSessionValidity(verifySession(staleSession)!, { token_version: after.token_version, is_active: true }).reason, 'revoked', 'the old session is dead');
        const fresh = verifySession(reply.body.token)!;
        assert.equal(fresh.tokenVersion, 2);
        assert.equal(checkSessionValidity(fresh, { token_version: after.token_version, is_active: true }).ok, true, 'the new one is alive');
        assert.equal(reply.body.purpose, 'reset');
        assert.equal(reply.body.created, false);
        assert.equal(world.memberships.length, 1, 'no membership was made');
    });

    it('is for the account it was made for: the page learns the address from the link, and the form cannot name another', async () => {
        const made = await makeReset();
        assert.equal((await peek(made.token)).body.email, 'owner-of-a@example.com');
        assert.equal((await peek(made.token)).body.purpose, 'reset');
        world.addUser(8, 'victim@example.com');
        world.addMember(uuid(8), TENANT);
        const reply = await accept({ token: made.token, email: 'victim@example.com', userId: uuid(8), user_id: uuid(8), password: 'a-brand-new-password' });
        assert.equal(reply.status, 201);
        assert.equal(world.users.get(uuid(8))!.token_version, 1, 'somebody else\'s account is untouched');
        assert.equal(world.users.get(uuid(2))!.token_version, 2);
    });

    it('lasts 24 hours by default', async () => {
        const made = await makeReset();
        const hours = (new Date(made.reply.body.invite.expires_at).getTime() - Date.now()) / 3_600_000;
        assert.ok(Math.abs(hours - 24) < 0.1, `${hours}`);
    });

    it('cannot be made for a platform admin, for somebody outside the tenant, for a disabled account or for nobody', async () => {
        world.addUser(9, 'outsider@example.com');
        const cases: Array<[string, Record<string, unknown>, number, string]> = [
            ['an admin', { purpose: 'reset', user_id: uuid(1) }, 409, 'USER_IS_ADMIN'],
            ['a non-member', { purpose: 'reset', user_id: uuid(9) }, 409, 'NOT_A_MEMBER'],
            ['nobody', { purpose: 'reset' }, 400, ''],
            ['an unknown user', { purpose: 'reset', user_id: uuid(404) }, 404, 'USER_NOT_FOUND'],
        ];
        for (const [label, body, status, code] of cases) {
            const reply = await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body, session: ADMIN_SESSION });
            assert.equal(reply.status, status, label);
            if (code) assert.equal(reply.body.code, code, label);
        }
        world.users.get(uuid(2))!.is_active = false;
        assert.equal((await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: { purpose: 'reset', user_id: uuid(2) }, session: ADMIN_SESSION })).body.code, 'USER_DISABLED');
        assert.equal(world.invites.length, 0, 'none of them left an invite behind');
    });

    it('is refused at the door if the account was made an admin, disabled or removed from the tenant after the link was made', async () => {
        const made = await makeReset();
        world.users.get(uuid(2))!.role = 'platform_admin';
        const promoted = await accept({ token: made.token, password: 'a-brand-new-password' });
        assert.equal(promoted.status, 410, 'an admin\'s password is not replaced by a link');
        assert.equal(world.users.get(uuid(2))!.token_version, 1);
        assert.equal(world.invites[0]!.used_at, null, 'and the refusal rolled the claim back');
        world.users.get(uuid(2))!.role = 'user';
        world.memberships.length = 0;
        assert.equal((await accept({ token: made.token, password: 'a-brand-new-password' })).status, 410, 'no longer a member');
    });

    it('needs a real password and keeps the long session setting', async () => {
        const made = await makeReset();
        assert.equal((await accept({ token: made.token, password: 'short' })).status, 400);
        assert.equal(world.users.get(uuid(2))!.token_version, 1);
        const reply = await accept({ token: made.token, password: 'a-brand-new-password', keepSignedIn: true });
        assert.equal(reply.body.expiresIn, '30d');
    });
});

// ─── revoke and regenerate ───────────────────────────────────────────────────────────────────────

describe('revoke and regenerate', () => {
    it('revoking stops the link at once, and does it only once', async () => {
        const made = await makeInvite();
        const reply = await call(adminRouter, 'DELETE', `/invites/${made.id}`, { session: ADMIN_SESSION });
        assert.equal(reply.status, 200);
        assert.deepEqual([reply.body.revoked, reply.body.already_revoked], [true, false]);
        assert.equal((await peek(made.token)).status, 410);
        assert.equal((await join(made.token)).status, 410);
        assert.equal(usersNamed('nour@example.com').length, 0);

        const again = await call(adminRouter, 'DELETE', `/invites/${made.id}`, { session: ADMIN_SESSION });
        assert.equal(again.status, 200);
        assert.equal(again.body.already_revoked, true);
        assert.equal(world.audits.filter((a) => a.action === AUDIT_ACTIONS.inviteRevoke).length, 1, 'recorded once');
        assert.equal((await call(adminRouter, 'GET', `/tenants/${TENANT}/invites`, { session: ADMIN_SESSION })).body.invites[0].status, 'revoked');
    });

    it('cannot revoke a link somebody already used: the person is in', async () => {
        const made = await makeInvite();
        await join(made.token);
        const reply = await call(adminRouter, 'DELETE', `/invites/${made.id}`, { session: ADMIN_SESSION });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'INVITE_USED');
        assert.equal((await call(adminRouter, 'GET', `/tenants/${TENANT}/invites`, { session: ADMIN_SESSION })).body.invites[0].used_by_email, 'nour@example.com');
    });

    it('answers 404 for an invite that is not there, or an id that is not one', async () => {
        assert.equal((await call(adminRouter, 'DELETE', `/invites/${uuid(9999)}`, { session: ADMIN_SESSION })).status, 404);
        assert.equal((await call(adminRouter, 'DELETE', '/invites/not-a-uuid', { session: ADMIN_SESSION })).status, 404);
        assert.equal((await call(adminRouter, 'POST', `/invites/${uuid(9999)}/regenerate`, { session: ADMIN_SESSION })).status, 404);
    });

    it('regenerating gives a new link for the same person and kills the old one in the same step', async () => {
        const old = await makeInvite({ email: 'person@example.com', role: 'viewer' });
        const reply = await call(adminRouter, 'POST', `/invites/${old.id}/regenerate`, { body: { lang: 'en' }, session: ADMIN_SESSION });
        assert.equal(reply.status, 201, JSON.stringify(reply.body));
        const fresh = reply.body.invite;
        assert.notEqual(fresh.id, old.id);
        assert.notEqual(tokenOf(fresh.url), old.token);
        assert.deepEqual([fresh.email, fresh.role, fresh.purpose, fresh.creator_id], ['person@example.com', 'viewer', 'join', TENANT]);
        assert.equal(reply.body.previous_invite_id, old.id);
        assert.ok(fresh.url.endsWith('&lang=en'));

        assert.equal((await peek(old.token)).status, 410, 'the old link is dead');
        assert.equal((await join(old.token, 'person@example.com')).status, 410);
        assert.equal((await peek(tokenOf(fresh.url))).status, 200, 'the new one opens');
        assert.equal((await join(tokenOf(fresh.url), 'person@example.com')).status, 201);
    });

    it('can regenerate one that expired or was revoked, but not one that was used', async () => {
        const expired = await makeInvite();
        world.invites[0]!.expires_at = new Date(Date.now() - 1000);
        assert.equal((await call(adminRouter, 'POST', `/invites/${expired.id}/regenerate`, { session: ADMIN_SESSION })).status, 201);

        const revoked = await makeInvite();
        await call(adminRouter, 'DELETE', `/invites/${revoked.id}`, { session: ADMIN_SESSION });
        assert.equal((await call(adminRouter, 'POST', `/invites/${revoked.id}/regenerate`, { session: ADMIN_SESSION })).status, 201);

        const used = await makeInvite();
        await join(used.token);
        const refused = await call(adminRouter, 'POST', `/invites/${used.id}/regenerate`, { session: ADMIN_SESSION });
        assert.equal(refused.status, 409);
        assert.equal(refused.body.code, 'INVITE_USED');
    });

    it('leaves the old link alive if the new one cannot be made', async () => {
        const old = await makeInvite();
        world.failNext = { pattern: /^INSERT INTO invites /, error: new Error('the database went away') };
        const reply = await call(adminRouter, 'POST', `/invites/${old.id}/regenerate`, { session: ADMIN_SESSION });
        assert.equal(reply.status, 500);
        assert.equal(world.invites.find((r) => r.id === old.id)!.revoked_at, null, 'the revoke rolled back with it');
        assert.equal((await peek(old.token)).status, 200);
    });
});

// ─── The link and the message ────────────────────────────────────────────────────────────────────

describe('the link and its WhatsApp message', () => {
    it('is built on the saved public address when there is one, not the host the request arrived on', async () => {
        world.settings['app.public_base_url'] = 'https://real.example.org';
        const made = await makeInvite();
        assert.equal(new URL(made.url).origin, 'https://real.example.org');
    });

    it('carries the language in the link and writes the message in it, with the tenant\'s name and the link', async () => {
        const ar = (await makeInvite({ lang: 'ar' })).reply.body.invite;
        assert.ok(ar.url.endsWith('&lang=ar'));
        assert.match(ar.whatsapp_text, /Nour Shop/);
        assert.ok(ar.whatsapp_text.includes(ar.url));
        assert.match(ar.whatsapp_text, /[؀-ۿ]/, 'Arabic');
        const en = (await makeInvite({ lang: 'en' })).reply.body.invite;
        assert.match(en.whatsapp_text, /workspace/);
        assert.doesNotMatch(en.whatsapp_text, /[؀-ۿ]/);
        assert.equal((await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: { lang: 'fr' }, session: ADMIN_SESSION })).status, 400);
    });

    it('uses the operator\'s own template, filling each placeholder once and never re-reading what it wrote', async () => {
        world.settings['onboarding.whatsapp_text'] = 'Hello {inviter}: {name} -> {link}';
        world.settings['onboarding.inviter_name'] = 'Amir';
        world.creators.get(TENANT)!.name = '{link}';
        const made = (await makeInvite()).reply.body.invite;
        assert.equal(made.whatsapp_text, `Hello Amir: {link} -> ${made.url}`, 'a tenant called {link} does not get the link written into its name');
    });

    it('ignores a template with no {link}: a message without the link is useless', async () => {
        world.settings['onboarding.whatsapp_text'] = 'Welcome!';
        const made = (await makeInvite()).reply.body.invite;
        assert.ok(made.whatsapp_text.includes(made.url));
    });

    it('gives a reset link its own sentence, not "your workspace is ready"', async () => {
        world.settings['onboarding.whatsapp_text'] = 'Your workspace is ready: {link}';
        const reset = (await makeInvite({ purpose: 'reset', user_id: uuid(2), lang: 'en' })).reply.body.invite;
        assert.match(reset.whatsapp_text, /new password/);
        assert.doesNotMatch(reset.whatsapp_text, /workspace is ready/);
    });

    it('refuses to make a link it cannot build, before storing anything', async () => {
        const reply = await new Promise<Reply>((resolve) => {
            const req = { method: 'POST', url: `/tenants/${TENANT}/invites`, originalUrl: '/', body: {}, query: {}, params: {}, headers: {}, session: ADMIN_SESSION } as unknown as Request;
            const res = {
                statusCode: 200,
                status(code: number) { (this as any).statusCode = code; return this; },
                json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload, headers: {} }); return this; },
                setHeader() { return this; },
            } as unknown as Response;
            adminRouter(req, res, () => resolve({ status: 0, body: null, headers: {} }));
        });
        assert.equal(reply.status, 500);
        assert.equal(reply.body.code, 'PUBLIC_URL_UNKNOWN');
        assert.equal(world.invites.length, 0, 'no invite nobody could be given');
    });
});

// ─── The throttle ────────────────────────────────────────────────────────────────────────────────

describe('the per-IP throttle', () => {
    const bad = 'B'.repeat(43);

    it('slows an address that keeps presenting links that do not open, on peek and accept alike', async () => {
        const ip = '198.51.100.7';
        for (let i = 0; i < LOGIN_FREE_ATTEMPTS + 1; i += 1) assert.equal((await peek(bad, { ip })).status, 410, `attempt ${i + 1}`);
        const blocked = await peek(bad, { ip });
        assert.equal(blocked.status, 429);
        assert.equal(blocked.body.code, 'RATE_LIMITED');
        assert.ok(Number(blocked.headers['retry-after']) >= 1);
        const alsoBlocked = await accept({ token: bad, email: 'a@b.co', password: PASSWORD }, { ip });
        assert.equal(alsoBlocked.status, 429, 'accept shares the throttle');
    });

    it('is not tripped by a person with a good link, whatever else they get wrong', async () => {
        const ip = '198.51.100.8';
        const made = await makeInvite();
        for (let i = 0; i < 8; i += 1) {
            assert.equal((await peek(made.token, { ip })).status, 200);
            assert.equal((await join(made.token, 'nour@example.com', { password: 'short' }) ).status, 400);
        }
        const reply = await accept({ token: made.token, email: 'nour@example.com', password: PASSWORD }, { ip });
        assert.equal(reply.status, 201);
    });

    it('leaves another address alone', async () => {
        for (let i = 0; i < LOGIN_FREE_ATTEMPTS + 2; i += 1) await peek(bad, { ip: '198.51.100.9' });
        assert.equal((await peek(bad, { ip: '198.51.100.9' })).status, 429);
        assert.equal((await peek(bad, { ip: '198.51.100.10' })).status, 410);
    });

    it('is the login\'s own throttle: failures at the login count here', async () => {
        const ip = '198.51.100.11';
        for (let i = 0; i < LOGIN_FREE_ATTEMPTS + 1; i += 1) recordLoginFailure(ip);
        assert.equal((await peek(bad, { ip })).status, 429);
        clearLoginFailures(ip);
        assert.equal((await peek(bad, { ip })).status, 410);
    });

    it('does not count a link that was taken or a password that was too short against the person', async () => {
        const ip = '198.51.100.12';
        world.addUser(7, 'taken@example.com');
        const made = await makeInvite();
        for (let i = 0; i < 10; i += 1) assert.equal((await accept({ token: made.token, email: 'taken@example.com', password: PASSWORD }, { ip })).status, 409);
        assert.equal((await peek(made.token, { ip })).status, 200);
    });
});

// ─── The trail ───────────────────────────────────────────────────────────────────────────────────

describe('the audit trail', () => {
    it('records create, regenerate, revoke and accept, and none of them holds a token, a hash or a link', async () => {
        const one = await makeInvite({ email: 'one@example.com' });
        const regenerated = await call(adminRouter, 'POST', `/invites/${one.id}/regenerate`, { session: ADMIN_SESSION });
        const second = tokenOf(regenerated.body.invite.url);
        const toRevoke = await makeInvite();
        await call(adminRouter, 'DELETE', `/invites/${toRevoke.id}`, { session: ADMIN_SESSION });
        const accepted = await join(second, 'one@example.com');
        assert.equal(accepted.status, 201);
        const reset = await makeInvite({ purpose: 'reset', user_id: uuid(2) });
        await accept({ token: reset.token, password: 'a-brand-new-password' });
        await call(adminRouter, 'PUT', '/onboarding-settings', { body: { inviterName: 'Amir', whatsappText: 'Hi {link}' }, session: ADMIN_SESSION });

        assert.deepEqual(world.audits.map((a) => a.action), [
            AUDIT_ACTIONS.inviteCreate, AUDIT_ACTIONS.inviteRegenerate, AUDIT_ACTIONS.inviteCreate, AUDIT_ACTIONS.inviteRevoke,
            AUDIT_ACTIONS.inviteAccept, AUDIT_ACTIONS.inviteCreate, AUDIT_ACTIONS.inviteAccept, AUDIT_ACTIONS.settingsOnboardingWrite,
        ]);

        const everything = JSON.stringify(world.audits);
        for (const token of [one.token, second, toRevoke.token, reset.token]) {
            assert.equal(everything.includes(token), false, 'no raw token');
            assert.equal(everything.includes(hashInviteToken(token)), false, 'no hash');
        }
        assert.equal(everything.includes('#/invite'), false, 'no link');
        assert.equal(everything.includes('/dashboard'), false);
        assert.equal(logs.some((line) => [one.token, second, toRevoke.token, reset.token].some((t) => line.includes(t))), false, 'no log line either');
    });

    it('says who and what: the operator for what they made, the person for what they used', async () => {
        const made = await makeInvite({ email: 'person@example.com', role: 'operator' });
        await join(made.token, 'person@example.com');
        const [created, accepted] = world.audits;
        assert.deepEqual([created!.actor_user_id, created!.actor_email, created!.target_type, created!.target_id], [uuid(1), 'admin@example.com', 'invite', made.id]);
        assert.deepEqual([created!.detail.tenant_id, created!.detail.purpose, created!.detail.membership_role, created!.detail.email], [TENANT, 'join', 'operator', 'person@example.com']);
        const person = usersNamed('person@example.com')[0]!;
        assert.deepEqual([accepted!.actor_user_id, accepted!.actor_email, accepted!.target_id], [person.id, 'person@example.com', made.id]);
        assert.deepEqual([accepted!.detail.created_user, accepted!.detail.attached_user, accepted!.detail.sessions_invalidated, accepted!.detail.keep_signed_in], [true, false, false, false]);
    });

    it('records a reset as one that signed everybody out', async () => {
        const reset = await makeInvite({ purpose: 'reset', user_id: uuid(2) });
        await accept({ token: reset.token, password: 'a-brand-new-password' });
        const accepted = world.audits.find((a) => a.action === AUDIT_ACTIONS.inviteAccept)!;
        assert.equal(accepted.detail.sessions_invalidated, true);
        assert.equal(accepted.detail.purpose, 'reset');
    });

    it('writes nothing for a refused attempt', async () => {
        const made = await makeInvite();
        const before = world.audits.length;
        await join(made.token, 'nour@example.com', { password: 'short' });
        await peek('C'.repeat(43));
        await join('C'.repeat(43));
        assert.equal(world.audits.length, before);
    });
});

// ─── Who may make links ──────────────────────────────────────────────────────────────────────────

describe('the admin guard', () => {
    const routes: Array<[string, string, unknown?]> = [
        ['POST', `/tenants/${TENANT}/invites`, {}],
        ['GET', `/tenants/${TENANT}/invites`],
        ['POST', `/invites/${uuid(5000)}/regenerate`, {}],
        ['DELETE', `/invites/${uuid(5000)}`],
        ['GET', '/onboarding-settings'],
        ['PUT', '/onboarding-settings', { sessionDays: 5 }],
    ];

    it('answers 404 to a tenant\'s own owner on every route, and touches nothing', async () => {
        for (const [method, url, body] of routes) {
            const reply = await call(adminRouter, method, url, { body, session: USER_SESSION });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
        assert.equal(world.invites.length, 0);
        assert.deepEqual(world.settings, {});
        assert.equal(world.db.statements.length, 0, 'not one statement ran for them');
        assert.equal(world.audits.length, 0);
    });

    it('answers 404 to a session with no role at all', async () => {
        const reply = await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: {}, session: undefined });
        assert.equal(reply.status, 404);
    });

    it('is behind the sign-in on the real API router: no token is a 401, a tenant owner\'s is a 404', async () => {
        for (const [method, url, body] of routes) {
            assert.equal((await call(apiRouter, method, `/admin${url}`, { body })).status, 401, `${method} ${url}`);
        }
        const token = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        assert.equal((await call(apiRouter, 'POST', `/admin/tenants/${TENANT}/invites`, { body: {}, bearer: token })).status, 404);
        assert.equal(world.invites.length, 0);
    });

    it('leaves the two public routes open, on the real API router, with no session', async () => {
        const made = await makeInvite();
        const opened = await call(apiRouter, 'POST', '/invites/peek', { body: { token: made.token } });
        assert.equal(opened.status, 200);
        assert.equal(opened.body.tenantName, 'Nour Shop');
        const accepted = await call(apiRouter, 'POST', '/invites/accept', { body: { token: made.token, email: 'nour@example.com', password: PASSWORD } });
        assert.equal(accepted.status, 201);
        assert.equal((await call(apiRouter, 'GET', '/invites/peek')).status, 401, 'and nothing else under /invites is');
    });
});

describe('a link goes to the tenant in its path', () => {
    it('does not let a tenant\'s owner invite anybody into another tenant: the route is the operator\'s, and the body cannot redirect it', async () => {
        const asOwner = await call(adminRouter, 'POST', `/tenants/${OTHER_TENANT}/invites`, { body: { creator_id: OTHER_TENANT }, session: USER_SESSION });
        assert.equal(asOwner.status, 404);
        assert.equal(world.invites.length, 0);

        const made = await makeInvite({ creator_id: OTHER_TENANT, tenantId: OTHER_TENANT, tenant_id: OTHER_TENANT });
        assert.equal(world.invites[0]!.creator_id, TENANT, 'made for the tenant in the path');
        assert.equal(made.reply.body.invite.creator_id, TENANT);
    });

    it('answers 404 for a tenant that does not exist, and 409 for one that is switched off', async () => {
        assert.equal((await call(adminRouter, 'POST', `/tenants/${uuid(9999)}/invites`, { body: {}, session: ADMIN_SESSION })).status, 404);
        assert.equal((await call(adminRouter, 'POST', '/tenants/nope/invites', { body: {}, session: ADMIN_SESSION })).status, 404);
        assert.equal((await call(adminRouter, 'GET', `/tenants/${uuid(9999)}/invites`, { session: ADMIN_SESSION })).status, 404);
        world.creators.get(TENANT)!.is_active = false;
        const reply = await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body: {}, session: ADMIN_SESSION });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'TENANT_INACTIVE');
    });

    it('validates what an operator may ask for', async () => {
        const bad: Array<Record<string, unknown>> = [{ role: 'god' }, { purpose: 'both' }, { email: 'not an email' }, { lang: 'fr' }, { ttl_days: 'soon' }];
        for (const body of bad) {
            const reply = await call(adminRouter, 'POST', `/tenants/${TENANT}/invites`, { body, session: ADMIN_SESSION });
            assert.equal(reply.status, 400, JSON.stringify(body));
        }
        assert.equal(world.invites.length, 0);
    });

    it('gives the role the setting names when the request does not, and the setting is validated', async () => {
        assert.equal((await makeInvite()).reply.body.invite.role, 'owner');
        await call(adminRouter, 'PUT', '/onboarding-settings', { body: { defaultRole: 'operator' }, session: ADMIN_SESSION });
        assert.equal((await makeInvite()).reply.body.invite.role, 'operator');
        assert.equal((await makeInvite({ role: 'viewer' })).reply.body.invite.role, 'viewer', 'the request wins');
        const refused = await call(adminRouter, 'PUT', '/onboarding-settings', { body: { defaultRole: 'root' }, session: ADMIN_SESSION });
        assert.equal(refused.status, 400);
        assert.equal(refused.body.field, 'defaultRole');
    });
});

// ─── The login ───────────────────────────────────────────────────────────────────────────────────

describe('the login', () => {
    it('keeps a user signed in for the operator\'s number of days when asked, and for 24 hours when not', async () => {
        const { hashPassword } = await import('../config/crypto.js');
        world.users.get(uuid(2))!.password_hash = await hashPassword(PASSWORD);
        world.addMember(uuid(2), TENANT);
        const plain = await call(apiRouter, 'POST', '/auth/login', { body: { email: 'owner-of-a@example.com', password: PASSWORD } });
        assert.equal(plain.status, 200, JSON.stringify(plain.body));
        assert.equal(plain.body.expiresIn, '24h');
        assert.equal('exp' in decode(plain.body.token), false);

        const kept = await call(apiRouter, 'POST', '/auth/login', { body: { email: 'owner-of-a@example.com', password: PASSWORD, keepSignedIn: true } });
        assert.equal(kept.body.expiresIn, '30d');
        const payload = decode(kept.body.token);
        assert.equal(payload.exp - payload.iat, 30 * 86_400_000);
    });

    it('never gives a platform admin more than 24 hours, whatever the form asks', async () => {
        const { hashPassword } = await import('../config/crypto.js');
        world.users.get(uuid(1))!.password_hash = await hashPassword(PASSWORD);
        const reply = await call(apiRouter, 'POST', '/auth/login', { body: { email: 'admin@example.com', password: PASSWORD, keepSignedIn: true } });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(reply.body.expiresIn, '24h');
        assert.equal('exp' in decode(reply.body.token), false);
    });
});

// ─── The rest of the surface ─────────────────────────────────────────────────────────────────────

describe('what peek says about "keep me signed in"', () => {
    it('is the operator\'s number of days, so the checkbox can say it', async () => {
        const made = await makeInvite();
        assert.equal((await peek(made.token)).body.sessionDays, 30);
        await call(adminRouter, 'PUT', '/onboarding-settings', { body: { sessionDays: 14 }, session: ADMIN_SESSION });
        assert.equal((await peek(made.token)).body.sessionDays, 14);
    });
});

describe('the language of a link', () => {
    it('defaults to the one the tenant writes in, and the request may overrule it', async () => {
        world.profileLanguage.set(TENANT, 'en');
        const fallback = await makeInvite();
        assert.ok(fallback.url.endsWith('&lang=en'), 'from the stored profile');
        assert.equal(fallback.reply.body.invite.lang, 'en');
        const overruled = await makeInvite({ lang: 'ar' });
        assert.ok(overruled.url.endsWith('&lang=ar'));
        world.profileLanguage.set(TENANT, 'fr');
        assert.ok((await makeInvite()).url.endsWith('&lang=ar'), 'anything that is not English is Arabic');
        world.profileLanguage.delete(TENANT);
        assert.ok((await makeInvite()).url.endsWith('&lang=ar'), 'and a tenant with no profile too');
    });

    it('is kept by Regenerate: the new link is in the tenant\'s language unless told otherwise', async () => {
        world.profileLanguage.set(TENANT, 'en');
        const old = await makeInvite();
        const regenerated = await call(adminRouter, 'POST', `/invites/${old.id}/regenerate`, { body: {}, session: ADMIN_SESSION });
        assert.ok(regenerated.body.invite.url.endsWith('&lang=en'));
        assert.match(regenerated.body.invite.whatsapp_text, /workspace/);
    });

    it('is never an error: a profile table that cannot be read gives Arabic', async () => {
        world.db.routes.unshift([/^SELECT profile #>> /, () => { throw Object.assign(new Error('relation "creator_profiles" does not exist'), { code: '42P01' }); }]);
        assert.ok((await makeInvite()).url.endsWith('&lang=ar'));
    });
});

describe('the onboarding settings routes', () => {
    const get = () => call(adminRouter, 'GET', '/onboarding-settings', { session: ADMIN_SESSION });
    const put = (body: unknown) => call(adminRouter, 'PUT', '/onboarding-settings', { body, session: ADMIN_SESSION });

    it('answers the values in force, which are saved and which are defaults, and the limits', async () => {
        const first = await get();
        assert.equal(first.status, 200);
        assert.deepEqual(first.body.settings, {
            inviteTtlDays: 7, resetTtlHours: 24, defaultRole: 'owner', sessionDays: 30, inviterName: null, whatsappText: null, defaultRules: ['no_women_imagery'],
        });
        assert.ok(Object.values(first.body.saved).every((saved) => saved === false), 'nothing saved yet');
        assert.deepEqual(first.body.limits.sessionDays, { min: 1, max: 90, fallback: 30 });
        assert.match(first.body.whatsappDefaults.ar, /\{link\}/);
        assert.match(first.body.whatsappDefaults.en, /\{link\}/);
    });

    it('saves what is sent, marks it saved, and leaves the rest alone', async () => {
        const saved = await put({ inviteTtlDays: 10, inviterName: 'Amir', defaultRules: [] });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal(saved.body.settings.inviteTtlDays, 10);
        assert.equal(saved.body.settings.inviterName, 'Amir');
        assert.deepEqual(saved.body.settings.defaultRules, [], 'a deliberate "none" is kept as one');
        assert.equal(saved.body.settings.sessionDays, 30);
        assert.deepEqual([saved.body.saved.inviteTtlDays, saved.body.saved.inviterName, saved.body.saved.defaultRules, saved.body.saved.sessionDays], [true, true, true, false]);
        assert.deepEqual(world.settings, { 'onboarding.invite_ttl_days': '10', 'onboarding.inviter_name': 'Amir', 'onboarding.default_rules': '[]' });
    });

    it('returns a field to its default when it is sent empty or null', async () => {
        await put({ inviteTtlDays: 10, sessionDays: 5 });
        const cleared = await put({ inviteTtlDays: '', sessionDays: null });
        assert.equal(cleared.body.settings.inviteTtlDays, 7);
        assert.equal(cleared.body.settings.sessionDays, 30);
        assert.deepEqual(world.settings, {});
        const rules = await put({ defaultRules: null });
        assert.deepEqual(rules.body.settings.defaultRules, ['no_women_imagery']);
    });

    it('refuses everything or nothing: one bad field saves none of them, and names the field', async () => {
        const reply = await put({ inviteTtlDays: 5, defaultRole: 'god' });
        assert.equal(reply.status, 400);
        assert.equal(reply.body.field, 'defaultRole');
        assert.deepEqual(world.settings, {}, 'the valid field was not written');
        assert.equal((await put({})).status, 400, 'an empty body is "nothing to save"');
        assert.equal(world.audits.length, 0, 'and a refusal is not recorded as a change');
    });

    it('falls back to the default when a saved value is not usable, instead of failing a create', async () => {
        world.settings['onboarding.invite_ttl_days'] = '9999';
        world.settings['onboarding.default_role'] = 'root';
        world.settings['onboarding.session_days'] = 'soon';
        const made = (await makeInvite()).reply.body.invite;
        assert.equal(made.role, 'owner');
        assert.equal(Math.round((new Date(made.expires_at).getTime() - Date.now()) / 86_400_000), 7);
        const reply = await join(tokenOf(made.url), 'nour@example.com', { keepSignedIn: true });
        assert.equal(reply.body.expiresIn, '30d');
    });

    it('records what changed as field names, and what was reset, never the message or the name', async () => {
        await put({ inviterName: 'Amir', whatsappText: 'Private text {link}', sessionDays: 20 });
        await put({ sessionDays: null });
        const [first, second] = world.audits;
        assert.equal(first!.action, AUDIT_ACTIONS.settingsOnboardingWrite);
        assert.deepEqual(first!.detail, { changed: ['sessionDays', 'inviterName', 'whatsappText'], reset_to_default: [] });
        assert.deepEqual(second!.detail, { changed: [], reset_to_default: ['sessionDays'] });
        assert.equal(JSON.stringify(world.audits).includes('Private text'), false);
        assert.equal(JSON.stringify(world.audits).includes('Amir'), false);
    });
});

describe('a session that was kept 30 days keeps its expiry across the routes that re-mint it', () => {
    it('switching tenant carries the same exp, and the answer says how long is left', async () => {
        world.addMember(uuid(2), OTHER_TENANT);
        const long = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 }, { ttlMs: 30 * 86_400_000 });
        const reply = await call(apiRouter, 'POST', '/auth/switch-tenant', { body: { tenantId: OTHER_TENANT }, bearer: long });
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(decode(reply.body.token).exp, decode(long).exp, 'not restarted');
        assert.equal(decode(reply.body.token).tenantId, OTHER_TENANT);
        assert.equal(reply.body.expiresIn, '30d');
    });

    it('an ordinary session is still an ordinary one after a switch', async () => {
        world.addMember(uuid(2), OTHER_TENANT);
        const plain = createSession({ userId: uuid(2), role: 'user', tenantId: TENANT, tokenVersion: 1 });
        const reply = await call(apiRouter, 'POST', '/auth/switch-tenant', { body: { tenantId: OTHER_TENANT }, bearer: plain });
        assert.equal('exp' in decode(reply.body.token), false);
        assert.equal(reply.body.expiresIn, '24h');
    });
});
