/**
 * Settings → Media storage, the card a platform admin configures Supabase Storage from.
 *
 * The dashboard has no build step, so a template that throws at render blanks the whole Settings
 * page, and a string that exists in one language only renders English inside the Arabic page.
 * These render the REAL files in a `node:vm` context — components.js, i18n.js, admin_common.js
 * and settings.js — the way escaping.test.ts and help.test.ts do, and assert what the card says
 * in each state the server can report.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = Record<string, any>;

function load(lang: 'ar' | 'en') {
    const noop = (): void => {};
    const stub = {
        addEventListener: noop, removeEventListener: noop,
        querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null,
        contains: () => false, children: [], innerHTML: '',
    };
    const unref = (t: ReturnType<typeof setTimeout>) => { (t as { unref?: () => void }).unref?.(); return t; };
    const ctx: Json = {
        document: {
            ...stub,
            createElement: () => ({ ...stub }),
            body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: () => null,
            activeElement: null,
            visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '#/settings' } },
        location: { hash: '#/settings' },
        history: { replaceState: noop },
        Intl, console, clearTimeout, clearInterval,
        setTimeout: (fn: () => void, ms?: number) => unref(setTimeout(fn, ms)),
        setInterval: (fn: () => void, ms?: number) => unref(setInterval(fn, ms)),
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        CSS: { escape: (v: string) => String(v) },
        API: { token: 'test' },
        App: { currentTheme: () => 'auto', navigate: noop, isAdmin: () => true, canAdminister: () => true, hashParam: () => '' },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js',
        'dashboard/js/i18n.js',
        'dashboard/js/motion.js',
        'dashboard/js/pages/admin_common.js',
        'dashboard/js/pages/settings.js',
    ]) {
        vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    }
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const { SettingsPage, t } = vm.runInContext('({ SettingsPage, t })', ctx) as {
        SettingsPage: { mediaStorageSection(ms: unknown, error: unknown): { toString(): string } };
        t: (key: string, params?: Json) => string;
    };
    return {
        render: (ms: unknown, error: unknown = null) => SettingsPage.mediaStorageSection(ms, error).toString(),
        t,
    };
}

const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const CONNECTED = {
    backend: 'supabase',
    bucket: 'media',
    url: { value: 'https://abcd1234.supabase.co', source: 'database' },
    key: { set: true, source: 'database', kind: 'secret', preview: 'sb_•••••OP' },
    env: { url: false, key: false },
    connection: { ok: true, bucketExists: true, public: true, created: false },
    usage: { storage: { files: 12, bytes: 283_115_520 }, database: { files: 0, bytes: 0 }, queuedDeletions: 0, tierBytes: 1024 ** 3 },
};

describe('Settings → Media storage', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`shows a live connection, the bucket and the space used (${lang})`, () => {
            const { render, t } = load(lang);
            const card = render(CONNECTED);

            assert.ok(card.includes(t('settings.media.title')));
            assert.ok(card.includes(t('settings.media.statusConnected')));
            assert.match(card, /health-fresh/);
            assert.ok(text(card).includes(' media '), 'the bucket is named');
            assert.match(text(card), /270(\.0)? MB|270٫0 MB|٢٧٠/, 'the space used, in megabytes');
            assert.ok(card.includes('https://abcd1234.supabase.co'));
            assert.ok(card.includes('sb_•••••OP'), 'a masked hint of the saved key');
            assert.ok(card.includes('id="media-storage-key"') && !/id="media-storage-key"[^>]*value=/.test(card), 'the key field is never prefilled');
            assert.ok(card.includes('data-action="settings:removeMediaStorage"'));
        });

        it(`says where to find both values, recommending the new secret key (${lang})`, () => {
            const { render, t } = load(lang);
            const help = t('settings.media.help');
            assert.notEqual(help, 'settings.media.help', 'the string exists');
            assert.ok(render(CONNECTED).includes(help));
            for (const place of ['Connect', 'Project Settings', 'API Keys', 'Secret keys', 'sb_secret_']) {
                assert.ok(help.includes(place), `${lang}: ${place}`);
            }
        });
    }

    it('writes Arabic prose in the Arabic card, not English', () => {
        const { t } = load('ar');
        for (const key of ['settings.media.title', 'settings.media.intro', 'settings.media.help', 'settings.media.statusConnected']) {
            assert.match(t(key), /[؀-ۿ]/, key);
        }
    });

    it('says uploads stay in the database when nothing is set up', () => {
        const { render, t } = load('en');
        const card = render({
            ...CONNECTED, backend: 'postgres', url: { value: null, source: null },
            key: { set: false, source: null, kind: null, preview: null }, connection: null,
            usage: { ...CONNECTED.usage, storage: { files: 0, bytes: 0 } },
        });
        assert.ok(card.includes(t('settings.media.statusPostgres')));
        assert.ok(!card.includes('settings:removeMediaStorage'), 'nothing saved, nothing to remove');
    });

    it('shows Supabase\'s refusal when the saved key stopped working', () => {
        const { render, t } = load('en');
        const card = render({ ...CONNECTED, connection: { ok: false, status: 400, error: 'Supabase Storage refused to read the bucket: Invalid API key' } });
        assert.ok(card.includes(t('settings.media.statusFailed')));
        assert.ok(card.includes('Invalid API key'));
    });

    it('points at the backfill while files are still in the database', () => {
        const { render } = load('en');
        const card = render({ ...CONNECTED, usage: { ...CONNECTED.usage, database: { files: 3, bytes: 5_000_000 } } });
        assert.ok(card.includes('scripts/migrate-media-to-storage.mjs'));
        assert.ok(card.includes('VACUUM FULL media_uploads'));
    });

    it('asks for the legacy service_role key to be replaced', () => {
        const { render, t } = load('en');
        const card = render({ ...CONNECTED, key: { ...CONNECTED.key, kind: 'legacy_jwt' } });
        assert.ok(card.includes(t('settings.media.keyLegacy')));
        assert.ok(!render(CONNECTED).includes(t('settings.media.keyLegacy')));
    });

    it('survives a failed load with a retry, rather than blanking Settings', () => {
        const { render, t } = load('ar');
        const card = render(null, new Error('boom'));
        assert.ok(card.includes(t('settings.media.loadFailed', { message: 'boom' })));
        assert.ok(card.includes('data-action="settings:render"'));
    });

    it('escapes whatever the server says', () => {
        const { render } = load('en');
        const card = render({ ...CONNECTED, connection: { ok: false, status: 400, error: '<img src=x onerror=alert(1)>' } });
        assert.ok(!card.includes('<img src=x'));
        assert.ok(card.includes('&lt;img src=x onerror=alert(1)&gt;'));
    });
});
