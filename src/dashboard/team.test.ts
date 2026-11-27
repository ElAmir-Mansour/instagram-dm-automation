/**
 * Team, You, Notifications, sign-in and the account area (U3, PR C): the dashboard's half.
 *
 * The REAL `settings.js`, `invite_card.js`, `admin_common.js` and `app.js` in the shared `node:vm` harness, in both languages. What is pinned:
 *
 *   - Team: every person is a row (their address escaped), a role picker for all but the account manager, who is read-only; Reset link and
 *     Remove; the open invites under "Waiting to join"; a refusal is said in words by its code, and the picker goes back;
 *   - a role change applies when picked and offers Undo; Remove asks first, with a verb on the button, and removing yourself takes you out;
 *   - the invite card has two scopes: the team's own endpoints (no tenant in a call), Operator by default, and a to-do checklist under the link;
 *   - You: Change password and Sign out everywhere (asked first; the answer's token is kept); only for a person with an account;
 *   - Notifications: fail-open when `notify_card.js` is not on this deployment (one static line, no routing card), and its hosts when it is;
 *   - the account area has Your settings (not a page link, so the 19 links hold) and the workspace chip shows one workspace's name.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

const TEAM = {
    members: [
        { userId: 'u-admin', email: 'admin@example.com', role: 'owner', isActive: true, lastLoginAt: null, you: false, accountManager: true },
        { userId: 'u-sara', email: 'sara@example.com', role: 'owner', isActive: true, lastLoginAt: new Date(Date.now() - 3_600_000).toISOString(), you: true, accountManager: false },
        { userId: 'u-ahmed', email: 'ahmed@example.com', role: 'operator', isActive: true, lastLoginAt: new Date(Date.now() - 86_400_000).toISOString(), you: false, accountManager: false },
        { userId: 'u-mona', email: '"><img src=x onerror=alert(1)>@example.com', role: 'viewer', isActive: false, lastLoginAt: null, you: false, accountManager: false },
    ],
    invites: [
        { id: 'i-1', creator_id: 'w', email: 'new@example.com', role: 'viewer', purpose: 'join', user_id: null, status: 'pending', created_at: '2026-11-27T10:00:00Z', expires_at: '2026-12-27T10:00:00Z', first_opened_at: null, open_count: 0, used_at: null, used_by_email: null, revoked_at: null },
        { id: 'i-2', creator_id: 'w', email: null, role: 'operator', purpose: 'join', user_id: null, status: 'used', created_at: '2026-11-20T10:00:00Z', expires_at: '2026-12-20T10:00:00Z', first_opened_at: null, open_count: 1, used_at: '2026-11-21T10:00:00Z', used_by_email: 'ahmed@example.com', revoked_at: null },
        { id: 'i-3', creator_id: 'w', email: null, role: 'viewer', purpose: 'join', user_id: null, status: 'revoked', created_at: '2026-11-20T10:00:00Z', expires_at: '2026-12-20T10:00:00Z', first_opened_at: null, open_count: 0, used_at: null, used_by_email: null, revoked_at: '2026-11-21T10:00:00Z' },
    ],
};
const VALID = { status: 'valid', type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: [], instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };

interface Opts { role?: 'admin' | 'owner' | 'member'; hash?: string; api?: Json; hasAccount?: boolean; notifyCard?: Json | null; modules?: string[] | null }

function load(lang: 'ar' | 'en', o: Opts = {}) {
    const calls: Array<{ method: string; args: Json[] }> = [];
    const stubs: Json = {
        token: 't',
        getTokenStatus: async () => VALID, getMetaConnection: async () => ({ enabled: false, connection: null }), getTenantHealth: async () => null,
        getTikTokConnection: async () => null, getYouTubeConnection: async () => null, getWhatsAppConnection: async () => null,
        getTeam: async () => TEAM, getAutoArchive: async () => ({ enabled: true, days: 30, minDays: 7, maxDays: 365, defaultDays: 30 }),
        getAdsSettings: async () => { throw Object.assign(new Error('off'), { status: 404 }); },
        ...(o.api ?? {}),
    };
    const api = new Proxy(stubs, {
        get: (target, prop: string) => (prop in target
            ? (typeof target[prop] === 'function' ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop](...args); } : target[prop])
            : () => Promise.reject(new Error(`API.${prop} is not stubbed`))),
    });
    const h = loadDashboard({
        lang, app: true, hash: o.hash ?? '',
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/invite_card.js', 'dashboard/js/pages/settings.js'],
        globals: { API: api },
    });
    const role = o.role ?? 'owner';
    h.App.isAdmin = () => role === 'admin';
    h.App.canAdminister = () => role !== 'member';
    h.App.canChangeOwnPassword = () => o.hasAccount ?? true;
    h.App.currentTenant = () => ({ id: 'w', name: 'Knowledge Hub' });
    // A company workspace by default (the five modules): the cards of the other channels are not on its page, so a test need not feed them.
    const modules = o.modules === undefined ? ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'] : o.modules;
    if (modules) h.App.hasModule = (id: string) => modules.includes(id);
    h.App.loadPageModule = async (name: string) => {
        if (name === 'invite_card') return h.run('InviteCard');
        if (name === 'notify_card') return o.notifyCard ?? null;
        return null;
    };
    for (const id of ['page-title', 'page-subtitle', 'sidebar', 'mobile-menu-btn']) h.el(id);
    const toasts: Array<{ message: string; arg: Json }> = [];
    const confirms: Json[] = [];
    h.UI.toast = (message: string, arg: Json) => { toasts.push({ message, arg }); return null; };
    h.UI.confirm = (options: Json) => { confirms.push(options); };
    const modals: string[] = [];
    h.UI.showModal = (markup: unknown) => { modals.push(String(markup)); };
    return { h, t: h.t, calls, toasts, confirms, modals, Settings: h.run<Json>('SettingsPage'), Card: h.run<Json>('InviteCard'), container: h.el('page-container') as Json };
}

describe('Team: the card', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`draws every person, a role picker for all but the account manager, and the open invites only (${lang})`, async () => {
            const { Settings, container, t } = load(lang);
            await Settings.render();
            await settle();
            const html = container.innerHTML;
            const team = html.slice(html.indexOf('data-settings-card="team"'), html.indexOf('data-settings-card="notify-me"'));
            assert.ok(team.includes(t('settings.team.title')));
            assert.ok(text(team).includes(t('settings.team.count', { count: 4 })), 'a count in the title');
            for (const email of ['admin@example.com', 'sara@example.com', 'ahmed@example.com']) assert.ok(team.includes(email), email);
            // Four rows; three have a picker (the account manager has none), each with Reset link and Remove, and a label for a screen reader.
            assert.equal((team.match(/class="select team-role-select"/g) ?? []).length, 3);
            assert.equal((team.match(/data-action="settings:teamReset"/g) ?? []).length, 3);
            assert.equal((team.match(/data-action="settings:teamRemove"/g) ?? []).length, 3);
            assert.ok(team.includes(t('settings.team.accountManager')) && team.includes(t('settings.team.accountManagerNote')));
            assert.ok(text(team).includes(t('settings.team.you')), 'you are marked');
            assert.ok(text(team).includes(t('settings.team.inactive')), 'a switched-off account says so');
            // The role picker holds the person's role.
            assert.match(team, /data-user="u-ahmed" data-current="operator"/);
            // The pending list: the pending invite, not the used or the revoked one.
            assert.ok(team.includes(t('settings.team.pending')));
            assert.ok(team.includes('new@example.com'));
            assert.equal((team.match(/class="invite-item"/g) ?? []).length, 1, 'only an invite that can still be used is listed');
            // What each role can do, in plain words (SA-05).
            for (const role of ['owner', 'operator', 'viewer']) assert.ok(team.includes(t(`roles.${role}.what`).replace(/&/g, '&amp;')) || text(team).includes(text(t(`roles.${role}.what`))), role);
            assert.ok(team.includes('data-action="settings:teamInvite"'));
        });
    }

    it('escapes everything a person typed or the server sent: no tag or handler of an address survives', async () => {
        const { Settings, container } = load('en');
        await Settings.render();
        await settle();
        assert.equal(container.innerHTML.includes('<img src=x'), false);
        assert.ok(container.innerHTML.includes('&lt;img src=x'));
    });

    it('a failed read is the card\'s own error with a Retry, and the rest of Settings still draws', async () => {
        const { Settings, container, t } = load('en', { api: { getTeam: async () => { throw new Error('db down'); } } });
        await Settings.render();
        await settle();
        const html = container.innerHTML;
        const team = html.slice(html.indexOf('data-settings-card="team"'), html.indexOf('data-settings-card="notify-me"'));
        assert.ok(text(team).includes(t('settings.team.loadFailed', { message: 'db down' })));
        assert.match(team, /data-action="settings:render"/);
        assert.ok(html.includes('data-settings-card="meta"'));
    });

    it('is not asked for, and not drawn, for an operator or a viewer: the server would refuse it', async () => {
        const { Settings, container, calls } = load('en', { role: 'member' });
        await Settings.render();
        await settle();
        assert.equal(calls.some((c) => c.method === 'getTeam'), false);
        assert.equal(container.innerHTML.includes('data-settings-card="team"'), false);
    });
});

describe('Team: changing a role, removing, resetting, inviting', () => {
    const select = (value: string, over: Json = {}): Json => ({ dataset: { user: 'u-ahmed', current: 'operator', email: 'ahmed@example.com' }, value, disabled: false, ...over });

    it('a new role is sent when picked, says so with an Undo, and the Undo gives the old one back', async () => {
        const { Settings, calls, toasts, t } = load('en', { api: { changeTeamRole: async (_u: string, role: string) => ({ userId: 'u-ahmed', role }) } });
        Settings.render = async () => undefined;
        await Settings.teamRole(select('viewer'));
        assert.deepEqual(calls.filter((c) => c.method === 'changeTeamRole').map((c) => c.args), [['u-ahmed', 'viewer']]);
        assert.equal(toasts.length, 1);
        assert.equal(toasts[0]!.message, t('settings.team.roleChanged', { email: 'ahmed@example.com', role: t('roles.viewer') }));
        assert.equal(toasts[0]!.arg.action.label, t('ui.undo'));
        await toasts[0]!.arg.action.onClick();
        assert.deepEqual(calls.filter((c) => c.method === 'changeTeamRole').map((c) => c.args), [['u-ahmed', 'viewer'], ['u-ahmed', 'operator']]);
    });

    it('picking the same role sends nothing', async () => {
        const { Settings, calls } = load('en');
        await Settings.teamRole(select('operator'));
        assert.equal(calls.some((c) => c.method === 'changeTeamRole'), false);
    });

    for (const [code, key] of [['LAST_OWNER', 'settings.team.err.LAST_OWNER'], ['MEMBER_IS_ADMIN', 'settings.team.err.MEMBER_IS_ADMIN']] as const) {
        it(`a refusal (${code}) is said in words by its code, in both languages, and the picker goes back`, async () => {
            for (const lang of ['ar', 'en'] as const) {
                const { Settings, toasts, t } = load(lang, { api: { changeTeamRole: async () => { throw Object.assign(new Error('English from the server'), { status: 409, code, body: { code } }); } } });
                const el = select('viewer');
                await Settings.teamRole(el);
                assert.equal(el.value, 'operator', 'back to what it was');
                assert.equal(el.disabled, false);
                assert.equal(toasts[0]!.message, t(key));
                assert.notEqual(toasts[0]!.message, 'English from the server');
            }
        });
    }

    it('Remove asks first, with the verb on the button, and removes only when the dialog\'s own confirm runs', async () => {
        const { Settings, calls, confirms, t } = load('en', { api: { removeTeamMember: async () => ({ userId: 'u-ahmed', removed: true, you: false }) } });
        Settings.render = async () => undefined;
        Settings.teamRemove({ dataset: { user: 'u-ahmed', email: 'ahmed@example.com', you: '' } });
        assert.equal(calls.length, 0, 'asking removes nothing');
        assert.equal(confirms.length, 1);
        assert.equal(confirms[0]!.confirmLabel, t('settings.team.remove'));
        assert.equal(confirms[0]!.title, t('settings.team.removeTitle'));
        assert.ok(String(confirms[0]!.body).includes('ahmed@example.com'));
        await confirms[0]!.onConfirm();
        assert.deepEqual(calls.map((c) => [c.method, c.args]), [['removeTeamMember', ['u-ahmed']]]);
    });

    it('removing yourself says so, and afterwards takes you to another workspace, or to the sign-in when there is none', async () => {
        for (const others of [[{ id: 'w2', name: 'Other' }], []]) {
            const { Settings, confirms, h, t } = load('en', { api: { removeTeamMember: async () => ({ userId: 'u-sara', removed: true, you: true }) } });
            h.App.session = { tenantId: 'w', tenants: [{ id: 'w', name: 'Knowledge Hub' }, ...others] };
            h.App.refreshSession = async () => true;
            const switched: string[] = [];
            h.App.switchTenant = async (id: string) => { switched.push(id); };
            let loggedOut = 0;
            h.App.logout = () => { loggedOut += 1; };
            Settings.teamRemove({ dataset: { user: 'u-sara', email: 'sara@example.com', you: '1' } });
            assert.equal(confirms[0]!.title, t('settings.team.leaveTitle'));
            assert.equal(confirms[0]!.confirmLabel, t('settings.team.leave'));
            await confirms[0]!.onConfirm();
            if (others.length) assert.deepEqual([switched, loggedOut], [['w2'], 0]);
            else assert.deepEqual([switched, loggedOut], [[], 1]);
        }
    });

    it('Invite a person opens the invite card for the Team scope, and a reset link is made from the team\'s own route', async () => {
        const { Settings, Card, calls, modals } = load('en', { api: { createResetLink: async () => ({ invite: { id: 'i-9', url: 'https://x.test/#/invite?t=abc', purpose: 'reset', email: 'ahmed@example.com', role: 'operator', status: 'pending', expires_at: '2026-12-01T00:00:00Z', whatsapp_text: 'hi' } }) } });
        await Settings.teamInvite();
        assert.equal(modals.length, 1);
        assert.ok(modals[0]!.includes('id="invite-create-form"'));
        assert.equal(Card.current.scope, 'team');
        await Settings.teamReset({ dataset: { user: 'u-ahmed' } });
        assert.deepEqual(calls.filter((c) => c.method === 'createResetLink').map((c) => c.args[0]), ['u-ahmed']);
        assert.equal(calls.some((c) => c.method === 'createTenantInvite'), false, 'never the platform admin\'s route');
        assert.ok(modals[1]!.includes('https://x.test/#/invite?t=abc'));
    });
});

describe('The invite card: two scopes (U3)', () => {
    const invite = { id: 'i-9', url: 'https://x.test/#/invite?t=abc', purpose: 'join', email: null, role: 'operator', status: 'pending', expires_at: '2026-12-01T00:00:00Z', whatsapp_text: 'hi', lang: 'en' };

    it('the team form defaults to Operator, has no "default role" option, and says what the roles are', () => {
        const { Card, t } = load('en');
        const team = String(Card.createView({ scope: 'team', tenantName: 'Knowledge Hub' }));
        assert.equal(team.includes(t('invites.roleDefault')), false);
        assert.match(team, /<option value="operator" selected>/);
        assert.ok(text(team).includes(t('settings.team.roleWhat')));
        const admin = String(Card.createView({ tenantId: 't', tenantName: 'X' }));
        assert.ok(admin.includes(t('invites.roleDefault')), 'the admin\'s form is what it was');
    });

    it('create, regenerate, revoke and reset go to the team\'s endpoints with no tenant in them, and the admin\'s go where they always did', async () => {
        const api = {
            createTeamInvite: async () => ({ invite }), regenerateTeamInvite: async () => ({ invite }), revokeTeamInvite: async () => ({ revoked: true }),
            createTenantInvite: async () => ({ invite }), regenerateInvite: async () => ({ invite }), revokeInvite: async () => ({ revoked: true }),
        };
        const team = load('en', { api });
        const api1 = team.Card.api('team');
        await api1.create({ tenantId: 'ignored' }, { email: 'a@b.co' });
        await api1.regenerate('i-1', { lang: 'en' });
        await api1.revoke('i-1');
        assert.deepEqual(plain(team.calls.map((c) => [c.method, c.args])), [
            ['createTeamInvite', [{ role: 'operator', email: 'a@b.co' }]], ['regenerateTeamInvite', ['i-1', { lang: 'en' }]], ['revokeTeamInvite', ['i-1']],
        ]);
        const admin = load('en', { api });
        const api2 = admin.Card.api('admin');
        await api2.create({ tenantId: 't-7' }, { email: 'a@b.co' });
        await api2.regenerate('i-1', {});
        await api2.revoke('i-1');
        assert.deepEqual(plain(admin.calls.map((c) => [c.method, c.args[0]])), [['createTenantInvite', 't-7'], ['regenerateInvite', 'i-1'], ['revokeInvite', 'i-1']]);
        assert.equal(team.Card.scope({}), 'admin', 'no scope is the admin\'s');
        assert.equal(team.Card.scope({ scope: 'team' }), 'team');
        assert.equal(team.Card.scope({ scope: 'anything' }), 'admin');
    });

    it('draws a to-do checklist under the link, each item worded by its key, and nothing when there is none', () => {
        const { Card, t } = load('en');
        const withTodo = String(Card.linkView({ invite, tenantName: 'X', scope: 'team', todo: ['settings.team.helpInvite', 'settings.team.roleWhat'] }));
        assert.ok(withTodo.includes('class="invite-card-todo"'));
        assert.ok(text(withTodo).includes(t('settings.team.todoTitle')));
        assert.equal((withTodo.match(/<li dir="auto">/g) ?? []).length, 2);
        assert.ok(text(withTodo).includes(t('settings.team.roleWhat')));
        for (const none of [undefined, [], ['', 5]]) assert.equal(String(Card.linkView({ invite, tenantName: 'X', todo: none })).includes('invite-card-todo'), false);
    });

    it('the team link points to the Team article, and the admin one to the onboarding article', () => {
        const { Card } = load('en');
        assert.ok(String(Card.linkView({ invite, tenantName: 'X', scope: 'team' })).includes('#/help/team#invite'));
        assert.ok(String(Card.linkView({ invite, tenantName: 'X' })).includes('#/help/onboarding#invite'));
    });

    it('a refusal from the team routes is worded by its code', () => {
        const { Card, t } = load('ar');
        assert.equal(Card.describe({ body: { code: 'LAST_OWNER' } }), t('settings.team.err.LAST_OWNER'));
        assert.equal(Card.describe({ body: { code: 'BAD_EMAIL' } }), t('invites.err.BAD_EMAIL'));
    });
});

describe('You: sign-in', () => {
    it('is drawn only for a person with an account of their own, with Change password and Sign out everywhere', async () => {
        const yes = load('en', { hasAccount: true });
        await yes.Settings.render();
        await settle();
        const html = yes.container.innerHTML;
        assert.ok(html.includes('data-settings-card="signin"'));
        assert.ok(html.includes('data-action="app:showPasswordModal"') && html.includes('data-action="settings:signOutEverywhere"'));
        const no = load('en', { hasAccount: false });
        await no.Settings.render();
        await settle();
        assert.equal(no.container.innerHTML.includes('data-settings-card="signin"'), false, 'the shared password has no account to sign out of');
        assert.ok(no.container.innerHTML.includes('data-settings-card="appearance"'), 'but language and theme are everyone\'s');
    });

    it('Sign out everywhere asks first, then keeps the token the answer carries, so this browser stays signed in', async () => {
        const { Settings, confirms, calls, toasts, h, t } = load('en', { api: { signOutEverywhere: async () => ({ token: 'fresh-token', message: 'x' }) } });
        const kept: string[] = [];
        h.ctx.API.setToken = (value: string) => { kept.push(value); };
        Settings.signOutEverywhere();
        assert.equal(calls.length, 0, 'asking ends nothing');
        assert.equal(confirms[0]!.title, t('settings.you.signin.confirmTitle'));
        assert.equal(confirms[0]!.confirmLabel, t('settings.you.signin.everywhere'));
        await confirms[0]!.onConfirm();
        assert.deepEqual(calls.filter((c) => c.method !== 'setToken').map((c) => c.method), ['signOutEverywhere']);
        assert.deepEqual(kept, ['fresh-token']);
        assert.equal(toasts[0]!.message, t('settings.you.signin.done'));
    });
});

describe('Notifications: fail-open until notify_card.js (PR D) is on the deployment', () => {
    it('without the module: one static line for "you", and no routing card', async () => {
        const { Settings, container, t } = load('en', { notifyCard: null });
        await Settings.render();
        await settle();
        const html = container.innerHTML;
        assert.ok(html.includes('data-settings-card="notify-me"'));
        assert.ok(text(html).includes(t('settings.notify.inApp')));
        assert.equal(html.includes('data-settings-card="notify-routing"'), false, 'the routing card is not drawn');
        assert.ok(html.includes('data-settings-card="cleanup"'), 'the clean-up is the owner\'s still');
    });

    it('with the module: its two hosts are handed to it, mine for everyone, routing for the owner, and it can hold the page back', async () => {
        const mounted: Array<[string, Json]> = [];
        let leave: boolean | undefined = true;
        const notifyCard = {
            mountMine: (host: Json, o: Json) => mounted.push(['mine', { host, o }]),
            mountRouting: (host: Json, o: Json) => mounted.push(['routing', { host, o }]),
            canLeave: () => leave,
        };
        const owner = load('en', { notifyCard });
        const hosts: Record<string, Json> = { '#notify-me-host': { id: 'me' }, '#notify-routing-host': { id: 'routing' } };
        owner.container.querySelector = (selector: string) => hosts[selector] ?? null;
        await owner.Settings.render();
        await settle();
        assert.deepEqual(plain(mounted.map(([kind, v]) => [kind, v.host.id, v.o])), [['mine', 'me', { hasAccount: true }], ['routing', 'routing', { canAdminister: true }]]);
        assert.ok(owner.container.innerHTML.includes('id="notify-me-host"') && owner.container.innerHTML.includes('id="notify-routing-host"'));
        // canLeave: false while the module says so (it is a global of the page, `NotifyCard`).
        (owner.h.ctx as Json).NotifyCard = notifyCard;
        owner.container.querySelectorAll = () => [];
        leave = false;
        assert.equal(owner.Settings.canLeave(), false);
        leave = true;
        assert.equal(owner.Settings.canLeave(), true);
        delete (owner.h.ctx as Json).NotifyCard;
        // A member gets "mine" and no routing card.
        mounted.length = 0;
        const member = load('en', { role: 'member', notifyCard });
        member.container.querySelector = (selector: string) => hosts[selector] ?? null;
        await member.Settings.render();
        await settle();
        assert.deepEqual(mounted.map(([kind]) => kind), ['mine']);
    });

    it('a workspace without the inbox has no notifications card of its own (the owner keeps the clean-up)', () => {
        const { Settings } = load('en', { modules: ['scheduler'] });
        const ids = Array.from<Json>(Settings.visibleCards('notifications')).map((c) => c.id);
        assert.deepEqual(ids, ['cleanup']);
        const member = load('en', { role: 'member', modules: ['scheduler'] });
        assert.deepEqual(Array.from<Json>(member.Settings.visibleGroups()).map((g) => g.id), ['channels', 'you']);
    });
});

describe('The account area and the workspace chip (U3, §4.4)', () => {
    const index = readFileSync('dashboard/index.html', 'utf8');

    it('has Your settings between the identity line and Change password: a button, not a page link', () => {
        const at = (s: string): number => index.indexOf(s);
        assert.ok(at('id="nav-identity"') < at('id="you-btn"') && at('id="you-btn"') < at('id="password-btn"'));
        assert.match(index, /<button id="you-btn" type="button" class="nav-item" data-action="app:openYourSettings">/);
        assert.equal(/<a [^>]*id="you-btn"/.test(index), false);
        assert.match(index, /data-i18n="nav\.account\.yourSettings"/);
    });

    it('goes to the You tab', () => {
        const { h } = load('en');
        h.App.openYourSettings();
        assert.equal(h.location.hash, '#/settings?s=you');
        const action = h.run<Json>('UI._actions.app.openYourSettings');
        h.location.hash = '';
        action();
        assert.equal(h.location.hash, '#/settings?s=you');
    });

    const chip = (tenants: Json[]) => {
        const { h } = load('en');
        h.App.session = { available: true, tenantId: tenants[0]?.id ?? null, tenants };
        h.App.needsSetup = () => false;
        const wrap = h.el('tenant-switcher') as Json;
        wrap.classList.add('hidden');
        h.App.renderTenantSwitcher();
        return wrap;
    };

    it('one workspace is a static chip with its name (and no select), two or more is the switcher, none is hidden', () => {
        const one = chip([{ id: 'w', name: 'Knowledge Hub' }]);
        assert.equal(one.classes.has('hidden'), false);
        assert.ok(one.innerHTML.includes('Knowledge Hub') && one.innerHTML.includes('building-2'));
        assert.equal(one.innerHTML.includes('<select'), false);
        assert.equal(one.attrs.get('title'), 'Knowledge Hub');
        const two = chip([{ id: 'w', name: 'Knowledge Hub' }, { id: 'v', name: 'Other' }]);
        assert.ok(two.innerHTML.includes('<select') && two.innerHTML.includes('Other'));
        const none = chip([]);
        assert.equal(none.classes.has('hidden'), true);
        assert.equal(none.innerHTML, '');
    });

    it('escapes a workspace name', () => {
        const one = chip([{ id: 'w', name: '<img src=x onerror=1>' }]);
        assert.equal(one.innerHTML.includes('<img'), false);
        assert.ok(one.innerHTML.includes('&lt;img'));
    });

    it('the sidebar still has 19 page links: Your settings is not one of them', () => {
        const links = [...index.matchAll(/<a href="#\/[a-z_]+" class="nav-item(?: active)?" data-page="([a-z_]+)"/g)].map((m) => m[1]);
        assert.equal(new Set(links).size, links.length);
        assert.equal(links.length, 19);
    });
});
