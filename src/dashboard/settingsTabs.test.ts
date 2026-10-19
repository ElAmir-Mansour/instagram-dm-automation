/**
 * Settings in tabs, with the connections health first (UX US10: audit SE-02, SE-04, SE-05, SE-08, SE-09, SE-13, SE-15, ST-02).
 *
 * The REAL `settings.js`, `meta_connect.js` and `app.js` in the shared `node:vm` harness, in both languages. There is no layout and no real
 * DOM here, so the parts that touch elements (unsaved edits, the carry-over of a card, the tab marks) are driven with small fake elements
 * that answer exactly the queries the page makes; what only a browser can show (the sticky bar, the sideways scroll, RTL) is for the live
 * check in the owner's steps.
 *
 *   - the map: who sees which tab and which card, and what an address asks for;
 *   - the page: one panel open, the others `hidden` (not left out), the tab bar's marks, the platform badges;
 *   - the summary: one status per integration, ONE expiry rule, never red for "not connected yet", a failed request never "broken",
 *     worst first, a tenant never sees the platform's rows;
 *   - unsaved edits: what counts, `canLeave()` and the router's guard, the dot on a tab;
 *   - a save keeps the other cards' edits, the scroll and the tab;
 *   - Disconnect at the end of its card, and the provider apps in the Platform tab.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));

type Role = 'admin' | 'owner' | 'member';
const ROLES: Record<Role, { isAdmin: boolean; canAdminister: boolean }> = {
    admin: { isAdmin: true, canAdminister: true },
    owner: { isAdmin: false, canAdminister: true },
    member: { isAdmin: false, canAdminister: false },
};

// ─── Fixtures: what the page's requests answer ──────────────────────────────────────────────────

const NOW = Date.parse('2026-10-19T12:00:00Z');
/** An ISO date exactly `n` days after NOW: `daysUntil` rounds up, so it is `n` days. */
const inDays = (n: number): string => new Date(NOW + n * 86400000).toISOString();

const ALL_SCOPES = ['pages_manage_engagement', 'pages_messaging', 'instagram_manage_comments', 'instagram_manage_messages', 'instagram_content_publish', 'instagram_manage_insights', 'read_insights'];
const VALID = { status: 'valid', type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: ALL_SCOPES, instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };
const NOT_CONNECTED = { status: 'not_connected', message: 'Instagram and Facebook are not connected for this tenant yet: connect them first.', expiresAt: null, dataAccessExpiresAt: null, instagramPageId: null, facebookPageId: null, isActive: true };
const INVALID = { status: 'invalid', error: 'Session has expired', expiresAt: null, dataAccessExpiresAt: null, instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };

const META = {
    enabled: true, appConfigured: true, redirectUriConfigured: true,
    connection: { connected: true, via: 'login', pageName: 'My page', instagramUsername: 'mybrand', webhookSubscribed: true, reconnectDue: false, tokenStatus: 'valid', connectedAt: inDays(-30) },
};
const META_NONE = { enabled: true, appConfigured: true, redirectUriConfigured: true, connection: null };
const TIKTOK = {
    appConfigured: true,
    connection: { connected: true, status: 'active', displayName: 'Sample creator', refreshExpiresAt: inDays(200), canUpload: true, canDirectPost: false, postMode: 'inbox', scopes: ['video.upload'] },
    inbox: { pending: 0, limit: 5 },
};
const YOUTUBE = {
    appConfigured: true, publicUploads: true, visibility: null,
    connection: { connected: true, status: 'active', channelTitle: 'My channel', refreshExpiresAt: null, canUpload: true },
};
const WHATSAPP = { connected: true, status: 'active', display_phone_number: '+20 100 000 0000', verified_name: 'My shop', token_expires_at: null };
const MEDIA = {
    backend: 'supabase', bucket: 'media', url: { value: 'https://x.supabase.co', source: 'database' }, key: { source: 'database', preview: 'ab12' },
    connection: { ok: true, bucketExists: true },
    usage: { tierBytes: 5 * 1024 ** 3, storage: { bytes: 1024 ** 3, files: 12 }, database: { files: 0, bytes: 0 }, queuedDeletions: 0 },
};
const META_APP = { enabled: true, configId: {}, mode: 'scope', app: { idSet: true, secretSet: true }, publicBaseUrl: 'https://x.example', register: null };
const SITE = { whatsappNumber: '', contactEmail: '', eidCouponsExpire: '', source: {} };
const NOTIFY = {
    telegram: { enabled: true, botToken: { set: true, last4: 'abcd' }, chatId: '4242', hotLeads: true },
    email: { enabled: false, ready: false, to: '', apiKey: { set: false } },
    echo: { takeover: false, ownerAppIds: [], documentedAppIds: [] },
};

/** The Settings page, with the real `App` (the router's address and leave guard) and `API` answering only what the test names. */
function load(lang: 'ar' | 'en', role: Role, options: { hash?: string; api?: Json; files?: string[] } = {}) {
    const stubs: Json = { token: 't', ...(options.api ?? {}) };
    const api = new Proxy(stubs, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) });
    const h = loadDashboard({
        lang, app: true, hash: options.hash ?? '',
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/settings.js', ...(options.files ?? [])],
        globals: { API: api },
    });
    h.App.isAdmin = () => ROLES[role].isAdmin;
    h.App.canAdminister = () => ROLES[role].canAdminister;
    h.App.loadPageModule = async () => null;
    for (const id of ['page-title', 'page-subtitle', 'sidebar', 'mobile-menu-btn']) h.el(id);
    return { h, t: h.t, Settings: h.run<Json>('SettingsPage'), container: h.el('page-container') as Json };
}

/** The panel segments of a rendered page, by tab: `{ id, hidden, html }`. */
function panels(markup: string): Array<{ id: string; hidden: boolean; html: string }> {
    return markup.split('<div class="settings-panel"').slice(1).map((chunk) => {
        const head = chunk.slice(0, chunk.indexOf('>'));
        return { id: /data-group="([^"]+)"/.exec(head)![1]!, hidden: /\bhidden\b/.test(head), html: chunk };
    });
}

const ctxOf = (over: Json = {}): Json => ({
    now: NOW, canAdmin: true, isAdmin: false,
    tokenStatus: VALID, tokenError: null, meta: META, metaError: null, health: null,
    tiktok: TIKTOK, tiktokError: null, youtube: YOUTUBE, youtubeError: null, whatsapp: WHATSAPP, whatsappError: null,
    media: null, mediaError: null, notify: null, notifyError: null,
    ...over,
});

const rowsOf = (S: Json, over: Json = {}): Json[] => Array.from(S.connectionRows(ctxOf(over)));
const rowFor = (rows: Json[], id: string): Json => rows.find((row) => row.id === id)!;

// ─── The map ────────────────────────────────────────────────────────────────────────────────────

describe('Settings tabs: who sees which tab and which card (SE-05)', () => {
    it('a platform admin has five tabs, in this order; a tenant owner three; a member two', () => {
        const ids = (role: Role) => Array.from<Json>(load('en', role).Settings.visibleGroups()).map((g) => g.id);
        assert.deepEqual(ids('admin'), ['connections', 'messages', 'appearance', 'advanced', 'platform']);
        assert.deepEqual(ids('owner'), ['connections', 'messages', 'appearance']);
        assert.deepEqual(ids('member'), ['connections', 'appearance'], 'a tab with no card for the viewer is not shown');
    });

    it('each card is in the tab the owner named, and the developer cards are the platform admin\'s alone', () => {
        const { Settings } = load('en', 'admin');
        const where = (group: string): string[] => Array.from<Json>(Settings.visibleCards(group)).map((c) => c.id);
        assert.deepEqual(where('connections'), ['meta', 'tiktok', 'youtube', 'whatsapp']);
        assert.deepEqual(where('messages'), ['iceb', 'alerts']);
        assert.deepEqual(where('appearance'), ['appearance']);
        assert.deepEqual(where('advanced'), ['token', 'webhook', 'account']);
        assert.deepEqual(where('platform'), ['meta-app', 'tiktok-app', 'youtube-app', 'storage', 'site', 'onboarding']);
        const owner = load('en', 'owner').Settings;
        const ownerCards = Array.from<Json>(owner.visibleGroups()).flatMap((g) => Array.from<Json>(owner.visibleCards(g.id)).map((c) => c.id));
        for (const developer of ['token', 'webhook', 'account', 'meta-app', 'tiktok-app', 'youtube-app', 'storage', 'site', 'onboarding', 'alerts']) {
            assert.equal(ownerCards.includes(developer), false, `a tenant owner never sees ${developer}`);
        }
        assert.ok(ownerCards.includes('iceb'), 'the owner keeps their ice breakers');
        const member = load('en', 'member').Settings;
        assert.equal(Array.from<Json>(member.visibleCards('messages')).length, 0, 'an operator has nothing in Messages');
    });

    it('every card names its tab, is in exactly one, and the platform ones carry the all-workspaces badge', () => {
        const { Settings } = load('en', 'admin');
        const cards = Array.from<Json>(Settings.CARDS);
        const groups = new Set(Array.from<Json>(Settings.GROUPS).map((g) => g.id));
        assert.equal(new Set(cards.map((c) => c.id)).size, cards.length, 'ids are unique');
        assert.equal(new Set(cards.map((c) => c.dom)).size, cards.length, 'anchors are unique');
        for (const card of cards) assert.ok(groups.has(card.group), `${card.id} is in a known tab`);
        for (const card of cards.filter((c) => c.group === 'platform')) assert.equal(card.platform, true, `${card.id} is badged`);
        assert.equal(Settings.GROUPS.find((g: Json) => g.id === 'platform').platform, true);
        assert.equal(cards.find((c) => c.id === 'alerts')!.platform, true, 'handoff alerts are the deployment\'s, in Messages');
    });
});

