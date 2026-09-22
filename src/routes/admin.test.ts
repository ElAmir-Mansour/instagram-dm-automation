/**
 * The admin router's gate and its validation.
 *
 * Driven by calling the router directly with a plain request object, so there is no server and
 * no database. That bounds what can be covered here to the decisions made *before* any SQL
 * runs — which is deliberately where the entire security surface lives:
 *
 *   - the role gate, which must 404 (not 403) for everyone who is not a platform_admin, on
 *     every route, because confirming this surface exists is itself a disclosure;
 *   - every validation refusal, including the one that matters most: there is no request body
 *     that erases a person without a preview token.
 *
 * The SQL these routes run was verified separately, against a throwaway local Postgres with
 * all fifteen migrations applied. The lockout guard, the page-id rules and the erasure token
 * are unit-tested in src/services/{adminGuards,erasure}.test.ts.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Request, Response } from 'express';
import adminRouter from './admin.js';

interface Reply {
    status: number;
    body: any;
    /** True when no route matched and the request fell out of the router. */
    fellThrough?: boolean;
}

type Session = { userId: string | null; role: string; tenantId: string | null; tokenVersion: number };

const ADMIN: Session = { userId: null, role: 'platform_admin', tenantId: 't-1', tokenVersion: 0 };
const NOT_ADMIN: Session = { userId: 'u-1', role: 'user', tenantId: 't-1', tokenVersion: 1 };

const UUID = '11111111-1111-4111-8111-111111111111';

/** Call the router as Express would, with nothing mounted above it. */
function call(
    method: string,
    url: string,
    opts: { session?: Session; body?: unknown; query?: Record<string, unknown> } = {}
): Promise<Reply> {
    return new Promise((resolve) => {
        const req = {
            method: method.toUpperCase(),
            url,
            originalUrl: url,
            body: opts.body ?? {},
            // Express populates this at the application level, not in a bare router.
            query: opts.query ?? {},
            params: {},
            headers: {},
            session: opts.session,
        } as unknown as Request;

        const res = {
            statusCode: 200,
            status(code: number) { (this as any).statusCode = code; return this; },
            json(body: unknown) { resolve({ status: (this as any).statusCode, body }); return this; },
            setHeader() { return this; },
        } as unknown as Response;

        adminRouter(req, res, () => resolve({ status: 0, body: null, fellThrough: true }));
    });
}

/** Every route this router serves, with an input that is valid enough to reach the handler. */
const ROUTES: Array<[string, string, Record<string, unknown>?]> = [
    ['GET', '/ops'],
    ['GET', '/tenants'],
    ['POST', '/tenants'],
    ['GET', `/tenants/${UUID}`],
    ['PATCH', `/tenants/${UUID}`],
    ['POST', `/tenants/${UUID}/recheck-token`],
    ['GET', '/users'],
    ['POST', '/users'],
    ['PATCH', `/users/${UUID}`],
    ['POST', `/users/${UUID}/password`],
    ['POST', `/users/${UUID}/revoke`],
    ['POST', `/users/${UUID}/memberships`],
    ['DELETE', `/users/${UUID}/memberships/${UUID}`],
    ['GET', '/jobs'],
    ['POST', `/jobs/${UUID}/retry`],
    ['POST', `/jobs/${UUID}/cancel`],
    ['GET', '/erasure/preview', { handle: 'someone' }],
    ['POST', '/erasure'],
    ['GET', '/audit'],
];

