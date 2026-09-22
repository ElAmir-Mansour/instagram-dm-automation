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
import { pool } from '../config/db.js';
import adminRouter from './admin.js';
import { setLogSink } from '../utils/log.js';
import apiRouter, {
    exportScopeFor, formatPublishedIds, parseExportDownload, publishDuePosts, publishedPlatforms,
    splitDueByTenantActivity, unsupportedAfterEdit, unsupportedPlatformCombination,
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

describe('unsupportedAfterEdit', () => {
    it('refuses the two-step edit the create-time guard exists to prevent', () => {
        // Create instagram + story (allowed), then change only the platform. The body alone
        // says nothing about post_type, so a guard reading the body would let this through —
        // and the publish would fail a day later at the cron instead of in the form.
        const current = { platform: 'instagram', post_type: 'story' };

        assert.ok(unsupportedAfterEdit({ platform: 'both' }, current));
        assert.ok(unsupportedAfterEdit({ platform: 'facebook' }, current));
    });

    it('refuses the mirror image: changing only the post type', () => {
        assert.ok(unsupportedAfterEdit({ post_type: 'story' }, { platform: 'both', post_type: 'video' }));
    });

    it('allows an edit that moves a post OUT of the unsupported combination', () => {
        // The row is already facebook+story — a state that predates the create-time guard.
        // Editing it back to something publishable must not be refused on account of the
        // column it is leaving behind.
        const current = { platform: 'both', post_type: 'story' };

        assert.equal(unsupportedAfterEdit({ platform: 'instagram' }, current), null);
        assert.equal(unsupportedAfterEdit({ post_type: 'video' }, current), null);
    });

    it('treats an absent field as COALESCE does — keep the stored value', () => {
        const current = { platform: 'instagram', post_type: 'story' };

        assert.equal(unsupportedAfterEdit({}, current), null, 'a caption-only edit must still save');
        assert.equal(unsupportedAfterEdit({ platform: undefined, post_type: null }, current), null);
    });

    it('agrees with the create-time guard when the body says everything', () => {
        for (const platform of ['instagram', 'facebook', 'both']) {
            for (const postType of ['image', 'video', 'story']) {
                assert.equal(
                    unsupportedAfterEdit({ platform, post_type: postType }, { platform: 'x', post_type: 'y' }),
                    unsupportedPlatformCombination(platform, postType),
                    `${platform}/${postType}`
                );
            }
        }
    });
});

/**
 * Whose scheduled posts a sweep may publish.
 *
 * The bug: `publishDuePosts`' join had no `is_active` filter while the webhook path has always
 * had one. Disabling a tenant — for non-payment, at their request, or because their token is
 * compromised — stopped their auto-replies and left their scheduler publishing to live
 * Instagram and Facebook accounts.
 */
describe('splitDueByTenantActivity', () => {
    it('holds an inactive tenant\'s due posts instead of publishing them', () => {
        const { due, held } = splitDueByTenantActivity([
            { creator_id: 'c-live', is_active: true },
            { creator_id: 'c-off', is_active: false },
            { creator_id: 'c-live', is_active: true },
        ]);

        assert.deepEqual(due.map((r) => r.creator_id), ['c-live', 'c-live']);
        assert.deepEqual(held.map((r) => r.creator_id), ['c-off']);
    });

    it('reports the held rows rather than dropping them', () => {
        // Held, not cancelled, and counted. `is_active` is routinely temporary — the
        // dashboard's switch is a pause, not a delete — so the rows stay PENDING and the next
        // sweep after re-enabling picks them up. Counting them is what stops the whole thing
        // being a silent filter: "nothing was due" and "a suspended client's backlog is piling
        // up" would otherwise be the same log line.
        const { held } = splitDueByTenantActivity([{ creator_id: 'c-off', is_active: false }]);

        assert.equal(held.length, 1, 'a held row must remain visible to the caller');
    });

    it('holds a row whose is_active did not come back from the query at all', () => {
        // pool.query rows are `any`. A SELECT that stops listing the column would hand every
        // row `undefined`, and a truthy test would hold every tenant — safe, but silent.
        const { due, held } = splitDueByTenantActivity([{ creator_id: 'c-1' }]);

        assert.equal(due.length, 0);
        assert.equal(held.length, 1);
    });

    it('publishes everything when every tenant is active', () => {
        const rows = [{ creator_id: 'a', is_active: true }, { creator_id: 'b', is_active: true }];
        const { due, held } = splitDueByTenantActivity(rows);

        assert.equal(due.length, 2);
        assert.equal(held.length, 0);
    });
});

/**
 * That `publishDuePosts` actually holds a disabled tenant's posts.
 *
 * `splitDueByTenantActivity` proves the rule and the sweep proves the wiring — and the wiring
 * is what was wrong: nothing about the rule was missing, the query simply never asked. The
 * sweep is run against a stubbed pool with only an inactive tenant due, which returns before
 * any Meta call, so the assertion is exactly "no claim was issued" plus "somebody was told".
 */
describe('publishDuePosts — a disabled tenant', () => {
    async function sweepWith(rows: Array<Record<string, unknown>>) {
        const statements: string[] = [];
        const logged: Array<{ level: string; event: string; creator_ids?: string[] }> = [];

        const originalQuery = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            statements.push(sql);
            if (/FROM scheduled_posts s/.test(sql)) return { rows, rowCount: rows.length };
            return { rows: [], rowCount: 0 };
        };
        // The sink takes a level and one JSON line, which is what makes a log assertion an
        // assertion about fields rather than about prose.
        const previousSink = setLogSink((level, line) => logged.push({ level, ...JSON.parse(line) }));
        try {
            return { result: await publishDuePosts(), statements, logged };
        } finally {
            (pool as unknown as { query: unknown }).query = originalQuery;
            setLogSink(previousSink);
        }
    }

    it('never claims a post belonging to a tenant that is switched off', async () => {
        const { result, statements } = await sweepWith([
            { id: 'p-1', creator_id: 'c-off', is_active: false, platform: 'both', post_type: 'video' },
        ]);

        assert.equal(result.due, 0, 'nothing is publishable');
        assert.equal(result.claimed, 0);
        assert.ok(!statements.some((sql) => /UPDATE scheduled_posts/.test(sql)),
            'claiming the row is the step that leads to a live post — it must not happen');
    });

    it('leaves the row PENDING, so re-enabling the tenant resumes it', async () => {
        const { statements } = await sweepWith([
            { id: 'p-1', creator_id: 'c-off', is_active: false },
        ]);

        // Held, not cancelled: `is_active` is a pause, and a post that quietly became FAILED
        // during a suspension would have to be rebuilt by hand afterwards.
        assert.ok(!statements.some((sql) => /FAILED|SKIPPED|DELETE/.test(sql)));
    });

    it('says so out loud, because a silent filter is the same bug in the other direction', async () => {
        const { result, logged } = await sweepWith([
            { id: 'p-1', creator_id: 'c-off', is_active: false },
            { id: 'p-2', creator_id: 'c-off', is_active: false },
        ]);

        assert.equal(result.heldForInactiveTenant, 2, 'the count must reach the caller');
        const warning = logged.find((entry) => entry.event === 'cron.publish_held_inactive');
        assert.ok(warning, 'a held backlog that is never mentioned is indistinguishable from an empty one');
        assert.equal(warning!.level, 'warn');
        assert.deepEqual(warning!.creator_ids, ['c-off']);
    });

    it('reports nothing held when every tenant is active', async () => {
        const { result, logged } = await sweepWith([]);

        assert.equal(result.heldForInactiveTenant, 0);
        assert.ok(!logged.some((entry) => entry.event === 'cron.publish_held_inactive'));
    });
});