describe('Settings tabs: what an address asks for', () => {
    const view = (role: Role, params: Json) => plain(load('en', role).Settings.resolveView(params));

    it('a tab by name, a card by name, and a card inside a tab', () => {
        assert.deepEqual(view('admin', { s: 'platform' }), { group: 'platform', card: '' });
        assert.deepEqual(view('admin', { s: 'messages', card: 'alerts' }), { group: 'messages', card: 'alerts' });
        // `?s=` also takes a card (the form the alerts link with): it opens that card's tab.
        assert.deepEqual(view('admin', { s: 'tiktok' }), { group: 'connections', card: 'tiktok' });
        assert.deepEqual(view('admin', { s: 'storage' }), { group: 'platform', card: 'storage' });
        assert.deepEqual(view('admin', { card: 'webhook' }), { group: 'advanced', card: 'webhook' });
    });

    it('no address, an unknown name, a name this viewer cannot see, and a card from another tab all land on a tab that exists', () => {
        assert.deepEqual(view('owner', {}), { group: 'connections', card: '' });
        assert.deepEqual(view('owner', { s: 'nonsense' }), { group: 'connections', card: '' });
        assert.deepEqual(view('owner', { s: 'platform' }), { group: 'connections', card: '' }, 'a tenant is never taken to the platform tab');
        assert.deepEqual(view('owner', { s: 'storage' }), { group: 'connections', card: '' }, 'nor to a card of it');
        assert.deepEqual(view('owner', { s: 'messages', card: 'alerts' }), { group: 'messages', card: '' }, 'a card they cannot see is dropped, the tab stays');
        assert.deepEqual(view('admin', { s: 'connections', card: 'alerts' }), { group: 'connections', card: '' }, 'a card from another tab is not scrolled to');
        assert.deepEqual(view('admin', { s: '__proto__', card: 'constructor' }), { group: 'connections', card: '' });
    });
});

// ─── The page ───────────────────────────────────────────────────────────────────────────────────

describe('Settings tabs: one panel open, the others hidden (not left out)', () => {
    const api = {
        getTokenStatus: async () => VALID, getMetaConnection: async () => META, getTikTokConnection: async () => TIKTOK,
        getYouTubeConnection: async () => YOUTUBE, getWhatsAppConnection: async () => WHATSAPP, getMediaStorage: async () => MEDIA,
        getNotifySettings: async () => NOTIFY, getSiteSettings: async () => SITE, getMetaAppSettings: async () => META_APP,
    };

    for (const lang of ['ar', 'en'] as const) {
        it(`opens on Connections by default, with every other tab present and hidden (${lang})`, async () => {
            const { Settings, container, t } = load(lang, 'admin', { api });
            await Settings.render();
            await settle();
            const found = panels(container.innerHTML);
            assert.deepEqual(found.map((p) => p.id), ['connections', 'messages', 'appearance', 'advanced', 'platform']);
            assert.deepEqual(found.filter((p) => !p.hidden).map((p) => p.id), ['connections'], 'exactly one panel is open');
            assert.ok(text(container.innerHTML).includes(t('settings.group.platform')));
            // Hidden, not left out: the platform panel still holds its cards, so what is typed in one tab survives a switch to another.
            assert.ok(found.find((p) => p.id === 'platform')!.html.includes('data-settings-card="storage"'));
            assert.ok(found.find((p) => p.id === 'advanced')!.html.includes('data-settings-card="token"'));
        });

        it(`the address chooses the tab, and the tab bar marks it with aria-current (${lang})`, async () => {
            const { Settings, container, h, t } = load(lang, 'admin', { api, hash: '#/settings?s=platform' });
            await Settings.render();
            await settle();
            const found = panels(container.innerHTML);
            assert.deepEqual(found.filter((p) => !p.hidden).map((p) => p.id), ['platform']);
            const bar = /<nav class="ui-tabs ui-tabs--link"[\s\S]*?<\/nav>/.exec(container.innerHTML)![0];
            assert.equal((bar.match(/aria-current="page"/g) ?? []).length, 1, 'one tab is current');
            assert.match(bar, /href="#\/settings\?s=platform"[^>]*aria-current="page"/);
            for (const id of ['connections', 'messages', 'appearance', 'advanced', 'platform']) assert.ok(bar.includes(`href="#/settings?s=${id}"`), `${id} is a link, so Back and a reload keep it`);
            assert.ok(bar.includes(`aria-label="${t('settings.nav.label')}"`));
            assert.equal(h.App.hashParams().s, 'platform');
        });

        it(`the Platform tab and each of its cards say they apply to every workspace (${lang})`, async () => {
            // The Meta module is loaded so its operator block has something to draw; with nothing to draw a card leaves no badge behind.
            const { Settings, container, t, h } = load(lang, 'admin', { api, hash: '#/settings?s=platform', files: ['dashboard/js/pages/meta_connect.js'] });
            h.App.loadPageModule = async () => h.run('MetaConnect');
            await Settings.render();
            await settle();
            const badge = text(t('settings.scope.platform'));
            const bar = /<nav class="ui-tabs ui-tabs--link"[\s\S]*?<\/nav>/.exec(container.innerHTML)![0];
            assert.ok(text(bar).includes(badge), 'on the tab');
            const platform = panels(container.innerHTML).find((p) => p.id === 'platform')!.html;
            assert.ok(text(platform).includes(t('settings.platform.lead')));
            for (const id of ['storage', 'site', 'onboarding', 'meta-app', 'tiktok-app', 'youtube-app']) {
                const at = platform.indexOf(`data-settings-card="${id}"`);
                assert.ok(at >= 0, `${id} is in the Platform tab`);
                assert.ok(platform.slice(at, at + 400).includes('settings-scope'), `${id} carries the badge`);
            }
        });
    }

    it('a card with nothing to draw for this viewer leaves no badge hanging over nothing', async () => {
        const { Settings, container } = load('en', 'admin', { api });
        await Settings.render();
        await settle();
        const html = container.innerHTML;
        // The Meta module is not loaded here, so its operator block has nothing to draw; the TikTok and YouTube apps say why theirs failed.
        assert.equal(html.includes('data-settings-card="meta-app"'), false);
        assert.ok(html.includes('data-settings-card="tiktok-app"') && html.includes('data-settings-card="youtube-app"'));
        // Handoff alerts, the TikTok and YouTube apps, storage, the public site, onboarding: six cards, six badges, and none for the missing one.
        assert.equal((html.match(/class="settings-scope"/g) ?? []).length, 6);
    });

    it('a tenant owner never gets the developer cards or the Platform tab in the page at all, not even hidden', async () => {
        const { Settings, container } = load('en', 'owner', { api: { ...api, getIceBreakers: async () => ({}) } });
        await Settings.render();
        await settle();
        const html = container.innerHTML;
        assert.deepEqual(panels(html).map((p) => p.id), ['connections', 'messages', 'appearance']);
        for (const id of ['token', 'webhook', 'account', 'storage', 'site', 'onboarding', 'meta-app', 'tiktok-app', 'youtube-app', 'alerts']) {
            assert.equal(html.includes(`data-settings-card="${id}"`), false, id);
        }
        assert.equal(html.includes('token-form'), false, 'no token paste');
        assert.equal(html.includes('webhook-token-form'), false, 'no verify token');
    });

    it('the Connections tab opens with the summary, then the warning about missing permissions, then the cards', async () => {
        const { Settings, container } = load('en', 'admin', { api: { ...api, getTokenStatus: async () => ({ ...VALID, scopes: ['pages_messaging'] }) } });
        await Settings.render();
        await settle();
        const connections = panels(container.innerHTML).find((p) => p.id === 'connections')!.html;
        const at = (needle: string): number => connections.indexOf(needle);
        assert.ok(at('id="settings-summary"') > 0 && at('warning-card') > at('id="settings-summary"') && at('data-settings-card="meta"') > at('warning-card'), 'summary, warning, cards');
    });

    it('the page subtitle names what the page holds now (SE-15), in both languages', () => {
        for (const lang of ['ar', 'en'] as const) {
            const { t } = load(lang, 'owner');
            const names = lang === 'ar' ? ['الاتصالات', 'التنبيهات', 'المظهر', 'التخزين'] : ['Connections', 'alerts', 'appearance', 'storage'];
            for (const name of names) assert.ok(t('page.settings.subtitle').includes(name), `${lang} names ${name}`);
        }
    });

    it('the access token\'s own failure is that card\'s, with Retry: the rest of the page still draws, and Meta is "could not check", not "broken" (SE-09)', async () => {
        const { Settings, container, t } = load('en', 'admin', { api: { ...api, getTokenStatus: async () => { throw new Error('Meta is asleep'); } } });
        await Settings.render();
        await settle();
        const html = container.innerHTML;
        assert.ok(html.includes('data-settings-card="tiktok"') && html.includes('data-settings-card="storage"'), 'the other cards are there');
        const token = html.slice(html.indexOf('data-settings-card="token"'), html.indexOf('data-settings-card="webhook"'));
        assert.ok(text(token).includes(t('settings.token.loadFailed', { message: 'Meta is asleep' })));
        assert.match(token, /data-action="settings:render"/, 'Retry');
        const meta = html.slice(html.indexOf('data-row="meta"'), html.indexOf('data-row="meta"') + 600);
        assert.match(meta, /data-state="unknown"/);
        assert.equal(/data-state="broken"/.test(html.slice(html.indexOf('id="settings-summary"'), html.indexOf('</section>', html.indexOf('id="settings-summary"')))), false);
    });
});

