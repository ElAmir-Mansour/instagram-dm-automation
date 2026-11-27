/**
 * Creating a workspace with its modules, and the Modules card on its page (U3, PR E: contract §3.2, §3.3 and §12.2).
 *
 * The REAL `admin_common.js`, `tenants.js` and `tenant_detail.js` run in the shared `node:vm` harness, with the API stubbed. What is pinned, because each is
 * a way a workspace gets the wrong parts of the product, or the owner's own workspace gets narrowed:
 *
 *   - **The picker is the server's table.** Its groups, its dependencies and its two presets are `MODULES` / `MODULE_PRESETS` of `src/services/modules.ts`
 *     (compared here), and every id of `Shell.MODULES` has exactly one row.
 *   - **Dependencies are enforced live.** Ticking a module ticks what it needs (and what that needs); unticking one unticks everything that needs it; the
 *     locked ones (the knowledge base, Explainers) can never be ticked; a preset fills the boxes and any other change moves the preset to Custom.
 *   - **Ads need a ceiling.** With Ads ticked both numbers are shown and required; the dialog refuses to leave step 2, and the card refuses to save, without a
 *     valid pair (a stored ceiling counts on the card).
 *   - **The dialog is three steps** (1 Who, 2 What, 3 Meta), one shown at a time, and its payload is the one contract §3.1 takes: `owner_email`, and `modules`
 *     with `metaConnect` defaulting to `self`. A workspace made WITH a Meta connection sends no modules. The to-do list under the link follows the contract.
 *   - **The platform owner's own workspace cannot be narrowed from the card**: it draws one line and the chips, no input and no Save, and the save refuses
 *     before it asks the server.
 *   - **A refusal is said next to the field** in the person's words (`errors.<CODE>`), and a missing ceiling points at Client ads.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MODULE_IDS, MODULE_PRESETS, MODULES } from '../services/modules.js';
import { loadDashboard, settle, type Json } from './_harness.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const COMPANY = ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results'];
const CREATOR = [...COMPANY, 'growth', 'studio', 'tiktok', 'youtube', 'whatsapp', 'muse'];

const plain = <T = Json>(x: unknown): T => JSON.parse(JSON.stringify(x)) as T;
const words = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/[⁦⁧⁨⁩]/g, '').replace(/\s+/g, ' ').trim();

/** A stand-in for the pieces of a form the picker and the pages read and write: elements by the exact selector the code asks with. */
interface Box { name: string; value: string; checked: boolean; disabled: boolean; required?: boolean; hidden?: boolean; focus?: () => void; setAttribute?: (k: string, v: string) => void; removeAttribute?: (k: string) => void }
function fakeForm(opts: { on?: string[]; preset?: string; daily?: string; monthly?: string; connect?: string; name?: string; lang?: string; step?: number; ownerEmail?: string; handle?: string; site?: string } = {}) {
    const on = opts.on ?? COMPANY;
    const boxes: Box[] = [...MODULE_IDS].map((id) => ({ name: 'module', value: id, checked: on.includes(id), disabled: id === 'knowledge' || id === 'explainers' }));
    const presets: Box[] = ['company', 'creator', 'custom'].map((p) => ({ name: 'preset', value: p, checked: p === (opts.preset ?? 'company'), disabled: false }));
    const input = (name: string, value = '') => ({ name, value, checked: false, disabled: false, required: false } as Box);
    const daily = input('ads_daily', opts.daily ?? '');
    const monthly = input('ads_monthly', opts.monthly ?? '');
    const connects: Box[] = ['self', 'operator'].map((c) => ({ name: 'meta_connect', value: c, checked: c === (opts.connect ?? 'self'), disabled: false }));
    const values: Record<string, string> = { name: opts.name ?? '', lang: opts.lang ?? 'ar', owner_email: opts.ownerEmail ?? '', instagram_username: opts.handle ?? '', website: opts.site ?? '' };
    const attrs = new Map<string, string>();
    const ceiling = { hidden: true } as Box;
    const step = (n: number) => ({ dataset: { step: String(n) }, hidden: n !== 1 }) as Json;
    const fieldsets = [step(1), step(2), step(3)];
    const labels = [1, 2, 3].map((n) => ({ dataset: { stepLabel: String(n) }, setAttribute: (k: string, v: string) => attrs.set(`${n}:${k}`, v), removeAttribute: (k: string) => attrs.delete(`${n}:${k}`) }));
    const buttons: Record<string, Json> = { 'tenant-create-back': { hidden: true }, 'tenant-create-next': { hidden: false }, 'tenant-create-submit': { hidden: true }, 'tenant-modules-save': { disabled: true } };
    const review = { textContent: '' };
    const errorHost = { innerHTML: '' };
    const form: Json = {
        dataset: { step: String(opts.step ?? 1), firstRun: '' },
        elements: [], attrs, fieldsets, labels, review, errorHost, buttons, ceiling, daily, monthly, boxes, presets, connects, values,
        querySelectorAll(sel: string): Json[] {
            if (sel === 'input[name="module"]') return boxes;
            if (sel === 'input[name="preset"]') return presets;
            if (sel === 'input[name="ads_daily"]') return [daily];
            if (sel === 'input[name="ads_monthly"]') return [monthly];
            if (sel === '.modules-ceiling') return [ceiling];
            if (sel === 'fieldset[data-step]') return fieldsets;
            if (sel === '[data-step-label]') return labels;
            return [];
        },
        querySelector(sel: string): Json {
            const byId = /^#(.+)$/.exec(sel);
            if (byId) { if (byId[1] === 'tenant-create-review') return review; if (byId[1] === 'tenant-modules-error') return errorHost; return buttons[byId[1]!] ?? null; }
            if (sel === 'input[name="meta_connect"]:checked') return connects.find((c) => c.checked) ?? null;
            if (sel === 'input[name="ads_daily"]') return daily;
            if (sel === 'input[name="ads_monthly"]') return monthly;
            const named = /^\[name="([a-z_]+)"\]$/.exec(sel);
            if (named) return values[named[1]!] !== undefined ? { value: values[named[1]!] } : null;
            if (sel.startsWith('fieldset[data-step=')) return null;
            return null;
        },
    };
    return form;
}

