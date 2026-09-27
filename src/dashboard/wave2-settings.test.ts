/**
 * Wave 2, configuration screens: Settings (public site, webhook handshake, scopes, Direct
 * Post), Activity (deep links, search, error one-liners, export scope), Campaigns (the failed
 * count's way into the log) and AI (the sandbox's payload, the unsaved note).
 *
 * The REAL dashboard files in a `node:vm` context, as media-storage.test.ts and
 * screens.test.ts load them, in both languages: a template that throws blanks the whole
 * screen, and a string that exists in one language renders English inside the Arabic page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;

function load(lang: 'ar' | 'en', hash: Record<string, string> = {}, api: Json = {}) {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const dom = new Map<string, Json>();
    const replaced: string[] = [];
    const unref = (t: ReturnType<typeof setTimeout>) => { (t as { unref?: () => void }).unref?.(); return t; };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '#/settings' } },
        location: { hash: '#/activity', pathname: '/dashboard', origin: 'https://example.test' },
        history: { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url); } },
        Intl, console, clearTimeout, clearInterval,
        setTimeout: (fn: () => void, ms?: number) => unref(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unref(setInterval(fn, ms)),
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: { token: 'test', ...api },
        // Reads what the test put on the form; the page only ever calls `get`.
        FormData: function FormData(this: Json, form: Json) { this.get = (k: string) => (form.__data ? form.__data[k] ?? null : null); },
        App: {
            currentTheme: () => 'auto', navigate: noop, isAdmin: () => true, canAdminister: () => true,
            canOperate: () => true, hashParam: (name: string) => hash[name] ?? '',
        },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        URLSearchParams,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/settings.js',
        'dashboard/js/pages/activity.js',
        'dashboard/js/pages/ai_settings.js',
        'dashboard/js/pages/campaigns.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const pages = vm.runInContext('({ SettingsPage, ActivityPage, AiSettingsPage, CampaignsPage, t })', ctx) as {
        SettingsPage: Json; ActivityPage: Json; AiSettingsPage: Json; CampaignsPage: Json;
        t: (key: string, params?: Json) => string;
    };
    return { ...pages, dom, replaced };
}

const LANGS = ['ar', 'en'] as const;
const text = (markup: unknown) => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const SITE = {
    whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '2026-04-05',
    whatsappUrl: 'https://wa.me/966501234567?text=x',
    source: { whatsappNumber: 'database', contactEmail: 'database', eidCouponsExpire: 'database' },
};
const BARE = {
    whatsappNumber: null, contactEmail: 'elamirmansour@outlook.com', eidCouponsExpire: null, whatsappUrl: '',
    source: { whatsappNumber: null, contactEmail: 'default', eidCouponsExpire: null },
};

describe('Settings → Public site', () => {
    for (const lang of LANGS) {
        it(`renders the three fields with what is saved, a live wa.me preview and a Save that goes through formBusy (${lang})`, () => {
            const { SettingsPage, t } = load(lang);
            const card = String(SettingsPage.siteSection(SITE, null));
            assert.ok(card.includes(t('settings.site.title')));
            assert.ok(card.includes('value="966501234567"'));
            assert.ok(card.includes('value="hello@example.com"'));
            assert.ok(card.includes('type="date"') && card.includes('value="2026-04-05"'));
            assert.ok(card.includes('href="https://wa.me/966501234567"'), 'the preview link');
            assert.ok(card.includes('data-input="settings:previewWhatsapp"'));
            assert.ok(card.includes('data-submit="settings:saveSiteSettings"'));
            assert.ok(card.includes('id="site-settings-error"'), 'the in-form error host');
            assert.equal(/settings\.site\./.test(text(card)), false, 'no raw key reaches the screen');
        });

        it(`says where an unsaved value comes from, and never prefills it as if saved (${lang})`, () => {
            const { SettingsPage, t } = load(lang);
            const card = String(SettingsPage.siteSection(BARE, null));
            assert.ok(card.includes('placeholder="elamirmansour@outlook.com"'));
            assert.equal(card.includes('value="elamirmansour@outlook.com"'), false);
            const squash = (v: unknown) => text(v).replace(/\s+/g, '');
            assert.ok(squash(card).includes(squash(t('settings.site.emailFromDefault', { value: 'elamirmansour@outlook.com' }))));
            assert.ok(text(card).includes(t('settings.site.whatsappNone')));
        });
    }

    it('isolates only the value inside the sentence, not the whole sentence (SE10)', () => {
        const { SettingsPage } = load('ar');
        const out = String(SettingsPage.ltrIn('settings.webhookPreview', { preview: 'my_•••26', count: 12 }, 'preview'));
        assert.ok(out.startsWith('<bdi class="ltr-text" dir="ltr">my_•••26</bdi>'), out);
        assert.ok(out.includes('حرفاً'), 'the Arabic rest of the sentence is outside the isolate');
        assert.equal((out.match(/<bdi/g) || []).length, 1);
    });

    it('normalises the number exactly as the server does, Arabic-Indic digits included', () => {
        const { SettingsPage } = load('ar');
        for (const input of ['966501234567', '+966 50 123 4567', '00966501234567', '٩٦٦٥٠١٢٣٤٥٦٧']) {
            assert.equal(SettingsPage.normaliseWhatsapp(input), '966501234567', input);
        }
        assert.equal(SettingsPage.normaliseWhatsapp(''), '');
        for (const bad of ['0501234567', '+966', 'wa.me/966']) assert.equal(SettingsPage.normaliseWhatsapp(bad), null, bad);
    });

    it('refuses an invalid number in the form, marks the field, and sends nothing', async () => {
        const sent: Json[] = [];
        const { SettingsPage, dom, t } = load('ar', {}, { saveSiteSettings: (p: Json) => { sent.push(p); return Promise.resolve({}); } });
        const host = { innerHTML: '', scrollIntoView() {} };
        const attrs: Json = {};
        dom.set('site-settings-error', host);
        dom.set('site-whatsapp', { setAttribute: (n: string, v: string) => { attrs[n] = v; }, focus() {} });
        const form = { querySelector: () => null, querySelectorAll: () => [], __data: { whatsappNumber: '0501234567', contactEmail: '', eidCouponsExpire: '' } };
        dom.set('site-settings-form', form);
        await SettingsPage.saveSiteSettings(form, { preventDefault() {} });
        assert.ok(host.innerHTML.includes(t('settings.site.invalid.whatsappNumber')));
        assert.equal(attrs['aria-invalid'], 'true');
        assert.equal(attrs['aria-describedby'], 'site-settings-error-strip');
        assert.equal(sent.length, 0);
    });

    it('sends all three fields, the number normalised, and an emptied field as a clear', async () => {
        const sent: Json[] = [];
        const { SettingsPage, dom } = load('ar', {}, { saveSiteSettings: (p: Json) => { sent.push(p); return Promise.resolve({}); } });
        dom.set('site-settings-error', { innerHTML: '' });
        SettingsPage.render = async () => {};
        const form = {
            querySelector: () => null, querySelectorAll: () => [],
            __data: { whatsappNumber: '+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧', contactEmail: ' hello@example.com ', eidCouponsExpire: '' },
        };
        await SettingsPage.saveSiteSettings(form, { preventDefault() {} });
        assert.equal(JSON.stringify(sent), JSON.stringify([{ whatsappNumber: '966501234567', contactEmail: 'hello@example.com', eidCouponsExpire: '' }]));
    });
});

describe('Settings → webhook handshake and scopes', () => {
    for (const lang of LANGS) {
        it(`names every reason the check can answer with, in the language on screen (${lang})`, () => {
            const { SettingsPage, t } = load(lang);
            for (const reason of SettingsPage.HANDSHAKE_REASONS) {
                const key = `settings.webhookTest.${reason}`;
                assert.notEqual(t(key), key, `${key} exists`);
            }
            const ok = String(SettingsPage.handshakeResult({ ok: true, reason: 'ok', status: 200, url: 'https://x.test/webhook' }));
            assert.ok(ok.includes('health-fresh') && ok.includes(t('settings.webhookTest.ok')));
            assert.ok(ok.includes('<bdi class="ltr-text" dir="ltr">https://x.test/webhook</bdi>'));
            const bad = String(SettingsPage.handshakeResult({ ok: false, reason: 'rejected', status: 403, url: 'https://x.test/webhook' }));
            assert.ok(bad.includes('role="alert"') && bad.includes(t('settings.webhookTest.rejected')));
            const odd = String(SettingsPage.handshakeResult({ ok: false, reason: 'something-new', status: 418 }));
            assert.ok(odd.includes(t('settings.webhookTest.unexpected', { status: 418 })), 'an unknown reason reads as unexpected');
        });
    }

    it('asks for the insights scopes Growth needs, and tags them «للنمو»', () => {
        const { SettingsPage, t } = load('ar');
        for (const scope of ['instagram_manage_insights', 'read_insights']) {
            assert.ok(SettingsPage.REQUIRED_SCOPES.includes(scope), scope);
            assert.ok(SettingsPage.GROWTH_SCOPES.includes(scope), scope);
            assert.notEqual(t(`settings.scope.${scope}`), `settings.scope.${scope}`);
        }
        assert.equal(t('settings.scopeForGrowth'), 'للنمو');
    });

    for (const lang of LANGS) {
        it(`previews what saving the Direct Post switch will do (${lang})`, () => {
            const { SettingsPage, dom, t } = load(lang);
            const out = { textContent: '' };
            dom.set('tiktok-direct-consequence', out);
            SettingsPage.previewDirectPost({ checked: true, dataset: { saved: 'off', connected: 'yes' } });
            assert.equal(out.textContent, t('settings.tiktok.app.reconnectAfterSave'));
            SettingsPage.previewDirectPost({ checked: false, dataset: { saved: 'on', connected: 'yes' } });
            assert.equal(out.textContent, t('settings.tiktok.app.draftsAfterSave'));
            SettingsPage.previewDirectPost({ checked: true, dataset: { saved: 'on', connected: 'yes' } });
            assert.equal(out.textContent, '', 'unchanged: nothing to warn about');
            SettingsPage.previewDirectPost({ checked: true, dataset: { saved: 'off', connected: 'no' } });
            assert.equal(out.textContent, '', 'no account yet: connecting will ask for it');
        });
    }
});

describe('Activity — deep links, search, errors, export (V1 V2 V3 V5 V6)', () => {
    it('seeds the filters from #/activity?campaign=…&status=FAILED and strips them', () => {
        const { ActivityPage, replaced } = load('ar', { campaign: 'c-1', status: 'failed', platform: 'instagram' });
        ActivityPage.currentSearch = 'stale';
        assert.equal(ActivityPage.seedFromHash(), true);
        assert.equal(ActivityPage.currentCampaignId, 'c-1');
        assert.equal(ActivityPage.currentStatus, 'FAILED');
        assert.equal(ActivityPage.currentPlatform, 'instagram');
        assert.equal(ActivityPage.currentSearch, '', 'a link describes a whole view');
        assert.equal(ActivityPage.currentPage, 1);
        assert.deepEqual(replaced, ['/dashboard#/activity']);
    });

    it('accepts campaign_id too, ignores values it does not know, and leaves the filters alone without a link', () => {
        const a = load('ar', { campaign_id: 'c-2', status: 'DROP TABLE', platform: 'myspace' }).ActivityPage;
        a.seedFromHash();
        assert.equal(a.currentCampaignId, 'c-2');
        assert.equal(a.currentStatus, '');
        assert.equal(a.currentPlatform, '');
        const { ActivityPage, replaced } = load('ar');
        ActivityPage.currentStatus = 'SENT';
        assert.equal(ActivityPage.seedFromHash(), false);
        assert.equal(ActivityPage.currentStatus, 'SENT');
        assert.deepEqual(replaced, []);
    });

    it('names a campaign by its first two keywords, with «…» when there are more', () => {
        const { ActivityPage, t } = load('ar');
        assert.equal(ActivityPage.campaignOptionLabel({ trigger_keyword: 'كورس' }), t('activity.campaignOption', { keyword: 'كورس' }));
        assert.equal(ActivityPage.campaignOptionLabel({ trigger_keyword: 'كورس، كوبون' }), t('activity.campaignOptionMany', { keywords: 'كورس، كوبون' }));
        assert.equal(ActivityPage.campaignOptionLabel({ trigger_keyword: 'كورس,كوبون,رابط' }), t('activity.campaignOptionMany', { keywords: 'كورس، كوبون…' }));
    });

    for (const lang of LANGS) {
        it(`explains the common Meta codes in one line, and leaves the rest raw (${lang})`, () => {
            const { ActivityPage, t } = load(lang);
            const cases: Array<[string, string]> = [
                ["Meta won't accept a private reply to this comment, usually because the person can't receive messages from Pages. (DM Send Failed: (#100) Invalid parameter (Code: 100))", 'activity.err.noPrivateReply'],
                ['Private Reply Failed: Error validating access token (Code: 190)', 'activity.err.token'],
                ['DM Send Failed: (#200) Permissions error (Code: 200)', 'activity.err.permission'],
                ['User privacy settings block DMs from Pages (Code 10903).', 'activity.err.blocked'],
                ['DM Send Failed: Application request limit reached (Code: 4)', 'activity.err.rateLimit'],
                ['Reply failed (Code: 613)', 'activity.err.rateLimit'],
            ];
            for (const [raw, key] of cases) assert.equal(ActivityPage.explainError(raw), t(key), raw);
            assert.equal(ActivityPage.explainError('Something else entirely (Code: 1)'), '');
            assert.equal(ActivityPage.explainError(''), '');
        });
    }

    it('counts the filtered export in the button, with the Arabic plural family', () => {
        const { t } = load('ar');
        assert.equal(t('activity.exportCount', { count: 1, n: '1' }), 'صدّر نتيجة واحدة');
        assert.equal(t('activity.exportCount', { count: 2, n: '2' }), 'صدّر نتيجتين');
        assert.equal(t('activity.exportCount', { count: 5, n: '5' }), 'صدّر 5 نتائج');
        assert.equal(t('activity.exportCount', { count: 40, n: '40' }), 'صدّر 40 نتيجة');
        assert.equal(load('en').t('activity.exportCount', { count: 3, n: '3' }), 'Export 3 results');
    });

    it('submits the search from its own form, with the term in the box', () => {
        const { ActivityPage } = load('ar');
        const calls: string[] = [];
        ActivityPage.loadData = () => { calls.push(ActivityPage.currentSearch); };
        ActivityPage.currentPage = 3;
        let prevented = false;
        ActivityPage.submitSearch({ querySelector: () => ({ value: 'sara' }) }, { preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        assert.deepEqual(calls, ['sara']);
        assert.equal(ActivityPage.currentPage, 1);
    });
});

describe('Campaigns — the failed count opens those failures (C8)', () => {
    const card = (failed: number) => {
        const { CampaignsPage, t } = load('ar');
        return {
            html: String(CampaignsPage.renderCard({
                id: 'c-9', trigger_keyword: 'كورس', dm_template: 'x', is_active: true,
                sent_count: 3, failed_count: failed, total_interactions: 3 + failed,
            })),
            t,
        };
    };

    it('links to the activity log filtered to this campaign and FAILED', () => {
        const { html, t } = card(4);
        assert.ok(html.includes('data-action="app:navigate" data-target="activity"'));
        assert.ok(html.includes('data-query="campaign=c-9&amp;status=FAILED"'), html.match(/data-query="[^"]*"/)?.[0]);
        assert.ok(html.includes(t('campaigns.openFailed')));
    });

    it('stays plain text at zero, where the link would open an empty list', () => {
        const { html } = card(0);
        assert.equal(html.includes('status=FAILED'), false);
    });
});

describe('AI — the sandbox and the unsaved note (AI1 AI3 AI5 AI6)', () => {
    function withForm(values: Json) {
        const page = load('ar');
        for (const [id, value] of Object.entries(values)) page.dom.set(id, { value, checked: true });
        return page;
    }

    it('sends the model and temperature on screen with the draft', () => {
        const { AiSettingsPage } = withForm({
            'system-prompt-text': 'p', 'knowledge-base-text': 'k', 'model-selector': 'gemini-2.5-pro', 'temp-slider': '0',
        });
        const payload = AiSettingsPage.sandboxPayload('كم السعر؟');
        assert.equal(JSON.stringify(payload), JSON.stringify({
            system_prompt: 'p', knowledge_base: 'k', user_message: 'كم السعر؟', model: 'gemini-2.5-pro', temperature: 0,
        }));
    });

    for (const lang of LANGS) {
        it(`says the agent is off in the operator's language, and passes other errors through (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            assert.equal(AiSettingsPage.sandboxErrorText({ status: 409, message: 'The AI agent is turned off — enable it to run a test.' }), t('ai.sandboxAgentOff'));
            assert.equal(AiSettingsPage.sandboxErrorText({ status: 500, message: 'Gemini timed out' }), 'Gemini timed out');
            assert.equal(AiSettingsPage.sandboxErrorText(null), t('ai.errorReply'));
        });

        it(`marks the default model, anchors the slider, and carries the unsaved note (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang);
            const shell = String(AiSettingsPage.shell());
            assert.ok(shell.includes(`Gemini 2.5 Flash ${t('ai.defaultModel')}`));
            assert.ok(shell.includes(t('ai.temperatureAnchors')));
            assert.ok(/id="ai-unsaved-note"[^>]*>/.test(shell) && shell.includes(t('ai.unsaved')));
        });
    }

    it('counts the switch, the model and the temperature as unsaved, not only the two texts', () => {
        const { AiSettingsPage, dom } = withForm({
            'system-prompt-text': 'p', 'knowledge-base-text': 'k', 'model-selector': 'gemini-2.5-flash', 'temp-slider': '0.7',
        });
        dom.set('ai-active-toggle', { checked: true });
        AiSettingsPage._saved = { system_prompt: 'p', knowledge_base: 'k', settings: AiSettingsPage.currentSettings() };
        assert.equal(AiSettingsPage.hasUnsavedChanges(), false);
        dom.get('model-selector')!.value = 'gemini-2.5-pro';
        assert.equal(AiSettingsPage.hasUnsavedChanges(), true);
        assert.equal(AiSettingsPage.isDirty(), false, 'the reload guard still only protects the texts');
    });
});
