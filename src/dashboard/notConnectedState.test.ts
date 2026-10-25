/**
 * "Not connected yet" is a state, not an error; and a check that could not run is not a verdict (UX US1: T048, T049's screen;
 * audit SE-01, OV-04, OV-08).
 *
 * A tenant that never connected used to open on the red "Invalid / expired" pill, a strip that printed the server's English
 * `message` inside the Arabic page, and on Today a danger alert about a token it never had. `GET /settings/token/status` now says
 * `not_connected` for that tenant and `unknown` when Meta did not answer. The REAL `settings.js` and `overview.js` in the shared
 * `node:vm` harness, in both languages:
 *
 *   - the four states are four different things on screen: only `invalid` is red, and only `invalid` shows Meta's words;
 *   - `not_connected` is a neutral pill and a Connect action, and says nothing the server said;
 *   - `unknown` is neutral, says it is not a verdict, and offers Retry;
 *   - Today raises an info alert (not danger) for a tenant that never connected, and a warning (not danger) for an unanswered check.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** What the server says today for a tenant created by name (`NOT_CONNECTED_MESSAGE`): English, and never to be printed. */
const SERVER_ENGLISH = 'Instagram and Facebook are not connected for this tenant yet: connect them first.';

const NOT_CONNECTED = { status: 'not_connected', code: 'NOT_CONNECTED', message: SERVER_ENGLISH, expiresAt: null, dataAccessExpiresAt: null, instagramPageId: null, facebookPageId: null, isActive: true };
const UNKNOWN = { status: 'unknown', message: 'Meta could not be reached to check the token just now.', expiresAt: null, dataAccessExpiresAt: null, instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };
const INVALID = { status: 'invalid', message: 'Token validation failed — token may be expired or revoked.', error: 'Meta reports the token as not valid: Session has expired', expiresAt: null, dataAccessExpiresAt: null, instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };
const VALID = { status: 'valid', type: 'PAGE', expiresAt: null, dataAccessExpiresAt: null, scopes: ['instagram_basic'], instagramPageId: 'ig-1', facebookPageId: 'fb-1', isActive: true };

/**
 * The Settings page, rendered whole against `tokenStatus`; every other call it makes fails, which is isolated per card.
 *
 * The access token card moved to the Advanced tab, which only a platform admin sees (UX US10, SE-03), so the card's own states are read as
 * the platform admin; `settingsTabs.test.ts` holds what a tenant owner sees instead (the Connections summary).
 */
async function renderSettings(lang: 'ar' | 'en', tokenStatus: Json, role: { canAdminister: boolean; isAdmin?: boolean } = { canAdminister: true }) {
    const stubs: Json = {
        token: 't',
        getTokenStatus: async () => tokenStatus,
        getWebhookToken: async () => ({ configuredInDatabase: true, preview: 'ab•••yz', length: 12, webhookUrl: 'https://example.test/webhook' }),
    };
    const api = new Proxy(stubs, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) });
    const h = loadDashboard({
        lang,
        files: ['dashboard/js/pages/settings.js'],
        globals: {
            API: api,
            App: {
                canAdminister: () => role.canAdminister, isAdmin: () => role.isAdmin !== false, canOperate: () => true,
                hashParam: () => '', hashParams: () => ({}), route: (page: string, params: Record<string, string> = {}) => `#/${page}?${new URLSearchParams(params)}`,
                currentTheme: () => 'auto', loadPageModule: async () => null,
            },
        },
    });
    const container = h.el('page-container');
    const page: Json = h.run('SettingsPage');
    await page.render();
    await settle();
    return { h, page, html: container.innerHTML, t: h.t };
}