// ─── The summary ────────────────────────────────────────────────────────────────────────────────

describe('Connections summary: one expiry rule for every connection (SE-08)', () => {
    /** Each integration's date field, set `days` out; everything else healthy. */
    const withDays = (id: 'meta' | 'tiktok' | 'youtube' | 'whatsapp', days: number | null): Json => {
        const when = days === null ? null : inDays(days);
        if (id === 'meta') return { tokenStatus: { ...VALID, dataAccessExpiresAt: when } };
        if (id === 'tiktok') return { tiktok: { ...TIKTOK, connection: { ...TIKTOK.connection, refreshExpiresAt: when } } };
        if (id === 'youtube') return { youtube: { ...YOUTUBE, connection: { ...YOUTUBE.connection, refreshExpiresAt: when } } };
        return { whatsapp: { ...WHATSAPP, token_expires_at: when } };
    };
    const table: Array<[number, string]> = [[60, 'fine'], [15, 'fine'], [14, 'expiring'], [8, 'expiring'], [4, 'expiring'], [3, 'broken'], [1, 'broken'], [0, 'broken'], [-2, 'broken']];

    it('amber at 14 days or fewer and red at 3 or fewer, the same for Meta, TikTok, YouTube and WhatsApp', () => {
        const { Settings } = load('en', 'owner');
        for (const id of ['meta', 'tiktok', 'youtube', 'whatsapp'] as const) {
            for (const [days, state] of table) {
                assert.equal(rowFor(rowsOf(Settings, withDays(id, days)), id).state, state, `${id} with ${days} days left`);
            }
            assert.equal(rowFor(rowsOf(Settings, withDays(id, null)), id).state, 'fine', `${id} with no end date`);
        }
    });

    it('says it in one sentence, the same words on every row: reconnect within N days (by the date), or that the time has run out', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { Settings, t, h } = load(lang, 'owner');
            const sentence = (days: number): string => text(t('settings.health.within', { count: days, date: h.UI.formatDay(new Date(inDays(days))) }));
            for (const id of ['meta', 'tiktok', 'youtube', 'whatsapp'] as const) {
                for (const days of [9, 3, 1]) {
                    const row = rowFor(rowsOf(Settings, withDays(id, days)), id);
                    assert.equal(text(row.detail), sentence(days), `${lang} ${id}/${days}: the one sentence, with the date`);
                    assert.equal(row.action, 'reconnect', `${id}/${days}: the one action is Reconnect`);
                }
                const gone = rowFor(rowsOf(Settings, withDays(id, -3)), id);
                assert.equal(text(gone.detail), text(t('settings.health.expired')), `${id}: past the date`);
            }
        }
    });

    it('the nearest of Meta\'s several dates decides: a token that never expires does not hide a data-access date 5 days out', () => {
        const { Settings } = load('en', 'owner');
        const row = rowFor(rowsOf(Settings, { tokenStatus: { ...VALID, expiresAt: null, dataAccessExpiresAt: inDays(5) } }), 'meta');
        assert.equal(row.state, 'expiring');
        const soonest = rowFor(rowsOf(Settings, { tokenStatus: { ...VALID, expiresAt: inDays(2), dataAccessExpiresAt: inDays(60) } }), 'meta');
        assert.equal(soonest.state, 'broken');
    });
});

