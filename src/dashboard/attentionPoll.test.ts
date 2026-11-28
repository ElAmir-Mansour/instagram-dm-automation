/**
 * R4-F1 / R1-T11: ONE attention read feeds the Inbox badge and the tab title on every page.
 *
 * Found live (2026-11-28): on a full load of `#/settings` `GET /api/attention` answered `counts.inbox: 1`, but the Inbox item had no badge and the
 * title no "(1)": only the Inbox and Today ever set it, and the shell's two polls ignored `counts.inbox`. These tests run the real `app.js` and the real
 * `api.js` (only `API.request` is faked) and prove: the badge and title come from the first read after boot on a page that is neither Inbox nor
 * Today; Today and the shell asking inside 30 s make one request; admins ask every 2 minutes and everyone else every 5; and nothing is asked while
 * the tab is hidden, with one forced read when it comes back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, type Json } from './_harness.js';

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
const answer = (counts: Json = {}): Json => ({ checkedAt: 'now', items: [], counts: { inbox: 0, studio: 0, scheduler: 0, ...counts } });

function rig(options: { admin?: boolean; counts?: Json } = {}) {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const h = loadDashboard({
        app: true,
        files: ['dashboard/js/api.js'],
        globals: {
            setInterval: (fn: () => void, ms: number) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
            clearInterval: (id: number) => { if (timers[id - 1]) timers[id - 1]!.cleared = true; },
        },
    });
    const App = h.App as Json;
    const API = h.run('API') as Json;
    const requests: string[] = [];
    let counts = options.counts ?? { inbox: 2 };
    API.request = async (path: string) => { requests.push(path); return answer(counts); };
    App.session = { available: true, role: options.admin ? 'platform_admin' : 'user', userId: null, email: '', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null };
    // The Inbox nav item, with the badge that setInboxWaiting appends.
    const item = new FakeEl('', 'a');
    item.dataset = { page: 'inbox' };
    (item as Json).querySelector = (): FakeEl | null => item.children.find((c) => c.classes.has('nav-count')) ?? null;
    const find = h.document.querySelector;
    h.document.querySelector = (selector: string) => (selector === '.nav-item[data-page="inbox"]' ? item : find(selector));
    App.currentPage = 'settings';
    App.setBaseTitle('Settings · AutoReply');
    const badge = (): FakeEl | undefined => item.children.find((c) => c.classes.has('nav-count'));
    return { h, App, API, item, timers, requests, badge, setCounts: (c: Json) => { counts = c; } };
}

describe('the one attention poll', () => {
    it('shows the Inbox badge and the title count on a page that is neither Inbox nor Today, from the first read after boot', async () => {
        const r = rig();
        assert.equal(r.badge(), undefined, 'nothing before the first read');
        r.App.startAttentionPoll();
        await settle();
        assert.deepEqual(r.requests, ['/attention'], 'one read at boot, no timer tick needed');
        const badge = r.badge();
        assert.ok(badge && badge.hidden === false, 'the badge exists');
        assert.match(badge!.innerHTML, /aria-hidden="true">2</);
        assert.equal(r.h.document.title, '(2) Settings · AutoReply');
        r.setCounts({ inbox: 0 });
        await r.App.refreshAttention({ force: true });
        assert.equal(r.badge()!.hidden, true, 'and it goes at zero');
        assert.equal(r.h.document.title, 'Settings · AutoReply');
    });

    it('leaves the badge alone when an answer carries no inbox count: unknown is never 0', async () => {
        const r = rig();
        r.App.startAttentionPoll();
        await settle();
        r.setCounts({ inbox: undefined });
        await r.App.refreshAttention({ force: true });
        assert.match(r.badge()!.innerHTML, /aria-hidden="true">2</);
    });

    it('keeps the badge when a read fails, and forgets it at sign-out', async () => {
        const r = rig();
        r.App.startAttentionPoll();
        await settle();
        r.API.request = async () => { throw new Error('500'); };
        assert.equal(await r.App.refreshAttention({ force: true }), null);
        assert.equal(r.badge()!.hidden, false, 'a failed read is not "all clear"');
        r.App.stopAttentionPoll();
        r.App.setInboxWaiting(0);
        assert.equal(r.timers.every((t) => t.cleared), true);
    });

    it('is one request when Today and the shell ask inside 30 s, and when two ask at once; force asks again', async () => {
        const r = rig();
        await Promise.all([r.API.getAttention(), r.API.getAttention(), r.App.refreshAttention()]);
        assert.equal(r.requests.length, 1, 'joined while in flight');
        await r.API.getAttention();
        await r.App.refreshAttention();
        assert.equal(r.requests.length, 1, 'reused inside 30 s');
        await r.API.getAttention({ force: true });
        assert.equal(r.requests.length, 2, 'force asks again');
        r.API.forgetAttention();
        await r.API.getAttention();
        assert.equal(r.requests.length, 3, 'a forgotten answer is asked for again');
    });

    it('asks again once the 30 s are over, and never keeps a failed read', async () => {
        const r = rig();
        await r.API.getAttention();
        r.API._attention.at -= 29_000;
        await r.API.getAttention();
        assert.equal(r.requests.length, 1, 'still inside 30 s');
        r.API._attention.at -= 2_000;
        await r.API.getAttention();
        assert.equal(r.requests.length, 2, 'older than 30 s');
        r.API.request = async () => { throw new Error('boom'); };
        await assert.rejects(r.API.getAttention({ force: true }));
        r.API.request = async (path: string) => { r.requests.push(path); return answer(); };
        await r.API.getAttention();
        assert.equal(r.requests.length, 3, 'the failure was not cached');
    });

    it('beats every 2 minutes for a platform admin and every 5 for everyone else, with one timer', () => {
        const admin = rig({ admin: true });
        admin.App.startAttentionPoll();
        admin.App.startAttentionPoll();
        assert.deepEqual(admin.timers.map((t) => t.ms), [120000]);
        const other = rig();
        other.App.startAttentionPoll();
        other.App.startAttentionPoll();
        assert.deepEqual(other.timers.map((t) => t.ms), [300000]);
    });

    it('asks nothing while the tab is hidden, and reads once when it becomes visible with no fresh answer', async () => {
        const r = rig();
        r.App.startAttentionPoll();
        await settle();
        assert.equal(r.requests.length, 1);
        r.h.document.visibilityState = 'hidden';
        r.API.forgetAttention(); // so only the visibility rule can be what stops the read
        r.timers[0]!.fn();
        await settle();
        assert.equal(r.requests.length, 1, 'a hidden tab asks nothing');
        r.h.document.visibilityState = 'visible';
        r.h.fire('document', 'visibilitychange');
        await settle();
        assert.equal(r.requests.length, 2, 'one read on return when no answer is kept');
        r.timers[0]!.fn();
        await settle();
        assert.equal(r.requests.length, 2, 'the beat that follows is inside the 30 s and shares that answer');
    });

    it('flipping away and back within 30 s reuses the answer: no request', async () => {
        const r = rig();
        r.App.startAttentionPoll();
        await settle();
        assert.equal(r.requests.length, 1);
        r.h.document.visibilityState = 'hidden';
        r.h.fire('document', 'visibilitychange');
        r.h.document.visibilityState = 'visible';
        r.h.fire('document', 'visibilitychange');
        await settle();
        assert.equal(r.requests.length, 1, 'a quick tab switch must not cost a request (Vercel CPU)');
    });

    it('does not read on a visibility change after sign-out', async () => {
        const r = rig();
        r.App.startAttentionPoll();
        await settle();
        r.App.stopAttentionPoll();
        r.h.fire('document', 'visibilitychange');
        await settle();
        assert.equal(r.requests.length, 1);
    });
});

describe('what reads and what calls it', () => {
    it('Today, the Inbox and the shell use the shared read; no page keeps its own timer for /attention', async () => {
        const { readFileSync } = await import('node:fs');
        const app = readFileSync('dashboard/js/app.js', 'utf8');
        assert.equal(/API\.request\('\/attention'\)/.test(app), false, 'app.js reads through API.getAttention');
        assert.equal((app.match(/await API\.getAttention\(/g) ?? []).length, 1);
        const inbox = readFileSync('dashboard/js/pages/inbox.js', 'utf8');
        assert.equal(/App\.setInboxWaiting/.test(inbox), false, 'the Inbox no longer sets the badge from its own newest-100 list');
        assert.match(inbox, /App\.refreshAttention\(\{ force: true \}\)/);
        const today = readFileSync('dashboard/js/pages/overview.js', 'utf8');
        assert.match(today, /App\.refreshAttention\(\{ force: true \}\)/);
    });
});