describe('Settings: the access token card has four states (SE-01)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`never connected: a neutral pill, one sentence of its own and a Connect action; not "invalid", not the server's English (${lang})`, async () => {
            const { html, t } = await renderSettings(lang, NOT_CONNECTED);
            assert.match(html, /data-status="connection\.not_set_up"/, 'the neutral pill');
            assert.match(html, /data-tone="neutral"/);
            assert.ok(text(html).includes(t('settings.notConnected')));
            assert.ok(text(html).includes(t('settings.notConnectedBody')));
            assert.match(html, /data-action="settings:goConnect"/, 'the Connect action');
            assert.ok(text(html).includes(t('settings.connectAction')));
            assert.equal(html.includes(SERVER_ENGLISH), false, 'the server\'s message is never printed');
            assert.equal(text(html).includes(t('settings.invalid')), false, 'never the red "Invalid / expired"');
            assert.equal(html.includes('health-stale'), false);
            assert.equal(text(html).includes(t('settings.tokenProblem')), false, 'no "Meta rejected the token" strip');
            assert.equal(text(html).includes(t('settings.expiresNever')), false, '"never expires" is not said about a token that does not exist');
            assert.equal(/settings\.(notConnected|connectAction|tokenUnknown)/.test(text(html)), false, 'no raw key');
        });
    }

    it('a member who is not the owner is told who can connect, and is not offered a button that would be refused', async () => {
        const { html, t } = await renderSettings('en', NOT_CONNECTED, { canAdminister: false });
        assert.ok(text(html).includes(t('settings.notConnected')));
        assert.equal(html.includes('settings:goConnect'), false);
        assert.ok(text(html).includes(t('settings.ownerOnlyMeta')));
    });

    for (const lang of ['ar', 'en'] as const) {
        it(`a check that could not run: neutral, "not a verdict", with Retry; not "invalid" (${lang})`, async () => {
            const { html, t } = await renderSettings(lang, UNKNOWN);
            assert.match(html, /data-status="connection\.unknown"/);
            assert.match(html, /data-tone="neutral"/);
            assert.ok(text(html).includes(t('settings.tokenUnknown')));
            assert.ok(text(html).includes(t('settings.tokenUnknownBody')));
            assert.match(html, /data-action="settings:render"/, 'Retry');
            assert.equal(html.includes(UNKNOWN.message), false);
            assert.equal(text(html).includes(t('settings.invalid')), false);
            assert.equal(html.includes('health-stale'), false);
            assert.equal(text(html).includes(t('settings.expiresNever')), false);
        });

        it(`a token Meta rejected is still the red one, with Meta's reason (${lang})`, async () => {
            const { html, t } = await renderSettings(lang, INVALID);
            assert.ok(html.includes('health-stale'));
            assert.ok(text(html).includes(t('settings.invalid')));
            assert.ok(text(html).includes(t('settings.tokenProblem')));
            assert.ok(html.includes('Session has expired'));
            assert.equal(html.includes('settings:goConnect'), false);
        });

        it(`a valid token is the green one, as before (${lang})`, async () => {
            const { html, t } = await renderSettings(lang, VALID);
            assert.ok(html.includes('health-fresh'));
            assert.ok(text(html).includes(t('settings.valid')));
            assert.ok(text(html).includes(t('settings.expiresNever')));
            assert.equal(html.includes('settings:goConnect'), false);
        });
    }

    it('any status this screen does not know is treated as invalid, not as healthy', async () => {
        const { page } = await renderSettings('en', VALID);
        for (const status of ['', undefined, 'no_creator', 'weird']) assert.equal(page.tokenState({ status }), 'invalid', String(status));
        assert.equal(page.tokenState(null), 'invalid');
        for (const status of ['valid', 'not_connected', 'unknown']) assert.equal(page.tokenState({ status }), status);
    });

    it('Connect scrolls to the Connections card and focuses its button', async () => {
        const { h, page } = await renderSettings('en', NOT_CONNECTED);
        const scrolled: unknown[] = [];
        const card = h.el('settings-meta');
        (card as Json).scrollIntoView = (options: unknown) => { scrolled.push(options); };
        const button = h.el('meta-connect');
        page.goConnect();
        assert.equal(scrolled.length, 1);
        assert.equal(button.focusCalls.length, 1, 'focus lands on the button that connects');
        assert.deepEqual(JSON.parse(JSON.stringify(button.focusCalls[0])), { preventScroll: true });
    });

    it('Connect with no Connections card on screen does nothing, rather than throwing', async () => {
        const { page } = await renderSettings('en', NOT_CONNECTED);
        assert.doesNotThrow(() => page.goConnect());
    });
});

// ─── Today ───────────────────────────────────────────────────────────────────────────────────

describe('Today: the token alert (OV-04, OV-08)', () => {
    function overview(lang: 'ar' | 'en') {
        const h = loadDashboard({ lang, files: ['dashboard/js/pages/overview.js'], globals: { App: {}, API: { token: 't' } } });
        return { page: h.run('OverviewPage') as Json, t: h.t };
    }
    const ok = (value: unknown) => ({ status: 'fulfilled', value });
    const alertsFor = (page: Json, token: Json | null, rejected = false) =>
        page.buildAlerts({ activeCampaigns: 1 }, ok({ data: [] }), rejected ? { status: 'rejected', reason: new Error('x') } : ok(token), ok([]), ok([]), ok([]), ok(null))
            .map((a: Json) => ({ ...a }));

    for (const lang of ['ar', 'en'] as const) {
        it(`never connected: an info alert with the way to connect, not the red "invalid" (${lang})`, () => {
            const { page, t } = overview(lang);
            const alerts = alertsFor(page, NOT_CONNECTED);
            assert.equal(alerts.length, 1);
            assert.equal(alerts[0].level, 'info');
            assert.equal(alerts[0].title, t('overview.alert.notConnected'));
            assert.equal(alerts[0].body, t('overview.alert.notConnectedBody'));
            assert.equal(alerts[0].action, t('overview.alert.connect'));
            assert.equal(alerts[0].target, 'settings');
            assert.equal(alerts.some((a: Json) => a.level === 'danger'), false);
            assert.equal(JSON.stringify(alerts).includes(SERVER_ENGLISH), false);
            assert.notEqual(alerts[0].title, t('overview.alert.tokenInvalid'));
        });

        it(`a check Meta did not answer: a warning that says so, not the red "invalid" (${lang})`, () => {
            const { page, t } = overview(lang);
            const alerts = alertsFor(page, UNKNOWN);
            assert.equal(alerts.length, 1);
            assert.equal(alerts[0].level, 'warning');
            assert.equal(alerts[0].title, t('overview.alert.tokenUnknown'));
            assert.equal(alerts[0].body, t('overview.alert.tokenUnansweredBody'));
            assert.equal(alerts.some((a: Json) => a.level === 'danger'), false);
        });

        it(`a token Meta rejected is still danger (${lang})`, () => {
            const { page, t } = overview(lang);
            const alerts = alertsFor(page, INVALID);
            assert.equal(alerts[0].level, 'danger');
            assert.equal(alerts[0].title, t('overview.alert.tokenInvalid'));
        });

        it(`a valid token raises nothing (${lang})`, () => {
            const { page } = overview(lang);
            assert.equal(alertsFor(page, VALID).length, 0);
        });
    }

    it('a token that could not even be asked about is still the warning it was', () => {
        const { page, t } = overview('en');
        const alerts = alertsFor(page, null, true);
        assert.equal(alerts[0].level, 'warning');
        assert.equal(alerts[0].title, t('overview.alert.tokenUnknown'));
    });
});