describe('Connections summary: never red for "not connected yet", never "broken" for a request that failed (SE-01)', () => {
    it('nothing connected is neutral and offers Connect, for every integration', () => {
        const { Settings } = load('en', 'owner');
        const rows = rowsOf(Settings, {
            tokenStatus: NOT_CONNECTED, meta: META_NONE,
            tiktok: { ...TIKTOK, connection: { connected: false } }, youtube: { ...YOUTUBE, connection: { connected: false } },
            whatsapp: { connected: false, status: 'revoked' },
        });
        assert.deepEqual(rows.map((r) => r.state), ['not_set_up', 'not_set_up', 'not_set_up', 'not_set_up']);
        assert.deepEqual(rows.map((r) => r.action), ['connect', 'connect', 'connect', 'connect']);
    });

    it('never prints the server\'s English for a tenant that never connected', () => {
        const { Settings, t } = load('en', 'owner');
        const meta = rowFor(rowsOf(Settings, { tokenStatus: NOT_CONNECTED, meta: META_NONE }), 'meta');
        assert.equal(String(meta.detail).includes(NOT_CONNECTED.message), false);
        assert.equal(text(meta.detail), t('settings.health.meta.notConnected'));
    });

    it('a request that failed is "could not check" (grey), for every integration, and never broken', () => {
        const { Settings } = load('en', 'admin');
        const failed = new Error('boom');
        const rows = rowsOf(Settings, {
            isAdmin: true, tokenError: failed, tokenStatus: null, meta: null, metaError: failed,
            tiktok: null, tiktokError: failed, youtube: null, youtubeError: failed, whatsapp: null, whatsappError: failed,
            media: null, mediaError: failed, notify: null, notifyError: failed,
        });
        assert.equal(rows.length, 6);
        assert.ok(rows.every((r) => r.state === 'unknown'), JSON.stringify(rows.map((r) => [r.id, r.state])));
        assert.ok(rows.every((r) => r.action === 'open'), 'the card has its own Retry');
    });

    it('only what Meta itself said makes Meta broken: a rejected token live, or (when Meta could not be asked) the stored status says so', () => {
        const { Settings } = load('en', 'owner');
        assert.equal(rowFor(rowsOf(Settings, { tokenStatus: INVALID }), 'meta').state, 'broken');
        assert.equal(rowFor(rowsOf(Settings, { tokenStatus: INVALID }), 'meta').action, 'reconnect');
        const stored = { ...META, connection: { ...META.connection, tokenStatus: 'invalid' } };
        assert.equal(rowFor(rowsOf(Settings, { tokenError: new Error('x'), tokenStatus: null, meta: stored }), 'meta').state, 'broken');
        assert.equal(rowFor(rowsOf(Settings, { tokenError: new Error('x'), tokenStatus: null }), 'meta').state, 'unknown');
        assert.equal(rowFor(rowsOf(Settings, { tokenStatus: { status: 'unknown' } }), 'meta').state, 'unknown', 'an unanswered check is not a verdict');
    });

    it('a connection that Meta, TikTok, YouTube or WhatsApp refused is broken with Reconnect', () => {
        const { Settings } = load('en', 'owner');
        const rows = rowsOf(Settings, {
            tiktok: { ...TIKTOK, connection: { ...TIKTOK.connection, connected: false, status: 'invalid' } },
            youtube: { ...YOUTUBE, connection: { ...YOUTUBE.connection, connected: false, status: 'invalid' } },
            whatsapp: { connected: false, status: 'invalid' },
        });
        for (const id of ['tiktok', 'youtube', 'whatsapp']) {
            assert.equal(rowFor(rows, id).state, 'broken', id);
            assert.equal(rowFor(rows, id).action, 'reconnect', id);
        }
    });

    it('a connected account that cannot post is "needs attention", not fine', () => {
        const { Settings } = load('en', 'owner');
        const rows = rowsOf(Settings, {
            tiktok: { ...TIKTOK, connection: { ...TIKTOK.connection, canUpload: false, canDirectPost: false } },
            youtube: { ...YOUTUBE, connection: { ...YOUTUBE.connection, canUpload: false } },
        });
        assert.equal(rowFor(rows, 'tiktok').state, 'expiring');
        assert.equal(rowFor(rows, 'youtube').state, 'expiring');
    });

    it('Meta says so when comments cannot arrive (the webhook is off for a connection made with Facebook)', () => {
        const { Settings, t } = load('en', 'owner');
        const off = { ...META, connection: { ...META.connection, webhookSubscribed: false } };
        const row = rowFor(rowsOf(Settings, { meta: off }), 'meta');
        assert.equal(row.state, 'expiring');
        assert.equal(text(row.detail), t('settings.health.meta.webhookOff'));
        // A connection made by pasting a token has its webhook set up in Meta's dashboard, not here: not a finding.
        const byToken = { ...META, connection: { ...META.connection, via: 'token', webhookSubscribed: false } };
        assert.equal(rowFor(rowsOf(Settings, { meta: byToken }), 'meta').state, 'fine');
    });

    it('a healthy Meta row names the account and how long ago the last webhook came', () => {
        const { Settings, h, t } = load('en', 'owner');
        const at = new Date(Date.now() - 4 * 60000).toISOString();
        const row = rowFor(rowsOf(Settings, { health: { lastWebhookAt: at } }), 'meta');
        assert.equal(row.state, 'fine');
        assert.ok(String(row.detail).includes('@mybrand'));
        assert.ok(text(row.detail).includes(t('settings.health.lastWebhook', { age: h.UI.relativeAge(at).text })));
        const quiet = rowFor(rowsOf(Settings, { health: null }), 'meta');
        assert.ok(String(quiet.detail).includes('@mybrand'), 'without the webhook age it still names the account');
    });
});

describe('Connections summary: scope, order and actions', () => {
    it('a tenant owner gets the four workspace rows; the platform admin also gets media storage and alerts, badged', () => {
        const { Settings } = load('en', 'owner');
        assert.deepEqual(rowsOf(Settings).map((r) => r.id).sort(), ['meta', 'tiktok', 'whatsapp', 'youtube']);
        const rows = rowsOf(Settings, { isAdmin: true, media: MEDIA, notify: NOTIFY });
        assert.deepEqual(rows.map((r) => r.id).sort(), ['alerts', 'meta', 'storage', 'tiktok', 'whatsapp', 'youtube']);
        assert.deepEqual(rows.filter((r) => r.platform).map((r) => r.id).sort(), ['alerts', 'storage']);
        // A tenant is never given the platform's rows, even when the page happened to hold the data.
        assert.equal(rowsOf(Settings, { isAdmin: false, media: MEDIA, notify: NOTIFY }).length, 4);
    });

    it('a provider the platform has not set up is no row for a tenant, and a way to the app settings for the admin', () => {
        const { Settings } = load('en', 'admin');
        const unset = { tiktok: { appConfigured: false, connection: null }, youtube: { appConfigured: false, connection: null } };
        assert.equal(rowsOf(Settings, { ...unset, isAdmin: false }).some((r) => r.id === 'tiktok' || r.id === 'youtube'), false);
        const admin = rowsOf(Settings, { ...unset, isAdmin: true, media: MEDIA, notify: NOTIFY });
        const tiktok = rowFor(admin, 'tiktok');
        assert.equal(tiktok.state, 'not_set_up');
        assert.equal(tiktok.target, 'tiktok-app', 'its action opens the app card, not the connection card');
        assert.equal(rowFor(admin, 'youtube').target, 'youtube-app');
    });

    it('worst first: broken, then expiring, then could-not-check, then not set up, then fine; ties keep the page\'s own order', () => {
        const { Settings } = load('en', 'owner');
        const rows = rowsOf(Settings, {
            tokenStatus: { ...VALID, dataAccessExpiresAt: inDays(9) },
            tiktok: { ...TIKTOK, connection: { connected: false, status: 'invalid' } },
            youtubeError: new Error('x'), youtube: null,
            whatsapp: { connected: false, status: 'revoked' },
        });
        assert.deepEqual(rows.map((r) => `${r.id}:${r.state}`), ['tiktok:broken', 'meta:expiring', 'youtube:unknown', 'whatsapp:not_set_up']);
        const calm = rowsOf(Settings);
        assert.deepEqual(calm.map((r) => r.id), ['meta', 'tiktok', 'youtube', 'whatsapp']);
    });

    it('only the workspace owner is offered Connect or Reconnect; anyone else is offered to open the card', () => {
        const { Settings } = load('en', 'member');
        const rows = Array.from<Json>(Settings.connectionRows(ctxOf({
            canAdmin: false, tokenStatus: INVALID, tiktok: { ...TIKTOK, connection: { connected: false } },
        })));
        assert.equal(rowFor(rows, 'meta').action, 'open');
        assert.equal(rowFor(rows, 'tiktok').action, 'open');
    });

    it('media storage: the database is "not set up", a refusing store is broken, a nearly full one is a warning, else fine', () => {
        const { Settings } = load('en', 'admin');
        const state = (media: Json): string => rowFor(rowsOf(Settings, { isAdmin: true, media, notify: NOTIFY }), 'storage').state;
        assert.equal(state({ ...MEDIA, backend: 'postgres' }), 'not_set_up');
        assert.equal(state({ ...MEDIA, connection: { ok: false, error: 'x' } }), 'broken');
        assert.equal(state({ ...MEDIA, connection: { ok: true, bucketExists: false } }), 'broken');
        assert.equal(state({ ...MEDIA, usage: { ...MEDIA.usage, storage: { bytes: 4.6 * 1024 ** 3, files: 1 } } }), 'expiring');
        assert.equal(state(MEDIA), 'fine');
    });

    it('alerts: a working channel is fine, one that is on but cannot send is a warning, none is "not set up"', () => {
        const { Settings } = load('en', 'admin');
        const state = (notify: Json): string => rowFor(rowsOf(Settings, { isAdmin: true, media: MEDIA, notify }), 'alerts').state;
        assert.equal(state(NOTIFY), 'fine');
        assert.equal(state({ ...NOTIFY, telegram: { ...NOTIFY.telegram, chatId: '' } }), 'expiring');
        assert.equal(state({ ...NOTIFY, telegram: { enabled: false, botToken: { set: false }, chatId: '' } }), 'not_set_up');
        assert.equal(state({ ...NOTIFY, telegram: { enabled: false, botToken: { set: false }, chatId: '' }, email: { enabled: true, ready: true, to: 'me@x.test', apiKey: { set: true } } }), 'fine');
    });
});

