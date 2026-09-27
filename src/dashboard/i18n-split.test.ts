/**
 * The interface copy is two files, one per language (split out of i18n.js on 2026-09-27).
 *
 * A visit needs only the language it is shown in — switching language reloads the page — so
 * index.html's head script fetches that one dictionary while the page is still parsing, and
 * app.js boots through `I18N.ready()`, which waits for it. These pin the parts that would fail
 * silently: the wrong file fetched, a boot that renders raw keys, a load order that matters, a
 * fetch failure that hangs the app.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const RUNTIME = 'dashboard/js/i18n.js';
const AR = 'dashboard/js/i18n.ar.js';
const EN = 'dashboard/js/i18n.en.js';
const read = (file: string): string => readFileSync(file, 'utf8');

type FakeScript = {
    tag: 'script'; src: string; attrs: Record<string, string>; listeners: Record<string, Array<() => void>>;
    onload: (() => void) | null; onerror: (() => void) | null; removed: boolean;
    setAttribute(name: string, value: string): void; getAttribute(name: string): string | null;
    addEventListener(type: string, fn: () => void): void; remove(): void; fire(type: 'load' | 'error'): void;
};

/** Just enough DOM for the head script and I18N.load: a head that collects scripts. */
function fakeDom(opts: { stored?: string | null; languages?: string[]; runtimeSrc?: string } = {}) {
    const appended: FakeScript[] = [];
    const makeScript = (): FakeScript => ({
        tag: 'script', src: '', attrs: {}, listeners: {}, onload: null, onerror: null, removed: false,
        setAttribute(name, value) { this.attrs[name] = String(value); },
        getAttribute(name) { return name in this.attrs ? this.attrs[name]! : null; },
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        remove() { this.removed = true; },
        fire(type) {
            if (type === 'load' && this.onload) this.onload();
            if (type === 'error' && this.onerror) this.onerror();
            (this.listeners[type] || []).forEach((fn) => fn());
        },
    });
    const storage = new Map<string, string>();
    if (opts.stored) storage.set('dashboard_lang', opts.stored);
    const document = {
        documentElement: { lang: '', dir: '', setAttribute() {} },
        currentScript: opts.runtimeSrc ? { src: opts.runtimeSrc } : null,
        head: { appendChild: (el: FakeScript) => { appended.push(el); return el; } },
        createElement: (tag: string) => (tag === 'script' ? makeScript() : { tag, setAttribute() {} }),
        querySelector: (sel: string) => {
            const m = /^script\[data-i18n-dict="(\w+)"\]$/.exec(sel);
            return m ? appended.filter((s) => s.tag === 'script' && !s.removed).find((s) => s.attrs['data-i18n-dict'] === m[1]) ?? null : null;
        },
    };
    const errors: string[] = [];
    const ctx: Record<string, unknown> = {
        document,
        localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v); } },
        navigator: { languages: opts.languages ?? [], language: (opts.languages ?? [])[0] ?? '' },
        location: { hash: '' },
        console: { error: (m: string) => errors.push(String(m)), warn() {}, log() {} },
        URL,
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    const run = (file: string) => vm.runInContext(read(file), ctx, { filename: file });
    const evalIn = <T>(code: string): T => vm.runInContext(code, ctx) as T;
    const dictScripts = () => appended.filter((s) => s.tag === 'script' && 'data-i18n-dict' in s.attrs);
    return { ctx, run, evalIn, appended, dictScripts, storage, errors };
}

/** The inline <script> in index.html's head that picks the theme, the language and preloads. */
function headScript(): string {
    const html = read('dashboard/index.html');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    const head = scripts.find((s) => s.includes('data-i18n-dict'));
    assert.ok(head, 'index.html has an inline head script that fetches the dictionary');
    return head!;
}

const assetVersion = (): string => (read('dashboard/js/app.js').match(/ASSET_VERSION:\s*'([\w.]+)'/) || [])[1]!;

