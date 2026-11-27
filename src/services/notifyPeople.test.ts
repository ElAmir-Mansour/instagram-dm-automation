/**
 * Who in a workspace is told (`notifyPeople.ts`, U3 SA-11), and that the platform owner's own alert did not change (`dmSales/handoff.ts`).
 *
 * `pool.query` and Telegram are the stand-ins of `notifyTestSupport.ts`: no test here reaches Telegram, the live database or a person. Pinned,
 * because each is a way staff are not told, are told twice, are told wrongly, or the owner's alert breaks:
 *
 *   - routing: with no row, every active owner and operator covers both kinds (a viewer does not); with a row, only the listed people who are
 *     STILL members; a platform admin, a deactivated account and a person who paused are never sent to;
 *   - no bot token on the platform: `notifyPeople` makes ZERO statements (the DM turn's pinned timelines), and `notifyOwner` gives today's
 *     outcomes with today's statements; with a token and nobody linked, the same outcomes, plus the one read of the members;
 *   - one allowance per conversation per kind, apart from the owner's; a failing chat costs the others nothing; the owner's own chat is
 *     never told twice;
 *   - the bot token and a chat id are in no log line, no statement parameter beyond the notify rows, and no audit row.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { notifyOwner, HANDOFF_ALERTS_PER_HOUR, HOT_LEAD_ALERTS_PER_HOUR } from './dmSales/handoff.js';
import {
    coveredBy, notifyPeople, parseRouting, parseUserNotify, recipientChats, userNotifyKey, notifyRoutingKey,
    type NotifyMember, type PeopleRequest,
} from './notifyPeople.js';
import { BOT_TOKEN, NotifyWorld, type FakeMember } from './notifyTestSupport.js';
import type { NoticeInput } from './notify.js';

const TENANT = 'tenant-company';
const linkedDoc = (chatId: string, over: Record<string, unknown> = {}): string =>
    JSON.stringify({ v: 1, telegram: { chatId, linkedAt: '2026-11-28T10:00:00.000Z', name: 'Sara', paused: false, ...over } });

const OWNER: FakeMember = { userId: 'u-owner', email: 'owner@company.test', role: 'owner' };
const OPERATOR: FakeMember = { userId: 'u-operator', email: 'op@company.test', role: 'operator' };
const VIEWER: FakeMember = { userId: 'u-viewer', email: 'view@company.test', role: 'viewer' };

const NOTICE: NoticeInput = {
    kind: 'handoff', reason: 'refund', lang: 'en', username: 'sara_dev', senderId: '17841400000000001', lastMessage: 'I want a refund', windowMs: 3_600_000, link: 'https://msg.example/dashboard#/inbox?c=1',
};

let world: NotifyWorld;
beforeEach(() => { world = new NotifyWorld(); world.owner = 'tenant-owner'; world.install(); });
afterEach(() => world.restore());

function request(over: Partial<PeopleRequest> = {}): PeopleRequest {
    return {
        creatorId: TENANT, kind: 'handoff', bucket: 'notify_people:conv-1', limit: HANDOFF_ALERTS_PER_HOUR,
        telegram: { token: BOT_TOKEN, chatId: null }, notice: async () => NOTICE, logBase: { conversation_id: 'conv-1' },
        ...over,
    };
}

const sentTo = (): string[] => world.posts.map((p) => String(p.body['chat_id']));

// ─── The pure rule ───────────────────────────────────────────────────────────────────────────────────────

describe('who covers a notice (pure)', () => {
    const member = (m: FakeMember, chatId: string | null, over: Record<string, unknown> = {}): NotifyMember => ({
        userId: m.userId, email: m.email, role: m.role, notify: chatId ? parseUserNotify(linkedDoc(chatId, over)) : { v: 1, telegram: null },
    });
    const all = [member(OWNER, '1001'), member(OPERATOR, '1002'), member(VIEWER, '1003')];

    it('with no routing row, the owners and operators cover both kinds, and a viewer does not', () => {
        for (const kind of ['handoff', 'hotLeads'] as const) {
            assert.deepEqual(coveredBy(kind, all, null).map((m) => m.userId), ['u-owner', 'u-operator']);
        }
    });

    it('with a routing row, exactly the listed people who are still members (one who left is skipped)', () => {
        const routing = parseRouting(JSON.stringify({ v: 1, handoff: ['u-viewer', 'u-gone'], hotLeads: ['u-owner'] }));
        assert.deepEqual(coveredBy('handoff', all, routing).map((m) => m.userId), ['u-viewer']);
        assert.deepEqual(coveredBy('hotLeads', all, routing).map((m) => m.userId), ['u-owner']);
    });

    it('the chats are the linked, unpaused ones, once each', () => {
        const people = [member(OWNER, '1001'), member(OPERATOR, '1001'), member(VIEWER, '1003', { paused: true }), member({ ...OPERATOR, userId: 'u-x', email: 'x@c.test' }, null)];
        assert.deepEqual(recipientChats('handoff', people, parseRouting(JSON.stringify({ v: 1, handoff: ['u-owner', 'u-operator', 'u-viewer', 'u-x'], hotLeads: [] }))), ['1001']);
    });

    it('an unreadable document is "not linked" and an unreadable routing is "the default": never an exception', () => {
        for (const raw of [null, '', 'not json', '[]', '{"telegram":"x"}', '{"telegram":{"chatId":12}}', '{"telegram":{"chatId":"abc"}}']) {
            assert.equal(parseUserNotify(raw).telegram, null, String(raw));
        }
        assert.equal(parseRouting('not json'), null);
        assert.equal(parseRouting(null), null);
    });

    it('a key is built from an id and refuses anything that is not the shape of one', () => {
        assert.equal(userNotifyKey('u-1'), 'user.notify.u-1');
        assert.equal(notifyRoutingKey('t-1'), 'notify.routing.t-1');
        assert.throws(() => userNotifyKey('a.b'));
        assert.throws(() => notifyRoutingKey('x'.repeat(65)));
    });
});

// ─── Delivery ────────────────────────────────────────────────────────────────────────────────────────────

describe('notifyPeople: delivery', () => {
    it('with no bot token on the platform it makes ZERO statements and sends nothing', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        const outcome = await notifyPeople(request({ telegram: { token: null, chatId: null } }));
        assert.equal(outcome, 'none');
        assert.deepEqual(world.executed, []);
        assert.deepEqual(world.posts, []);
    });

    it('with the default routing it tells every linked owner and operator, not the viewer, with the same words the owner gets', async () => {
        world.members = [OWNER, OPERATOR, VIEWER];
        for (const [m, chat] of [[OWNER, '1001'], [OPERATOR, '1002'], [VIEWER, '1003']] as const) world.settings[userNotifyKey(m.userId)] = linkedDoc(chat);
        const outcome = await notifyPeople(request());
        assert.equal(outcome, 'sent');
        assert.deepEqual(sentTo().sort(), ['1001', '1002']);
        const text = String(world.posts[0]!.body['text']);
        assert.match(text, /^Needs you: refund request\n/);
        assert.match(text, /@sara_dev/);
        assert.equal(world.posts[0]!.body['parse_mode'], undefined, 'plain text: nothing a customer typed is read as markup');
        assert.equal(world.posts[0]!.url, `/bot${BOT_TOKEN}/sendMessage`);
    });

    it('PER-PERSON ROUTING: only the people the owner chose are sent to, and hot leads have their own list', async () => {
        world.members = [OWNER, OPERATOR, VIEWER];
        for (const [m, chat] of [[OWNER, '1001'], [OPERATOR, '1002'], [VIEWER, '1003']] as const) world.settings[userNotifyKey(m.userId)] = linkedDoc(chat);
        world.settings[notifyRoutingKey(TENANT)] = JSON.stringify({ v: 1, handoff: ['u-viewer'], hotLeads: ['u-operator'] });

        assert.equal(await notifyPeople(request()), 'sent');
        assert.deepEqual(sentTo(), ['1003'], 'a handoff goes to the viewer the owner chose, and to nobody else');

        world.posts.length = 0;
        assert.equal(await notifyPeople(request({ kind: 'hot_lead', bucket: 'notify_people_hot:conv-1', limit: HOT_LEAD_ALERTS_PER_HOUR, notice: async () => ({ ...NOTICE, kind: 'hot_lead', reason: 'hot_lead' }) })), 'sent');
        assert.deepEqual(sentTo(), ['1002'], 'a hot lead goes to the person chosen for hot leads');
    });

    it('never to a paused person, a deactivated account, a platform admin, or someone who left the workspace', async () => {
        world.members = [
            { ...OWNER }, { ...OPERATOR, active: false }, { ...VIEWER, role: 'operator', userRole: 'platform_admin' },
            { userId: 'u-paused', email: 'paused@company.test', role: 'operator' },
        ];
        world.settings[userNotifyKey('u-owner')] = linkedDoc('1001');
        world.settings[userNotifyKey('u-operator')] = linkedDoc('1002');
        world.settings[userNotifyKey('u-viewer')] = linkedDoc('1003');
        world.settings[userNotifyKey('u-paused')] = linkedDoc('1004', { paused: true });
        world.settings[userNotifyKey('u-left')] = linkedDoc('1005');
        world.settings[notifyRoutingKey(TENANT)] = JSON.stringify({ v: 1, handoff: ['u-owner', 'u-operator', 'u-viewer', 'u-paused', 'u-left'], hotLeads: [] });
        assert.equal(await notifyPeople(request()), 'sent');
        assert.deepEqual(sentTo(), ['1001']);
    });

    it('nobody linked is "none": no allowance is spent and nothing is sent', async () => {
        world.members = [OWNER, OPERATOR];
        assert.equal(await notifyPeople(request()), 'none');
        assert.deepEqual(world.posts, []);
        assert.equal(world.counters.size, 0, 'the conversation\'s allowance is spent only when somebody would be written to');
    });

    it('the platform owner\'s own chat is not told a second time in his own workspace, but another workspace\'s person with the same chat is', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('4242');
        assert.equal(await notifyPeople(request({ creatorId: world.owner, telegram: { token: BOT_TOKEN, chatId: '4242' } })), 'none');
        assert.deepEqual(world.posts, []);
        assert.equal(await notifyPeople(request({ creatorId: TENANT, telegram: { token: BOT_TOKEN, chatId: '4242' } })), 'sent');
        assert.deepEqual(sentTo(), ['4242']);
    });

    it('one allowance per conversation per kind: three handoffs an hour, then rate_limited, and a hot lead has its own', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        const outcomes: string[] = [];
        for (let i = 0; i < HANDOFF_ALERTS_PER_HOUR + 1; i++) outcomes.push(await notifyPeople(request()));
        assert.deepEqual(outcomes, ['sent', 'sent', 'sent', 'rate_limited']);
        assert.equal(world.posts.length, HANDOFF_ALERTS_PER_HOUR);
        assert.equal(await notifyPeople(request({ kind: 'hot_lead', bucket: 'notify_people_hot:conv-1', limit: HOT_LEAD_ALERTS_PER_HOUR })), 'sent', 'the hot lead bucket is separate');
        assert.ok(world.counters.has('notify_people:conv-1') && world.counters.has('notify_people_hot:conv-1'));
        assert.ok(![...world.counters.keys()].some((k) => k.startsWith('notify:') || k.startsWith('notify_hot:')), 'and apart from the owner\'s buckets');
    });

    it('a limiter that cannot be read lets the notice through, and says so', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        world.limiterDown = true;
        assert.equal(await notifyPeople(request()), 'sent');
        assert.ok(world.logged.some((l) => l.event === 'notify.people_limiter_failed'));
    });

    it('a chat that refuses costs the others nothing: the notice is sent, the failure counted without an id', async () => {
        world.members = [OWNER, OPERATOR];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        world.settings[userNotifyKey(OPERATOR.userId)] = linkedDoc('1002');
        world.send = (chatId) => {
            if (chatId === '1001') throw Object.assign(new Error('blocked'), { response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } });
            return { data: { ok: true } };
        };
        assert.equal(await notifyPeople(request()), 'sent');
        assert.equal(world.posts.length, 2, 'both were tried');
        const sentLine = world.logged.find((l) => l.event === 'notify.people_sent');
        const failedLine = world.logged.find((l) => l.event === 'notify.people_failed');
        assert.deepEqual([sentLine?.['count'], sentLine?.['kind'], failedLine?.['count']], [1, 'handoff', 1]);
        assert.equal(await notifyPeople(request({ bucket: 'notify_people:conv-2' })), 'sent');
    });

    it('every chat refusing is "failed": nothing throws', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        world.send = () => { throw Object.assign(new Error('boom'), { code: 'ECONNABORTED' }); };
        assert.equal(await notifyPeople(request()), 'failed');
    });

    it('a database that cannot be read is "error", never a throw', async () => {
        const original = world.members;
        world.members = new Proxy(original, { get() { throw new Error('connection terminated'); } });
        assert.equal(await notifyPeople(request()), 'error');
    });

    it('the bot token and a chat id are in no log line, no audit row and no statement parameter', async () => {
        world.members = [OWNER];
        world.settings[userNotifyKey(OWNER.userId)] = linkedDoc('1001');
        world.send = () => { throw Object.assign(new Error('x'), { response: { status: 400, data: { description: `bad request ${BOT_TOKEN}` } } }); };
        await notifyPeople(request());
        const seen = JSON.stringify([world.logs, world.audits, world.params.filter((p) => !p.some((v) => typeof v === 'string' && v.startsWith('user.notify.')))]);
        assert.ok(!seen.includes(BOT_TOKEN), 'no token');
        assert.ok(!seen.includes('1001'), 'no chat id');
    });
});

// ─── The owner's own alert is what it was ──────────────────────────────────────────────────────────────

describe('notifyOwner: the platform owner\'s alert did not change', () => {
    const PLAN = { kind: 'handoff', reason: 'refund' } as const;
    const base = (creatorId: string) => ({ creatorId, conversationId: 'conv-1', plan: PLAN, language: 'en' });
    const PEOPLE_READ = /FROM memberships m/;

    it('with no bot token and nothing switched on: outcome off, and not one statement beyond the settings read', async () => {
        const outcome = await notifyOwner(base(world.owner));
        assert.equal(outcome, 'off');
        assert.equal(world.executed.length, 1, 'only readNotifyChannels\' one round trip');
        assert.ok(!world.executed.some((s) => PEOPLE_READ.test(s)));
    });

    it('with the owner\'s Telegram on and NOBODY linked: his alert goes out exactly once, and the only extra statement is the one read of the members', async () => {
        world.withTelegram({ 'notify.telegram_chat_id': '4242', 'notify.telegram_enabled': 'true', 'app.public_base_url': 'https://msg.example' });
        world.members = [OWNER];
        const outcome = await notifyOwner(base(world.owner));
        assert.equal(outcome, 'sent');
        assert.deepEqual(sentTo(), ['4242']);
        assert.equal(world.executed.filter((s) => PEOPLE_READ.test(s)).length, 1);
        assert.equal(world.executed.filter((s) => /SELECT c\.username/.test(s)).length, 1, 'the notice is looked up ONCE for both paths');
    });

    it('another workspace\'s conversation: the owner\'s chat is never sent to (not_owner), and its linked people ARE', async () => {
        world.withTelegram({ 'notify.telegram_chat_id': '4242', 'notify.telegram_enabled': 'true' });
        world.members = [OWNER, OPERATOR];
        const quiet = await notifyOwner(base(TENANT));
        assert.equal(quiet, 'not_owner', 'nobody linked: the outcome is what it always was');
        assert.deepEqual(world.posts, []);

        world.settings[userNotifyKey(OPERATOR.userId)] = linkedDoc('1002');
        const outcome = await notifyOwner({ ...base(TENANT), conversationId: 'conv-2' });
        assert.equal(outcome, 'sent');
        assert.deepEqual(sentTo(), ['1002'], 'the operator, and not the owner\'s own chat 4242');
    });

    it('a bot token with the owner\'s alerts OFF still tells a workspace\'s linked people (the token is the sender)', async () => {
        world.withTelegram();
        world.members = [OPERATOR];
        world.settings[userNotifyKey(OPERATOR.userId)] = linkedDoc('1002');
        assert.equal(await notifyOwner(base(TENANT)), 'sent');
        assert.deepEqual(sentTo(), ['1002']);
    });

    it('when the owner\'s own path fails but a person was told, the alert counts as sent; when both fail it is the platform\'s outcome', async () => {
        world.withTelegram({ 'notify.telegram_chat_id': '4242', 'notify.telegram_enabled': 'true' });
        world.members = [OWNER];
        world.send = (chatId) => {
            if (chatId === '4242') throw Object.assign(new Error('x'), { response: { status: 403, data: { description: 'Forbidden' } } });
            return { data: { ok: true } };
        };
        world.settings[userNotifyKey('u-owner')] = linkedDoc('1001');
        assert.equal(await notifyOwner(base(world.owner)), 'sent');
        world.send = () => { throw Object.assign(new Error('x'), { code: 'ECONNABORTED' }); };
        assert.equal(await notifyOwner({ ...base(world.owner), conversationId: 'conv-9' }), 'failed');
    });
});
