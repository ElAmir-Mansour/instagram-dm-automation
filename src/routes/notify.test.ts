/**
 * `/api/notify` (U3 SA-11): how each person chooses to be told, and who covers what.
 *
 * Each route's WHOLE stack (guard, then handler) runs with the stand-ins of `notifyTestSupport.ts`: no test here reaches Telegram, the
 * database or a person. Pinned:
 *
 *   - who: every member sees and changes THEIR OWN notices; only the workspace's owner reads or writes the routing (403 otherwise, before
 *     anything is read);
 *   - the shared-password session has no account: linking is `NO_USER_ACCOUNT`, and it is told so before Telegram is asked;
 *   - the routing: the default is every owner and operator; a person who is not a member of the workspace is `ROUTING_INVALID` and nothing is
 *     written; a saved routing is what the table says next, and is audited with counts only;
 *   - `confirm` links through the real handshake (a fake `getUpdates` holding `/start <code>`) and refuses an expired code with 410;
 *   - isolation: the workspace is the session's, and the routing of another workspace is not reachable by naming it;
 *   - the token and any chat id are in no answer, and an answer about one person never carries another's chat.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { INSUFFICIENT_ROLE_CODE, resolveTenant } from '../services/tenant.js';
import { notifyRoutingKey, userNotifyKey } from '../services/notifyPeople.js';
import { BOT_TOKEN, NotifyWorld } from '../services/notifyTestSupport.js';
import apiRouter from './api.js';
import { notifyRouter } from './notify.js';

type Handle = (req: unknown, res: unknown, next: (err?: unknown) => void) => unknown;
type Json = any;

function stackFor(method: string, path: string): Handle[] {
    const stack = (notifyRouter as unknown as {
        stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> } }>;
    }).stack;
    const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
    assert.ok(layer, `${method.toUpperCase()} ${path} must be mounted`);
    return layer!.route!.stack.map((l) => l.handle);
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as Json,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
    };
}

async function run(method: 'get' | 'put' | 'post' | 'delete' | 'patch', path: string, over: { role?: string; tenantId?: string; userId?: string | null; sessionRole?: string; body?: unknown } = {}) {
    const res = fakeRes();
    const req = {
        session: { userId: over.userId === undefined ? 'u-owner' : over.userId, role: over.sessionRole ?? 'user', tenantId: over.tenantId ?? 'tenant-company' },
        body: over.body ?? {}, params: {}, tenantRole: over.role ?? 'owner',
    };
    for (const handle of stackFor(method, path)) {
        let passed = false;
        await handle(req, res, () => { passed = true; });
        if (!passed) break;
    }
    return res;
}

let world: NotifyWorld;
beforeEach(() => {
    world = new NotifyWorld().withTelegram();
    world.members = [
        { userId: 'u-owner', email: 'owner@company.test', role: 'owner' },
        { userId: 'u-op', email: 'op@company.test', role: 'operator' },
        { userId: 'u-view', email: 'view@company.test', role: 'viewer' },
    ];
    world.install();
});
afterEach(() => world.restore());

const linkedDoc = (chatId: string): string => JSON.stringify({ v: 1, telegram: { chatId, linkedAt: '2026-11-28T10:00:00.000Z', name: 'Op', paused: false } });

describe('/notify: how it is mounted and who may call it', () => {
    it('is mounted on the API router BELOW resolveTenant, so it always acts as the session\'s workspace', () => {
        const layers = (apiRouter as unknown as { stack: Array<{ handle: unknown; route?: unknown }> }).stack;
        const at = layers.findIndex((l) => !l.route && l.handle === notifyRouter);
        const tenantAt = layers.findIndex((l) => !l.route && l.handle === resolveTenant);
        assert.ok(at > tenantAt && tenantAt >= 0, 'below resolveTenant');
    });

    it('the routing is the owner\'s: an operator and a viewer are refused with 403 before anything is read or written', async () => {
        for (const role of ['operator', 'viewer']) {
            world.executed.length = 0;
            for (const [method, path] of [['get', '/routing'], ['put', '/routing']] as const) {
                const res = await run(method, path, { role, body: { handoff: [], hotLeads: [] } });
                assert.equal(res.statusCode, 403, `${role} ${method} ${path}`);
                assert.equal(res.body.code, INSUFFICIENT_ROLE_CODE);
            }
            assert.deepEqual(world.executed, [], `${role}: nothing was read`);
        }
    });

    it('a person\'s own routes are open to every member, a viewer included', async () => {
        const me = await run('get', '/me', { role: 'viewer', userId: 'u-view' });
        assert.equal(me.statusCode, 200);
    });
});

describe('GET /me and the link', () => {
    it('says whether a bot exists, the person\'s own state and what covers them, and nothing of anybody else', async () => {
        world.settings[userNotifyKey('u-op')] = linkedDoc('1002');
        const res = await run('get', '/me', { role: 'operator', userId: 'u-op' });
        assert.deepEqual(res.body, {
            hasAccount: true, platformAdmin: false, botReady: true,
            telegram: { linked: true, linkedAt: '2026-11-28T10:00:00.000Z', name: 'Op', paused: false },
            covers: { handoff: true, hotLeads: true },
        });
        assert.ok(!JSON.stringify(res.body).includes('1002'), 'the chat id is never sent back');
        assert.ok(!JSON.stringify(res.body).includes(BOT_TOKEN));
    });

    it('a viewer is told they are not covered by default, and the platform having no bot is "botReady: false"', async () => {
        world.settings = {};
        const res = await run('get', '/me', { role: 'viewer', userId: 'u-view' });
        assert.deepEqual([res.body.botReady, res.body.covers, res.body.telegram.linked], [false, { handoff: false, hotLeads: false }, false]);
    });

    it('a platform admin acting as the workspace is told so, and is covered by nothing here', async () => {
        const res = await run('get', '/me', { userId: 'u-admin', sessionRole: 'platform_admin' });
        assert.equal(res.body.platformAdmin, true);
        assert.deepEqual(res.body.covers, { handoff: false, hotLeads: false });
    });

    it('the shared-password session has no account: NO_USER_ACCOUNT on link, confirm, pause and unlink, and Telegram is never asked', async () => {
        for (const [method, path] of [['post', '/telegram/link'], ['post', '/telegram/confirm'], ['patch', '/me'], ['delete', '/telegram']] as const) {
            const res = await run(method, path, { userId: null, body: { code: 'x', paused: true } });
            assert.equal(res.statusCode, 400, `${method} ${path}`);
            assert.equal(res.body.code, 'NO_USER_ACCOUNT');
        }
        const me = await run('get', '/me', { userId: null });
        assert.deepEqual([me.body.hasAccount, me.body.telegram], [false, null]);
        assert.deepEqual(world.gets, []);
    });

    it('link answers the address; without a bot token it is 409 TELEGRAM_BOT_MISSING; when Telegram is down, 502 TELEGRAM_UNREACHABLE', async () => {
        const ok = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        assert.equal(ok.statusCode, 200);
        assert.match(ok.body.url, /^https:\/\/t\.me\/autoreply_pro_bot\?start=[A-Za-z0-9_-]{43}$/);

        world.getMe = () => { throw Object.assign(new Error('x'), { code: 'ECONNABORTED' }); };
        const down = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        assert.deepEqual([down.statusCode, down.body.code], [502, 'TELEGRAM_UNREACHABLE']);

        world.settings = {};
        const missing = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        assert.deepEqual([missing.statusCode, missing.body.code], [409, 'TELEGRAM_BOT_MISSING']);
    });
});

describe('confirm, pause and unlink', () => {
    it('confirm: "not yet" while nobody pressed Start, then linked with the first name; the code then answers 410', async () => {
        const link = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        const code = String(link.body.url).split('start=')[1];

        const waiting = await run('post', '/telegram/confirm', { userId: 'u-op', role: 'operator', body: { code } });
        assert.deepEqual([waiting.statusCode, waiting.body], [200, { linked: false }]);

        world.pressStart(code!, { id: 31337, first_name: 'Omar' });
        const done = await run('post', '/telegram/confirm', { userId: 'u-op', role: 'operator', body: { code } });
        assert.deepEqual([done.statusCode, done.body], [200, { linked: true, name: 'Omar' }]);
        assert.ok(!JSON.stringify(done.body).includes('31337'));

        const again = await run('post', '/telegram/confirm', { userId: 'u-op', role: 'operator', body: { code } });
        assert.deepEqual([again.statusCode, again.body.code], [410, 'TELEGRAM_LINK_EXPIRED']);
    });

    it('confirm with an expired code is 410 and Telegram is not asked', async () => {
        const link = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        const code = String(link.body.url).split('start=')[1]!;
        world.states.get(code)!.expiresAt = new Date(Date.now() - 1);
        world.gets.length = 0;
        const res = await run('post', '/telegram/confirm', { userId: 'u-op', role: 'operator', body: { code } });
        assert.deepEqual([res.statusCode, res.body.code], [410, 'TELEGRAM_LINK_EXPIRED']);
        assert.deepEqual(world.gets, []);
    });

    it('another person cannot spend a code made for someone else', async () => {
        const link = await run('post', '/telegram/link', { userId: 'u-op', role: 'operator' });
        const code = String(link.body.url).split('start=')[1]!;
        world.pressStart(code, { id: 555 });
        const res = await run('post', '/telegram/confirm', { userId: 'u-view', role: 'viewer', body: { code } });
        assert.equal(res.statusCode, 410);
        assert.ok(!(userNotifyKey('u-view') in world.settings));
    });

    it('pause needs a boolean, keeps the link, and answers the new state; unlink deletes it', async () => {
        world.settings[userNotifyKey('u-op')] = linkedDoc('1002');
        const bad = await run('patch', '/me', { userId: 'u-op', role: 'operator', body: { paused: 'yes' } });
        assert.equal(bad.statusCode, 400);
        const paused = await run('patch', '/me', { userId: 'u-op', role: 'operator', body: { paused: true } });
        assert.equal(paused.body.telegram.paused, true);
        assert.equal(paused.body.telegram.linked, true);
        const gone = await run('delete', '/telegram', { userId: 'u-op', role: 'operator' });
        assert.deepEqual(gone.body, { linked: false });
        assert.ok(!(userNotifyKey('u-op') in world.settings));
        assert.deepEqual(world.audits.map((a) => a.action), ['notify.telegram_unlink']);
    });
});

describe('the routing (owner)', () => {
    it('with nothing chosen it is the default: the owners and operators, for both kinds, and who has not linked is shown', async () => {
        world.settings[userNotifyKey('u-op')] = linkedDoc('1002');
        const res = await run('get', '/routing');
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.defaults, true);
        assert.equal(res.body.botReady, true);
        assert.deepEqual([...res.body.handoff].sort(), ['u-op', 'u-owner']);
        assert.deepEqual([...res.body.hotLeads].sort(), ['u-op', 'u-owner']);
        assert.deepEqual(res.body.members.map((m: Json) => [m.userId, m.telegramLinked]).sort(), [['u-op', true], ['u-owner', false], ['u-view', false]]);
        assert.ok(!JSON.stringify(res.body).includes('1002'), 'a person\'s chat id is never in the owner\'s table');
    });

    it('PUT saves exactly what was chosen, answers the table again, and audits counts only', async () => {
        const res = await run('put', '/routing', { body: { handoff: ['u-view', 'u-view'], hotLeads: ['u-op', 'u-owner'] } });
        assert.equal(res.statusCode, 200, JSON.stringify(res.body));
        assert.equal(res.body.defaults, false);
        assert.deepEqual(res.body.handoff, ['u-view']);
        assert.deepEqual([...res.body.hotLeads].sort(), ['u-op', 'u-owner']);
        assert.deepEqual(JSON.parse(world.settings[notifyRoutingKey('tenant-company')]!), { v: 1, handoff: ['u-view'], hotLeads: ['u-op', 'u-owner'] });
        assert.deepEqual(world.audits.map((a) => [a.action, a.detail]), [['notify.routing_write', { handoff_count: 1, hot_leads_count: 2 }]]);
    });

    it('a person who is not a member of the workspace is ROUTING_INVALID, and nothing is written', async () => {
        const res = await run('put', '/routing', { body: { handoff: ['u-owner', 'u-stranger'], hotLeads: [] } });
        assert.deepEqual([res.statusCode, res.body.code, res.body.params], [400, 'ROUTING_INVALID', { userId: 'u-stranger' }]);
        assert.ok(!(notifyRoutingKey('tenant-company') in world.settings));
        assert.deepEqual(world.audits, []);
    });

    it('a body that is not two lists of ids is refused as ROUTING_INVALID too', async () => {
        for (const body of [{}, { handoff: 'u-owner', hotLeads: [] }, { handoff: [1], hotLeads: [] }, { handoff: [], hotLeads: null }]) {
            const res = await run('put', '/routing', { body });
            assert.deepEqual([res.statusCode, res.body.code], [400, 'ROUTING_INVALID'], JSON.stringify(body));
        }
        assert.ok(!(notifyRoutingKey('tenant-company') in world.settings));
    });

    it('ISOLATION: the routing is the session\'s workspace\'s, and another workspace\'s row is never read or written', async () => {
        world.settings[notifyRoutingKey('tenant-other')] = JSON.stringify({ v: 1, handoff: ['u-view'], hotLeads: [] });
        const mine = await run('get', '/routing', { tenantId: 'tenant-company' });
        assert.equal(mine.body.defaults, true, 'the other workspace\'s row does not leak in');
        await run('put', '/routing', { tenantId: 'tenant-company', body: { handoff: ['u-owner'], hotLeads: [] } });
        assert.deepEqual(JSON.parse(world.settings[notifyRoutingKey('tenant-other')]!).handoff, ['u-view'], 'and is untouched');
        assert.ok(world.writes.every((w) => w.key !== notifyRoutingKey('tenant-other')));
    });
});