describe('i18n split — the files', () => {
    it('keeps the runtime small and each dictionary in its own file', () => {
        assert.ok(read(RUNTIME).length < 20_000, 'i18n.js is the runtime only');
        assert.match(read(AR), /\(globalThis\.I18N_DICT = globalThis\.I18N_DICT \|\| \{\}\)\.ar = \{/);
        assert.match(read(EN), /\(globalThis\.I18N_DICT = globalThis\.I18N_DICT \|\| \{\}\)\.en = \{/);
        assert.equal(/'app\.name':/.test(read(RUNTIME)), false, 'no strings left in the runtime');
    });

    it('registers the same strings whichever file runs first', () => {
        const a = fakeDom(); a.run(RUNTIME); a.run(AR); a.run(EN);
        const b = fakeDom(); b.run(EN); b.run(AR); b.run(RUNTIME);
        const sa = a.evalIn<Record<string, Record<string, string>>>('I18N.strings');
        const sb = b.evalIn<Record<string, Record<string, string>>>('I18N.strings');
        assert.deepEqual(Object.keys(sb.ar!).length, Object.keys(sa.ar!).length);
        assert.equal(sb.ar!['app.name'], sa.ar!['app.name']);
        assert.equal(b.evalIn(`I18N.lang = 'ar'; t('app.name')`), sa.ar!['app.name']);
    });

    it('renders Arabic from the Arabic file alone', () => {
        const d = fakeDom(); d.run(RUNTIME); d.run(AR);
        assert.equal(d.evalIn(`'en' in I18N.strings`), false);
        const name = d.evalIn<string>(`I18N.lang = 'ar'; t('app.name')`);
        assert.match(name, /[؀-ۿ]/, 'an Arabic value, not the key');
    });
});

describe('i18n split — index.html fetches only the page’s language', () => {
    const cases: Array<[string, { stored?: string | null; languages?: string[] }, 'ar' | 'en']> = [
        ['a first visit with no preference', {}, 'ar'],
        ['a stored Arabic preference', { stored: 'ar' }, 'ar'],
        ['a stored English preference', { stored: 'en' }, 'en'],
        ['a first visit from an English browser', { languages: ['en-US'] }, 'en'],
        ['a first visit from an Arabic browser', { languages: ['ar-SA', 'en'] }, 'ar'],
        ['a browser in neither language', { languages: ['fr-FR'] }, 'ar'],
    ];
    for (const [name, opts, want] of cases) {
        it(`${name} → i18n.${want}.js`, () => {
            const d = fakeDom(opts);
            vm.runInContext(headScript(), d.ctx, { filename: 'index.html#head' });
            const dicts = d.dictScripts();
            assert.equal(dicts.length, 1, 'exactly one dictionary');
            assert.equal(dicts[0]!.attrs['data-i18n-dict'], want);
            assert.equal(dicts[0]!.src, `/dashboard/js/i18n.${want}.js?v=${assetVersion()}`, 'the same cache version as everything else');
        });
    }

    it('marks a failed fetch so the boot can retry it', () => {
        const d = fakeDom();
        vm.runInContext(headScript(), d.ctx, { filename: 'index.html#head' });
        d.dictScripts()[0]!.fire('error');
        assert.equal(d.dictScripts()[0]!.attrs['data-state'], 'failed');
    });

    it('does not also load either dictionary with a static tag', () => {
        assert.equal(/<script[^>]+src="\/dashboard\/js\/i18n\.(ar|en)\.js/.test(read('dashboard/index.html')), false);
    });
});

describe('i18n split — I18N.ready()', () => {
    it('resolves at once when the dictionary is already in', async () => {
        const d = fakeDom({ stored: 'ar' });
        d.run(AR); d.run(RUNTIME);
        await d.evalIn<Promise<void>>('I18N.ready()');
        assert.equal(d.dictScripts().length, 0, 'nothing fetched');
    });

    it('waits for a dictionary the head script is still fetching, and does not fetch it twice', async () => {
        const d = fakeDom({ stored: 'ar', runtimeSrc: 'https://x/dashboard/js/i18n.js?v=9.9' });
        vm.runInContext(headScript(), d.ctx, { filename: 'index.html#head' });
        d.run(RUNTIME);
        let settled = false;
        const ready = d.evalIn<Promise<void>>('I18N.ready()').then(() => { settled = true; });
        await Promise.resolve();
        assert.equal(settled, false, 'the boot waits');
        d.run(AR); // the dictionary lands and announces itself
        await ready;
        assert.equal(settled, true);
        assert.equal(d.dictScripts().length, 1, 'the head script’s fetch was reused');
    });

    it('fetches the dictionary itself when nothing did, at the runtime’s own version', async () => {
        const d = fakeDom({ stored: 'en', runtimeSrc: 'https://x/dashboard/js/i18n.js?v=9.9' });
        d.run(RUNTIME);
        const ready = d.evalIn<Promise<void>>('I18N.ready()');
        const [script] = d.dictScripts();
        assert.equal(script!.src, '/dashboard/js/i18n.en.js?v=9.9');
        d.run(EN); script!.fire('load');
        await ready;
        assert.equal(d.evalIn(`t('app.name')`), 'AutoReply Pro');
    });

    it('retries a fetch the head script saw fail', async () => {
        const d = fakeDom({ stored: 'ar' });
        vm.runInContext(headScript(), d.ctx, { filename: 'index.html#head' });
        d.dictScripts()[0]!.fire('error');
        d.run(RUNTIME);
        const ready = d.evalIn<Promise<void>>('I18N.ready()');
        const live = d.dictScripts().filter((s) => !s.removed);
        assert.equal(live.length, 1, 'the failed tag is replaced by a fresh one');
        assert.notEqual(live[0], d.dictScripts()[0]);
        d.run(AR);
        await ready;
    });

    it('falls back to English when the Arabic file will not load, and never hangs', async () => {
        const d = fakeDom({ stored: 'ar' });
        d.run(RUNTIME);
        const ready = d.evalIn<Promise<void>>('I18N.ready()');
        d.dictScripts()[0]!.fire('error');
        await Promise.resolve(); await Promise.resolve();
        const en = d.dictScripts().find((s) => s.attrs['data-i18n-dict'] === 'en');
        assert.ok(en, 'the English dictionary is fetched instead');
        d.run(EN); en!.fire('load');
        await ready;
        assert.equal(d.evalIn(`t('app.name')`), 'AutoReply Pro', 'English words, not raw keys');
        assert.match(d.errors.join('\n'), /did not load/);
    });

    it('is what app.js boots through', () => {
        assert.match(read('dashboard/js/app.js'), /DOMContentLoaded[\s\S]{0,200}I18N\.ready\(\)\.then\(\(\) => App\.init\(\), \(\) => App\.init\(\)\)/);
    });
});
