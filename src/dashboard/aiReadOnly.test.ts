/**
 * AI settings: a viewer reads the screen, an operator changes it.
 *
 * The server refuses a viewer on every write this page makes (`POST /settings/ai`, `/settings/ai/test` and `/settings/sales-variants` are
 * `canOperate`), yet the page drew every control live, so a viewer learned it from an English 403 toast. `campaigns.js` and the others already
 * hide or disable by role; this screen now does the same, with a short note, and what it pins is:
 *
 *   - an operator's shell is what it always was: no disabled or read-only control, no note;
 *   - a viewer's shell has NO live control: every input, select, textarea and button is disabled or read-only (a scan of the whole markup, so a
 *     control added to the shell later without a decision fails here), with the note in both languages;
 *   - Save and the sandbox send nothing for a viewer, a load does not hand Save back, and the wording experiment's cards are read-only too;
 *   - the write paths this page calls are exactly the seven audited here, each behind the server guard the page's question mirrors (`canOperate`, and for
 *     Meta vision's card and its video library `canAdminister`: the owner's, so an operator reads that card and changes only the agent), and the library's
 *     reads are the owner's as well.
 *
 * The REAL `ai_settings.js` in a `node:vm` context, as `aiVariants.test.ts` loads it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;
type Lang = 'ar' | 'en';
type Role = 'owner' | 'operator' | 'viewer';

interface FakeEl {
    id: string;
    value: string;
    checked: boolean;
    disabled: boolean;
    innerHTML: string;
    textContent: string;
    classes: Set<string>;
    classList: { toggle(name: string, force?: boolean): boolean; add(name: string): void; remove(name: string): void; contains(name: string): boolean };
    focus(): void;
    querySelector(selector: string): unknown;
    querySelectorAll(selector: string): unknown[];
    setAttribute(): void;
    getAttribute(): null;
}

function fakeEl(id: string, over: Partial<FakeEl> = {}): FakeEl {
    const classes = new Set<string>();
    const el: FakeEl = {
        id, value: '', checked: false, disabled: false, innerHTML: '', textContent: '', classes,
        classList: {
            toggle: (name, force) => { const on = force === undefined ? !classes.has(name) : force; if (on) classes.add(name); else classes.delete(name); return on; },
            add: (name) => { classes.add(name); }, remove: (name) => { classes.delete(name); }, contains: (name) => classes.has(name),
        },
        focus() {}, querySelector: () => null, querySelectorAll: () => [], setAttribute: () => {}, getAttribute: () => null,
        ...over,
    };
    return el;
}

function load(lang: Lang, role: Role, api: Json = {}) {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null, appendChild: noop, setAttribute: noop,
        getAttribute: () => null, removeAttribute: noop, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '',
    };
    const dom = new Map<string, FakeEl>();
    const calls: string[] = [];
    const record = (name: string, answer: unknown) => async () => { calls.push(name); return answer; };
    const ctx: Json = {
        document: {
            ...stub, createElement: () => ({ ...stub }), body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '#/ai_settings' } },
        location: { hash: '#/ai_settings', pathname: '/dashboard', origin: 'https://example.test' },
        Intl, console, clearTimeout, clearInterval, setTimeout, setInterval,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: {
            token: 'test',
            getAdminAi: async () => ({ purposes: [], providers: [] }),
            getAiSettings: async () => ({ is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7 }),
            saveAiSettings: record('saveAiSettings', {}),
            testAiSettings: record('testAiSettings', { text: 'ok' }),
            saveSalesVariants: record('saveSalesVariants', {}),
            saveSalesFollowup: record('saveSalesFollowup', {}),
            ...api,
        },
        // What `App.canOperate()` answers: the session's role is anything but a viewer.
        App: { currentTheme: () => 'auto', navigate: noop, isAdmin: () => false, canOperate: () => role !== 'viewer' },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        URLSearchParams,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/ai_settings.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const pages = vm.runInContext('({ AiSettingsPage, UI, t })', ctx) as { AiSettingsPage: Json; UI: Json; t: (key: string, params?: Json) => string };
    const toasts: string[] = [];
    pages.UI.toast = (message: unknown) => { toasts.push(String(message)); };
    return { ...pages, dom, calls, toasts };
}

const LANGS = ['ar', 'en'] as const;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Every control tag of the form and the sandbox, as written in the shell: `<input …>`, `<select …>`, `<textarea …>` and `<button …>`. */
function controlsOf(shell: string): { id: string; tag: string }[] {
    return [...shell.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((m) => ({ id: /\bid="([^"]*)"/.exec(m[0])?.[1] ?? '(no id)', tag: m[0] }));
}
const isDisabled = (tag: string) => /\sdisabled(?=[\s>=])/.test(tag);
const isReadOnly = (tag: string) => /\sreadonly(?=[\s>=])/.test(tag);

/** The text boxes: read-only for a viewer, so the prompt can still be read, selected and copied. Everything else is disabled. */
const TEXT_BOXES = ['system-prompt-text', 'knowledge-base-text', 'sales-test-senders', 'sales-followup-minutes', 'muse-daily-usd'];
/** What a viewer must not be able to touch, by id: the audit of this screen's controls. */
const GATED = [
    'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'engine-selector', 'gemini-fallback-toggle', 'sales-mode-selector',
    'sales-test-senders', 'sales-followup-minutes', 'sales-variants-enabled', 'sales-variant-add', 'model-selector', 'temp-slider',
    'save-settings-btn', 'sandbox-user-input', 'sandbox-btn',
    // Meta vision (beta), the owner's card: the three switches, who it answers, the picker's button and search, the cap, and its own Save.
    'muse-dm-media', 'muse-voice', 'muse-memory', 'muse-who', 'muse-picker-open', 'muse-picker-search', 'muse-daily-usd', 'muse-save-btn',
    // and its video library: "Index my reels" and Refresh (the buttons of each reel are drawn by the list, and only for an owner).
    'muse-index-btn', 'muse-library-refresh',
];

describe('AI settings — an operator keeps every control', () => {
    for (const lang of LANGS) {
        for (const role of ['owner', 'operator'] as const) {
            it(`draws the shell with nothing disabled or read-only, and no note, for the ${role} (${lang})`, () => {
                const { AiSettingsPage } = load(lang, role);
                const shell = String(AiSettingsPage.shell());
                const controls = controlsOf(shell);
                for (const id of GATED) assert.ok(controls.some((c) => c.id === id), `the shell has the control ${id}`);
                for (const c of controls) {
                    assert.equal(isDisabled(c.tag), false, `${c.id} is live: ${c.tag.replace(/\s+/g, ' ')}`);
                    assert.equal(isReadOnly(c.tag), false, `${c.id} is editable`);
                }
                assert.equal(shell.includes('ai-readonly-note'), false, 'no note');
            });
        }
    }
});

describe('AI settings — a viewer reads, and nothing on the screen is live', () => {
    for (const lang of LANGS) {
        it(`disables or locks every control of the shell, and says so in a note (${lang})`, () => {
            const { AiSettingsPage, t } = load(lang, 'viewer');
            const shell = String(AiSettingsPage.shell());
            const controls = controlsOf(shell);
            for (const id of GATED) assert.ok(controls.some((c) => c.id === id), `the shell has the control ${id}`);

            // The scan: ANY control in the markup, named or not, is disabled or read-only.
            for (const c of controls) assert.ok(isDisabled(c.tag) || isReadOnly(c.tag), `${c.id} is still live for a viewer: ${c.tag.replace(/\s+/g, ' ')}`);

            // And the kind of lock: a text box stays readable and selectable, everything else is disabled.
            for (const c of controls) {
                if (TEXT_BOXES.includes(c.id)) assert.ok(isReadOnly(c.tag) && !isDisabled(c.tag), `${c.id} is read-only, not disabled`);
                else assert.ok(isDisabled(c.tag), `${c.id} is disabled`);
            }

            const note = /<p[^>]*\bid="ai-readonly-note"[^>]*>([\s\S]*?)<\/p>/.exec(shell);
            assert.ok(note, 'the note is there');
            assert.ok(note![1]!.includes(t('ai.readOnly')), 'and it is the dictionary\'s sentence');
            assert.notEqual(t('ai.readOnly'), 'ai.readOnly', 'which exists in this language');
            assert.equal(/\{\w+\}/.test(t('ai.readOnly')), false, 'with no placeholder left unfilled');
        });

        it(`names the role the page is read-only for, in the words the role badge uses (${lang})`, () => {
            const { t } = load(lang, 'viewer');
            assert.ok(t('ai.readOnly').includes(t('roles.viewer')), `${t('ai.readOnly')} should name «${t('roles.viewer')}»`);
        });
    }

    it('paints the read-only state in the skeleton too: it is the first thing the router draws, and the note must not push the form down after', () => {
        const { AiSettingsPage } = load('en', 'viewer');
        const skeleton = String(AiSettingsPage.skeleton());
        assert.ok(skeleton.includes('id="ai-readonly-note"'), 'the note is already there');
        const save = controlsOf(skeleton).find((c) => c.id === 'save-settings-btn');
        assert.ok(save && isDisabled(save.tag), 'and Save is already disabled');
    });

    it('sends nothing on Save, and nothing from the sandbox, and still stops the browser submitting the form', async () => {
        const { AiSettingsPage, calls, toasts, dom } = load('en', 'viewer');
        for (const id of ['ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'sandbox-user-input']) dom.set(id, fakeEl(id));
        dom.get('sandbox-user-input')!.value = 'hello';
        let prevented = 0;
        const event = { preventDefault() { prevented++; } };
        await AiSettingsPage.saveSettings({ querySelector: () => null }, event);
        await AiSettingsPage.sendSandboxTest({ querySelector: () => null }, event);
        assert.equal(prevented, 2, 'both forms stay un-submitted');
        assert.deepEqual(calls, [], 'no request left the page');
        assert.deepEqual(toasts, [], 'and no toast quotes a refusal that never came');
        assert.equal(dom.get('sandbox-user-input')!.value, 'hello', 'the typed message was not eaten');
    });

    it('does not let a load hand Save back, and an operator still gets it back after a failed load', async () => {
        for (const [role, wantDisabled] of [['viewer', true], ['operator', false]] as const) {
            const { AiSettingsPage, dom } = load('en', role);
            for (const id of [
                'ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn',
                'ai-settings-error', 'ai-unsaved-note',
            ]) dom.set(id, fakeEl(id));
            dom.get('save-settings-btn')!.disabled = true;   // as a failed load, or a viewer's shell, leaves it
            await AiSettingsPage.loadSettings();
            await settle();
            assert.equal(dom.get('save-settings-btn')!.disabled, wantDisabled, `${role}: Save is ${wantDisabled ? 'still disabled' : 'live again'}`);
            assert.equal(dom.get('system-prompt-text')!.value, 'p', `${role}: the saved text is still shown`);
        }
    });

    it('draws the wording experiment read-only: locked fields, no remove button, the add button disabled', () => {
        // A cap of four, so that the operator's add button is live with three rows on screen (the real cap is three).
        const limits = { max: 4, label: 40, text: 300, weight: 100 };
        const rows = [
            { id: 'A', label: 'Warm', weight: 50, opening: 'Open with a question.', cta: '', saved: true },
            { id: 'B', label: 'Direct', weight: 50, opening: '', cta: 'Offer the link.', saved: true },
            { id: 'C', label: 'Extra', weight: 0, opening: '', cta: '', saved: false },   // unsaved, and three rows: removable for an operator
        ];
        for (const [role, locked] of [['viewer', true], ['operator', false]] as const) {
            const { AiSettingsPage, dom } = load('en', role);
            const list = fakeEl('sales-variants-list');
            dom.set('sales-variants-list', list);
            dom.set('sales-variants-enabled', fakeEl('sales-variants-enabled'));
            dom.set('sales-variant-add', fakeEl('sales-variant-add'));
            dom.set('sales-variants-hint', fakeEl('sales-variants-hint'));
            AiSettingsPage._variants = { limits, enabled: true, rows: structuredClone(rows), savedCanon: '' };
            AiSettingsPage.paintVariants();

            const fields = controlsOf(list.innerHTML);
            assert.equal(fields.length, 4 * 3 + (locked ? 0 : 1), `${role}: four fields per card${locked ? ', and no remove button' : ', and the one removable card\'s remove button'}`);
            for (const f of fields.filter((c) => c.id !== '(no id)')) assert.equal(isReadOnly(f.tag), locked, `${role}: ${f.id} ${locked ? 'is read-only' : 'is editable'}`);
            assert.equal(list.innerHTML.includes('ai:removeVariant'), !locked, `${role}: the remove button is ${locked ? 'gone' : 'there'}`);
            assert.equal(dom.get('sales-variant-add')!.disabled, locked, `${role}: the add button is ${locked ? 'disabled' : 'live'}`);
        }
    });

    it('adds and removes no variant for a viewer, whatever reaches the handlers, and still does for an operator', () => {
        const limits = { max: 3, label: 40, text: 300, weight: 100 };
        const A = { id: 'A', label: 'Warm', weight: 50, opening: 'x', cta: '', saved: true };
        const B = { id: 'B', label: 'Direct', weight: 50, opening: '', cta: 'y', saved: true };
        const C = { id: 'C', label: '', weight: 0, opening: '', cta: '', saved: false };
        for (const [role, canChange] of [['viewer', false], ['operator', true]] as const) {
            const { AiSettingsPage, dom } = load('en', role);
            for (const id of ['sales-variants-list', 'sales-variants-enabled', 'sales-variant-add', 'sales-variants-hint', 'ai-unsaved-note']) dom.set(id, fakeEl(id));
            const ids = () => AiSettingsPage._variants.rows.map((r: Json) => r.id);

            AiSettingsPage._variants = { limits, enabled: true, rows: structuredClone([A, B, C]), savedCanon: '' };
            AiSettingsPage.removeVariant('C');
            assert.deepEqual(ids(), canChange ? ['A', 'B'] : ['A', 'B', 'C'], `${role}: remove`);

            AiSettingsPage._variants = { limits, enabled: true, rows: structuredClone([A, B]), savedCanon: '' };
            AiSettingsPage.addVariant();
            assert.deepEqual(ids(), canChange ? ['A', 'B', 'C'] : ['A', 'B'], `${role}: add`);
        }
    });
});

describe('AI settings — the write paths, audited against the server\'s guards', () => {
    const page = readFileSync('dashboard/js/pages/ai_settings.js', 'utf8');
    const client = readFileSync('dashboard/js/api.js', 'utf8');
    const routes = readFileSync('src/routes/api.ts', 'utf8');
    const libraryRoutes = readFileSync('src/routes/museLibrary.ts', 'utf8');

    /**
     * Every `API.<name>(` the page calls, with the method and path `api.js` gives it. A path is a quoted string, or a template that holds an id
     * (`/settings/ai/muse/library/${encodeURIComponent(id)}/index`), whose id is written `:id` here, as the route names it.
     */
    function callsOfThePage(): { name: string; path: string; method: string }[] {
        const quoted = "(?:'([^']+)'|`([^`]+)`)";
        return [...new Set([...page.matchAll(/\bAPI\.(\w+)\(/g)].map((m) => m[1]!))].map((name) => {
            const def = new RegExp(`\\b${name}: \\([^)]*\\) => API\\.request\\(${quoted}(?:, \\{ method: '(\\w+)')?`).exec(client);
            assert.ok(def, `api.js defines ${name}`);
            return { name, path: (def![1] ?? def![2]!).replace(/\$\{[^}]*\}/g, ':id'), method: def![3] ?? 'GET' };
        });
    }

    /** What this screen may write, and the guard each write sits behind on the server: the audit of 2026-10-25. */
    const AUDITED: Record<string, { path: string; guard: 'canOperate' | 'canAdminister'; router?: 'museLibrary' }> = {
        saveAiSettings: { path: '/settings/ai', guard: 'canOperate' },
        testAiSettings: { path: '/settings/ai/test', guard: 'canOperate' },
        saveSalesVariants: { path: '/settings/sales-variants', guard: 'canOperate' },
        // A platform admin's route (`requirePlatformAdmin`), and a platform admin always acts as owner: the field is drawn for them alone.
        saveSalesFollowup: { path: '/settings/sales-followup', guard: 'canAdminister' },
        // Meta vision's card (T038): the OWNER's, because it decides whether a customer's media is sent to Meta's models and sets his daily spend. The card draws
        // itself read-only for an operator as well as a viewer (`canEditMuse`), which the card's own tests pin.
        saveMuseSettings: { path: '/settings/ai/muse', guard: 'canAdminister' },
        // The video library inside that card (T057): its own router (`routes/museLibrary.ts`), mounted under `/settings/ai/muse/library`, the owner's on EVERY route.
        indexMuseLibrary: { path: '/settings/ai/muse/library/index', guard: 'canAdminister', router: 'museLibrary' },
        reindexMuseReel: { path: '/settings/ai/muse/library/:id/index', guard: 'canAdminister', router: 'museLibrary' },
    };
    const MOUNT = '/settings/ai/muse/library';

    it('calls exactly the seven writes audited here: an eighth means deciding who may make it, and drawing it read-only for the rest', () => {
        const calls = callsOfThePage();
        assert.deepEqual(calls.filter((c) => c.method !== 'GET').map((c) => c.name).sort(), Object.keys(AUDITED).sort());
        for (const [name, want] of Object.entries(AUDITED)) {
            const call = calls.find((c) => c.name === name)!;
            assert.equal(call.method, 'POST', name);
            assert.equal(call.path, want.path, name);
        }
    });

    it('finds each of them behind the guard this page\'s question mirrors, and the reads behind none', () => {
        for (const [name, want] of Object.entries(AUDITED)) {
            // The library's routes are in their own file, named relative to where `api.ts` mounts it; the others are `router.post(<the whole path>, …)` in `api.ts`.
            const [source, owner, path] = want.router ? [libraryRoutes, 'museLibraryRouter', want.path.slice(MOUNT.length)] : [routes, 'router', want.path];
            const m = new RegExp(`${owner}\\.post\\('${path.replace(/\//g, '\\/')}',\\s*([^{]*?)async`).exec(source);
            assert.ok(m, `${name}: the route ${want.path} exists`);
            assert.ok(m![1]!.includes(want.guard), `${name}: ${want.path} is behind ${want.guard} (found: ${m![1]!.trim()})`);
        }
        // What the viewer's screen is made of: any role may read it.
        assert.match(routes, /router\.get\('\/settings\/ai',\s*async/, 'GET /settings/ai has no role guard');
        assert.match(routes, /router\.get\('\/settings\/sales-variants',\s*async/, 'nor has the wording experiment\'s read');
    });

    it('keeps the video library the owner\'s on every route, reads included, and mounted where the page asks for it: the card is not drawn for anyone else', () => {
        assert.match(libraryRoutes, /const canAdminister = requireTenantRole\('owner'\);/);
        const all = [...libraryRoutes.matchAll(/museLibraryRouter\.(get|post|put|patch|delete)\('([^']*)',\s*([^{]*?)async/g)].map((m) => [m[1], m[2], m[3]!.trim()]);
        assert.deepEqual(all.map(([method, path]) => `${method} ${path}`).sort(), ['get /', 'get /:id', 'post /:id/index', 'post /index']);
        for (const [method, path, guard] of all) assert.equal(String(guard).replace(/,$/, ''), 'canAdminister', `${method} ${path} is behind canAdminister`);
        assert.match(routes, new RegExp(`router\\.use\\('${MOUNT.replace(/\//g, '\\/')}', museLibraryRouter\\);`), 'api.ts mounts it where api.js asks');
        // The two reads the page makes are asked only for an owner: the section is not drawn, and nothing is requested, for any other role.
        const reads = callsOfThePage().filter((c) => c.method === 'GET' && c.name.includes('Muse'));
        assert.deepEqual(reads.map((c) => `${c.name} ${c.path}`).sort(), ['getMuseLibrary /settings/ai/muse/library', 'getMuseReel /settings/ai/muse/library/:id']);
    });
});
