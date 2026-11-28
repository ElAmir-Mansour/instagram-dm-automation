/**
 * What the live check of a COMPANY workspace found on 2026-11-28 (a test workspace with the company preset: Inbox, Keyword replies, the DM assistant,
 * the Scheduler and Results), and what each fix promises:
 *
 *   - The Scheduler offered TikTok (the platform list and "Also send to TikTok") in a workspace without TikTok, which the server refuses on save
 *     (404 MODULE_OFF). A NEW post is now offered TikTok only where the workspace has it; an existing TikTok row keeps its platform.
 *   - The Scheduler's subtitle and its empty queue named TikTok and YouTube to a workspace that has neither: they name its platforms now.
 *   - A `<button class="btn" hidden>` was drawn anyway (`.btn`'s own display beat the browser's `[hidden]`): the stylesheet hides `[hidden]` itself.
 *   - Saving the modules of the workspace you are acting in left its menu as it was until the next page load: the session is read again.
 *   - The DM assistant asked for the Meta vision library, and Results for the ads rows, in a workspace without them (two 404s and a console error).
 *   - With no AI cap set, the New workspace dialog said spend "is capped at no limit".
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const COMPANY = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
const has = (modules: string[] | null) => (id: string): boolean => modules === null || modules.includes(id);

// ─── The Scheduler ─────────────────────────────────────────────────────────────────────────────────

function scheduler(modules: string[] | null, stored: Json = null) {
    const app = { hasModule: has(modules), canOperate: () => true, hashParam: () => '', session: { tenantId: 't1' } };
    const storage = { getItem: () => (stored ? JSON.stringify(stored) : null), setItem: () => undefined };
    const Admin = { emptyState: (_icon: string, title: string, body: string) => `<div class="empty">${title} ${body}</div>`, confirm: () => undefined };
    const h = loadDashboard({ files: ['dashboard/js/pages/posts.js'], globals: { App: app, Admin, localStorage: storage } });
    let modal = '';
    h.UI.showModal = (markup: unknown) => { modal = String(markup); };
    return { h, P: h.run('PostsPage'), modal: () => modal };
}

describe('the Scheduler in a workspace without TikTok', () => {
    it('offers a new post Instagram, Facebook and both, never TikTok', () => {
        const { P } = scheduler(COMPANY);
        assert.deepEqual([...P.offeredPlatforms()], ['instagram', 'facebook', 'both']);
        const options = String(P.platformOptions('instagram'));
        assert.doesNotMatch(options, /value="tiktok"/);
        assert.match(options, /value="both"/);
    });

    it('still offers TikTok where the workspace has it, and everywhere when the session names no modules (an older server)', () => {
        assert.match(String(scheduler([...COMPANY, 'tiktok']).P.platformOptions('instagram')), /value="tiktok"/);
        assert.match(String(scheduler(null).P.platformOptions('instagram')), /value="tiktok"/);
    });

    it('keeps an existing TikTok row on TikTok when it is edited, rather than silently turning it into Instagram', () => {
        const options = String(scheduler(COMPANY).P.platformOptions('tiktok'));
        assert.match(options, /value="tiktok" selected/);
    });

    it('does not open the composer on TikTok because this browser last posted to TikTok in another workspace', () => {
        assert.equal(scheduler(COMPANY, { platform: 'tiktok', type: 'video' }).P.prefs().platform, 'instagram');
        assert.equal(scheduler([...COMPANY, 'tiktok'], { platform: 'tiktok', type: 'video' }).P.prefs().platform, 'tiktok');
    });

    it('leaves "Also send to TikTok" out of the composer', () => {
        const without = scheduler(COMPANY);
        without.P.showCreateModal();
        assert.ok(without.modal().includes('id="post-platform-select"'), 'the composer was drawn');
        assert.doesNotMatch(without.modal(), /name="also_tiktok"/);
        assert.doesNotMatch(without.modal(), /<option value="tiktok"/);

        const withTikTok = scheduler([...COMPANY, 'tiktok']);
        withTikTok.P.showCreateModal();
        assert.match(withTikTok.modal(), /name="also_tiktok"/);
    });

    it('names only the workspace\'s platforms when the queue is empty', () => {
        const { P, h } = scheduler(COMPANY);
        assert.equal(P.emptyQueueBody(), h.t('posts.emptyQueueBodyMeta'));
        assert.doesNotMatch(P.emptyQueueBody(), /TikTok|YouTube/);
        assert.equal(scheduler([...COMPANY, 'tiktok']).P.emptyQueueBody(), h.t('posts.emptyQueueBodyTikTok'));
        assert.equal(scheduler([...COMPANY, 'youtube']).P.emptyQueueBody(), h.t('posts.emptyQueueBodyYouTube'));
        assert.equal(scheduler(null).P.emptyQueueBody(), h.t('posts.emptyQueueBody'));
    });
});

describe('the Scheduler\'s subtitle names the workspace\'s platforms, in both languages', () => {
    const subtitle = (modules: string[] | null, lang: 'en' | 'ar' = 'en'): { text: string; t: (k: string) => string } => {
        const h = loadDashboard({ app: true, lang });
        h.App.session = { available: true, role: 'user', userId: 'u1', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null, modules };
        return { text: String(h.App.subtitle('posts')), t: h.t };
    };

    it('says Instagram and Facebook to a company workspace', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { text, t } = subtitle(COMPANY, lang);
            assert.equal(text, t('page.posts.subtitleMeta'));
            assert.doesNotMatch(text, /TikTok|YouTube|تيك توك|يوتيوب/);
        }
    });

    it('adds TikTok or YouTube when the workspace has one of them, and all four when it has both or the session names no modules', () => {
        assert.equal(subtitle([...COMPANY, 'tiktok']).text, subtitle(null).t('page.posts.subtitleTikTok'));
        assert.equal(subtitle([...COMPANY, 'youtube']).text, subtitle(null).t('page.posts.subtitleYouTube'));
        assert.equal(subtitle([...COMPANY, 'tiktok', 'youtube']).text, subtitle(null).t('page.posts.subtitle'));
        assert.equal(subtitle(null).text, subtitle(null).t('page.posts.subtitle'));
    });

    it('leaves every other page\'s subtitle alone', () => {
        const h = loadDashboard({ app: true });
        h.App.session = { available: true, role: 'user', userId: 'u1', tenantId: 't1', tenantRole: 'owner', tenants: [{ id: 't1' }], onboarding: null, modules: COMPANY };
        assert.equal(h.App.subtitle('inbox'), h.t('page.inbox.subtitle'));
    });
});

// ─── The stylesheet ────────────────────────────────────────────────────────────────────────────────

describe('the hidden attribute hides, whatever the element\'s own display', () => {
    it('is one rule in the stylesheet, with !important, like `.hidden`', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        assert.match(css, /\[hidden\]:not\(\[hidden='until-found'\]\) \{ display: none !important; \}/);
        assert.match(css, /\.btn \{[^}]*display: inline-flex/, 'the rule exists because `.btn` sets its own display');
    });
});

// ─── The workspace page: saving the modules of the workspace you are in ────────────────────────────

function detail(currentTenant: string) {
    const refreshed: string[] = [];
    const app = { session: { tenantId: currentTenant }, refreshSession: async () => { refreshed.push('refresh'); return true; }, canAdminister: () => true, go: () => undefined };
    const api = { saveAdminTenantModules: async (_id: string, body: Json) => ({ tenantId: 'T1', on: body.on, owner: false, stored: true, preset: body.preset, metaConnect: body.metaConnect, adsCeiling: null }) };
    const h = loadDashboard({ files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/tenant_detail.js'], globals: { App: app, API: api, Shell: undefined } });
    h.UI.toast = () => null;
    h.UI.formBusy = () => () => undefined;
    const Admin = h.run('Admin');
    Admin.readModulesPicker = () => ({ preset: 'company', on: COMPANY });
    Admin.moduleProblem = () => false;
    const D = h.run('TenantDetailPage');
    D.tenantId = 'T1';
    D.modulesView = { owner: false, adsCeiling: null };
    D.paintModules = () => undefined;
    const form = { querySelector: () => null, querySelectorAll: () => [] };
    return { D, form, refreshed };
}

describe('saving a workspace\'s modules', () => {
    it('reads the session again when it is the workspace this session acts as, so its menu changes at once', async () => {
        const { D, form, refreshed } = detail('T1');
        await D.saveModules(form, { preventDefault: () => undefined });
        await settle();
        assert.deepEqual(refreshed, ['refresh']);
    });

    it('leaves the session alone for another workspace', async () => {
        const { D, form, refreshed } = detail('T-other');
        await D.saveModules(form, { preventDefault: () => undefined });
        await settle();
        assert.deepEqual(refreshed, []);
    });
});

// ─── No request a workspace would only refuse ──────────────────────────────────────────────────────

describe('a page asks nothing of a module the workspace has not got', () => {
    it('the DM assistant asks for the Meta vision library only where the workspace has Meta vision', async () => {
        const calls: string[] = [];
        const load = (modules: string[]) => {
            const api = { getMuseLibrary: async () => { calls.push('library'); return { reels: [], total: 0 }; } };
            const h = loadDashboard({ files: ['dashboard/js/pages/ai_settings.js'], globals: { App: { hasModule: has(modules), canAdminister: () => true }, API: api } });
            return h.run('AiSettingsPage');
        };
        await load(COMPANY).loadMuseLibrary();
        assert.deepEqual(calls, []);
        await load([...COMPANY, 'muse']).loadMuseLibrary();
        assert.deepEqual(calls, ['library']);
    });

    it('Results asks for the ads rows only where the workspace has Ads, and keeps the table hidden otherwise', async () => {
        const calls: string[] = [];
        const load = (modules: string[]) => {
            const api = { getAdsResults: async () => { calls.push('ads'); return { rows: [] }; } };
            const h = loadDashboard({ files: ['dashboard/js/pages/analytics.js'], globals: { App: { hasModule: has(modules) }, API: api } });
            const host = h.el('analytics-ad-rows');
            host.hidden = false;
            return { A: h.run('AnalyticsPage'), host };
        };
        const off = load(COMPANY);
        await off.A.fillAdRows(28, () => true);
        assert.deepEqual(calls, []);
        assert.equal(off.host.hidden, true);
        await load([...COMPANY, 'ads']).A.fillAdRows(28, () => true);
        assert.deepEqual(calls, ['ads']);
    });
});

// ─── The New workspace dialog's AI line ────────────────────────────────────────────────────────────

describe('the New workspace dialog says plainly when no AI cap is set', () => {
    const line = async (budgets: Json, lang: 'en' | 'ar' = 'en'): Promise<{ text: string; t: (k: string, p?: Json) => string }> => {
        const api = { getAdminAi: async () => ({ budgets }), getNotifySettings: async () => ({ telegram: { botToken: { set: false } } }) };
        const h = loadDashboard({ lang, files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/tenants.js'], globals: { API: api, App: { canAdminister: () => true }, Shell: undefined } });
        const el = h.el('tenant-create-ai');
        el.hidden = true;
        await h.run('TenantsPage').loadCreateContext();
        assert.equal(el.hidden, false);
        return { text: String(el.textContent), t: h.t };
    };

    it('no cap at all: one sentence that says so, never "capped at no limit"', async () => {
        for (const lang of ['en', 'ar'] as const) {
            const { text, t } = await line({ tenantDailyUsd: null, tenantMonthlyUsd: null }, lang);
            assert.equal(text, t('tenants.create.aiCapsNone'));
        }
        assert.doesNotMatch((await line({})).text, /capped/);
    });

    it('a cap on either keeps the sentence with the numbers', async () => {
        const { text } = await line({ tenantDailyUsd: 2, tenantMonthlyUsd: null });
        assert.match(text, /\$2 a day and no limit a month/);
    });
});