describe('Connections summary: how it is drawn', () => {
    const draw = (lang: 'ar' | 'en', over: Json = {}) => {
        const { Settings, t } = load(lang, 'owner');
        return { markup: String(Settings.healthMarkup(Settings.connectionRows(ctxOf(over)))), t };
    };

    for (const lang of ['ar', 'en'] as const) {
        it(`all fine: one line, «${lang === 'ar' ? 'كل الاتصالات تعمل' : 'All connections are working'}», with the rows behind "show details" (${lang})`, () => {
            const { markup, t } = draw(lang);
            assert.ok(text(markup).includes(t('settings.health.allFine')));
            assert.ok(text(markup).includes(t('settings.health.showDetails')));
            assert.match(markup, /<details class="settings-health-fold">/);
            assert.ok(markup.indexOf('<details') < markup.indexOf('data-row="meta"'), 'the rows are inside the fold');
            assert.equal((markup.match(/data-row="/g) ?? []).length, 4);
        });

        it(`something needs the owner: a headline that counts, the rows open and worst first, no "all working" (${lang})`, () => {
            const { markup, t } = draw(lang, { tokenStatus: INVALID, whatsapp: { connected: false, status: 'revoked' } });
            assert.ok(text(markup).includes(t('settings.health.needs', { count: 1 })));
            assert.equal(text(markup).includes(t('settings.health.allFine')), false);
            assert.equal(markup.includes('<details'), false, 'not folded away');
            assert.ok(markup.indexOf('data-row="meta"') < markup.indexOf('data-row="whatsapp"'), 'worst first');
            assert.match(markup, /role="status"/, 'the headline is announced');
        });

        it(`nothing connected yet says so, with the rows and their Connect actions (${lang})`, () => {
            const { markup, t } = draw(lang, {
                tokenStatus: NOT_CONNECTED, meta: META_NONE, tiktok: { ...TIKTOK, connection: { connected: false } },
                youtube: { ...YOUTUBE, connection: { connected: false } }, whatsapp: { connected: false, status: 'revoked' },
            });
            assert.ok(text(markup).includes(t('settings.health.nothing')));
            assert.equal(text(markup).includes(t('settings.health.allFine')), false);
            assert.equal((markup.match(/data-state="not_set_up"/g) ?? []).length, 4);
            assert.equal((markup.match(new RegExp(`>${text(t('settings.health.connect'))}<`, 'g')) ?? []).length, 4);
        });
    }

    it('the headline\'s glyph has its own shape for each case: ● all working, ▲ something runs out, ✕ something broke', () => {
        const head = (over: Json): string => /<(?:p|summary) class="settings-health-head[^"]*"[\s\S]*?<\/(?:p|summary)>/.exec(draw('en', over).markup)![0];
        assert.match(head({}), /is-fine[\s\S]*●/);
        assert.match(head({ tokenStatus: { ...VALID, dataAccessExpiresAt: inDays(9) } }), /is-attention[\s\S]*▲/);
        assert.match(head({ tokenStatus: INVALID }), /is-broken[\s\S]*✕/);
        assert.match(head({ tokenStatus: { ...VALID, dataAccessExpiresAt: inDays(9) }, whatsapp: { connected: false, status: 'invalid' } }), /is-broken[\s\S]*✕/, 'the worst one names the headline');
    });

    it('every row is a glyph and a word (never colour alone), one detail line and ONE action that opens its card', () => {
        const { markup, t } = draw('en', { tokenStatus: { ...VALID, dataAccessExpiresAt: inDays(9) }, tiktok: { ...TIKTOK, connection: { connected: false } } });
        const rows = markup.split('<li class="settings-row"').slice(1);
        assert.equal(rows.length, 4);
        for (const row of rows) {
            assert.match(row, /data-status="connection\.[a-z_]+"/);
            assert.match(row, /<span class="status-pill-glyph" aria-hidden="true">[●▲✕○]<\/span>/, 'a glyph with a shape of its own');
            assert.equal((row.match(/<button /g) ?? []).length, 1, 'one action');
            assert.match(row, /data-action="settings:openCard"[^>]*data-card="[a-z-]+"/);
            assert.match(row, /aria-label="[^"]+: [^"]+"/, 'the button says which row it is for');
        }
        const meta = rows.find((r) => r.includes('data-row="meta"') || r.includes('data-state="expiring"'))!;
        assert.ok(text(meta).includes(t('status.connection.expiring')), 'the word, as well as the glyph');
    });

    it('a row\'s Latin values are isolated, so their punctuation does not jump to the other end of an Arabic sentence', () => {
        const { markup } = draw('ar');
        assert.ok(markup.includes('<bdi class="ltr-text" dir="ltr">@mybrand</bdi>'));
    });

    it('"Check again" re-reads the page; it is a button in the summary\'s header', () => {
        const { markup, t } = draw('en');
        assert.match(markup, /id="settings-recheck"[^>]*|data-action="settings:render"[^>]*id="settings-recheck"/);
        assert.ok(text(markup).includes(t('settings.health.recheck')));
    });
});

// ─── Unsaved edits ──────────────────────────────────────────────────────────────────────────────

/** A form control as the page reads it. */
const field = (over: Json = {}): Json => ({ type: 'text', value: '', defaultValue: '', checked: false, defaultChecked: false, ...over });
/** A card element: its id in `dataset`, and the form controls inside it. */
const card = (id: string, fields: Json[]): Json => ({
    dataset: { settingsCard: id },
    querySelectorAll: (selector: string) => (selector === 'form input, form select, form textarea' ? fields : []),
});
const select = (selectedIndex: number, defaults: boolean[]): Json => ({
    type: 'select-one', selectedIndex, options: defaults.map((defaultSelected) => ({ defaultSelected })),
});

describe('Settings: what counts as an unsaved edit', () => {
    const { Settings } = load('en', 'admin');

    it('a text field that differs from what was drawn; a box that was ticked or cleared; a select moved off its default', () => {
        assert.equal(Settings.fieldIsDirty(field({ value: 'x' })), true);
        assert.equal(Settings.fieldIsDirty(field({ value: 'x', defaultValue: 'x' })), false);
        assert.equal(Settings.fieldIsDirty(field({ type: 'textarea', value: 'a\nb', defaultValue: 'a\nb' })), false);
        assert.equal(Settings.fieldIsDirty(field({ type: 'password', value: 'secret' })), true, 'a typed secret is an unsaved edit');
        assert.equal(Settings.fieldIsDirty(field({ type: 'checkbox', checked: true, defaultChecked: false })), true);
        assert.equal(Settings.fieldIsDirty(field({ type: 'checkbox', checked: true, defaultChecked: true })), false);
        assert.equal(Settings.fieldIsDirty(field({ type: 'radio', checked: false, defaultChecked: true })), true);
        assert.equal(Settings.fieldIsDirty(select(2, [false, true, false])), true);
        assert.equal(Settings.fieldIsDirty(select(1, [false, true, false])), false, 'the option marked selected is the default');
        assert.equal(Settings.fieldIsDirty(select(0, [false, false, false])), false, 'no option marked: the first is the default');
        assert.equal(Settings.fieldIsDirty(select(1, [false, false, false])), true);
    });

    it('a file picker, a hidden field, a button and nothing at all are never an edit', () => {
        for (const type of ['file', 'hidden', 'button', 'submit', 'reset', 'image']) assert.equal(Settings.fieldIsDirty(field({ type, value: 'x' })), false, type);
        assert.equal(Settings.fieldIsDirty(null), false);
        assert.equal(Settings.fieldIsDirty({}), false);
    });

    it('a card is dirty when any field in a form of it is; only cards are named, once each, in page order', () => {
        const host = {
            querySelectorAll: (selector: string) => (selector === '[data-settings-card]' ? [
                card('token', [field(), field({ value: 'typed' })]), card('site', [field({ value: 'a', defaultValue: 'a' })]),
                card('notify', [field({ type: 'checkbox', checked: true }), field({ value: 'z' })]),
            ] : []),
        };
        assert.deepEqual(plain(Settings.dirtyCards(host)), ['token', 'notify']);
        assert.deepEqual(plain(Settings.dirtyCards({ querySelectorAll: () => [] })), []);
        assert.deepEqual(plain(Settings.dirtyCards({})), [], 'a host with no DOM has nothing unsaved');
    });

    it('only controls inside a <form> are looked at, so the instant ones (language, theme, the clean-up switch) never count', () => {
        const selectors: string[] = [];
        const probe = { dataset: { settingsCard: 'appearance' }, querySelectorAll: (s: string) => { selectors.push(s); return []; } };
        Settings.dirtyCards({ querySelectorAll: () => [probe] });
        assert.deepEqual(selectors, ['form input, form select, form textarea']);
    });
});

describe('Settings: leaving with unsaved edits', () => {
    it('canLeave() is false while any card holds an edit, and true once none does', async () => {
        const { Settings, h } = load('en', 'admin');
        const container = h.el('page-container') as Json;
        const fields = [field({ value: 'x' })];
        container.querySelectorAll = (selector: string) => (selector === '[data-settings-card]' ? [card('site', fields)] : []);
        assert.equal(Settings.canLeave(), false);
        fields[0]!.value = '';
        assert.equal(Settings.canLeave(), true);
    });

    it('the router asks it: leaving Settings with an edit is a "page" guard, and the shared beforeunload asks the same question', () => {
        const { Settings, h } = load('en', 'admin');
        h.App.currentPage = 'settings';
        const fields = [field({ value: 'x' })];
        (h.el('page-container') as Json).querySelectorAll = (selector: string) => (selector === '[data-settings-card]' ? [card('notify', fields)] : []);
        assert.equal(h.App.unsavedKind(), 'page');
        let prevented = 0;
        h.App.bindShellGuards();
        h.listeners.window.get('beforeunload')!.forEach(({ fn }) => fn({ preventDefault: () => { prevented += 1; }, returnValue: undefined }));
        assert.equal(prevented, 1, 'a reload or a closed tab is asked about');
        fields[0]!.value = '';
        assert.equal(h.App.unsavedKind(), '');
        assert.equal(typeof Settings.canLeave, 'function');
    });

    it('a tab that holds an edit shows its dot, and loses it when the edit is gone', () => {
        const { Settings, h } = load('en', 'admin');
        const container = h.el('page-container') as Json;
        const fields = [field({ value: 'x' })];
        container.querySelectorAll = (selector: string) => (selector === '[data-settings-card]' ? [card('storage', fields)] : []);
        const dots = ['connections', 'messages', 'appearance', 'advanced', 'platform'].map((id) => ({ dataset: { settingsDot: id }, hidden: true }));
        h.document.querySelectorAll = (selector: string) => (selector === '[data-settings-dot]' ? dots : []);
        Settings.syncDirtyDots();
        assert.deepEqual(dots.map((d) => d.hidden), [true, true, true, true, false], 'the platform tab holds the storage card');
        fields[0]!.value = '';
        Settings.syncDirtyDots();
        assert.ok(dots.every((d) => d.hidden), 'cleared');
    });

    it('the dot is drawn hidden on every tab, with words for a screen reader', async () => {
        const { Settings, container, t } = load('en', 'admin');
        await Settings.render();
        await settle();
        const dots = container.innerHTML.match(/<span class="settings-tab-dot"[^>]*>/g) ?? [];
        assert.equal(dots.length, 5);
        for (const dot of dots) {
            assert.match(dot, /role="img"/);
            assert.ok(dot.includes(`aria-label="${t('settings.tab.unsaved')}"`));
            assert.match(dot, /\shidden>$/);
        }
    });
});

// ─── A save refreshes in place ──────────────────────────────────────────────────────────────────

describe('Settings: a save keeps the other cards\' edits, the scroll and the tab (SE-02)', () => {
    const api = { getTokenStatus: async () => VALID, getMetaConnection: async () => META, getTikTokConnection: async () => TIKTOK, getYouTubeConnection: async () => YOUTUBE, getWhatsAppConnection: async () => WHATSAPP, getMediaStorage: async () => MEDIA, getNotifySettings: async () => NOTIFY, getSiteSettings: async () => SITE };

    /** A page that is already on screen: a root, live cards (some dirty), and stand-ins that record what replaces them. */
    function onScreen(live: Record<string, Json>) {
        const rig = load('en', 'admin', { api, hash: '#/settings?s=platform' });
        const stands: Record<string, { replaced: unknown[] }> = {};
        const container = rig.container;
        container.querySelector = (selector: string) => {
            if (selector === '[data-settings-root]') return {};
            const stand = /^\[data-settings-card="([^"]+)"\]\[data-adopt\]$/.exec(selector);
            if (stand) {
                const id = stand[1]!;
                stands[id] = stands[id] ?? { replaced: [] };
                return { replaceWith: (node: unknown) => { stands[id]!.replaced.push(node); } };
            }
            const wrap = /^\[data-settings-card="([^"]+)"\]$/.exec(selector);
            return wrap ? live[wrap[1]!] ?? null : null;
        };
        container.querySelectorAll = (selector: string) => (selector === '[data-settings-card]' ? Object.values(live) : []);
        return { ...rig, stands };
    }

    it('a card with unsaved edits that was NOT the one saved is carried over as it is: not redrawn, not copied, its live element put back', async () => {
        const site = card('site', [field({ value: 'typed' })]);
        const storage = card('storage', [field()]);
        const { Settings, container, stands } = onScreen({ site, storage });
        await Settings.render();
        await settle();
        assert.ok(container.innerHTML.includes('data-settings-card="site" data-adopt'), 'a stand-in where it was');
        assert.equal(container.innerHTML.includes('data-settings-card="storage" data-adopt'), false, 'a clean card is drawn from the new answers');
        assert.equal(container.innerHTML.includes('id="site-settings-form"'), false, 'the carried card\'s form is not drawn again');
        assert.ok(container.innerHTML.includes('id="media-storage-form"'));
        assert.deepEqual(stands.site!.replaced, [site], 'the very element the person typed in goes back');
        assert.equal(stands.storage, undefined);
    });

    it('the card that was just saved is drawn fresh, even though its fields differ from the page before: the answer is the saved one', async () => {
        const site = card('site', [field({ value: 'typed' })]);
        const notify = card('alerts', [field({ type: 'password', value: 'typed-secret' })]);
        const { Settings, container, stands } = onScreen({ site, alerts: notify });
        // Pressing Save in the site card: the click is noted, then the save ends in render().
        Settings.noteActed({ closest: () => ({ dataset: { settingsCard: 'site' } }), getAttribute: () => 'settings:saveSiteSettings' });
        await Settings.render();
        await settle();
        assert.equal(container.innerHTML.includes('data-settings-card="site" data-adopt'), false);
        assert.ok(container.innerHTML.includes('id="site-settings-form"'), 'the saved card is redrawn');
        assert.ok(container.innerHTML.includes('data-settings-card="alerts" data-adopt'), 'the other card keeps its typed secret');
        assert.deepEqual(stands.alerts!.replaced, [notify]);
    });

    it('stays where it was: no skeleton, and the scroll is put back', async () => {
        const { Settings, h } = onScreen({ site: card('site', [field()]) });
        let skeletons = 0;
        const beginLoad = h.Motion.beginLoad.bind(h.Motion);
        h.Motion.beginLoad = (...args: unknown[]) => { skeletons += 1; return beginLoad(...args); };
        h.window.scrollY = 480;
        await Settings.render();
        await settle();
        assert.equal(skeletons, 0, 'the page is not replaced by a skeleton while the answers come in');
        assert.deepEqual(plain(h.scrolls.at(-1)), { top: 480, behavior: 'instant' });
    });

    it('the first draw is the other way round: a skeleton, no scroll to restore, nothing carried', async () => {
        const { Settings, h, container } = load('en', 'admin', { api });
        let skeletons = 0;
        const beginLoad = h.Motion.beginLoad.bind(h.Motion);
        h.Motion.beginLoad = (...args: unknown[]) => { skeletons += 1; return beginLoad(...args); };
        container.querySelectorAll = () => [card('site', [field({ value: 'typed' })])];
        h.window.scrollY = 480;
        await Settings.render();
        await settle();
        assert.equal(skeletons, 1);
        assert.equal(container.innerHTML.includes('data-adopt'), false);
        assert.equal(h.scrolls.some((s: Json) => s && s.top === 480), false);
    });

    it('which card is "the one just acted on": a button or form in a card, for a short while, and only once', () => {
        const { Settings } = load('en', 'admin');
        const control = (id: string): Json => ({ closest: () => (id ? { dataset: { settingsCard: id } } : null) });
        Settings.noteActed(control('notify'));
        assert.equal(Settings.takeActed(), 'notify');
        assert.equal(Settings.takeActed(), '', 'taken once');
        Settings.noteActed(control(''));
        assert.equal(Settings.takeActed(), '', 'a control outside every card (Check again, a tab) names none');
        Settings.noteActed(control('site'));
        Settings._acted.at -= Settings.ACTED_MS + 1;
        assert.equal(Settings.takeActed(), '', 'a click from long ago is not a save in flight');
    });

    it('a save that was overtaken by a later refresh still counts as saved: the later refresh redraws that card, it does not carry it', async () => {
        const { Settings, container } = onScreen({ site: card('site', [field({ value: 'typed' })]) });
        Settings.noteActed({ closest: () => ({ dataset: { settingsCard: 'site' } }), getAttribute: () => '' });
        const first = Settings.render();
        const second = Settings.render();
        await Promise.all([first, second]);
        await settle();
        assert.equal(container.innerHTML.includes('data-settings-card="site" data-adopt'), false);
        assert.ok(container.innerHTML.includes('id="site-settings-form"'));
        assert.equal(Settings._saving.size, 0, 'and it is forgotten once a render has landed');
    });

    it('listens on the page container once, and lets go of it when the page is left', async () => {
        const { Settings, container } = load('en', 'admin', { api });
        await Settings.render();
        await settle();
        assert.deepEqual([...container.listeners.keys()].sort(), ['change', 'click', 'input', 'submit']);
        await Settings.render();
        await settle();
        assert.equal(container.listeners.get('input')!.length, 1, 'a second draw does not stack a second listener');
        Settings.destroy();
        for (const type of ['change', 'click', 'input', 'submit']) assert.equal(container.listeners.get(type)!.length, 0, `${type} released`);
    });

    it('a click on a copy button is not an act on the card; a click on a card\'s button is', async () => {
        const { Settings, container } = load('en', 'admin', { api });
        await Settings.render();
        await settle();
        const click = container.listeners.get('click')![0]!;
        const target = (action: string, id: string): Json => ({ closest: () => ({ getAttribute: () => action, dataset: {}, closest: () => ({ dataset: { settingsCard: id } }) }) });
        (click as unknown as (e: Json) => void)({ target: target('app:copyValue', 'site') });
        assert.equal(Settings._acted, null);
        (click as unknown as (e: Json) => void)({ target: target('settings:saveSiteSettings', 'site') });
        assert.equal(Settings._acted.id, 'site');
    });
});