/** `Admin`, `TenantsPage` and `TenantDetailPage` in the harness, with every call that leaves the page recorded. */
function load(over: { api?: Json; lang?: 'en' | 'ar' } = {}) {
    const calls: Array<[string, unknown[]]> = [];
    const stubs: Json = {
        createAdminTenant: async (p: Json) => ({ id: TENANT, name: p.name, invite: { id: 'i1', url: 'https://x.test/#/invite?t=1' } }),
        getAdminAi: async () => ({ budgets: { tenantDailyUsd: 2, tenantMonthlyUsd: 30 } }),
        getNotifySettings: async () => ({ telegram: { botToken: { set: false } } }),
        getAdminTenants: async () => [],
        getAdminTenantModules: async () => ({ tenantId: TENANT, on: COMPANY, owner: false, stored: true, preset: 'company', metaConnect: 'self', adsCeiling: null }),
        saveAdminTenantModules: async (_id: string, body: Json) => ({ tenantId: TENANT, on: body.on, owner: false, stored: true, preset: body.preset, metaConnect: body.metaConnect, adsCeiling: body.adsCeiling ?? null }),
        ...over.api,
    };
    const api = new Proxy(stubs, { get: (t, p) => (p in t ? (...a: unknown[]) => { calls.push([String(p), a]); return t[p as string](...a); } : () => Promise.reject(new Error(`API.${String(p)} is not stubbed`))) });
    const created: Json = { cards: [] as Json[] };
    const app = {
        refreshSession: async () => {}, go: () => {}, session: { tenants: [] }, dropAdminAccess: () => {}, canAdminister: () => true,
        loadPageModule: async () => ({ showCreated: (invite: Json, context: Json) => created.cards.push({ invite, context }) }),
    };
    class FormData { constructor(private readonly form: Json) {} get(key: string): string | null { const v = this.form.values[key]; if (v !== undefined) return v; const c = this.form.connects.find((x: Box) => x.checked); return key === 'meta_connect' && c ? c.value : null; } }
    const h = loadDashboard({
        lang: over.lang ?? 'en',
        files: ['dashboard/js/pages/admin_common.js', 'dashboard/js/pages/tenants.js', 'dashboard/js/pages/tenant_detail.js'],
        globals: { API: api, App: app, FormData, Shell: undefined },
    });
    const toasts: string[] = [];
    let modal = '';
    h.UI.toast = (m: string) => { toasts.push(String(m)); return null; };
    h.UI.showModal = (m: unknown) => { modal = String(m); };
    h.UI.closeModal = () => {};
    h.UI.formBusy = () => () => {};
    const tag: Json = h.run('html');
    h.UI.helpLink = (target: string, label: string) => tag(['<a class="help-link" href="#/help/', '">', '</a>'], target, label);
    const Admin: Json = h.run('Admin');
    const Tenants: Json = h.run('TenantsPage');
    const Detail: Json = h.run('TenantDetailPage');
    Tenants.render = async () => {};
    return { h, Admin, Tenants, Detail, calls, toasts, created, modal: () => modal, called: (n: string) => calls.filter(([c]) => c === n), t: h.t };
}

