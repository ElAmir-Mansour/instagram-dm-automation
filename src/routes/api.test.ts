/**
 * The CSV export's tenant binding.
 *
 * GET /api/interactions/export runs above the auth boundary — a browser navigation cannot
 * carry an Authorization header — so it has no session to read a tenant from. The tenant
 * therefore travels in the download token as `<tenantId>~<one-shot token>`, where the token is
 * minted over a path key containing that same tenant id.
 *
 * What these tests are actually for: proving that rewriting the tenant half of that string
 * does not hand you another tenant's interactions. That is the one place in this codebase
 * where a tenant id is taken from a URL.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { Request, Response } from 'express';
import {
    consumeDownloadToken, createDownloadToken, createLegacySession, requireAuth,
} from '../middleware/auth.js';
import { requireLiveSession, resolveTenant } from '../services/tenant.js';
import adminRouter from './admin.js';
import apiRouter, {
    exportScopeFor, formatPublishedIds, parseExportDownload, publishedPlatforms,
    unsupportedPlatformCombination,
} from './api.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** What the authenticated half of the export hands to the dashboard. */
function mintDownload(tenantId: string): string {
    return `${tenantId}~${createDownloadToken(exportScopeFor(tenantId))}`;
}

function setEnv(key: string, value: string | undefined): void {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

describe('export download binding', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    it('round-trips the tenant it was minted for', () => {
        const parsed = parseExportDownload(mintDownload(TENANT_A));

        assert.ok(parsed);
        assert.equal(parsed.tenantId, TENANT_A);
        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), true);
    });

    it('refuses a token whose tenant half was swapped for another tenant', () => {
        // The attack this exists to stop: log in as A, edit the id in the URL, export B.
        const token = mintDownload(TENANT_A).split('~')[1];
        const parsed = parseExportDownload(`${TENANT_B}~${token}`);

        assert.ok(parsed);
        assert.equal(parsed.tenantId, TENANT_B, 'the id is taken at face value...');
        assert.equal(
            consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)),
            false,
            '...but the signature was made over tenant A, so it no longer verifies'
        );
    });

    it('still burns after a single use', () => {
        const parsed = parseExportDownload(mintDownload(TENANT_A))!;

        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), true);
        assert.equal(consumeDownloadToken(parsed.token, exportScopeFor(parsed.tenantId)), false);
    });

    it('rejects anything that is not <uuid>~<token>', () => {
        for (const raw of [
            undefined, null, 42, {}, '',
            'no-separator',
            '~leading-separator',
            `${TENANT_A}~`,                 // no token
            `not-a-uuid~${'a'.repeat(10)}`, // tenant half must be a uuid
        ]) {
            assert.equal(parseExportDownload(raw), null, `input ${JSON.stringify(raw)}`);
        }
    });

    it('keeps the tenant inside the signed path key', () => {
        // If two tenants shared a scope string, either token would verify for both.
        assert.notEqual(exportScopeFor(TENANT_A), exportScopeFor(TENANT_B));
        assert.equal(exportScopeFor(TENANT_A).includes(TENANT_A), true);
    });
});

/**
 * The partial-publish bug, which is the one on this branch with a consequence that cannot be
 * undone: a duplicate post on a live Instagram or Facebook account.
 *
 * `platform: 'both'` publishes Facebook first. A Facebook success followed by an Instagram
 * failure used to throw away the Facebook post id and record the row as FAILED — so the post
 * was live, the dashboard said it was not, and editing the row (which flips FAILED back to
 * PENDING) republished it to Facebook a second time.
 */