/**
 * That the edit guard is actually CALLED by the edit route.
 *
 * `unsupportedAfterEdit` above proves the rule; this proves the wiring, which is the half that
 * was missing — the create route called the create-time guard and the edit route called
 * nothing at all. A pure function nobody invokes is exactly the shape of the original bug, so
 * the handler is pulled off the router's own stack and run against a stubbed pool.
 */
describe('PUT /posts/scheduled/:id — the edit-time platform guard', () => {
    /** The final handler for one route on the API router. */
    function handlerFor(method: string, path: string) {
        const stack = (apiRouter as unknown as {
            stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }>;
        }).stack;
        const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
        assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
        return layer!.route!.stack[layer!.route!.stack.length - 1]!.handle;
    }

    /** Run the handler with `pool.query` answering from `rows`, and collect the response. */
    async function runEdit(body: Record<string, unknown>, current: Record<string, unknown> | null) {
        const res = {
            statusCode: 200,
            body: null as unknown,
            status(code: number) { this.statusCode = code; return this; },
            json(payload: unknown) { this.body = payload; return this; },
        };
        const statements: string[] = [];
        const original = pool.query;
        (pool as unknown as { query: unknown }).query = async (sql: string) => {
            statements.push(sql);
            if (/SELECT platform, post_type/.test(sql)) return { rows: current ? [current] : [], rowCount: current ? 1 : 0 };
            return { rows: [{ id: 'post-1', ...current, ...body }], rowCount: 1 };
        };
        try {
            await handlerFor('put', '/posts/scheduled/:id')(
                { params: { id: TENANT_A }, body, session: { userId: 'u-1', role: 'user', tenantId: TENANT_B } },
                res,
                () => {}
            );
        } finally {
            (pool as unknown as { query: unknown }).query = original;
        }
        return { res, statements };
    }

    it('refuses the two-step edit at the form, not at the cron', async () => {
        const { res } = await runEdit({ platform: 'both' }, { platform: 'instagram', post_type: 'story' });

        assert.equal(res.statusCode, 400);
        assert.match(String((res.body as { error: string }).error), /Facebook Page stories/);
    });

    it('reads the stored row, because the body alone cannot answer the question', async () => {
        const { statements } = await runEdit({ platform: 'both' }, { platform: 'instagram', post_type: 'story' });

        assert.ok(statements.some((sql) => /SELECT platform, post_type/.test(sql)),
            'the effective combination needs the columns the PUT did not send');
        assert.ok(!statements.some((sql) => /UPDATE scheduled_posts/.test(sql)),
            'and the refused edit must not have been written');
    });

    it('still saves an ordinary edit', async () => {
        const { res, statements } = await runEdit({ caption: 'جديد' }, { platform: 'instagram', post_type: 'video' });

        assert.equal(res.statusCode, 200);
        assert.ok(statements.some((sql) => /UPDATE scheduled_posts/.test(sql)));
    });

    it('404s an edit of a row this tenant does not own', async () => {
        const { res, statements } = await runEdit({ platform: 'both' }, null);

        assert.equal(res.statusCode, 404);
        assert.ok(!statements.some((sql) => /UPDATE scheduled_posts/.test(sql)));
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
 * Which tenant-scoped routes a restricted membership may reach.
 *
 * `memberships.role` was stored, displayed and audited for four migrations while no
 * authorization decision anywhere read it — so a "member" could delete campaigns, rotate the
 * Meta page access token and publish to the live account. The decision functions are tested in
 * `src/services/tenant.test.ts`; the thing that was actually missing is the MOUNT, and a guard
 * nobody mounted is worth nothing. That is what this asserts, against the router's own stack,
 * exactly as the middleware-order test above does for `requireLiveSession`.
 *
 * The blanket rule is the valuable half: every route below `resolveTenant` that is not a GET
 * must carry a guard. A route added later without one fails here rather than shipping open,
 * which is how this class of hole gets in — not by somebody deleting a guard, but by the next
 * route not knowing it needed one.
 */
describe('tenant role guards', () => {
    interface RouteLayer {
        route?: {
            path: string;
            methods: Record<string, boolean>;
            stack: Array<{ handle: { minimumRole?: string } }>;
        };
        handle: unknown;
    }

    const stack = (apiRouter as unknown as { stack: RouteLayer[] }).stack;
    const resolveTenantAt = stack.findIndex((layer) => !layer.route && layer.handle === resolveTenant);

    /** Every route mounted below `resolveTenant`, as `METHOD /path` plus the guard it carries. */
    function tenantScopedRoutes(): Array<{ key: string; method: string; guard: string | null }> {
        return stack.slice(resolveTenantAt + 1).flatMap((layer) => {
            if (!layer.route) return [];
            const guard = layer.route.stack
                .map((inner) => inner.handle?.minimumRole)
                .find((min): min is string => typeof min === 'string') ?? null;
            return Object.keys(layer.route.methods).map((method) => ({
                key: `${method.toUpperCase()} ${layer.route!.path}`,
                method,
                guard,
            }));
        });
    }

    it('mounts every guard below resolveTenant, which is what sets req.tenantRole', () => {
        assert.ok(resolveTenantAt >= 0, 'resolveTenant must be mounted');
        const guarded = tenantScopedRoutes().filter((r) => r.guard);
        assert.ok(guarded.length > 0, 'no guard is mounted at all — the whole feature is inert');
    });

    it('refuses a viewer on every mutating tenant-scoped route', () => {
        // The blanket rule. `/interactions/export/token` is the one deliberate exception: it
        // mints a short-lived token for an export of rows the caller can already read on
        // screen, so it is a read that happens to be a POST.
        const READ_ONLY_POSTS = new Set(['POST /interactions/export/token']);

        const ungated = tenantScopedRoutes()
            .filter((r) => r.method !== 'get' && !r.guard && !READ_ONLY_POSTS.has(r.key))
            .map((r) => r.key);

        assert.deepEqual(ungated, [],
            'these routes mutate a tenant and any membership can reach them — add canOperate '
            + 'or canAdminister, or list the route as a deliberate read');
    });

    it('reserves the Meta connection for an owner', () => {
        // The one distinction three tiers exist for. Rotating the page access token or the
        // webhook verify token is not the same permission as running campaigns: break either
        // and the tenant goes dark, and holding the page token means being able to post as the
        // business anywhere Meta allows.
        const byKey = new Map(tenantScopedRoutes().map((r) => [r.key, r.guard]));

        for (const key of [
            'POST /settings/token',
            'POST /settings/token/extend',
            'POST /settings/webhook-token',
        ]) {
            assert.equal(byKey.get(key), 'owner', `${key} must require an owner`);
        }
    });

    it('lets an operator run the account without holding its credentials', () => {
        const byKey = new Map(tenantScopedRoutes().map((r) => [r.key, r.guard]));

        for (const key of [
            'POST /campaigns',
            'PUT /campaigns/:id',
            'DELETE /campaigns/:id',
            'POST /posts/scheduled',
            'PUT /posts/scheduled/:id',
            'DELETE /posts/scheduled/:id',
            'POST /posts/scheduled/:id/publish-now',
            'POST /upload',
            'POST /conversations/:id/messages',
            'PUT /conversations/:id/toggle-bot',
            'POST /settings/ai',
            'POST /settings/ai/test',
            'POST /settings/token/recheck',
        ]) {
            assert.equal(byKey.get(key), 'operator', `${key} must require an operator`);
        }
    });

    it('gates no read, so a membership still means you can see the account', () => {
        // Hiding rows by role would need a second parallel set of filters on every read query,
        // and would leave a viewer unable to see the thing they are being asked about.
        // `GET /settings/webhook-token` is the only read touching a secret, and it has always
        // returned a masked preview rather than the value.
        const gatedReads = tenantScopedRoutes()
            .filter((r) => r.method === 'get' && r.guard)
            .map((r) => r.key);

        assert.deepEqual(gatedReads, []);
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