describe('the picker is the server\'s table', () => {
    it('draws every module once, grouped as the contract groups them, and nothing the server does not know', () => {
        const { Admin } = load();
        const ids: string[] = plain(Admin.moduleIds());
        assert.deepEqual([...ids].sort(), [...MODULE_IDS].sort());
        assert.equal(new Set(ids).size, ids.length);
        assert.deepEqual(plain(Admin.MODULE_GROUPS.map((g: Json) => [g.key, [...g.ids]])), [
            ['core', ['inbox', 'keyword_replies', 'dm_assistant', 'scheduler', 'results']], ['more', ['growth', 'whatsapp', 'muse', 'knowledge']],
            ['content', ['studio', 'explainers']], ['channels', ['tiktok', 'youtube']], ['ads', ['ads']],
        ]);
    });

    it('has the server\'s requirements and presets, copied here so the dialog works before it asks', () => {
        const { Admin } = load();
        const serverNeeds = Object.fromEntries(MODULES.filter((m) => m.requires.length).map((m) => [m.id, [...m.requires]]));
        assert.deepEqual(JSON.parse(JSON.stringify(Admin.MODULE_REQUIRES)), serverNeeds);
        assert.deepEqual([...Admin.MODULE_PRESETS.company], [...MODULE_PRESETS.company]);
        assert.deepEqual([...Admin.MODULE_PRESETS.creator].sort(), [...MODULE_PRESETS.creator].sort());
        assert.deepEqual(Object.keys(Admin.MODULE_LOCKED).sort(), MODULES.filter((m) => !m.available || m.ownerOnly).map((m) => m.id).sort());
    });

    it('names every module with a label and a `what` and `needs` line, in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { Admin, t } = load({ lang });
            for (const id of MODULE_IDS) {
                for (const key of [Admin.MODULE_LABELS[id], `modules.${id}.what`, `modules.${id}.needs`]) {
                    assert.notEqual(t(key), key, `${lang}: ${key} has words`);
                }
            }
        }
    });
});

describe('dependencies are enforced in the picker', () => {
    it('ticking a module ticks what it needs, and what that needs', () => {
        const { Admin } = load();
        assert.deepEqual(plain(Admin.moduleToggle([], 'muse', true)), ['inbox', 'dm_assistant', 'muse']);
        assert.deepEqual(plain(Admin.moduleToggle([], 'tiktok', true)), ['scheduler', 'tiktok']);
        assert.deepEqual(plain(Admin.moduleToggle(['inbox'], 'whatsapp', true)), ['inbox', 'whatsapp']);
        assert.deepEqual(plain(Admin.moduleToggle(['inbox'], 'results', true)), ['inbox', 'results']);
    });

    it('unticking a module unticks everything that needs it, and what needs those', () => {
        const { Admin } = load();
        assert.deepEqual(plain(Admin.moduleToggle([...CREATOR], 'inbox', false)), ['keyword_replies', 'scheduler', 'results', 'growth', 'studio', 'tiktok', 'youtube']);
        assert.deepEqual(Admin.moduleToggle([...CREATOR], 'dm_assistant', false).includes('muse'), false);
        assert.deepEqual(plain(Admin.moduleToggle([...CREATOR], 'scheduler', false).filter((m: string) => m === 'tiktok' || m === 'youtube')), []);
        assert.deepEqual(Admin.moduleToggle([...CREATOR], 'growth', false).includes('inbox'), true, 'what nothing depends on takes nothing else with it');
    });

    it('never leaves a module on whose requirement is off, for any single click from any preset', () => {
        const { Admin } = load();
        const needs: Record<string, string[]> = Admin.MODULE_REQUIRES;
        for (const start of [[], COMPANY, CREATOR, [...CREATOR, 'ads']]) {
            for (const id of Admin.moduleIds()) {
                for (const checked of [true, false]) {
                    const out: string[] = Admin.moduleToggle(start, id, checked);
                    for (const m of out) for (const n of needs[m] ?? []) assert.ok(out.includes(n), `${checked ? 'ticking' : 'unticking'} ${id} from [${start}] left ${m} without ${n}`);
                }
            }
        }
    });

    it('never ticks the knowledge base or Explainers, however it is asked', () => {
        const { Admin } = load();
        assert.deepEqual(plain(Admin.moduleToggle(COMPANY, 'knowledge', true)), COMPANY);
        assert.deepEqual(plain(Admin.moduleToggle(['studio'], 'explainers', true)), ['studio']);
    });

    it('works on the form: a click on a box redraws the others, and the preset follows what the boxes are', () => {
        const { Admin } = load();
        const form = fakeForm({ on: COMPANY });
        const box = (id: string) => form.boxes.find((b: Box) => b.value === id);
        box('muse').checked = true;
        Admin.modulesChanged({ name: 'module', value: 'muse', checked: true, form });
        assert.equal(box('muse').checked, true);
        assert.equal(box('dm_assistant').checked, true);
        assert.equal(form.presets.find((p: Box) => p.checked).value, 'custom', 'the company plus Meta vision is no preset');
        box('inbox').checked = false;
        Admin.modulesChanged({ name: 'module', value: 'inbox', checked: false, form });
        for (const gone of ['inbox', 'dm_assistant', 'muse']) assert.equal(box(gone).checked, false, `${gone} follows inbox off`);
        assert.equal(box('scheduler').checked, true, 'what does not need the inbox stays');
        // Back to exactly the company: the preset says so again.
        const exact = fakeForm({ on: [...COMPANY, 'growth'] });
        exact.boxes.find((b: Box) => b.value === 'growth').checked = false;
        Admin.modulesChanged({ name: 'module', value: 'growth', checked: false, form: exact });
        assert.equal(exact.presets.find((p: Box) => p.checked).value, 'company');
    });

    it('a preset fills the boxes (Custom leaves them), and keeps Ads as it was: no preset carries Ads', () => {
        const { Admin } = load();
        const form = fakeForm({ on: COMPANY, preset: 'company' });
        form.presets.forEach((p: Box) => { p.checked = p.value === 'creator'; });
        Admin.modulesChanged({ name: 'preset', value: 'creator', checked: true, form });
        assert.deepEqual(plain<string[]>(Admin.readModulesPicker(form).on).sort(), [...CREATOR].sort());
        form.presets.forEach((p: Box) => { p.checked = p.value === 'custom'; });
        Admin.modulesChanged({ name: 'preset', value: 'custom', checked: true, form });
        assert.equal(Admin.readModulesPicker(form).on.length, CREATOR.length, 'Custom changes nothing');
        const withAds = fakeForm({ on: [...COMPANY, 'ads'], preset: 'custom', daily: '10', monthly: '100' });
        withAds.presets.forEach((p: Box) => { p.checked = p.value === 'creator'; });
        Admin.modulesChanged({ name: 'preset', value: 'creator', checked: true, form: withAds });
        assert.equal(Admin.readModulesPicker(withAds).on.includes('ads'), true);
    });
});

