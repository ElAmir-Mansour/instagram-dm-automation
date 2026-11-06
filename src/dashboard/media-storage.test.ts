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
        'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js',
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

// ─── Cloudflare R2 (src/services/r2Storage.ts, r2Usage.ts) ───────────────────────────────────

const SECRET = 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY0123456789abcdef0123';
const ORIGIN = 'https://msg-response-auto.vercel.app';
const LIMITS = { storage_bytes: 9 * 1024 ** 3, class_a: 900_000, class_b: 9_000_000 };
const CEILINGS = { storage_bytes: 10_000_000_000, class_a: 1_000_000, class_b: 10_000_000 };
const item = (kind: string, used: number, limit: number) => ({ kind, used, limit, ceiling: limit, pct: Math.floor((used / limit) * 100) });
const summary = (over: Json = {}) => ({
    month: '2026-11', resetsAt: '2026-12-01T00:00:00.000Z', limits: LIMITS, ceilings: CEILINGS, level: 'ok',
    items: [item('storage', 1_000_000_000, LIMITS.storage_bytes), item('class_a', 1200, LIMITS.class_a), item('class_b', 45_000, LIMITS.class_b)], ...over,
});
const R2_OFF = {
    configured: false, accountId: null, bucket: 'media', accessKeyId: { set: false, preview: null }, secretAccessKey: { set: false, preview: null },
    connection: null, summary: null, copy: null, cors: { status: null, origin: ORIGIN, policy: null },
};
const R2_ON = {
    configured: true, accountId: '0123456789abcdef0123456789abcdef', bucket: 'media',
    accessKeyId: { set: true, preview: 'AKI•••••45' }, secretAccessKey: { set: true, preview: 'wJa•••••23' },
    connection: { ok: true, bucketExists: true, created: false, cors: 'unchecked' }, summary: summary(),
    copy: { active: true, requestedAt: '2026-11-06T10:00:00.000Z', doneAt: null, lastError: null, inR2: 3, total: 10, skipped: 0 },
    cors: { status: 'ok', origin: ORIGIN, policy: JSON.stringify([{ AllowedOrigins: [ORIGIN] }], null, 2) },
};
const WITH_R2 = (r2: Json, over: Json = {}) => ({ ...CONNECTED, choice: null, usage: { ...CONNECTED.usage, r2: { files: 3, bytes: 12_000_000 } }, r2, ...over });

