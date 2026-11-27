/**
 * Today's go-live card and the staff orientation card (`dashboard/js/pages/overview.js`, U3 SA-12), and the two small changes that came
 * with them: a failed row's raw Graph text goes through `UI.failure`, and Today stops offering what the workspace does not have.
 *
 * The real file runs in the harness's `node:vm` context with the real dictionaries; `App` and `API` are stubs a test arranges. Pinned:
 *
 *   - the card is drawn only from a well-formed `show: true`; an item or a button name that is not one of ours is never put in the page
 *     (an unknown id is dropped; an address that is not a screen of this dashboard has no button); everything from the server is escaped;
 *   - ONE to-do card, not two: while the checklist shows the profile card stays out, whichever answer lands first;
 *   - only the OWNER asks (nobody else makes the request), Hide acts first and offers an Undo that asks for it back, and
 *     `#/overview?golive=show` brings a hidden checklist back before it is read;
 *   - the orientation card is for an operator or a viewer, once per browser (per workspace and person), and survives blocked storage;
 *   - a failed row reads as a sentence with the raw text behind Details, dated when `updated_at` is there;
 *   - Today has no Growth strip and no "View all" for a workspace without those modules.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeEl, loadDashboard, type Json } from './_harness.js';

interface Opts {
    lang?: 'ar' | 'en';
    role?: 'owner' | 'operator' | 'viewer';
    admin?: boolean;
    modules?: string[] | null;
    api?: Record<string, (...a: any[]) => any>;
    hash?: string;
    storage?: 'ok' | 'blocked';
    userId?: string | null;
}

function load(o: Opts = {}) {
    const role = o.role ?? 'owner';
    const calls: string[] = [];
    const api: Record<string, (...a: any[]) => any> = {};
    for (const [name, fn] of Object.entries(o.api ?? {})) api[name] = (...args: any[]) => { calls.push(name); return fn(...args); };
    const saved = new Map<string, string>();
    const App: Json = {
        pages: { overview: {}, settings: {}, campaigns: {}, ai_settings: {}, inbox: {}, welcome: { routable: false }, tenants: { adminOnly: true } },
        session: { tenantId: 't1', userId: o.userId === undefined ? 'u1' : o.userId, role: o.admin ? 'platform_admin' : 'user', tenantRole: role },
        tenantRole: () => role,
        canAdminister: () => role === 'owner',
        canOperate: () => role !== 'viewer',
        isAdmin: () => o.admin === true,
        currentTenant: () => ({ id: 't1', name: 'The Knowledge Hub' }),
        hashParam: (name: string) => new URLSearchParams((o.hash ?? '').split('?')[1] ?? '').get(name) ?? '',
        ...(o.modules === undefined ? {} : { hasModule: (id: string) => o.modules === null || (o.modules ?? []).includes(id) }),
    };
    const h = loadDashboard({ lang: o.lang ?? 'en', files: ['dashboard/js/pages/overview.js'], globals: { App, API: api } });
    const toasts: Array<{ message: string; opts: Json }> = [];
    h.UI.undoToast = (message: string, opts: Json) => { toasts.push({ message, opts }); return Promise.resolve(false); };
    h.UI.toast = (message: string) => { toasts.push({ message, opts: null }); return null; };
    h.window.localStorage = {
        getItem: (k: string) => { if (o.storage === 'blocked') throw new Error('blocked'); return saved.get(k) ?? null; },
        setItem: (k: string, v: string) => { if (o.storage === 'blocked') throw new Error('blocked'); saved.set(k, v); },
    };
    const Page = h.run('OverviewPage') as Json;
    const hosts: Record<string, FakeEl> = {};
    Page.region = (name: string) => (hosts[name] ??= new FakeEl(name));
    return { h, Page, App, calls, toasts, hosts, saved };
}

const ITEMS = (done: string[]) => ['profile', 'meta', 'test_comment', 'first_reply_on', 'assistant_tested', 'team', 'alerts_chosen']
    .map((id) => ({ id, done: done.includes(id), doneAt: null, detail: id === 'meta' && done.includes('meta') ? { handle: 'acme' } : null, href: ({
        profile: '#/welcome', meta: '#/settings?s=channels&card=meta', test_comment: '#/help/go-live#test-comment', first_reply_on: '#/campaigns',
        assistant_tested: '#/ai_settings', team: '#/settings?s=team', alerts_chosen: '#/settings?s=notifications',
    } as Record<string, string>)[id] }));
const ANSWER = (done: string[] = ['meta'], over: Json = {}) => ({
    show: true, done: done.length, total: 7, live: false, liveAt: null, dismissedAt: null, items: ITEMS(done), optional: [], activation: {}, ...over,
});
const fulfilled = (value: unknown) => ({ status: 'fulfilled', value });

describe('the go-live card', () => {
    it('draws the title with the name and the count, one row per item with ✓ or ○ and one button, and a Hide', () => {
        const { Page, hosts } = load();
        Page.fillGoLive(fulfilled(ANSWER(['meta'])));
        const html = hosts['golive']!.innerHTML;
        assert.match(html, /Get The Knowledge Hub live · 1 of 7/);
        assert.equal((html.match(/<li class="golive-item/g) ?? []).length, 7);
        assert.match(html, /data-item="meta" data-done="true"/);
        assert.match(html, /data-item="team" data-done="false"/);
        assert.match(html, /<span class="golive-detail" dir="ltr">@acme<\/span>/);
        assert.match(html, /data-action="overview:hideGoLive"/);
        // A done item has no button; an item still to do has the right one.
        const meta = html.split('data-item="meta"')[1]!.split('</li>')[0]!;
        assert.doesNotMatch(meta, /<button/);
        assert.match(html, /data-action="app:navigate" data-target="settings" data-query="s=team">Invite</);
        assert.match(html, /data-action="app:navigate" data-target="campaigns">Open keyword replies</);
        assert.match(html, /data-action="app:navigate" data-target="ai_settings">Try it</);
        assert.match(html, /href="#\/help\/go-live#test-comment"/, 'the test comment points at Help');
        assert.equal(Page._goLiveShown, true);
    });

    it('the profile item has no button for the owner, and the setup button for the platform admin', () => {
        const owner = load({ role: 'owner' });
        owner.Page.fillGoLive(fulfilled(ANSWER([])));
        assert.doesNotMatch(owner.hosts['golive']!.innerHTML.split('data-item="profile"')[1]!.split('</li>')[0]!, /<button/);
        const admin = load({ admin: true });
        admin.Page.fillGoLive(fulfilled(ANSWER([])));
        assert.match(admin.hosts['golive']!.innerHTML.split('data-item="profile"')[1]!.split('</li>')[0]!, /data-action="overview:wizard"/);
    });

    it('never draws what it does not know: an unknown item id, an address that is not a screen here, markup in a handle', () => {
        const { Page, hosts } = load();
        const answer = ANSWER(['meta']);
        answer.items.push({ id: '<script>x</script>', done: false, doneAt: null, detail: null, href: '#/settings' } as any);
        answer.items[1]!.detail = { handle: '<img src=x onerror=alert(1)>' } as any;
        answer.items[3]!.href = '#/tenants' as any; // an admin-only screen
        answer.items[5]!.href = 'javascript:alert(1)' as any;
        Page.fillGoLive(fulfilled(answer));
        const html = hosts['golive']!.innerHTML;
        assert.doesNotMatch(html, /<script>|<img|javascript:/);
        assert.equal((html.match(/<li class="golive-item/g) ?? []).length, 7, 'the unknown id is dropped');
        const keywordRow = html.split('data-item="first_reply_on"')[1]!.split('</li>')[0]!;
        const teamRow = html.split('data-item="team"')[1]!.split('</li>')[0]!;
        assert.doesNotMatch(keywordRow + teamRow, /<button/, 'no button for an address that is not an openable screen');
    });

    it('anything but a well-formed show: true draws nothing and never hurts the page', () => {
        for (const res of [null, { status: 'rejected', reason: new Error('x') }, fulfilled({ show: false }), fulfilled({ show: true }), fulfilled({ show: true, items: 'x' }), fulfilled(null)]) {
            const { Page, hosts } = load();
            Page.fillGoLive(res);
            assert.equal((hosts['golive']?.innerHTML ?? ''), '');
            assert.equal(Page._goLiveShown, false);
        }
    });

    it('live is one line, not the list', () => {
        const { Page, hosts } = load();
        Page.fillGoLive(fulfilled(ANSWER(['profile', 'meta'], { live: true, liveAt: '2026-11-28T10:00:00.000Z' })));
        const html = hosts['golive']!.innerHTML;
        assert.match(html, /<strong>You&#39;re live<\/strong>/);
        assert.doesNotMatch(html, /golive-items/);
    });

    it('optional items are offered only while undone', () => {
        const { Page, hosts } = load();
        Page.fillGoLive(fulfilled(ANSWER(['meta'], { optional: [{ id: 'whatsapp', done: false, href: '#/settings?s=channels&card=whatsapp' }, { id: 'youtube', done: true, href: '#/settings' }] })));
        assert.match(hosts['golive']!.innerHTML, /data-query="s=channels&amp;card=whatsapp">Connect WhatsApp</);
        assert.doesNotMatch(hosts['golive']!.innerHTML, /Connect YouTube/);
    });

    it('is the same card in Arabic', () => {
        const { Page, hosts } = load({ lang: 'ar' });
        Page.fillGoLive(fulfilled(ANSWER(['meta'])));
        assert.match(hosts['golive']!.innerHTML, /أطلِق The Knowledge Hub · 1 من 7/);
        assert.match(hosts['golive']!.innerHTML, /اربط إنستجرام وفيسبوك/);
    });
});

describe('one to-do card, not two', () => {
    const PROGRESS = fulfilled({ percent: 46, complete: false, canEdit: true, actions: [{ id: 'audience', link: { kind: 'ask', fields: ['audience'] } }] });

    it('while the checklist shows, the profile card stays out, whichever answer lands first', () => {
        const a = load();
        a.Page.fillGoLive(fulfilled(ANSWER()));
        a.Page.fillProfile(PROGRESS);
        assert.equal(a.hosts['profile']!.innerHTML, '');

        const b = load();
        b.Page.fillProfile(PROGRESS);
        assert.match(b.hosts['profile']!.innerHTML, /profile-card/, 'drawn while nothing says otherwise');
        b.Page.fillGoLive(fulfilled(ANSWER()));
        assert.equal(b.hosts['profile']!.innerHTML, '', 'and taken away when the checklist lands');
    });

    it('with no checklist the profile card is drawn as it always was', () => {
        const { Page, hosts } = load();
        Page.fillGoLive(fulfilled({ show: false }));
        Page.fillProfile(PROGRESS);
        assert.match(hosts['profile']!.innerHTML, /profile-card/);
    });
});

describe('who asks, hiding and bringing it back', () => {
    it('only the owner makes the request; an operator and a viewer make none', async () => {
        for (const role of ['operator', 'viewer'] as const) {
            const { Page, calls } = load({ role, api: { getGoLive: async () => ANSWER() } });
            assert.equal(await Page.askGoLive(), null);
            assert.deepEqual(calls, []);
        }
        const owner = load({ api: { getGoLive: async () => ANSWER() } });
        assert.equal((await owner.Page.askGoLive()).status, 'fulfilled');
    });

    it('?golive=show brings a hidden checklist back BEFORE it is read', async () => {
        const order: string[] = [];
        const { Page } = load({ hash: '#/overview?golive=show', api: { undismissGoLive: async () => { order.push('undismiss'); return {}; }, getGoLive: async () => { order.push('get'); return ANSWER(); } } });
        await Page.askGoLive();
        assert.deepEqual(order, ['undismiss', 'get']);
        const plain = load({ hash: '#/overview', api: { undismissGoLive: async () => { throw new Error('no'); }, getGoLive: async () => ANSWER() } });
        assert.equal((await plain.Page.askGoLive()).status, 'fulfilled');
    });

    it('Hide asks the server, clears the card at once, and offers an Undo that asks for it back and draws it again', async () => {
        const { Page, hosts, toasts, calls } = load({ api: { dismissGoLive: async () => ({ dismissedAt: 'x' }), undismissGoLive: async () => ({ dismissedAt: null }), getGoLive: async () => ANSWER(['meta']) } });
        Page.fillGoLive(fulfilled(ANSWER()));
        await Page.hideGoLive(new FakeEl('btn'));
        assert.ok(calls.includes('dismissGoLive'));
        assert.equal(hosts['golive']!.innerHTML, '');
        assert.equal(Page._goLiveShown, false);
        assert.equal(toasts.length, 1);
        await toasts[0]!.opts.onUndo();
        assert.ok(calls.includes('undismissGoLive'));
        assert.match(hosts['golive']!.innerHTML, /Get The Knowledge Hub live/);
    });

    it('a refused Hide says so and leaves the card where it was', async () => {
        const { Page, hosts, toasts } = load({ api: { dismissGoLive: async () => { throw new Error('nope'); } } });
        Page.fillGoLive(fulfilled(ANSWER()));
        await Page.hideGoLive(new FakeEl('btn'));
        assert.match(hosts['golive']!.innerHTML, /Get The Knowledge Hub live/);
        assert.equal(toasts.length, 1);
    });
});

describe('the staff orientation card', () => {
    it('an operator sees their role in plain words, where to choose how they are told, and the inbox', () => {
        const { Page, hosts } = load({ role: 'operator' });
        Page.fillOrientation();
        const html = hosts['golive']!.innerHTML;
        assert.match(html, /Welcome to your workspace/);
        assert.match(html, /Your role: Operator\./);
        assert.match(html, /data-target="settings" data-query="s=notifications">Choose how you&#39;re told</);
        assert.match(html, /data-target="inbox">Open the inbox</);
    });

    it('is once per browser, per workspace and person: closing it remembers, and a seen card is not drawn again', () => {
        const { Page, hosts, saved } = load({ role: 'viewer' });
        Page.fillOrientation();
        assert.ok(hosts['golive']!.innerHTML);
        Page.closeOrientation();
        assert.equal(hosts['golive']!.innerHTML, '');
        assert.deepEqual([...saved.keys()], ['orientation_seen:t1:u1']);
        hosts['golive']!.innerHTML = '';
        Page.fillOrientation();
        assert.equal(hosts['golive']!.innerHTML, '');
    });

    it('the shared-password session is "shared", and blocked storage shows the card rather than hiding it', () => {
        const shared = load({ role: 'viewer', userId: null });
        shared.Page.fillOrientation();
        shared.Page.closeOrientation();
        assert.deepEqual([...shared.saved.keys()], ['orientation_seen:t1:shared']);

        const blocked = load({ role: 'operator', storage: 'blocked' });
        blocked.Page.fillOrientation();
        assert.ok(blocked.hosts['golive']!.innerHTML, 'drawn');
        assert.doesNotThrow(() => blocked.Page.closeOrientation());
    });

    it('the owner and the platform admin never see it', () => {
        for (const o of [{ role: 'owner' as const }, { role: 'operator' as const, admin: true }]) {
            const { Page, hosts } = load(o);
            Page.fillOrientation();
            assert.equal(hosts['golive']?.innerHTML ?? '', '');
        }
    });
});

describe('what else changed on Today', () => {
    it('a failed row reads as a sentence with the raw text behind Details, and says when', () => {
        const { Page, h } = load();
        const raw = '(#10) Application does not have permission for this action [code 10, fbtrace_id AbC123]';
        const markup = String(Page.renderRecent([
            { id: 'i1', status: 'FAILED', error_log: raw, trigger_keyword: 'سعر', timestamp: '2026-11-27T10:00:00.000Z', updated_at: '2026-11-27T10:00:05.000Z', username: 'sara', instagram_user_id: '1' },
        ]).value ?? '');
        assert.match(markup, /data-failure="/);
        assert.match(markup, /<details class="error-details">/);
        const detailsAt = markup.indexOf('<details');
        assert.ok(markup.indexOf('fbtrace_id') > detailsAt, 'the raw Graph text is inside Details, never the main line');
        assert.match(markup, /failure-when/, 'dated');
        assert.ok(h.t('error.details'));
        const undated = String(Page.renderRecent([{ id: 'i2', status: 'FAILED', error_log: raw, timestamp: '2026-11-27T10:00:00.000Z' }]).value ?? '');
        assert.doesNotMatch(undated, /failure-when/, 'no date when updated_at is absent');
    });

    it('a workspace without Growth has no growth strip, and without Results no "View all"; with every module on nothing changes', () => {
        const off = load({ modules: ['inbox', 'keyword_replies', 'scheduler'] });
        assert.equal(off.Page.showsGrowth(), false);
        assert.doesNotMatch(String(off.Page.renderRecent([]).value ?? ''), /data-target="activity"/);
        const on = load({ modules: null });
        assert.equal(on.Page.showsGrowth(), true);
        assert.match(String(on.Page.renderRecent([]).value ?? ''), /data-target="activity"/);
        const legacy = load();
        assert.equal(legacy.Page.showsGrowth(), true, 'with no registry on the page everything is on, as before');
        assert.match(String(legacy.Page.renderRecent([]).value ?? ''), /data-target="activity"/);
        assert.doesNotMatch(String(off.Page.skeleton().value ?? ''), /growth-strip/);
        assert.match(String(on.Page.skeleton().value ?? ''), /data-region="golive"/);
    });

    it('a profile action that points at a screen the workspace has not got is not openable', () => {
        const { Page, App } = load();
        assert.equal(Page.isOpenablePage('campaigns'), true);
        App.shellContext = () => ({ modules: ['inbox'] });
        // `Shell` is a script global of the page: once B's registry is there, it decides.
        const h = loadDashboard({ files: ['dashboard/js/pages/overview.js'], globals: { App, Shell: { canSee: (page: string) => page !== 'campaigns' }, API: {} } });
        const P = h.run('OverviewPage') as Json;
        assert.equal(P.isOpenablePage('campaigns'), false);
        assert.equal(P.isOpenablePage('settings'), true);
        assert.equal(P.isOpenablePage('welcome'), false, 'a non-routable module is never openable');
    });
});