describe('the ads ceiling is required when Ads is on', () => {
    it('a ceiling is two numbers above 0, the daily one not above the monthly one', () => {
        const { Admin } = load();
        assert.deepEqual(JSON.parse(JSON.stringify(Admin.moduleCeiling('10', '300'))), { maxDailyBudget: 10, monthlyCap: 300 });
        assert.deepEqual(JSON.parse(JSON.stringify(Admin.moduleCeiling(5, 5))), { maxDailyBudget: 5, monthlyCap: 5 });
        for (const [d, m] of [['', ''], ['10', ''], ['', '300'], ['0', '300'], ['-1', '300'], ['400', '300'], ['abc', '300'], [undefined, undefined], ['10', 'NaN']]) {
            assert.equal(Admin.moduleCeiling(d, m), null, JSON.stringify([d, m]));
        }
    });

    it('Ads without a ceiling is a problem, with one (typed, or stored) is not, and no Ads is never one', () => {
        const { Admin } = load();
        assert.equal(Admin.moduleProblem({ on: [...COMPANY, 'ads'], adsCeiling: null }, false), 'ceiling');
        assert.equal(Admin.moduleProblem({ on: [...COMPANY, 'ads'], adsCeiling: { maxDailyBudget: 1, monthlyCap: 2 } }, false), '');
        assert.equal(Admin.moduleProblem({ on: [...COMPANY, 'ads'], adsCeiling: null }, true), '', 'a ceiling already stored counts');
        assert.equal(Admin.moduleProblem({ on: COMPANY, adsCeiling: null }, false), '');
    });

    it('shows the two numbers, required, only while Ads is ticked', () => {
        const { Admin } = load();
        const form = fakeForm({ on: COMPANY });
        assert.equal(form.ceiling.hidden, true);
        form.boxes.find((b: Box) => b.value === 'ads').checked = true;
        Admin.modulesChanged({ name: 'module', value: 'ads', checked: true, form });
        assert.equal(form.ceiling.hidden, false);
        assert.equal(form.daily.required, true);
        assert.equal(form.monthly.required, true);
        form.boxes.find((b: Box) => b.value === 'ads').checked = false;
        Admin.modulesChanged({ name: 'module', value: 'ads', checked: false, form });
        assert.equal(form.ceiling.hidden, true);
        assert.equal(form.daily.required, false);
    });

    it('the markup has both inputs required when Ads is on and hidden when it is not, prefilled with a stored ceiling', () => {
        const { Admin } = load();
        const on = String(Admin.modulesPicker({ on: [...COMPANY, 'ads'], ceiling: { maxDailyBudget: 20, monthlyCap: 400 }, idPrefix: 'x' }));
        assert.match(on, /name="ads_daily"[^>]*value="20"[^>]*required/);
        assert.match(on, /name="ads_monthly"[^>]*value="400"[^>]*required/);
        assert.doesNotMatch(on, /id="x-ceiling"\s+hidden/);
        const off = String(Admin.modulesPicker({ on: COMPANY, idPrefix: 'x' }));
        assert.match(off, /id="x-ceiling"\s+hidden/);
        assert.doesNotMatch(off, /name="ads_daily"[^>]*required/);
    });
});

