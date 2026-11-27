/**
 * `/api/golive` (U3 SA-12): the owner's setup checklist.
 *
 * Each route's WHOLE stack runs with the stand-ins of `notifyTestSupport.ts`. Pinned: the read is any member's and answers
 * `{ show: false }` to all but an owner; hiding is the owner's (403 for anyone else, before anything is written); hiding and showing again
 * are audited as events and leave the rest of the stored doc alone; the owner's own workspace is `{ show: false }` through the route too.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { goLiveKey } from '../services/goLive.js';
import { INSUFFICIENT_ROLE_CODE, resolveTenant } from '../services/tenant.js';
import { invalidateModulesCache } from '../services/modules.js';
import { NotifyWorld } from '../services/notifyTestSupport.js';
import apiRouter from './api.js';
import { goLiveRouter } from './goLive.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

function stackFor(method: string, path: string): Handle[] {
    const stack = (goLiveRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

async function run(method: 'get' | 'post' | 'delete', path: string, over: { role?: string; tenantId?: string } = {}) {
    const res = { statusCode: 200, body: null as Json, status(c: number) { this.statusCode = c; return this; }, json(p: unknown) { this.body = p; return this; } };
    const req = { session: { userId: 'u-owner', role: 'user', tenantId: over.tenantId ?? 'tenant-company' }, body: {}, params: {}, tenantRole: over.role ?? 'owner' };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

const ROW = {
    onboarding_status: 'in_progress', onboarding_completed_at: null, meta_ok: true, instagram_username: 'acme', campaign_on: false, assistant_tested_at: null,
    members: 1, invited_after: false, whatsapp: false, youtube: false,
};

let world: NotifyWorld;
beforeEach(() => {
    world = new NotifyWorld();
    world.members = [{ userId: 'u-owner', email: 'o@c.test', role: 'owner' }];
    world.goliveFacts = ROW;
    world.install();
    invalidateModulesCache();
});
afterEach(() => world.restore());

describe('/golive', () => {
    it('is mounted on the API router BELOW resolveTenant', () => {
        const layers = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack;
        assert.ok(layers.findIndex((l) => !l.route && l.handle === goLiveRouter) > layers.findIndex((l) => !l.route && l.handle === resolveTenant));
    });

    it('the owner reads the checklist; an operator and a viewer are told { show: false } and nothing is read', async () => {
        const owner = await run('get', '/');
        assert.equal(owner.statusCode, 200);
        assert.equal(owner.body.show, true);
        assert.equal(owner.body.total, 7);
        world.executed.length = 0;
        for (const role of ['operator', 'viewer']) {
            const res = await run('get', '/', { role });
            assert.deepEqual(res.body, { show: false }, role);
        }
        assert.deepEqual(world.executed, []);
    });

    it('the platform owner\'s own workspace is { show: false } through the route too', async () => {
        world.owner = 'tenant-company';
        assert.deepEqual((await run('get', '/')).body, { show: false });
    });

    it('hiding is the owner\'s: 403 for anyone else, before anything is written', async () => {
        for (const role of ['operator', 'viewer']) {
            for (const method of ['post', 'delete'] as const) {
                const res = await run(method, '/dismiss', { role });
                assert.equal(res.statusCode, 403);
                assert.equal(res.body.code, INSUFFICIENT_ROLE_CODE);
            }
        }
        assert.deepEqual(world.writes, []);
    });

    it('hide, then the card is gone; show again, and it is back; hiding records its event', async () => {
        const hidden = await run('post', '/dismiss');
        assert.equal(typeof hidden.body.dismissedAt, 'string');
        assert.deepEqual(world.events.map((e) => e.event), ['golive_dismissed']);
        assert.deepEqual((await run('get', '/')).body, { show: false });

        const back = await run('delete', '/dismiss');
        assert.deepEqual(back.body, { dismissedAt: null });
        assert.equal((await run('get', '/')).body.show, true);
        assert.deepEqual(world.events.map((e) => e.event), ['golive_dismissed'], 'showing again records nothing');
    });

    it('isolation: hiding it for one workspace writes only that workspace\'s doc', async () => {
        world.settings[goLiveKey('tenant-other')] = JSON.stringify({ v: 1, dismissedAt: null, liveAt: null, seen: {} });
        await run('post', '/dismiss', { tenantId: 'tenant-company' });
        assert.equal(JSON.parse(world.settings[goLiveKey('tenant-other')]!).dismissedAt, null);
        assert.ok(world.writes.every((w) => w.key === goLiveKey('tenant-company')));
    });
});