// ─── Deep links and tab changes inside the page ─────────────────────────────────────────────────

describe('Settings: opening a card from anywhere', () => {
    const el = (id: string, extra: Json = {}): Json => ({ id, calls: [] as unknown[], scrollIntoView(o: unknown) { this.calls.push(['scroll', o]); }, focus(o: unknown) { this.calls.push(['focus', o]); }, ...extra });

    it('in the open tab it scrolls to the card and puts focus on its main control', async () => {
        const { Settings, h } = load('en', 'owner');
        await Settings.render();
        await settle();
        const meta = h.el('settings-meta', el('settings-meta'));
        const connect = h.el('meta-connect', el('meta-connect'));
        Settings.openCard('meta');
        assert.equal((meta as Json).calls.length, 1);
        assert.deepEqual(plain((connect as Json).calls[0]), ['focus', { preventScroll: true }]);
        assert.equal(h.location.hash, '', 'the address did not move');
    });

    it('in another tab it changes the address (so Back returns), and the tab change does the rest', async () => {
        const { Settings, h } = load('en', 'admin');
        await Settings.render();
        await settle();
        Settings.openCard('tiktok-app');
        assert.equal(h.location.hash, '#/settings?s=platform&card=tiktok-app');
        Settings.openCard('token');
        assert.equal(h.location.hash, '#/settings?s=advanced&card=token');
    });

    it('a card this viewer cannot see, or that does not exist, does nothing', async () => {
        const { Settings, h } = load('en', 'owner');
        await Settings.render();
        await settle();
        Settings.openCard('storage');
        Settings.openCard('nonsense');
        Settings.openCard('');
        Settings.openCard(undefined);
        assert.equal(h.location.hash, '');
    });

    it('the access token card\'s Connect goes to the Instagram & Facebook card, in whichever tab the admin is on', async () => {
        const { Settings, h } = load('en', 'admin', { hash: '#/settings?s=advanced' });
        await Settings.render();
        await settle();
        assert.equal(Settings._view.group, 'advanced');
        Settings.goConnect();
        assert.equal(h.location.hash, '#/settings?s=connections&card=meta');
    });

    it('a collapsed provider-app card is opened when it is the target', () => {
        const { Settings, h } = load('en', 'admin');
        Settings._view = { group: 'platform', card: '' };
        const details = { open: false };
        const wrapper = el('settings-tiktok-app', { querySelector: (s: string) => (s === 'details' ? details : { tagName: 'SUMMARY', focus() {} }) });
        h.el('settings-tiktok-app', wrapper);
        Settings.revealCard('tiktok-app');
        assert.equal(details.open, true);
        assert.equal(wrapper.calls[0][0], 'scroll');
    });

    it('a tab change inside the page redraws nothing: the panels and the tab marks follow the address', async () => {
        const { Settings, h, container } = load('en', 'admin');
        await Settings.render();
        await settle();
        const before = container.innerHTML;
        const panelEls = ['connections', 'messages', 'appearance', 'advanced', 'platform'].map((id) => ({ dataset: { group: id }, hidden: id !== 'connections' }));
        const links = panelEls.map(() => ({ marks: new Set<string>(), setAttribute(n: string) { this.marks.add(n); }, removeAttribute(n: string) { this.marks.delete(n); } }));
        container.querySelectorAll = (selector: string) => (selector === '.settings-panel' ? panelEls : selector === '.settings-tabbar a.ui-tab' ? links : []);
        h.location.hash = '#/settings?s=advanced';
        Settings.onHashChange();
        assert.deepEqual(panelEls.map((p) => p.hidden), [true, true, true, false, true]);
        assert.deepEqual(links.map((l) => l.marks.has('aria-current')), [false, false, false, true, false]);
        assert.equal(container.innerHTML, before, 'nothing was drawn again');
        assert.ok(h.announcements.includes(h.t('settings.group.advanced')), 'a screen reader is told which tab opened');
    });

    it('the router hands an in-page address change to the page instead of tearing it down', async () => {
        const { Settings, h } = load('en', 'admin');
        h.App.currentPage = 'settings';
        h.App.pages.settings = { src: 'settings', page: () => Settings };
        let applied = 0;
        const original = Settings.onHashChange.bind(Settings);
        Settings.onHashChange = () => { applied += 1; original(); };
        h.App.show = () => { throw new Error('a tab change must not navigate'); };
        h.location.hash = '#/settings?s=messages';
        h.App.onHashChange({ oldURL: 'https://example.test/dashboard#/settings', newURL: 'https://example.test/dashboard#/settings?s=messages' });
        assert.equal(applied, 1);
    });
});