describe('the picker\'s markup', () => {
    it('draws a box per module with what it is and what it needs, the preset, and the company\'s five ticked', () => {
        const { Admin, t } = load();
        const markup = String(Admin.modulesPicker({ on: COMPANY, idPrefix: 'p' }));
        for (const id of MODULE_IDS) {
            assert.match(markup, new RegExp(`id="p-${id}" name="module" value="${id}"`), id);
            assert.ok(words(markup).includes(t(`modules.${id}.what`)), `${id} says what it is`);
            assert.ok(words(markup).includes(t(`modules.${id}.needs`)), `${id} says what it needs`);
        }
        assert.equal((markup.match(/name="module" value="[a-z_]+" data-change="admin:modulesChanged" checked/g) || []).length, 5);
        assert.match(markup, /name="preset" value="company" data-change="admin:modulesChanged" checked/);
        assert.ok(words(markup).includes(t('tenants.create.preset.company')) && words(markup).includes(t('tenants.create.preset.creator')) && words(markup).includes(t('tenants.create.preset.custom')));
    });

    it('locks the knowledge base and Explainers (disabled, never ticked), whatever the server said was on', () => {
        const { Admin } = load();
        const markup = String(Admin.modulesPicker({ on: ['studio', 'explainers', 'knowledge'], idPrefix: 'p' }));
        assert.match(markup, /id="p-knowledge" name="module" value="knowledge"[^>]*disabled/);
        assert.match(markup, /id="p-explainers" name="module" value="explainers"[^>]*disabled/);
        assert.doesNotMatch(markup, /value="explainers"[^>]*checked/);
        assert.doesNotMatch(markup, /value="knowledge"[^>]*checked/);
    });

    it('sends its changes to the page that drew it', () => {
        const { Admin } = load();
        assert.match(String(Admin.modulesPicker({ on: COMPANY, change: 'tenants:modulesChanged' })), /data-change="tenants:modulesChanged"/);
    });

    it('reads a form into the payload: the modules in order, the preset, and the ceiling only while Ads is on', () => {
        const { Admin } = load();
        const form = fakeForm({ on: ['results', 'inbox', 'ads'], preset: 'custom', daily: '10', monthly: '300' });
        assert.deepEqual(plain(Admin.readModulesPicker(form)), { preset: 'custom', on: ['inbox', 'results', 'ads'], adsCeiling: { maxDailyBudget: 10, monthlyCap: 300 } });
        const noAds = fakeForm({ on: COMPANY, daily: '10', monthly: '300' });
        assert.equal(Admin.readModulesPicker(noAds).adsCeiling, null);
        const bad = fakeForm({ on: ['ads'], daily: '', monthly: '' });
        assert.equal(Admin.readModulesPicker(bad).adsCeiling, null);
    });

    it('escapes nothing it was not given and draws no input at all for the owner\'s own workspace', () => {
        const { Admin, t } = load();
        const markup = String(Admin.modulesPicker({ on: MODULE_IDS.filter((m) => m !== 'knowledge'), owner: true, idPrefix: 'o' }));
        assert.doesNotMatch(markup, /<input|<button|<select/);
        assert.ok(words(markup).includes(t('tenantModules.owner')));
        assert.ok(words(markup).includes(t('nav.inbox')) && words(markup).includes(t('nav.studio')));
    });
});

