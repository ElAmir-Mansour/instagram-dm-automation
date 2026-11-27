/**
 * The notices cards (`dashboard/js/pages/notify_card.js`, U3 SA-11): a person's own Telegram, and the owner's routing table.
 *
 * The real file runs in the harness's `node:vm` context with the real dictionaries, and `API` is a stub that answers what a test arranges
 * (nothing reaches a network). Pinned, because each is a way a person is misled or a secret shows:
 *
 *   - Mine says WHY there is no button (no bot on the platform, no account of their own, the account manager's own alerts) and draws the Link
 *     button only when it can work; a linked person sees their first name, Pause and Unlink, and the chat id is nowhere in the markup;
 *   - the handshake: Link opens Telegram's own address in a new tab, polls `confirm` until the answer is "linked", stops at an expired code,
 *     stops when the card leaves the page, never opens an address that is not `https://t.me/<bot>?start=<code>`;
 *   - the routing table escapes everything a person typed (an email), names each box for a screen reader, tracks unsaved changes
 *     (`canLeave()`), saves exactly the ticked ids, and draws nothing for anyone but the owner.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

function load(lang: 'en' | 'ar' = 'en', api: Record<string, (...a: any[]) => any> = {}) {
    const calls: Array<{ fn: string; args: unknown[] }> = [];
    const stub: Record<string, (...a: any[]) => any> = {};
    for (const [name, fn] of Object.entries(api)) stub[name] = (...args: any[]) => { calls.push({ fn: name, args }); return fn(...args); };
    const toasts: Array<{ message: string; type: unknown }> = [];
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/notify_card.js'], globals: { API: stub } });
    h.UI.toast = (message: string, type: unknown) => { toasts.push({ message, type }); return null; };
    const opened: Array<{ url: string; target: string; features: string }> = [];
    h.window.open = (url: string, target: string, features: string) => { opened.push({ url, target, features }); return null; };
    const Card = h.run('NotifyCard') as Json;
    Card.POLL_MS = 1;
    return { h, Card, calls, toasts, opened };
}

const ME = (over: Record<string, unknown> = {}) => ({
    hasAccount: true, platformAdmin: false, botReady: true, telegram: { linked: false, linkedAt: null, name: null, paused: false }, covers: { handoff: true, hotLeads: true }, ...over,
});
const LINKED = { linked: true, linkedAt: '2026-11-28T10:00:00.000Z', name: 'Sara', paused: false };
const URL_OK = 'https://t.me/autoreply_pro_bot?start=' + 'A'.repeat(43);

describe('mountMine: what a person sees', () => {
    it('always names the Inbox badge and Today, and offers Link when there is a bot and an account', async () => {
        const { Card, h } = load('en', { getNotifyMe: async () => ME() });
        const host = new FakeEl('host');
        await Card.mountMine(host, { hasAccount: true });
        assert.match(host.innerHTML, /Always on: the Inbox badge and Today\./);
        assert.match(host.innerHTML, /data-action="notifyCard:link"[^>]*>Link Telegram</);
        assert.match(host.innerHTML, /You are told when a conversation needs you, and when a customer is ready to buy\./);
        assert.ok(h.t('notifyMe.title'));
    });

    it('says why there is no button: no bot on the platform, no account of one\'s own, or the account manager', async () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ botReady: false }, /Not set up on this platform yet\./],
            [{ hasAccount: false, telegram: null }, /Sign in with your own account to get notices on Telegram\./],
            [{ platformAdmin: true }, /Settings → Platform → Alerts/],
        ];
        for (const [over, text] of cases) {
            const { Card } = load('en', { getNotifyMe: async () => ME(over) });
            const host = new FakeEl('host');
            await Card.mountMine(host, {});
            assert.match(host.innerHTML, text);
            assert.doesNotMatch(host.innerHTML, /notifyCard:link/, 'and no button that could not work');
        }
    });

    it('a linked person sees their first name, Pause and Unlink; a paused one sees Resume and why; the chat id is nowhere', async () => {
        const { Card } = load('en', { getNotifyMe: async () => ME({ telegram: LINKED }) });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        assert.match(host.innerHTML, /Linked as Sara/);
        assert.match(host.innerHTML, /notifyCard:pause[^>]*>Pause</);
        assert.match(host.innerHTML, /notifyCard:unlink[^>]*>Unlink</);
        const paused = load('en', { getNotifyMe: async () => ME({ telegram: { ...LINKED, paused: true } }) });
        const host2 = new FakeEl('host');
        await paused.Card.mountMine(host2, {});
        assert.match(host2.innerHTML, /notifyCard:pause[^>]*>Resume</);
        assert.match(host2.innerHTML, /Paused: nothing is sent to Telegram until you resume\./);
    });

    it('escapes a first name that is markup, and a failed read says so instead of drawing nothing', async () => {
        const evil = load('en', { getNotifyMe: async () => ME({ telegram: { ...LINKED, name: '<img src=x onerror=alert(1)>' } }) });
        const host = new FakeEl('host');
        await evil.Card.mountMine(host, {});
        assert.doesNotMatch(host.innerHTML, /<img/);
        assert.match(host.innerHTML, /&lt;img/);

        const failing = load('en', { getNotifyMe: async () => { throw Object.assign(new Error('boom'), { message: 'boom' }); } });
        const host2 = new FakeEl('host');
        await failing.Card.mountMine(host2, {});
        assert.match(host2.innerHTML, /Could not load your notices/);
    });

    it('is the same card in Arabic, in the glossary\'s words', async () => {
        const { Card } = load('ar', { getNotifyMe: async () => ME() });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        assert.match(host.innerHTML, /دائمًا: شارة الرسائل وصفحة اليوم\./);
        assert.match(host.innerHTML, /اربط تيليجرام/);
        assert.match(host.innerHTML, /بحاجة إليك/);
    });
});

describe('the handshake', () => {
    it('opens Telegram\'s own address in a new tab, polls until the answer is "linked", then shows the name and stops', async () => {
        let polls = 0;
        const { Card, opened, toasts, calls } = load('en', {
            getNotifyMe: async () => (polls >= 2 ? ME({ telegram: LINKED }) : ME()),
            startTelegramLink: async () => ({ url: URL_OK, expiresAt: 'x' }),
            confirmTelegramLink: async () => { polls += 1; return polls >= 2 ? { linked: true, name: 'Omar' } : { linked: false }; },
        });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        await Card.startLink();
        assert.deepEqual(opened, [{ url: URL_OK, target: '_blank', features: 'noopener,noreferrer' }]);
        assert.match(host.innerHTML, /Waiting for you in Telegram/);
        assert.match(host.innerHTML, new RegExp(`href="${URL_OK.replace(/[?.]/g, '\\$&')}"`), 'the link is also in the card, for a blocked popup');
        await settle(40);
        await new Promise((r) => setTimeout(r, 30));
        await settle(40);
        assert.equal(polls, 2, 'asked until linked, and then no more');
        assert.equal(Card._timer, null);
        assert.match(host.innerHTML, /Linked as Sara/);
        assert.ok(toasts.some((t) => /Telegram linked as Omar/.test(t.message)));
        assert.equal(calls.filter((c) => c.fn === 'confirmTelegramLink').every((c) => c.args[0] === 'A'.repeat(43)), true, 'confirm is sent the code from the address');
    });

    it('an expired code stops the polling and offers a new link', async () => {
        let polls = 0;
        const { Card } = load('en', {
            getNotifyMe: async () => ME(),
            startTelegramLink: async () => ({ url: URL_OK, expiresAt: 'x' }),
            confirmTelegramLink: async () => { polls += 1; throw Object.assign(new Error('expired'), { code: 'TELEGRAM_LINK_EXPIRED', status: 410 }); },
        });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        await Card.startLink();
        await new Promise((r) => setTimeout(r, 30));
        await settle(20);
        assert.equal(polls, 1);
        assert.equal(Card._timer, null);
        assert.match(host.innerHTML, /That link has expired\. Link again\./);
        assert.match(host.innerHTML, /notifyCard:link/);
    });

    it('stops when the card has left the page, and after Cancel', async () => {
        let polls = 0;
        const { Card } = load('en', {
            getNotifyMe: async () => ME(),
            startTelegramLink: async () => ({ url: URL_OK, expiresAt: 'x' }),
            confirmTelegramLink: async () => { polls += 1; return { linked: false }; },
        });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        await Card.startLink();
        host.isConnected = false;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(polls, 0, 'the card is gone: no request is made for it');
        assert.equal(Card._timer, null);

        const second = load('en', {
            getNotifyMe: async () => ME(),
            startTelegramLink: async () => ({ url: URL_OK, expiresAt: 'x' }),
            confirmTelegramLink: async () => ({ linked: false }),
        });
        const host2 = new FakeEl('host');
        await second.Card.mountMine(host2, {});
        await second.Card.startLink();
        second.Card.cancelLink();
        assert.equal(second.Card._timer, null);
        assert.doesNotMatch(host2.innerHTML, /Waiting for you/);
    });

    it('never opens an address that is not Telegram\'s own', async () => {
        for (const url of ['https://evil.test/x?start=abc', 'javascript:alert(1)', 'https://t.me/bot?start=abc&x=1', 'http://t.me/bot?start=abc', undefined]) {
            const { Card, opened, toasts } = load('en', { getNotifyMe: async () => ME(), startTelegramLink: async () => ({ url }) });
            const host = new FakeEl('host');
            await Card.mountMine(host, {});
            await Card.startLink();
            assert.deepEqual(opened, [], String(url));
            assert.ok(toasts.some((t) => t.type === 'error'), 'and says it did not work');
            assert.equal(Card._timer, null);
        }
    });

    it('a refused link (the platform has no bot) says so and does not wait', async () => {
        const { Card, toasts, opened } = load('en', {
            getNotifyMe: async () => ME(),
            startTelegramLink: async () => { throw Object.assign(new Error('x'), { code: 'TELEGRAM_BOT_MISSING', status: 409, message: 'Telegram alerts are not set up on this platform yet.' }); },
        });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        await Card.startLink();
        assert.deepEqual(opened, []);
        assert.equal(toasts.length, 1);
        assert.equal(Card.linkState, 'idle');
    });

    it('pause and unlink ask the server and repaint from its answer', async () => {
        const { Card, calls, toasts } = load('en', {
            getNotifyMe: async () => ME({ telegram: LINKED }),
            setNotifyPaused: async (paused: boolean) => ME({ telegram: { ...LINKED, paused } }),
            unlinkTelegram: async () => ({ linked: false }),
        });
        const host = new FakeEl('host');
        await Card.mountMine(host, {});
        await Card.togglePause();
        assert.deepEqual(calls.find((c) => c.fn === 'setNotifyPaused')!.args, [true]);
        assert.match(host.innerHTML, /Paused: nothing is sent/);
        await Card.unlinkTelegram();
        assert.match(host.innerHTML, /Link Telegram/);
        assert.ok(toasts.some((t) => /Telegram unlinked/.test(t.message)));
    });
});

describe('mountRouting: the owner\'s table', () => {
    const ROUTING = {
        botReady: true, defaults: true,
        members: [
            { userId: 'u-owner', email: 'owner@company.test', role: 'owner', telegramLinked: true },
            { userId: 'u-op', email: '<b>op</b>@company.test', role: 'operator', telegramLinked: false },
            { userId: 'u-view', email: 'view@company.test', role: 'viewer', telegramLinked: false },
        ],
        handoff: ['u-owner', 'u-op'], hotLeads: ['u-owner', 'u-op'],
    };

    it('draws one row per member with two boxes each, ticked as the server says, escaped, and tells who will only see it in the Inbox', async () => {
        const { Card } = load('en', { getNotifyRouting: async () => ROUTING });
        const host = new FakeEl('host');
        await Card.mountRouting(host, { canAdminister: true });
        const rows = host.innerHTML.split('<tr data-user-id=').slice(1);
        assert.equal(rows.length, 3);
        assert.match(host.innerHTML, /Nothing chosen yet: the workspace&#39;s owners and operators are told\./);
        assert.doesNotMatch(host.innerHTML, /<b>op<\/b>/);
        assert.match(host.innerHTML, /&lt;b&gt;op&lt;\/b&gt;@company\.test/);
        const boxes = (row: string) => (row.match(/<input type="checkbox"[^>]*>/g) ?? []).map((b) => /\schecked/.test(b));
        assert.deepEqual(rows.map(boxes), [[true, true], [true, true], [false, false]]);
        assert.match(rows[2]!, /has not linked Telegram: will see it in the Inbox/);
        assert.match(rows[0]!, /Tell owner@company\.test when a conversation needs a person/, 'each box is named for a screen reader');
    });

    it('an unsaved change blocks leaving, Save sends exactly the ticked ids, and then leaving is free', async () => {
        const { Card, calls } = load('en', {
            getNotifyRouting: async () => ROUTING,
            saveNotifyRouting: async (body: Json) => ({ ...ROUTING, defaults: false, handoff: body.handoff, hotLeads: body.hotLeads }),
        });
        const host = new FakeEl('host');
        await Card.mountRouting(host, { canAdminister: true });
        assert.equal(Card.canLeave(), true);
        Card.toggleBox({ checked: true, dataset: { column: 'handoff', userId: 'u-view' } });
        Card.toggleBox({ checked: false, dataset: { column: 'hotLeads', userId: 'u-op' } });
        assert.equal(Card.canLeave(), false, 'unsaved changes');
        await Card.saveRouting();
        assert.deepEqual(JSON.parse(JSON.stringify(calls.find((c) => c.fn === 'saveNotifyRouting')!.args[0])), { handoff: ['u-owner', 'u-op', 'u-view'], hotLeads: ['u-owner'] });
        assert.equal(Card.canLeave(), true);
        assert.doesNotMatch(host.innerHTML, /Nothing chosen yet/);
    });

    it('a refused save keeps the changes and says so', async () => {
        const { Card, toasts } = load('en', {
            getNotifyRouting: async () => ROUTING,
            saveNotifyRouting: async () => { throw Object.assign(new Error('x'), { code: 'ROUTING_INVALID', status: 400, message: 'That person is not in this workspace.' }); },
        });
        const host = new FakeEl('host');
        await Card.mountRouting(host, { canAdminister: true });
        Card.toggleBox({ checked: true, dataset: { column: 'handoff', userId: 'u-view' } });
        await Card.saveRouting();
        assert.equal(Card.canLeave(), false);
        assert.ok(toasts.some((t) => t.type === 'error'));
    });

    it('draws nothing, and asks nothing, for anyone but the owner; tells the owner when there is no bot', async () => {
        const quiet = load('en', {});
        const host = new FakeEl('host');
        host.innerHTML = 'stale';
        await quiet.Card.mountRouting(host, { canAdminister: false });
        assert.equal(host.innerHTML, '');
        assert.deepEqual(quiet.calls, []);

        const noBot = load('en', { getNotifyRouting: async () => ({ ...ROUTING, botReady: false }) });
        const host2 = new FakeEl('host');
        await noBot.Card.mountRouting(host2, { canAdminister: true });
        assert.match(host2.innerHTML, /Telegram is not set up on this platform yet/);
    });

    it('is registered as a non-routable page module with its own stylesheet, so Settings can load it and the route list does not grow', () => {
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.match(app, /notify_card: \{ src: 'notify_card', page: \(\) => NotifyCard, routable: false, css: true \},/);
        assert.ok(readFileSync('dashboard/css/pages/notify_card.css', 'utf8').includes('.notify-routing-table'));
    });
});
