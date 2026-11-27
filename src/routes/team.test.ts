/**
 * Team (U3, CO-2): `/api/team` and `/api/account/sign-out-everywhere`.
 *
 * Run through the real routers over the in-memory invite world (`services/invites/testDb.ts`), whose statements answer by SQL, so a rule
 * taken out of a query stops holding here too. What is pinned:
 *
 *   - the guard: every route is the workspace owner's; an operator and a viewer are refused with 403 before anything is read;
 *   - LAST_OWNER, on a demotion and on a removal, and that it is the LAST OWNER OF THE WORKSPACE'S OWN: a platform admin is not counted;
 *   - MEMBER_IS_ADMIN and MEMBER_NOT_FOUND; a role outside the three is ROLE_INVALID;
 *   - another workspace's invite id is a 404 on regenerate and revoke, and its member is a 404 on role, remove and reset link;
 *   - a removed member's next request to the workspace is a 404 (`resolveTenantAccess`), and their other workspace is untouched;
 *   - a reset link is `purpose: 'reset'`, for a member of this workspace only;
 *   - the audit rows (`via: 'team'`), and that no link, token or hash is in an audit row or a log line;
 *   - sign out everywhere bumps `token_version`, answers a token carrying the new one, audits it, and refuses the shared password with 400.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import { verifySession } from '../middleware/auth.js';
import { installInviteWorld, uuid, type InviteWorld } from '../services/invites/testDb.js';
import { resolveTenantAccess } from '../services/tenant.js';
import { setLogSink } from '../utils/log.js';
import { accountRouter } from './account.js';
import { teamRouter } from './team.js';

interface Reply { status: number; body: any }

function call(router: unknown, method: string, url: string, options: { body?: unknown; session?: Record<string, unknown> } = {}): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method: method.toUpperCase(), url, originalUrl: url, body: options.body, query: {}, params: {},
            headers: { host: 'app.example.test', 'x-forwarded-proto': 'https' }, session: options.session, socket: { remoteAddress: '203.0.113.9' },
        } as unknown as Request;
        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
            setHeader() { return this; },
        } as unknown as Response;
        (router as (r: Request, s: Response, n: () => void) => void)(req, res, () => resolve({ status: 0, body: { fellThrough: true } }));
    });
}

const TENANT = uuid(100);
const OTHER = uuid(101);
const session = (n: number, tenantId = TENANT, role = 'user') => ({ userId: uuid(n), role, tenantId, tokenVersion: 1 });

let world: InviteWorld;
let logs: string[];
let restoreSink: (() => void) | undefined;

beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = 'dashboard-password';
    process.env.META_APP_SECRET = 'meta-app-secret';
    delete process.env.PUBLIC_BASE_URL;
    world = installInviteWorld();
    world.addCreator(100, 'Knowledge Hub');
    world.addCreator(101, 'Other Co');
    world.addUser(1, 'admin@example.com', { role: 'platform_admin' });
    world.addUser(2, 'sara@example.com');                 // the owner
    world.addUser(3, 'ahmed@example.com');                // an operator
    world.addUser(4, 'mona@example.com');                 // a viewer
    world.addUser(5, 'second-owner@example.com');
    world.addUser(6, 'stranger@example.com');             // a member of OTHER only
    world.addMember(uuid(2), TENANT, 'owner');
    world.addMember(uuid(3), TENANT, 'operator');
    world.addMember(uuid(4), TENANT, 'viewer');
    world.addMember(uuid(1), TENANT, 'owner');            // the account manager, an "owner" row that must not count
    world.addMember(uuid(6), OTHER, 'owner');
    world.addMember(uuid(3), OTHER, 'viewer');            // ahmed is in two workspaces
    logs = [];
    const previous = setLogSink((_level, line) => { logs.push(line); });
    restoreSink = () => setLogSink(previous);
});

afterEach(() => {
    world.restore();
    restoreSink?.();
});

const owner = { session: session(2) };
const roleOf = (userId: string, tenant = TENANT) => world.memberships.find((m) => m.user_id === userId && m.creator_id === tenant)?.role;

describe('Team: the guard', () => {
    const routes: Array<[string, string, unknown?]> = [
        ['GET', '/'],
        ['POST', '/invites', { role: 'viewer' }],
        ['POST', `/invites/${uuid(5000)}/regenerate`],
        ['DELETE', `/invites/${uuid(5000)}`],
        ['PATCH', `/members/${uuid(4)}`, { role: 'operator' }],
        ['DELETE', `/members/${uuid(4)}`],
        ['POST', `/members/${uuid(4)}/reset-link`],
    ];
    for (const [method, url, body] of routes) {
        for (const who of [3, 4]) {
            it(`${method} ${url.replace(uuid(5000), ':id').replace(uuid(4), ':userId')} is refused for ${who === 3 ? 'an operator' : 'a viewer'}, and nothing is read or written`, async () => {
                const before = JSON.stringify([world.memberships, world.invites]);
                const reply = await call(teamRouter, method, url, { body, session: session(who) });
                assert.equal(reply.status, 403);
                assert.equal(JSON.stringify([world.memberships, world.invites]), before);
                assert.equal(world.audits.length, 0);
            });
        }
    }
    it('the platform admin acting in the workspace is an owner of it', async () => {
        const reply = await call(teamRouter, 'GET', '/', { session: session(1, TENANT, 'platform_admin') });
        assert.equal(reply.status, 200);
    });
});

describe('Team: the list', () => {
    it('lists the people, owners first, marks you and the account manager, and the newest invites without a link', async () => {
        const made = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'viewer', email: 'new@example.com' } });
        assert.equal(made.status, 201);
        const reply = await call(teamRouter, 'GET', '/', owner);
        assert.equal(reply.status, 200);
        const members = reply.body.members as Array<Record<string, any>>;
        assert.deepEqual(members.map((m) => m.email), ['admin@example.com', 'sara@example.com', 'ahmed@example.com', 'mona@example.com']);
        assert.equal(members.find((m) => m.email === 'sara@example.com')!.you, true);
        assert.equal(members.filter((m) => m.you).length, 1);
        assert.equal(members.find((m) => m.email === 'admin@example.com')!.accountManager, true);
        assert.equal(members.find((m) => m.email === 'ahmed@example.com')!.role, 'operator');
        assert.equal(reply.body.invites.length, 1);
        assert.equal(reply.body.invites[0].email, 'new@example.com');
        assert.equal('url' in reply.body.invites[0], false, 'the link exists only in the answer that made it');
        assert.equal(JSON.stringify(reply.body).includes('token'), false);
    });

    it('never lists another workspace\'s people', async () => {
        const reply = await call(teamRouter, 'GET', '/', owner);
        assert.equal((reply.body.members as Array<{ email: string }>).some((m) => m.email === 'stranger@example.com'), false);
    });
});

describe('Team: LAST_OWNER', () => {
    it('refuses to demote the only owner of its own, even though an account manager holds an owner row', async () => {
        const reply = await call(teamRouter, 'PATCH', `/members/${uuid(2)}`, { ...owner, body: { role: 'operator' } });
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'LAST_OWNER');
        assert.equal(roleOf(uuid(2)), 'owner');
        assert.equal(world.audits.length, 0, 'a refused change is not a change');
    });

    it('refuses to remove the only owner of its own', async () => {
        const reply = await call(teamRouter, 'DELETE', `/members/${uuid(2)}`, owner);
        assert.equal(reply.status, 409);
        assert.equal(reply.body.code, 'LAST_OWNER');
        assert.equal(roleOf(uuid(2)), 'owner');
    });

    it('allows both once there is a second owner, and the second one is then the last', async () => {
        world.addMember(uuid(5), TENANT, 'owner');
        const demoted = await call(teamRouter, 'PATCH', `/members/${uuid(2)}`, { ...owner, body: { role: 'viewer' } });
        assert.equal(demoted.status, 200);
        assert.equal(roleOf(uuid(2)), 'viewer');
        // sara is a viewer now: the remaining owner (second-owner) is the one acting.
        const second = { session: session(5) };
        const last = await call(teamRouter, 'DELETE', `/members/${uuid(5)}`, second);
        assert.equal(last.status, 409);
        assert.equal(last.body.code, 'LAST_OWNER');
        const removed = await call(teamRouter, 'DELETE', `/members/${uuid(2)}`, second);
        assert.equal(removed.status, 200);
        assert.equal(roleOf(uuid(2)), undefined);
    });

    it('counts a legacy role as an owner, the way resolveTenant reads it', async () => {
        world.addMember(uuid(5), TENANT, 'member');
        const reply = await call(teamRouter, 'PATCH', `/members/${uuid(2)}`, { ...owner, body: { role: 'operator' } });
        assert.equal(reply.status, 200, 'the legacy "member" row is an owner, so sara is not the last one');
    });

    it('an owner may "change" their own role to owner: nothing is written, nothing is audited', async () => {
        const reply = await call(teamRouter, 'PATCH', `/members/${uuid(2)}`, { ...owner, body: { role: 'owner' } });
        assert.equal(reply.status, 200);
        assert.equal(world.audits.length, 0);
    });
});

describe('Team: the other refusals', () => {
    it('the account manager is read-only: MEMBER_IS_ADMIN on role, remove and reset link', async () => {
        for (const [method, url, body] of [
            ['PATCH', `/members/${uuid(1)}`, { role: 'viewer' }], ['DELETE', `/members/${uuid(1)}`, undefined], ['POST', `/members/${uuid(1)}/reset-link`, {}],
        ] as const) {
            const reply = await call(teamRouter, method, url, { ...owner, body });
            assert.equal(reply.status, 409, `${method} ${url}`);
            assert.equal(reply.body.code, 'MEMBER_IS_ADMIN');
        }
        assert.equal(roleOf(uuid(1)), 'owner');
    });

    it('a person of another workspace, or nobody, is MEMBER_NOT_FOUND (404) on role, remove and reset link', async () => {
        for (const id of [uuid(6), uuid(999), 'not-a-uuid']) {
            for (const [method, suffix, body] of [['PATCH', '', { role: 'viewer' }], ['DELETE', '', undefined], ['POST', '/reset-link', {}]] as const) {
                const reply = await call(teamRouter, method, `/members/${id}${suffix}`, { ...owner, body });
                assert.equal(reply.status, 404, `${method} ${id}${suffix}`);
                assert.equal(reply.body.code, 'MEMBER_NOT_FOUND');
            }
        }
        assert.equal(roleOf(uuid(6), OTHER), 'owner', 'the other workspace is untouched');
    });

    it('a role outside owner, operator and viewer is ROLE_INVALID, on a change and on an invite', async () => {
        const change = await call(teamRouter, 'PATCH', `/members/${uuid(4)}`, { ...owner, body: { role: 'admin' } });
        assert.equal(change.status, 400);
        assert.equal(change.body.code, 'ROLE_INVALID');
        const invite = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'god' } });
        assert.equal(invite.status, 400);
        assert.equal(invite.body.code, 'ROLE_INVALID');
        assert.equal(roleOf(uuid(4)), 'viewer');
        assert.equal(world.invites.length, 0);
    });
});

describe('Team: changing a role and removing a person', () => {
    it('changes a role and audits it, with via team and without any link', async () => {
        const reply = await call(teamRouter, 'PATCH', `/members/${uuid(4)}`, { ...owner, body: { role: 'operator' } });
        assert.deepEqual(reply.body, { userId: uuid(4), role: 'operator' });
        assert.equal(roleOf(uuid(4)), 'operator');
        const row = world.audits.find((a) => a.action === 'membership.role_change')!;
        assert.deepEqual(row.detail, { user_id: uuid(4), creator_id: TENANT, from: 'viewer', to: 'operator', via: 'team' });
    });

    it('removes a person: the row goes, the audit says so, and the person\'s other workspace stays', async () => {
        const reply = await call(teamRouter, 'DELETE', `/members/${uuid(3)}`, owner);
        assert.deepEqual(reply.body, { userId: uuid(3), removed: true, you: false });
        assert.equal(roleOf(uuid(3)), undefined);
        assert.equal(roleOf(uuid(3), OTHER), 'viewer');
        assert.ok(world.users.has(uuid(3)), 'the account itself stays');
        const row = world.audits.find((a) => a.action === 'membership.revoke')!;
        assert.deepEqual(row.detail, { user_id: uuid(3), creator_id: TENANT, membership_role: 'operator', via: 'team' });
    });

    it('their next request to the workspace is a 404: resolveTenant re-reads the membership, so there is no token bump', async () => {
        const live = { userId: uuid(3), role: 'user', tenantId: TENANT };
        assert.equal((await resolveTenantAccess(live)).allowed, true);
        const version = world.users.get(uuid(3))!.token_version;
        await call(teamRouter, 'DELETE', `/members/${uuid(3)}`, owner);
        assert.equal((await resolveTenantAccess(live)).allowed, false);
        assert.equal(world.users.get(uuid(3))!.token_version, version, 'their other workspace keeps its sessions');
    });

    it('an owner who removes themselves (a second owner exists) is told it was them', async () => {
        world.addMember(uuid(5), TENANT, 'owner');
        const reply = await call(teamRouter, 'DELETE', `/members/${uuid(2)}`, owner);
        assert.equal(reply.body.you, true);
    });
});

describe('Team: invites and reset links', () => {
    it('invites by role, once, with the one link, audited as via team and recorded as the tenant\'s own', async () => {
        const reply = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'operator', email: 'Nour@Example.com', lang: 'en' } });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.invite.role, 'operator');
        assert.equal(reply.body.invite.email, 'nour@example.com');
        assert.equal(reply.body.invite.purpose, 'join');
        assert.equal(reply.body.invite.lang, 'en');
        assert.ok(reply.body.invite.url.startsWith('https://app.example.test/dashboard#/invite?t='));
        assert.equal(world.invites.length, 1);
        assert.equal(world.invites[0]!.creator_id, TENANT, 'the workspace is the session\'s, never the body\'s');
        const row = world.audits.find((a) => a.action === 'invite.create')!;
        assert.equal(row.detail.via, 'team');
        assert.equal(JSON.stringify(row.detail).includes('#/invite'), false, 'no link in the audit row');
        assert.deepEqual(world.events.map((e) => [e.event, e.actor]), [['invite_created', 'tenant']]);
    });

    it('a bad email is a 400 and creates nothing; a bad language too', async () => {
        const email = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'viewer', email: 'nope' } });
        assert.equal(email.status, 400);
        assert.equal(email.body.code, 'BAD_EMAIL');
        const lang = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'viewer', lang: 'fr' } });
        assert.equal(lang.status, 400);
        assert.equal(world.invites.length, 0);
    });

    it('another workspace\'s invite is a 404 to regenerate and to revoke, and stays exactly as it was', async () => {
        const theirs = await call(teamRouter, 'POST', '/invites', { session: session(6, OTHER), body: { role: 'viewer' } });
        assert.equal(theirs.status, 201);
        const id = theirs.body.invite.id as string;
        const regen = await call(teamRouter, 'POST', `/invites/${id}/regenerate`, owner);
        assert.equal(regen.status, 404);
        const revoke = await call(teamRouter, 'DELETE', `/invites/${id}`, owner);
        assert.equal(revoke.status, 404);
        assert.equal(world.invites.length, 1);
        assert.equal(world.invites[0]!.revoked_at, null);
    });

    it('regenerates its own invite (the old link stops, a new one is made) and revokes it', async () => {
        const made = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'viewer' } });
        const id = made.body.invite.id as string;
        const regen = await call(teamRouter, 'POST', `/invites/${id}/regenerate`, owner);
        assert.equal(regen.status, 201);
        assert.equal(regen.body.previous_invite_id, id);
        assert.notEqual(regen.body.invite.url, made.body.invite.url);
        assert.ok(world.invites.find((r) => r.id === id)!.revoked_at, 'the old one is revoked');
        const revoke = await call(teamRouter, 'DELETE', `/invites/${regen.body.invite.id}`, owner);
        assert.deepEqual([revoke.body.revoked, revoke.body.already_revoked], [true, false]);
        const again = await call(teamRouter, 'DELETE', `/invites/${regen.body.invite.id}`, owner);
        assert.equal(again.body.already_revoked, true);
        assert.deepEqual(world.audits.map((a) => a.action), ['invite.create', 'invite.regenerate', 'invite.revoke']);
        assert.ok(world.audits.every((a) => a.detail.via === 'team'));
    });

    it('a reset link is purpose reset, for a member of this workspace, and carries that person\'s address', async () => {
        const reply = await call(teamRouter, 'POST', `/members/${uuid(3)}/reset-link`, { ...owner, body: { lang: 'ar' } });
        assert.equal(reply.status, 201);
        assert.equal(reply.body.invite.purpose, 'reset');
        assert.equal(reply.body.invite.email, 'ahmed@example.com');
        assert.equal(reply.body.invite.user_id, uuid(3));
        assert.equal(world.invites[0]!.creator_id, TENANT);
    });

    it('no link, token or hash reaches a log line or an audit row', async () => {
        const reply = await call(teamRouter, 'POST', '/invites', { ...owner, body: { role: 'viewer' } });
        const token = new URLSearchParams(new URL(reply.body.invite.url).hash.split('?')[1]).get('t')!;
        const haystack = JSON.stringify(world.audits) + logs.join('\n') + JSON.stringify(world.invites.map((r) => r.token_hash));
        assert.equal(haystack.includes(token), false);
    });
});

describe('Sign out everywhere', () => {
    it('bumps token_version, answers a fresh token carrying it, and audits it as self service', async () => {
        const before = world.users.get(uuid(2))!.token_version;
        const reply = await call(accountRouter, 'POST', '/sign-out-everywhere', { session: { ...session(2), exp: Date.now() + 3_600_000 } });
        assert.equal(reply.status, 200);
        assert.equal(world.users.get(uuid(2))!.token_version, before + 1);
        const verified = verifySession(reply.body.token);
        assert.equal(verified?.tokenVersion, before + 1);
        assert.equal(verified?.userId, uuid(2));
        const row = world.audits.find((a) => a.action === 'user.sessions_revoke')!;
        assert.deepEqual(row.detail, { self_service: true });
        assert.equal(JSON.stringify(world.audits).includes(reply.body.token), false);
    });

    it('is a 400 NO_USER_ACCOUNT, never a 401, for the shared dashboard password', async () => {
        const reply = await call(accountRouter, 'POST', '/sign-out-everywhere', { session: { userId: null, role: 'platform_admin', tenantId: TENANT } });
        assert.equal(reply.status, 400);
        assert.equal(reply.body.code, 'NO_USER_ACCOUNT');
    });
});