describe('the New workspace dialog: 1 Who · 2 What · 3 Meta', () => {
    it('is one form with three fieldsets, the first shown, a preset (the company) and Meta (they connect it) chosen, and the owner\'s email asked', () => {
        const { Tenants, modal, t } = load();
        Tenants.showCreateModal(false);
        const markup = modal();
        assert.equal((markup.match(/<fieldset class="fieldset-plain create-step" data-step="[123]"/g) || []).length, 3);
        assert.match(markup, /data-step="1"(?![^>]*hidden)/);
        assert.match(markup, /data-step="2"[^>]*hidden/);
        assert.match(markup, /data-step="3"[^>]*hidden/);
        assert.match(markup, /name="owner_email" type="email"/);
        assert.match(markup, /name="preset" value="company"[^>]*checked/);
        assert.match(markup, /name="meta_connect" value="self"[^>]*checked/);
        assert.match(markup, /data-action="tenants:wizardNext"/);
        assert.match(markup, /id="tenant-create-submit" hidden/);
        assert.ok(words(markup).includes(t('tenants.create.submit')));
        for (const key of ['who', 'what', 'meta']) assert.ok(words(markup).includes(t(`tenants.create.step.${key}`)));
        assert.match(markup, /href="#\/help\/workspaces#tester"/, 'a Help link for the Tester step');
    });

    it('reads the platform\'s AI caps and whether a Telegram bot is saved, once, and a failure of either breaks nothing', async () => {
        const { Tenants, h, called } = load();
        const line = h.el('tenant-create-ai');
        line.hidden = true;
        Tenants.showCreateModal(false);
        await settle();
        assert.equal(called('getAdminAi').length, 1);
        assert.equal(called('getNotifySettings').length, 1);
        assert.equal(Tenants.botSet, false);
        assert.match(String(line.textContent), /\$2 a day and \$30 a month/);
        assert.equal(line.hidden, false);

        const broken = load({ api: { getAdminAi: async () => { throw new Error('down'); }, getNotifySettings: async () => { throw new Error('down'); } } });
        broken.Tenants.showCreateModal(false);
        await settle();
        assert.equal(broken.Tenants.botSet, null);
    });

    it('step 1 cannot be left without a name, or with an email that is not one; step 2 not with Ads and no ceiling', () => {
        const { Tenants, toasts, t } = load();
        const form = fakeForm({ name: '' });
        Tenants.wizardNext(form);
        assert.equal(form.dataset.step, '1');
        assert.deepEqual(toasts, [t('tenants.create.nameFirst')]);
        const bad = fakeForm({ name: 'Hub', ownerEmail: 'nope' });
        Tenants.wizardNext(bad);
        assert.equal(bad.dataset.step, '1');
        assert.equal(toasts.at(-1), t('tenants.create.ownerEmailBad'));
        const ok = fakeForm({ name: 'Hub', ownerEmail: 'sara@company.example' });
        Tenants.wizardNext(ok);
        assert.equal(ok.dataset.step, '2');
        assert.equal(ok.fieldsets[0].hidden, true);
        assert.equal(ok.fieldsets[1].hidden, false);

        const ads = fakeForm({ name: 'Hub', on: [...COMPANY, 'ads'], step: 2 });
        Tenants.wizardNext(ads);
        assert.equal(ads.dataset.step, '2', 'Ads with no ceiling stays on step 2');
        assert.equal(toasts.at(-1), t('tenantModules.ceilingRequired'));
        const withCeiling = fakeForm({ name: 'Hub', on: [...COMPANY, 'ads'], step: 2, daily: '10', monthly: '300' });
        Tenants.wizardNext(withCeiling);
        assert.equal(withCeiling.dataset.step, '3');
    });

    it('shows Back from step 2, Next until step 3, and Create only on step 3, with the review line there', () => {
        const { Tenants, t } = load();
        const form = fakeForm({ name: 'Hub', lang: 'en' });
        const state = () => [form.buttons['tenant-create-back'].hidden, form.buttons['tenant-create-next'].hidden, form.buttons['tenant-create-submit'].hidden];
        Tenants.showStep(form, 1);
        assert.deepEqual(state(), [true, false, true]);
        Tenants.wizardNext(form);
        assert.deepEqual(state(), [false, false, true]);
        Tenants.wizardNext(form);
        assert.deepEqual(state(), [false, true, false]);
        assert.equal(form.review.textContent, t('tenants.create.review', { lang: t('tenants.lang.en'), kind: t('tenants.create.preset.company'), meta: t('tenants.create.reviewSelf') }));
        assert.equal(form.attrs.get('3:aria-current'), 'step');
        Tenants.wizardBack(form);
        assert.equal(form.dataset.step, '2');
        assert.equal(form.attrs.has('3:aria-current'), false);
        Tenants.wizardBack(form);
        Tenants.wizardBack(form);
        assert.equal(form.dataset.step, '1', 'Back never goes below the first step');
    });

    it('the review says "n modules" for a custom choice', () => {
        const { Tenants, t } = load();
        const form = fakeForm({ on: ['inbox', 'results'], preset: 'custom', lang: 'en', connect: 'operator', step: 3 });
        Tenants.paintReview(form);
        assert.equal(form.review.textContent, t('tenants.create.review', { lang: t('tenants.lang.en'), kind: t('tenants.create.reviewCustom', { n: 2 }), meta: t('tenants.create.reviewOperator') }));
    });

    it('Enter on step 1 or 2 goes forward and creates nothing', async () => {
        const { Tenants, called } = load();
        const form = fakeForm({ name: 'Hub' });
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        assert.equal(form.dataset.step, '2');
        assert.equal(called('createAdminTenant').length, 0);
    });

    it('sends the payload contract §3.1 takes: owner_email, and modules with the preset, the list and how Meta connects', async () => {
        const { Tenants, called } = load();
        const form = fakeForm({ name: ' The Knowledge Hub ', lang: 'ar', step: 3, ownerEmail: 'sara@company.example', handle: '@hub', site: 'hub.example' });
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        assert.equal(called('createAdminTenant').length, 1);
        const body = JSON.parse(JSON.stringify(called('createAdminTenant')[0]![1][0]));
        assert.deepEqual(body, {
            name: 'The Knowledge Hub', lang: 'ar', instagram_username: '@hub', website: 'hub.example', owner_email: 'sara@company.example',
            modules: { preset: 'company', on: COMPANY, metaConnect: 'self', adsCeiling: null },
        });
    });

    it('sends "operator" when they choose we connect it, and the ceiling with Ads', async () => {
        const { Tenants, called } = load();
        const form = fakeForm({ name: 'Shop', step: 3, on: [...COMPANY, 'ads'], preset: 'custom', daily: '15', monthly: '200', connect: 'operator' });
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        const body = JSON.parse(JSON.stringify(called('createAdminTenant')[0]![1][0]));
        assert.deepEqual(body.modules, { preset: 'custom', on: [...COMPANY, 'ads'], metaConnect: 'operator', adsCeiling: { maxDailyBudget: 15, monthlyCap: 200 } });
    });

    it('refuses Ads with no ceiling at Create too, and asks the server nothing', async () => {
        const { Tenants, called, toasts, t } = load();
        const form = fakeForm({ name: 'Shop', step: 3, on: [...COMPANY, 'ads'], preset: 'custom' });
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        assert.equal(called('createAdminTenant').length, 0);
        assert.equal(toasts.at(-1), t('tenantModules.ceilingRequired'));
    });

    it('sends no modules for a workspace made WITH a Meta connection: that is the operator\'s own', async () => {
        const { Tenants, called } = load();
        const form = fakeForm({ name: 'Own', step: 3 });
        form.values.instagram_page_id = '17841400000000001';
        form.values.page_access_token = 'EAAG'.repeat(10);
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        const body = JSON.parse(JSON.stringify(called('createAdminTenant')[0]![1][0]));
        assert.equal('modules' in body, false);
        assert.equal(body.instagram_page_id, '17841400000000001');
    });

    it('opens the invite card with the to-do list, in the contract\'s order', async () => {
        const { Tenants, created, called } = load();
        await Tenants.loadCreateContext();
        const form = fakeForm({ name: 'Hub', step: 3, on: [...COMPANY, 'whatsapp'], preset: 'custom', handle: '@hub' });
        await Tenants.handleCreate(form, { preventDefault: () => {} });
        assert.equal(called('createAdminTenant').length, 1);
        assert.equal(created.cards.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(created.cards[0].context.todo)), ['tenants.todo.tester', 'tenants.todo.whatsappCall', 'tenants.todo.draft', 'tenants.todo.telegramBot']);
        assert.equal(created.cards[0].context.tenantId, TENANT);
    });

    it('builds each to-do from the choices: Tester only when they connect themselves, the call only with WhatsApp, the draft only with a handle or site, the bot only when none is saved', () => {
        const { Tenants } = load();
        const todo = (payload: Json, bot: boolean | null) => JSON.parse(JSON.stringify(Tenants.todoFor(payload, bot)));
        assert.deepEqual(todo({ modules: { metaConnect: 'operator', on: COMPANY } }, true), []);
        assert.deepEqual(todo({ modules: { metaConnect: 'self', on: COMPANY } }, true), ['tenants.todo.tester']);
        assert.deepEqual(todo({ modules: { metaConnect: 'operator', on: ['whatsapp'] }, website: 'x.test' }, true), ['tenants.todo.whatsappCall', 'tenants.todo.draft']);
        assert.deepEqual(todo({ modules: { metaConnect: 'operator', on: COMPANY } }, false), ['tenants.todo.telegramBot']);
        assert.deepEqual(todo({ modules: { metaConnect: 'operator', on: COMPANY } }, null), [], 'unknown is not "none"');
        assert.deepEqual(todo({}, true), []);
    });

    it('leaves the first-run dialog as it was: one step, the Meta connection required, no modules', () => {
        const { Tenants, modal } = load();
        Tenants.showCreateModal(true);
        const markup = modal();
        assert.doesNotMatch(markup, /data-step=|name="module"|name="preset"/);
        assert.match(markup, /data-first-run="true"/);
        assert.match(markup, /name="instagram_page_id"[^>]*required/);
        assert.match(markup, /name="page_access_token"[^>]*required/);
    });
});