describe('publishedPlatforms', () => {
    it('reads back both ids from the string the publisher writes', () => {
        assert.deepEqual(publishedPlatforms('FB:123 | IG:456'), { fb: '123', ig: '456' });
    });

    it('reads back a single-platform publish', () => {
        assert.deepEqual(publishedPlatforms('FB:123'), { fb: '123', ig: null });
        assert.deepEqual(publishedPlatforms('IG:456'), { fb: null, ig: '456' });
    });

    it('handles the Facebook composite id format', () => {
        // Facebook returns page-scoped ids as `<pageId>_<postId>`, which contains an
        // underscore and no space — the id must survive intact or the skip check misfires.
        assert.deepEqual(publishedPlatforms('FB:102938_5566'), { fb: '102938_5566', ig: null });
    });

    it('finds nothing in an empty or absent value, so a fresh post publishes normally', () => {
        for (const raw of [null, undefined, '', 42, {}, 'FAILED']) {
            assert.deepEqual(publishedPlatforms(raw), { fb: null, ig: null },
                `input ${JSON.stringify(raw)}`);
        }
    });

    it('does not mistake an id containing FB: for a platform marker', () => {
        // `IG:` must be matched at a boundary, not anywhere in the string.
        assert.deepEqual(publishedPlatforms('IG:abcFB:def'), { fb: null, ig: 'abcFB:def' });
    });
});

describe('formatPublishedIds', () => {
    it('round-trips through publishedPlatforms', () => {
        for (const [fb, ig] of [['1', '2'], ['1', null], [null, '2']] as [string | null, string | null][]) {
            assert.deepEqual(publishedPlatforms(formatPublishedIds(fb, ig)), { fb, ig });
        }
    });

    it('is empty when nothing was published', () => {
        assert.equal(formatPublishedIds(null, null), '');
    });
});

describe('unsupportedPlatformCombination', () => {
    it('rejects a story aimed at Facebook, where it silently cannot work', () => {
        // `publishFacebookPost` throws on 'story' — Page stories need /photo_stories and
        // /video_stories, which this service does not implement. On `both`, Facebook runs
        // first, so the throw means Instagram is never attempted even though it would have
        // worked. Caught at create time instead of once a day in a cron log.
        assert.ok(unsupportedPlatformCombination('facebook', 'story'));
        assert.ok(unsupportedPlatformCombination('both', 'story'));
    });

    it('allows an Instagram story, which is implemented', () => {
        assert.equal(unsupportedPlatformCombination('instagram', 'story'), null);
    });

    it('allows every other combination unchanged', () => {
        for (const platform of ['instagram', 'facebook', 'both']) {
            for (const postType of ['image', 'video', 'reel']) {
                assert.equal(unsupportedPlatformCombination(platform, postType), null,
                    `${platform}/${postType}`);
            }
        }
    });
});

/**
 * The guards mounted on the API router, and the order they run in.
 *
 * This exists because both of them were deletable with the suite green. Verified by mutation:
 * commenting out `router.use(requireLiveSession)` left 281/281 passing, and `users.token_version`
 * — described elsewhere in this codebase as the only kill switch it has — stopped being
 * enforced at all. Nothing asserted that the line was there, because every test of the rule
 * tested `checkSessionValidity` in isolation, and the rule is only worth anything if something
 * calls it.
 *
 * Asserted structurally, against the router's own middleware stack, because that is the thing
 * that actually broke: the decision functions were all fine.
 */