describe('the platform_admin gate', () => {
    it('404s every route for a non-admin session', async () => {
        for (const [method, url, query] of ROUTES) {
            const reply = await call(method, url, { session: NOT_ADMIN, query });

            assert.equal(reply.status, 404, `${method} ${url}`);
            assert.deepEqual(reply.body, { error: 'Not found.' }, `${method} ${url}`);
        }
    });

    it('404s every route when there is no session at all', async () => {
        // requireAuth runs above this router in api.ts, so this should be unreachable — which
        // is exactly why it is asserted: a guard that depends on a caller is one refactor away
        // from being no guard.
        for (const [method, url, query] of ROUTES) {
            const reply = await call(method, url, { query });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
    });

    it('gives a non-admin the same answer for a route that does not exist', async () => {
        // The disclosure this prevents: if a real route answered 403 and a made-up one 404,
        // the difference would map the surface.
        const real = await call('GET', '/ops', { session: NOT_ADMIN });
        const invented = await call('GET', '/there-is-no-such-endpoint', { session: NOT_ADMIN });

        assert.deepEqual(real, invented);
    });

    it('does not 404 an admin on those same routes', async () => {
        // The gate must not be so broad that it hides the surface from its own audience. Only
        // the routes that refuse before touching SQL can be checked without a database.
        const reply = await call('POST', '/tenants', { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /instagram_page_id is required/);
    });
});

describe('tenant validation', () => {
    it('requires a page id and a token to create one', async () => {
        assert.match((await call('POST', '/tenants', { session: ADMIN, body: {} })).body.error,
            /instagram_page_id is required/);

        assert.match((await call('POST', '/tenants', {
            session: ADMIN, body: { instagram_page_id: '17841400000000000' },
        })).body.error, /page_access_token is required/);
    });

    it('rejects a page id that is not a Meta page id', async () => {
        const reply = await call('POST', '/tenants', {
            session: ADMIN,
            body: { instagram_page_id: 'https://instagram.com/someone', page_access_token: 'x' },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /not a valid Meta page id/);
    });

    it('404s a tenant id that is not a uuid, rather than querying for it', async () => {
        for (const [method, url] of [
            ['GET', '/tenants/not-a-uuid'],
            ['PATCH', '/tenants/not-a-uuid'],
            ['POST', '/tenants/not-a-uuid/recheck-token'],
        ] as const) {
            const reply = await call(method, url, { session: ADMIN, body: { name: 'x' } });
            assert.equal(reply.status, 404, `${method} ${url}`);
        }
    });

    it('refuses an empty PATCH rather than reporting a no-op as success', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Nothing to update/);
        // The message must list what IS accepted, which is the whole point of widening it.
        assert.match(reply.body.error, /instagram_page_id/);
        assert.match(reply.body.error, /webhook_verify_token/);
    });

    it('refuses to blank the page id every webhook is routed by', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, {
            session: ADMIN, body: { instagram_page_id: null },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /every webhook/);
    });

    it('validates the verify token the same way the settings route does', async () => {
        const reply = await call('PATCH', `/tenants/${UUID}`, {
            session: ADMIN, body: { webhook_verify_token: 'short' },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /at least 8 characters/);
    });
});

describe('user validation', () => {
    it('requires a valid email and a long enough password', async () => {
        assert.match((await call('POST', '/users', { session: ADMIN, body: { email: 'nope' } })).body.error,
            /valid email/);

        assert.match((await call('POST', '/users', {
            session: ADMIN, body: { email: 'a@b.co', password: 'short' },
        })).body.error, /at least 12 characters/);
    });

    it('rejects a role that is not one of the two the schema means', async () => {
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: { role: 'admin' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /'user' or 'platform_admin'/);
    });

    it('rejects a non-boolean is_active rather than coercing it', async () => {
        // `is_active: "false"` is truthy. Coercing it would switch an account ON when the
        // caller meant off.
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: { is_active: 'false' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /must be a boolean/);
    });

    it('refuses an empty user PATCH', async () => {
        const reply = await call('PATCH', `/users/${UUID}`, { session: ADMIN, body: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Nothing to update/);
    });

    it('404s a membership revoke whose ids are not uuids', async () => {
        const reply = await call('DELETE', '/users/nope/memberships/also-nope', { session: ADMIN });

        assert.equal(reply.status, 404);
    });
});

describe('membership role validation', () => {
    it('refuses a role outside the vocabulary', async () => {
        // `role` used to be stored verbatim, because nothing read it. It is an authorization
        // decision now, and `normalizeTenantRole` resolves anything it does not recognise to
        // `owner` — so a typo would silently grant everything to the person an operator was
        // deliberately restricting. Failing open is right for existing data and wrong for a
        // value somebody is typing right now.
        // `'viewer '` is deliberately absent: surrounding whitespace is trimmed, the same
        // leniency every other string field here applies to a pasted value. Case is NOT,
        // because 'Owner' is a different string and guessing at intent is how a restriction
        // becomes a grant.
        for (const role of ['member', 'admin', 'Owner', 'read-only', 42, {}]) {
            const reply = await call('POST', `/users/${UUID}/memberships`, {
                session: ADMIN, body: { creator_id: UUID, role },
            });

            assert.equal(reply.status, 400, `role ${JSON.stringify(role)}`);
            assert.match(reply.body.error, /owner, operator, viewer/);
        }
    });

    it('still defaults to owner when no role is named', async () => {
        // The grant call that existed before roles meant anything sent no role at all, and it
        // must keep granting exactly what it granted then. Reaching SQL — which this suite has
        // no database for — is the pass condition: the refusals above all answer before it.
        const reply = await call('POST', `/users/${UUID}/memberships`, {
            session: ADMIN, body: { creator_id: UUID },
        });

        assert.notEqual(reply.status, 400, 'an unspecified role is not a validation failure');
    });
});

describe('job validation', () => {
    it('rejects an unknown status filter and lists the real ones', async () => {
        const reply = await call('GET', '/jobs', { session: ADMIN, query: { status: 'broken' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /pending, running, done, failed, cancelled/);
    });

    it('404s a job id that is not a uuid', async () => {
        for (const url of [`/jobs/nope/retry`, `/jobs/nope/cancel`]) {
            assert.equal((await call('POST', url, { session: ADMIN })).status, 404, url);
        }
    });
});

describe('erasure', () => {
    it('cannot be triggered without a preview token', async () => {
        // The invariant this whole design exists for: POST accepts a token and nothing else,
        // so no combination of body fields spells "delete this handle" in one request.
        for (const body of [
            {},
            { handle: 'someone' },
            { handle: 'someone', confirm: true },
            { token: null },
            { token: '' },
            { token: 'made-up' },
            { token: { forged: true } },
        ]) {
            const reply = await call('POST', '/erasure', { session: ADMIN, body });

            assert.equal(reply.status, 400, JSON.stringify(body));
            assert.equal(reply.body.code, 'INVALID_TOKEN', JSON.stringify(body));
            // And the message has to say what to do instead.
            assert.match(reply.body.error, /preview/i, JSON.stringify(body));
        }
    });

    it('requires a handle to preview, and says what a handle is', async () => {
        const reply = await call('GET', '/erasure/preview', { session: ADMIN, query: {} });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /username or the numeric user id/);
    });

    it('refuses an absurdly long handle before it becomes a query', async () => {
        const reply = await call('GET', '/erasure/preview', {
            session: ADMIN, query: { handle: 'x'.repeat(300) },
        });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /longer than 255/);
    });
});

describe('audit', () => {
    it('rejects an unknown action filter rather than answering "nothing happened"', async () => {
        // An empty list in response to a typo reads as "no privileged actions have occurred",
        // which is the opposite of what an auditor needs to hear.
        const reply = await call('GET', '/audit', { session: ADMIN, query: { action: 'tenant.updated' } });

        assert.equal(reply.status, 400);
        assert.match(reply.body.error, /Unknown action filter/);
    });
});