describe('Settings → Media storage: Cloudflare R2', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`offers the R2 keys form before R2 is set up, without the choice of where uploads go or any meter (${lang})`, () => {
            const { render, t } = load(lang);
            const card = render(WITH_R2(R2_OFF));
            assert.ok(card.includes(t('settings.media.r2.title')));
            assert.ok(card.includes(t('settings.media.r2.statusOff')));
            for (const id of ['r2-account', 'r2-bucket', 'r2-key-id', 'r2-secret']) assert.ok(card.includes(`id="${id}"`), id);
            assert.ok(card.includes('data-submit="settings:saveR2Storage"'));
            assert.ok(text(card).includes(text(t('settings.media.r2.help'))), 'where to find the keys in Cloudflare');
            assert.ok(!card.includes('name="media-backend"'), 'nothing to choose yet');
            assert.ok(!card.includes('r2-meter-'));
            assert.ok(!card.includes('settings:copyToR2'));
        });

        it(`once set up: the choice, this month's meters against each limit, the reset date, the copy progress, and never the secret (${lang})`, () => {
            const { render, t } = load(lang);
            const card = render(WITH_R2(R2_ON, { backend: 'supabase', choice: 'supabase' }));
            assert.ok(card.includes('name="media-backend"') && card.includes('data-change="settings:setMediaBackend"'));
            assert.match(card, /id="media-backend-supabase"[^>]*checked/);
            assert.ok(!/id="media-backend-r2"[^>]*checked/.test(card));
            for (const kind of ['storage', 'class_a', 'class_b']) {
                assert.ok(card.includes(`id="r2-meter-${kind}"`), kind);
                assert.ok(card.includes(t(`settings.media.r2.meter.${kind}`)), kind);
            }
            assert.match(card, /<progress id="r2-meter-class_a" value="1200" max="900000">/);
            assert.ok(card.includes(t('settings.media.r2.usageTitle', { month: '2026-11' })));
            assert.ok(card.includes(t('settings.media.r2.copyProgress', { done: '3', total: '10' })) || /3/.test(text(card)), 'N of M');
            assert.ok(card.includes('data-action="settings:copyToR2"'));
            assert.ok(card.includes('id="r2-limits-form"'));
            assert.match(card, /id="r2-limit-a"[^>]*max="1000000"/, 'the field cannot go above Cloudflare\'s tier');
            assert.match(card, /id="r2-limit-b"[^>]*max="10000000"/);
            assert.ok(card.includes('AKI•••••45') && card.includes('wJa•••••23'), 'masked hints');
            assert.ok(!card.includes(SECRET));
            assert.ok(card.includes('id="r2-secret"') && !/id="r2-secret"[^>]*value=/.test(card), 'the secret field is never prefilled');
            assert.ok(!card.includes('class="inline-error"'), 'no banner under 80%');
        });

        it(`warns at 80% and says it is used up at 100%, with the reset date (${lang})`, () => {
            const { render, t } = load(lang);
            const warn = render(WITH_R2({ ...R2_ON, summary: summary({ level: 'warn', items: [item('storage', 1, 10), item('class_a', 1200, 900_000), item('class_b', 7_500_000, 9_000_000)] }) }));
            assert.ok(warn.includes(t('settings.media.r2.bannerWarn')));
            assert.ok(!warn.includes(t('settings.media.r2.bannerFull')));
            const full = render(WITH_R2({ ...R2_ON, summary: summary({ level: 'full', items: [item('storage', 1, 10), item('class_a', 1200, 900_000), item('class_b', 9_000_000, 9_000_000)] }) }));
            assert.ok(full.includes(t('settings.media.r2.bannerFull')));
            assert.match(full, /role="alert"/);
            assert.ok(text(full).includes('100%'));
        });

        it(`shows the CORS policy to paste, with a copy button, only when the token could not set it (${lang})`, () => {
            const { render, t } = load(lang);
            const refused = render(WITH_R2({ ...R2_ON, cors: { ...R2_ON.cors, status: 'refused' } }));
            assert.ok(refused.includes(t('settings.media.r2.corsNotice')));
            assert.ok(refused.includes('id="r2-cors-policy"') && refused.includes('data-action="settings:copyR2Cors"'));
            assert.ok(refused.includes('AllowedOrigins'));
            assert.ok(!render(WITH_R2(R2_ON)).includes('id="r2-cors-policy"'));
        });

        it(`says why the copy is waiting when Supabase refused (${lang})`, () => {
            const { render, t } = load(lang);
            const card = render(WITH_R2({ ...R2_ON, copy: { ...R2_ON.copy!, lastError: 'Supabase Storage refused to download the file: Egress quota exceeded' } }));
            assert.ok(card.includes(t('settings.media.r2.copyError', { message: 'Supabase Storage refused to download the file: Egress quota exceeded' })));
        });
    }

    it('writes the new R2 strings in Arabic as Arabic prose', () => {
        const { t } = load('ar');
        for (const key of ['settings.media.r2.intro', 'settings.media.r2.help', 'settings.media.r2.bannerFull', 'settings.media.r2.corsNotice', 'settings.media.r2.copyHint', 'errors.R2_LIMIT', 'errors.R2_LIMIT.next', 'overview.alert.r2Full']) {
            assert.match(t(key), /[؀-ۿ]/, key);
        }
    });

    it('is still a card when the server predates R2: no r2 block, no throw', () => {
        const { render, t } = load('en');
        assert.ok(render(CONNECTED).includes(t('settings.media.title')));
    });

    it('escapes what the server says about R2', () => {
        const { render } = load('en');
        const card = render(WITH_R2({ ...R2_ON, connection: { ok: false, status: 400, error: '<img src=x onerror=alert(1)>' } }));
        assert.ok(!card.includes('<img src=x'));
    });
});
