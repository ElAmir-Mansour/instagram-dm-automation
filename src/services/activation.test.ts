/**
 * The activation events (`activation.ts`, U3 WA-9): written after the response, only for a 2xx, once.
 *
 * `pool.query` is the stand-in of `notifyTestSupport.ts`. Pinned: only the two requests that count are tapped; a refused request records
 * nothing; the event is written AFTER the response finishes (never delaying it); a platform admin and the shared-password session record
 * nothing; the insert is one `WHERE NOT EXISTS` statement (once per workspace, or once per person); and a failing insert is logged and never thrown.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { activationFor, activationTap, recordOnce } from './activation.js';
import { NotifyWorld } from './notifyTestSupport.js';

let world: NotifyWorld;
/** Read through a function: `assert.deepEqual(world.events, [])` narrows the field to `never[]` for the rest of the test. */
const events = () => world.events;
beforeEach(() => { world = new NotifyWorld(); world.install(); });
afterEach(() => world.restore());

function tap(method: string, path: string, session: Record<string, unknown> | undefined, status: number): { order: string[]; finish: () => Promise<void> } {
    const res = Object.assign(new EventEmitter(), { statusCode: status });
    const order: string[] = [];
    activationTap({ method, path, session } as any, res as any, () => order.push('next'));
    return { order, finish: async () => { order.push('finish'); res.emit('finish'); await new Promise((r) => setImmediate(r)); } };
}

const USER = { userId: 'u-sara', role: 'user', tenantId: 'tenant-company' };

describe('which requests count', () => {
    it('the first assistant test and a reply from the Inbox, and nothing else', () => {
        assert.deepEqual(activationFor('POST', '/settings/ai/test'), { event: 'assistant_tested', perUser: false });
        assert.deepEqual(activationFor('post', '/conversations/abc-123/messages'), { event: 'staff_first_reply', perUser: true });
        for (const [m, p] of [['GET', '/settings/ai/test'], ['POST', '/settings/ai'], ['GET', '/conversations/abc/messages'], ['POST', '/conversations/abc/messages/extra'], ['PUT', '/conversations/abc/toggle-bot'], ['POST', '/posts/scheduled']]) {
            assert.equal(activationFor(m!, p!), null, `${m} ${p}`);
        }
    });
});

describe('activationTap', () => {
    it('calls next at once and writes the event only AFTER the response, for a 2xx', async () => {
        const t = tap('POST', '/settings/ai/test', USER, 200);
        assert.deepEqual(t.order, ['next']);
        assert.deepEqual(world.events, [], 'nothing is written while the request is in flight');
        await t.finish();
        assert.deepEqual(events().map((e) => [e.event, e.once]), [['assistant_tested', true]]);
        assert.deepEqual(events()[0]!.params, ['tenant-company', 'u-sara', 'assistant_tested', false]);
    });

    it('a refused or failed request records nothing', async () => {
        for (const status of [400, 403, 409, 429, 500]) {
            const t = tap('POST', '/conversations/c1/messages', USER, status);
            await t.finish();
        }
        assert.deepEqual(world.events, []);
    });

    it('a reply is once per PERSON: the statement is told to compare the user', async () => {
        await tap('POST', '/conversations/c1/messages', USER, 200).finish();
        assert.deepEqual(events()[0]!.params, ['tenant-company', 'u-sara', 'staff_first_reply', true]);
        const sql = world.executed.find((s) => /INSERT INTO onboarding_events/.test(s))!;
        assert.match(sql, /WHERE NOT EXISTS/);
        assert.match(sql, /user_id IS NOT DISTINCT FROM \$2::uuid/);
        assert.match(sql, /\$4::boolean IS FALSE OR/);
    });

    it('a platform admin acting as the workspace, the shared-password session and a request with no session record nothing', async () => {
        await tap('POST', '/settings/ai/test', { ...USER, role: 'platform_admin' }, 200).finish();
        await tap('POST', '/settings/ai/test', { ...USER, userId: null }, 200).finish();
        await tap('POST', '/settings/ai/test', { ...USER, tenantId: null }, 200).finish();
        await tap('POST', '/settings/ai/test', undefined, 200).finish();
        assert.deepEqual(world.events, []);
    });

    it('a request that is not one of the two is not even listened to', () => {
        const res = Object.assign(new EventEmitter(), { statusCode: 200 });
        activationTap({ method: 'GET', path: '/stats', session: USER } as any, res as any, () => undefined);
        assert.equal(res.listenerCount('finish'), 0);
    });
});

describe('recordOnce', () => {
    it('never throws: a failing insert is logged and nothing else', async () => {
        const { pool } = await import('../config/db.js');
        const previous = pool.query;
        (pool as any).query = async () => { throw new Error('connection terminated'); };
        try {
            await recordOnce('tenant-company', 'u-sara', 'assistant_tested', false);
        } finally {
            (pool as any).query = previous;
        }
        assert.ok(world.logged.some((l) => l.event === 'activation.record_failed'));
    });
});