describe('API router middleware stack', () => {
    /** The router-level middleware, in mount order, ignoring routes. */
    function middlewareOrder(): unknown[] {
        return ((apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack)
            .filter((layer) => !layer.route)
            .map((layer) => layer.handle);
    }

    it('mounts requireAuth, then requireLiveSession, then resolveTenant', () => {
        const order = middlewareOrder();
        const auth = order.indexOf(requireAuth);
        const live = order.indexOf(requireLiveSession);
        const tenant = order.indexOf(resolveTenant);

        assert.ok(auth >= 0, 'requireAuth must be mounted on the API router');
        assert.ok(live >= 0, 'requireLiveSession must be mounted — it is the token_version kill switch');
        assert.ok(tenant >= 0, 'resolveTenant must be mounted');

        assert.ok(live > auth, 'requireLiveSession must run after requireAuth, which sets req.session');
        assert.ok(tenant > live,
            'resolveTenant must run after requireLiveSession, or a revoked session would still '
            + 'resolve a tenant and reach tenant-scoped data');
    });

    it('keeps the admin router above resolveTenant', () => {
        // resolveTenant 409s when the deployment has no creator at all, which is precisely the
        // state POST /api/admin/tenants exists to fix. Behind it, the first-run endpoint is
        // unreachable on exactly the deployment that needs it.
        // By reference, not by mount path: Express 5's Layer does not expose the path it was
        // mounted at, and comparing the handle is the stronger assertion anyway.
        const order = middlewareOrder();
        const adminAt = order.indexOf(adminRouter as unknown as never);
        const tenantAt = order.indexOf(resolveTenant);

        assert.ok(adminAt >= 0, 'the admin router must be mounted');
        assert.ok(adminAt < tenantAt, 'the admin router must be mounted above resolveTenant');
    });
});

/**
 * POST /api/auth/password — the route that made `users.passwordHint` stop being a lie.
 *
 * Only the branches that decide before any SQL are exercised here; there is no database in
 * this suite. The password rule itself lives in `passwordProblem`
 * (src/services/adminGuards.test.ts) so that this route, user creation and the admin reset
 * cannot drift apart.
 */
describe('POST /auth/password', () => {
    let savedPassword: string | undefined;
    let savedAppSecret: string | undefined;

    beforeEach(() => {
        savedPassword = process.env.DASHBOARD_PASSWORD;
        savedAppSecret = process.env.META_APP_SECRET;
        process.env.DASHBOARD_PASSWORD = 'dashboard-password';
        process.env.META_APP_SECRET = 'meta-app-secret';
    });

    afterEach(() => {
        setEnv('DASHBOARD_PASSWORD', savedPassword);
        setEnv('META_APP_SECRET', savedAppSecret);
    });

    function post(body: unknown, token: string): Promise<{ status: number; body: any }> {
        return new Promise((resolve) => {
            const req = {
                method: 'POST', url: '/auth/password', originalUrl: '/api/auth/password',
                body, query: {}, params: {},
                headers: { authorization: `Bearer ${token}` },
                socket: { remoteAddress: '127.0.0.1' },
            } as unknown as Request;

            const res = {
                statusCode: 200,
                status(code: number) { (this as any).statusCode = code; return this; },
                json(payload: unknown) { resolve({ status: (this as any).statusCode, body: payload }); return this; },
                setHeader() { return this; },
            } as unknown as Response;

            apiRouter(req, res, () => resolve({ status: 0, body: { fellThrough: true } }));
        });
    }

    it('401s a request with no session at all', async () => {
        const reply = await post({}, 'not-a-token');

        assert.equal(reply.status, 401);
    });

    it('explains itself to a shared-password session instead of 404ing', async () => {
        // The only kind of session that exists on this deployment: the `users` table is empty,
        // so every operator today holds a legacy token with no user row behind it. "Not found"
        // would read as a broken endpoint; this has to say what to do instead.
        const reply = await post(
            { currentPassword: 'x', newPassword: 'a-long-enough-password' },
            createLegacySession('t-1')
        );

        assert.equal(reply.status, 400);
        assert.equal(reply.body.code, 'NO_USER_ACCOUNT');
        assert.match(reply.body.error, /shared dashboard password/);
        assert.match(reply.body.error, /DASHBOARD_PASSWORD/);
    });

    it('never answers 401 for a validation failure', async () => {
        // The dashboard's shared client clears the token and bounces to login on ANY 401,
        // before a page's handler runs — so a 401 here logs an operator out for a typo.
        // 401 on an authenticated route must mean "your session died" and nothing else.
        const reply = await post({ newPassword: 'short' }, createLegacySession('t-1'));

        assert.notEqual(reply.status, 401);
        assert.equal(reply.status, 400);
    });
});
