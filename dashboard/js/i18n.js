/**
 * i18n — the single place every piece of interface copy lives.
 *
 * ─── Why this file exists ───────────────────────────────────────────────────
 * The product's user is an Arabic-speaking creator. Every piece of *content*
 * in this system is Arabic — DM templates, the AI system prompt, captions,
 * inbound DMs, campaign keywords — while the dashboard used to be an English
 * LTR shell with ~100 English strings hardcoded across ten files. Arabic is now
 * the primary language of the interface; English is the accommodation.
 *
 * ─── Contract ───────────────────────────────────────────────────────────────
 *   I18N.t('campaigns.title')            → the string in the active language
 *   I18N.t('posts.willPublish', { day }) → {placeholders} are substituted
 *   I18N.t('campaigns.count', { count }) → picks campaigns.count_one / _two /
 *                                          _few / _many / _other via
 *                                          Intl.PluralRules. Arabic has six
 *                                          plural categories; English has two,
 *                                          and both come out of the same call.
 *
 * Substituted values are plain strings and are escaped by `html` at the call
 * site exactly like any other interpolation — `t()` never returns markup.
 *
 * ─── Numerals, dates, direction ─────────────────────────────────────────────
 * Arabic-script locales default to Arabic-Indic digits (٠١٢٣) and, for some
 * regions, the Hijri calendar. GCC business software uses Western digits and
 * the Gregorian calendar, so the locale is pinned to `ar-u-nu-latn-ca-gregory`:
 * Arabic month and day names, Latin numerals, Gregorian dates.
 */
const I18N = {
    STORAGE_KEY: 'dashboard_lang',
    DEFAULT: 'ar',

    LANGS: {
        ar: { label: 'العربية', dir: 'rtl', locale: 'ar-u-nu-latn-ca-gregory', htmlLang: 'ar' },
        en: { label: 'English', dir: 'ltr', locale: 'en-US', htmlLang: 'en' },
    },

    lang: 'ar',

    /**
     * Read the stored preference once, at boot. On a FIRST visit there is no
     * preference, so take the language from the browser rather than hardcoding
     * one — an English-speaking operator should not have to find the toggle.
     * Arabic stays the default when the browser asks for neither.
     *
     * index.html runs the same resolution inline, before first paint, so the
     * document is never RTL for a frame on an English machine. This is the
     * fallback for the case where that write failed (private mode).
     */
    fromNavigator() {
        try {
            const prefs = navigator.languages || [navigator.language || ''];
            for (const tag of prefs) {
                const code = String(tag || '').toLowerCase().split('-')[0];
                if (I18N.LANGS[code]) return code;
            }
        } catch { /* no navigator language information */ }
        return null;
    },

    init() {
        let stored = null;
        try { stored = localStorage.getItem(I18N.STORAGE_KEY); } catch { /* private mode */ }
        if (I18N.LANGS[stored]) {
            I18N.lang = stored;
        } else {
            I18N.lang = I18N.fromNavigator() || I18N.DEFAULT;
        }
        I18N.applyDocument();
        return I18N.lang;
    },

    setLang(lang) {
        if (!I18N.LANGS[lang] || lang === I18N.lang) return;
        try { localStorage.setItem(I18N.STORAGE_KEY, lang); } catch { /* private mode */ }
        // A full reload is the honest way to re-render every string, every
        // chart and every date in a no-framework app. It costs one paint.
        location.reload();
    },

    dir() { return I18N.LANGS[I18N.lang].dir; },
    isRtl() { return I18N.dir() === 'rtl'; },
    locale() { return I18N.LANGS[I18N.lang].locale; },

    /** <html lang dir> — the root of the whole RTL layout. */
    applyDocument() {
        const cfg = I18N.LANGS[I18N.lang];
        document.documentElement.lang = cfg.htmlLang;
        document.documentElement.dir = cfg.dir;
    },

    _plural(key, count) {
        try {
            const category = new Intl.PluralRules(I18N.lang).select(count);
            const dict = I18N.strings[I18N.lang] || {};
            if (dict[`${key}_${category}`] !== undefined) return `${key}_${category}`;
            if (dict[`${key}_other`] !== undefined) return `${key}_other`;
        } catch { /* fall through to the bare key */ }
        return key;
    },

    /**
     * Look a string up. Falls back: active language → English → the key
     * itself, so a missing translation is visible in the UI rather than
     * rendering an empty element.
     */
    t(key, params) {
        let lookup = key;
        if (params && typeof params.count === 'number') lookup = I18N._plural(key, params.count);

        const active = I18N.strings[I18N.lang] || {};
        const fallback = I18N.strings.en || {};
        let value = active[lookup];
        if (value === undefined) value = fallback[lookup];
        if (value === undefined) value = active[key] !== undefined ? active[key] : fallback[key];
        if (value === undefined) return key;

        if (!params) return value;
        return String(value).replace(/\{(\w+)\}/g, (match, name) => (
            params[name] === undefined || params[name] === null ? match : String(params[name])
        ));
    },

    /**
     * Translate static markup in index.html: `data-i18n` sets textContent,
     * `data-i18n-attr="aria-label:key,title:key"` sets attributes.
     */
    applyStatic(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n]').forEach((el) => {
            el.textContent = I18N.t(el.getAttribute('data-i18n'));
        });
        scope.querySelectorAll('[data-i18n-attr]').forEach((el) => {
            el.getAttribute('data-i18n-attr').split(',').forEach((pair) => {
                const [attr, key] = pair.split(':').map((s) => s.trim());
                if (attr && key) el.setAttribute(attr, I18N.t(key));
            });
        });
    },
};
/* ═══════════════════════════════════════════════════════════════════════════
   Strings live in i18n.ar.js and i18n.en.js. Each registers itself into this
   shared object whenever it runs — before or after this file — so the order
   the browser happens to execute them in does not matter.
   ═══════════════════════════════════════════════════════════════════════════ */