describe('the Modules card on a workspace\'s page', () => {
    function opened(view: Json, api: Json = {}) {
        const l = load({ api: { getAdminTenantModules: async () => view, ...api } });
        l.Detail.tenantId = TENANT;
        const host = l.h.el('tenant-modules-body');
        return { ...l, host };
    }
    const company = { tenantId: TENANT, on: COMPANY, owner: false, stored: true, preset: 'company', metaConnect: 'self', adsCeiling: null };

    it('is read from GET …/modules after the page paints, and drawn with the picker, how Meta connects, and a Save that starts disabled', async () => {
        const { Detail, host, called, t } = opened(company);
        await Detail.mountModules();
        assert.equal(called('getAdminTenantModules').length, 1);
        assert.deepEqual(called('getAdminTenantModules')[0]![1], [TENANT]);
        const markup = String(host.innerHTML);
        assert.match(markup, /id="tenant-modules-form" data-submit="tenantDetail:saveModules"/);
        assert.match(markup, /name="module" value="inbox" data-change="tenantDetail:modulesChanged" checked/);
        assert.match(markup, /name="meta_connect" value="self" data-change="tenantDetail:modulesChanged" checked/);
        assert.match(markup, /id="tenant-modules-save" disabled/);
        assert.ok(words(markup).includes(t('tenantModules.save')));
    });

    it('the platform owner\'s own workspace is read-only: one line, the chips, no input, no Save, and nothing to save', async () => {
        const owner = { tenantId: TENANT, on: MODULE_IDS.filter((m) => m !== 'knowledge'), owner: true, stored: false, preset: null, metaConnect: 'operator', adsCeiling: null };
        const { Detail, host, called, t } = opened(owner);
        await Detail.mountModules();
        const markup = String(host.innerHTML);
        assert.doesNotMatch(markup, /<input|<button|<form|<select/);
        assert.ok(words(markup).includes(t('tenantModules.owner')));
        // And even if a save is forced through, it asks nobody.
        await Detail.saveModules(fakeForm({ on: COMPANY }), { preventDefault: () => {} });
        assert.equal(called('saveAdminTenantModules').length, 0);
    });

    it('enables Save only while the form differs from what was drawn', async () => {
        const { Detail } = opened(company);
        await Detail.mountModules();
        const form = fakeForm({ on: COMPANY, connect: 'self' });
        Detail.modulesInitial = Detail.modulesKey(form);
        Detail.refreshModulesSave(form);
        assert.equal(form.buttons['tenant-modules-save'].disabled, true);
        form.boxes.find((b: Box) => b.value === 'growth').checked = true;
        Detail.refreshModulesSave(form);
        assert.equal(form.buttons['tenant-modules-save'].disabled, false);
        form.boxes.find((b: Box) => b.value === 'growth').checked = false;
        Detail.refreshModulesSave(form);
        assert.equal(form.buttons['tenant-modules-save'].disabled, true, 'back to what it was');
        form.connects.forEach((c: Box) => { c.checked = c.value === 'operator'; });
        Detail.refreshModulesSave(form);
        assert.equal(form.buttons['tenant-modules-save'].disabled, false, 'how Meta connects counts too');
    });

    it('saves with PUT …/modules: the preset, the list, how Meta connects and the ceiling, then draws what the server answered', async () => {
        const { Detail, host, called, toasts, t } = opened(company);
        await Detail.mountModules();
        const form = fakeForm({ on: [...COMPANY, 'ads'], preset: 'custom', daily: '10', monthly: '300', connect: 'operator' });
        await Detail.saveModules(form, { preventDefault: () => {} });
        assert.equal(called('saveAdminTenantModules').length, 1);
        const [id, body] = called('saveAdminTenantModules')[0]![1] as [string, Json];
        assert.equal(id, TENANT);
        assert.deepEqual(JSON.parse(JSON.stringify(body)), { preset: 'custom', on: [...COMPANY, 'ads'], metaConnect: 'operator', adsCeiling: { maxDailyBudget: 10, monthlyCap: 300 } });
        assert.deepEqual(toasts, [t('tenantModules.saved')]);
        assert.match(String(host.innerHTML), /name="module" value="ads"[^>]*checked/);
        assert.match(String(host.innerHTML), /name="meta_connect" value="operator"[^>]*checked/);
    });

    it('refuses Ads with no ceiling before it asks the server, unless one is already stored', async () => {
        const { Detail, called, t } = opened(company);
        await Detail.mountModules();
        const form = fakeForm({ on: [...COMPANY, 'ads'], preset: 'custom' });
        await Detail.saveModules(form, { preventDefault: () => {} });
        assert.equal(called('saveAdminTenantModules').length, 0);
        assert.ok(words(form.errorHost.innerHTML).includes(t('tenantModules.ceilingRequired')));

        const stored = opened({ ...company, on: [...COMPANY, 'ads'], adsCeiling: { maxDailyBudget: 5, monthlyCap: 50 } });
        await stored.Detail.mountModules();
        await stored.Detail.saveModules(fakeForm({ on: [...COMPANY, 'ads', 'growth'], preset: 'custom' }), { preventDefault: () => {} });
        assert.equal(stored.called('saveAdminTenantModules').length, 1, 'a stored ceiling counts');
        assert.equal('adsCeiling' in (stored.called('saveAdminTenantModules')[0]![1][1] as Json), false, 'and none is sent');
    });

    it('says a refusal next to the field in the person\'s words, and points a missing ceiling at Client ads', async () => {
        const refusal = Object.assign(new Error('Set this tenant\'s ads ceiling'), { status: 409, code: 'CEILING_REQUIRED', params: { module: 'ads' } });
        const { Detail, h, t } = opened(company, { saveAdminTenantModules: async () => { throw refusal; } });
        await Detail.mountModules();
        const form = fakeForm({ on: [...COMPANY, 'ads'], preset: 'custom', daily: '10', monthly: '300' });
        await Detail.saveModules(form, { preventDefault: () => {} });
        const said = words(form.errorHost.innerHTML);
        assert.ok(said.includes(t('errors.CEILING_REQUIRED')), 'the sentence of errors.CEILING_REQUIRED');
        assert.ok(said.includes(t('errors.CEILING_REQUIRED.next')));
        assert.ok(said.includes(t('tenantModules.ceilingHint')));
        assert.match(String(form.errorHost.innerHTML), /href="#\/admin_ads"/);
        void h;

        const other = Object.assign(new Error('x'), { status: 400, code: 'MODULE_NEEDS', params: { module: 'muse', needs: 'dm_assistant' } });
        const second = opened(company, { saveAdminTenantModules: async () => { throw other; } });
        await second.Detail.mountModules();
        const f2 = fakeForm({ on: COMPANY });
        await second.Detail.saveModules(f2, { preventDefault: () => {} });
        assert.ok(words(f2.errorHost.innerHTML).includes(second.t('errors.MODULE_NEEDS')));
        assert.doesNotMatch(String(f2.errorHost.innerHTML), /admin_ads/);
    });

    it('says the modules could not be loaded, with a retry, and leaves the rest of the page alone', async () => {
        const { Detail, host } = opened(company, { getAdminTenantModules: async () => { throw new Error('down'); } });
        await Detail.mountModules();
        assert.match(String(host.innerHTML), /data-action="tenantDetail:mountModules"/);
        assert.doesNotMatch(String(host.innerHTML), /<form/);
    });
});