// ─── Disconnect, and the provider apps ──────────────────────────────────────────────────────────

describe('Settings: Disconnect at the end of its card, the provider apps in the Platform tab (SE-13, SE-05)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`TikTok: Reconnect is in the card's body, Disconnect alone in a danger-zone row after it, and the app block is not in the card (${lang})`, () => {
            const { Settings, t } = load(lang, 'admin');
            const markup = String(Settings.tiktokSection({ tiktok: TIKTOK, tiktokError: null }));
            const reconnect = markup.indexOf('id="settings-tiktok-connect"');
            const danger = markup.indexOf('class="settings-danger"');
            const disconnect = markup.indexOf('id="settings-tiktok-disconnect"');
            assert.ok(reconnect > 0 && danger > reconnect && disconnect > danger, 'Reconnect, then the danger zone, then Disconnect');
            assert.ok(text(markup).includes(t('settings.dangerZone')));
            assert.equal(markup.includes('tiktok-app-form'), false, 'the app block lives in the Platform tab');
            assert.equal(markup.indexOf('</section>') > disconnect, true, 'the danger zone is inside the card, at its end');
        });

        it(`YouTube: the same (${lang})`, () => {
            const { Settings } = load(lang, 'admin');
            const markup = String(Settings.youtubeSection({ youtube: YOUTUBE, youtubeError: null }));
            const reconnect = markup.indexOf('id="settings-youtube-connect"');
            const danger = markup.indexOf('class="settings-danger"');
            assert.ok(reconnect > 0 && danger > reconnect && markup.indexOf('id="settings-youtube-disconnect"') > danger);
            assert.equal(markup.includes('youtube-app-form'), false);
        });
    }

    it('Instagram & Facebook: Disconnect (only for a connection made with Facebook) is in a danger-zone row after Reconnect', () => {
        const { h, t } = load('en', 'owner', { files: ['dashboard/js/pages/meta_connect.js'] });
        const MetaConnect = h.run<Json>('MetaConnect');
        const body = String(MetaConnect.settingsBody(META, { canAdminister: true }));
        const connect = body.indexOf('id="meta-connect"');
        const danger = body.indexOf('class="settings-danger"');
        assert.ok(connect > 0 && danger > connect && body.indexOf('id="meta-disconnect"') > danger);
        assert.ok(text(body).includes(t('settings.dangerZone')));
        const byToken = String(MetaConnect.settingsBody({ ...META, connection: { ...META.connection, via: 'token' } }, { canAdminister: true }));
        assert.equal(byToken.includes('meta-disconnect'), false, 'a connection made by pasting a token is never offered Disconnect');
        assert.equal(byToken.includes('settings-danger'), false);
        const member = String(MetaConnect.settingsBody(META, { canAdminister: false }));
        assert.equal(member.includes('meta-disconnect'), false, 'nor is anyone who is not the owner');
    });

    it('the Instagram & Facebook card holds no operator block any more: the platform admin finds it in the Platform tab', () => {
        const { Settings, h } = load('en', 'admin', { files: ['dashboard/js/pages/meta_connect.js'] });
        const app = { enabled: true, configId: {}, mode: 'scope', app: { idSet: true, secretSet: true }, publicBaseUrl: 'https://x.example', register: null };
        const card = String(Settings.metaSection({ meta: META, metaError: null, metaApp: app, metaAppError: null }));
        assert.equal(card.includes('meta-app-form'), false);
        // The module is not loaded by `App.loadPageModule` here (stubbed), so the Platform card is drawn straight from the loaded one.
        const platform = String(Settings.metaAppSection({ metaApp: app, metaAppError: null }));
        assert.ok(platform.includes('id="meta-app-form"'));
        assert.ok(platform.includes('<details'));
        assert.ok(h.run<Json>('MetaConnect'));
    });

    it('the TikTok and YouTube app blocks are cards of their own, with the same forms and ids they always had', () => {
        const { Settings } = load('en', 'admin');
        const reg = { websiteUrl: 'https://x.example/', termsUrl: 'https://x.example/terms', privacyUrl: 'https://x.example/privacy', redirectUri: 'https://x.example/cb', webhookUrl: 'https://x.example/hook', homepageUrl: 'https://x.example/' };
        const tiktokApp = { clientKey: { value: 'k' }, clientSecret: { source: 'database', preview: 'ab' }, publicBaseUrl: { saved: '', effective: '' }, verification: {}, directPostEnabled: false, audited: false, profileScopeEnabled: false, register: reg, scopes: ['video.upload'] };
        const youtubeApp = { clientId: { value: 'id' }, clientSecret: { source: 'database', preview: 'ab' }, publicUploads: false, register: reg, scopes: ['x'] };
        const tiktok = String(Settings.tiktokAppSection({ tiktok: TIKTOK, tiktokApp, tiktokAppError: null }));
        assert.ok(tiktok.includes('id="tiktok-app-form"') && tiktok.includes('data-submit="settings:saveTikTokApp"') && tiktok.includes('id="tiktok-app-submit"'));
        const youtube = String(Settings.youtubeAppSection({ youtube: YOUTUBE, youtubeApp, youtubeAppError: null }));
        assert.ok(youtube.includes('id="youtube-app-form"') && youtube.includes('data-submit="settings:saveYouTubeApp"'));
        assert.equal(String(Settings.tiktokAppSection({ tiktok: TIKTOK, tiktokApp: null, tiktokAppError: null })), '', 'nothing to draw for a viewer who got no app settings');
    });

    it('a platform admin whose TikTok app is not set up is told where to set it up, with a button that opens that card; a member is not', () => {
        for (const lang of ['ar', 'en'] as const) {
            const admin = load(lang, 'admin');
            const markup = String(admin.Settings.tiktokSection({ tiktok: { appConfigured: false, connection: null }, tiktokError: null }));
            assert.ok(text(markup).includes(admin.t('settings.tiktok.notConfiguredAdmin')));
            assert.match(markup, /data-action="settings:openCard" data-card="tiktok-app"/);
            assert.equal(admin.t('settings.tiktok.notConfiguredAdmin').includes('أدناه') || /\bbelow\b/.test(admin.t('settings.tiktok.notConfiguredAdmin')), false, 'it does not say "below": the form is in another tab');
            const member = load(lang, 'member');
            const said = String(member.Settings.tiktokSection({ tiktok: { appConfigured: false, connection: null }, tiktokError: null }));
            assert.equal(said.includes('settings:openCard'), false);
            assert.ok(text(said).includes(member.t('settings.tiktok.notConfiguredMember')));
        }
    });
});

// ─── The files ──────────────────────────────────────────────────────────────────────────────────

describe('Settings: the stylesheet and its registration', () => {
    const css = readFileSync('dashboard/css/pages/settings.css', 'utf8');

    it('the page declares css: true, and the file it names exists', () => {
        assert.match(readFileSync('dashboard/js/app.js', 'utf8'), /settings: \{ src: 'settings', page: \(\) => SettingsPage, css: true \}/);
        assert.ok(existsSync('dashboard/css/pages/settings.css'));
    });

    it('uses logical properties and tokens only: no left or right, no colour literals, no pixel sizes outside a media query', () => {
        const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
        assert.equal(/\b(margin|padding|border)-(left|right)\b|\b(left|right)\s*:|text-align\s*:\s*(left|right)|float\s*:/.test(code), false, 'logical properties only');
        assert.equal(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(code), false, 'colours come from tokens');
        // A hairline border (`1px solid`) and the focus ring's inset are the stylesheet's own convention, not sizes.
        const outsideMedia = code.split('\n').filter((line) => !/@media/.test(line)).join('\n').replace(/\b1px solid\b/g, '').replace(/outline-offset:\s*-?2px/g, '');
        assert.equal(/\b\d+px\b/.test(outsideMedia), false, 'sizes come from tokens');
    });

    it('the tab bar scrolls sideways on a phone, sticks under the header, and keeps every target at 44px', () => {
        assert.match(css, /\.settings-tabbar \{[^}]*position: sticky;[^}]*inset-block-start: var\(--header-height\)/);
        assert.match(css, /\.settings-tabbar \.ui-tabs \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto/);
        assert.match(css, /summary\.settings-health-head \{[^}]*min-block-size: var\(--tap-target\)/);
    });

    it('every string this page adds exists in both languages (the dictionaries are checked whole by check:i18n)', () => {
        const ar = loadDashboard({ lang: 'ar' }).t;
        const en = loadDashboard({ lang: 'en' }).t;
        const keys = ['settings.nav.label', 'settings.group.connections', 'settings.group.messages', 'settings.group.appearance', 'settings.group.advanced', 'settings.group.platform',
            'settings.scope.platform', 'settings.tab.unsaved', 'settings.platform.lead', 'settings.dangerZone', 'settings.health.title', 'settings.health.allFine', 'settings.health.unknown'];
        for (const key of keys) {
            assert.notEqual(ar(key), key, `ar ${key}`);
            assert.notEqual(en(key), key, `en ${key}`);
            assert.notEqual(ar(key), en(key), `${key} is translated, not copied`);
        }
        assert.equal(ar('settings.health.allFine'), 'كل الاتصالات تعمل');
        assert.equal(ar('settings.group.connections'), 'الاتصالات');
        assert.equal(ar('settings.group.messages'), 'الرسائل والتنبيهات');
        assert.equal(ar('settings.group.platform'), 'المنصة');
        assert.equal(ar('settings.scope.platform'), 'لكل المساحات');
    });

    it('the reconnect-within sentence agrees in number in Arabic: one, two, a few, many', () => {
        const { t } = load('ar', 'owner');
        const said = (count: number): string => t('settings.health.within', { count, date: 'D' });
        assert.ok(said(1).includes('يوم واحد'));
        assert.ok(said(2).includes('يومين'));
        assert.ok(said(5).includes('5 أيام'));
        assert.ok(said(12).includes('12 يومًا'));
        const attention = (count: number): string => t('settings.health.needs', { count });
        assert.equal(attention(1), 'اتصال واحد يحتاج انتباهك');
        assert.equal(attention(2), 'اتصالان يحتاجان انتباهك');
        assert.equal(attention(4), '4 اتصالات تحتاج انتباهك');
    });
});