I18N.strings = (globalThis.I18N_DICT = globalThis.I18N_DICT || {});

/**
 * The `?v=` this file was served with, so a dictionary fetched from here carries the same
 * cache version (check:assets keeps every ref in index.html on one version). Null outside a
 * browser, where the dictionaries are loaded directly.
 */
I18N._version = (() => {
    try {
        const src = typeof document !== 'undefined' && document.currentScript && document.currentScript.src;
        return src ? new URL(src).searchParams.get('v') : null;
    } catch { return null; }
})();

I18N.dictUrl = (lang) => `/dashboard/js/i18n.${lang}.js${I18N._version ? `?v=${encodeURIComponent(I18N._version)}` : ''}`;

/** Resolvers waiting for a dictionary, by language. A dictionary calls the hook when it runs. */
I18N._waiting = Object.create(null);
globalThis.I18N_DICT_LOADED = (lang) => {
    const waiting = I18N._waiting[lang] || [];
    delete I18N._waiting[lang];
    waiting.forEach((resolve) => resolve(true));
};

/**
 * Resolves true once `lang`'s dictionary is registered, false if it could not be fetched.
 *
 * index.html's inline head script normally started this fetch already (a
 * `<script data-i18n-dict>` it inserted while the page was still parsing), so this usually
 * finds the dictionary present or in flight and only waits. It fetches the file itself when
 * nothing did, and once more when the head script's fetch failed.
 */
I18N.load = (lang) => new Promise((resolve) => {
    if (I18N.strings[lang]) { resolve(true); return; }
    let done = false;
    const finish = (ok) => { if (!done) { done = true; resolve(ok); } };
    (I18N._waiting[lang] = I18N._waiting[lang] || []).push(finish);
    if (typeof document === 'undefined') { finish(false); return; }
    let script = document.querySelector(`script[data-i18n-dict="${lang}"]`);
    if (script && script.getAttribute('data-state') === 'failed') {
        script.remove();
        script = null;
    }
    if (!script) {
        script = document.createElement('script');
        script.src = I18N.dictUrl(lang);
        script.setAttribute('data-i18n-dict', lang);
        document.head.appendChild(script);
    }
    script.addEventListener('load', () => finish(!!I18N.strings[lang]));
    script.addEventListener('error', () => finish(false));
});

/**
 * The app boots through this (app.js): decide the language, then wait for its dictionary.
 * An Arabic page whose dictionary will not load falls back to the English one, so the
 * operator reads English words rather than raw keys; `t()` already falls back to English.
 * Memoised, so every caller shares one load.
 */
I18N.ready = () => {
    if (!I18N._ready) {
        try { I18N.init(); } catch { /* no DOM: the language stays the default */ }
        const lang = I18N.lang;
        I18N._ready = I18N.load(lang).then((ok) => {
            if (ok || lang === 'en') return;
            console.error(`i18n: the ${lang} dictionary did not load; showing English.`);
            return I18N.load('en').then(() => undefined);
        });
    }
    return I18N._ready;
};

/** Shorthand used everywhere in the page modules. */
const t = (key, params) => I18N.t(key, params);
