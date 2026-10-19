/**
 * UX F4, "primitives A" (Dashboard UX overhaul, T014-T017 and T027): the error envelope in `api.js`, and in `components.js`
 * `UI.errorText` / `UI.errorHtml`, `UI.statusPill`, the tenant-zone helpers and the bidi-isolated `UI.formatPercent`.
 *
 * Loaded the way buttons.test.ts and charts.test.ts do it: the REAL shipped files (`i18n.js`, both dictionaries, `components.js`,
 * `api.js`) in a `node:vm` context, so these test what ships rather than a copy. The claims a screenshot cannot check:
 *
 *   - a server refusal is read in BOTH envelope shapes, `err.message` stays today's sentence, `err.body.error` never becomes an object;
 *   - `errorText` falls back message-first and never leaves a sentence empty, and the server's own words only reach `details`
 *     once a translated sentence has replaced them; everything is escaped on the way into markup;
 *   - a pill is a glyph, a word and a tone for every state in the data-model vocabulary, in both languages, never a bare colour;
 *   - a datetime-local value is read in the TENANT's zone (not the machine's), either side of a daylight-saving change;
 *   - a percent is a left-to-right isolate, so "46%" cannot become "%46" in an Arabic sentence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;

interface Loaded {
    UI: Json;
    API: Json;
    I18N: Json;
    /** Add strings to a dictionary, the way a parallel PR adds `errors.<code>` keys. */
    strings(lang: 'ar' | 'en', more: Record<string, string>): void;
    sent: Array<{ url: string; method: string }>;
}

const FILES = ['dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/components.js', 'dashboard/js/api.js'];

/** The shared files in a sandbox, in `lang`. `reply` is what `fetch` answers: a status and a raw body (JSON or not). */
function load(lang: 'ar' | 'en' = 'en', reply: { status: number; body: string } = { status: 200, body: '{}' }): Loaded {
    const noop = (): void => {};
    const stubEl = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [],
    };
    const sent: Array<{ url: string; method: string }> = [];
    const ctx: Json = {
        document: {
            ...stubEl,
            createElement: () => ({ ...stubEl }),
            body: { ...stubEl }, head: { ...stubEl },
            documentElement: { ...stubEl, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: () => null, activeElement: null,
        },
        window: { addEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console, setTimeout, clearTimeout,
        requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang },
        localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
        fetch: (url: string, opts: Json) => {
            sent.push({ url, method: (opts && opts.method) || 'GET' });
            return Promise.resolve({ status: reply.status, ok: reply.status >= 200 && reply.status < 300, text: () => Promise.resolve(reply.body) });
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of FILES) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = '${lang}';`, ctx);
    const { UI, API, I18N } = vm.runInContext('({ UI, API, I18N })', ctx) as Json;
    return {
        UI, API, I18N, sent,
        strings: (l, more) => { Object.assign(I18N.strings[l], more); },
    };
}

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const LRI = '⁦';
const FSI = '⁨';
const PDI = '⁩';

/** What `API.request` throws for a refusal with this status and body. */
async function refusal(status: number, body: string, lang: 'ar' | 'en' = 'en'): Promise<{ err: Json; env: Loaded }> {
    const env = load(lang, { status, body });
    let thrown: unknown;
    try { await env.API.request('/anything', { method: 'POST' }); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the request should have been refused');
    return { err: thrown, env };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('api.js: the error envelope (T014)', () => {
    it('reads today\'s shape: the sentence in `error`, a top-level `code`, `params`', async () => {
        const { err } = await refusal(409, JSON.stringify({ error: 'Not retryable.', code: 'JOB_NOT_RETRYABLE', params: { status: 'done' }, extra: 1 }));
        assert.equal(err.message, 'Not retryable.');
        assert.equal(err.status, 409);
        assert.equal(err.code, 'JOB_NOT_RETRYABLE');
        assert.deepEqual(plain(err.params), { status: 'done' });
        assert.equal(err.body.error, 'Not retryable.', 'err.body is what readers written before the envelope expect');
        assert.equal(err.body.extra, 1, 'and keeps every other field');
    });

    it('reads the nested envelope: `{ error: { code, params, message } }`, with `err.body.error` still a sentence', async () => {
        const { err } = await refusal(409, JSON.stringify({ error: { code: 'WINDOW_CLOSED', params: { closedAt: '2026-10-19T08:00:00Z' }, message: 'The 24-hour reply window closed.' } }));
        assert.equal(err.message, 'The 24-hour reply window closed.');
        assert.equal(err.code, 'WINDOW_CLOSED');
        assert.deepEqual(plain(err.params), { closedAt: '2026-10-19T08:00:00Z' });
        assert.equal(typeof err.body.error, 'string', 'a toast that prints err.body.error must not say [object Object]');
        assert.equal(err.body.error, 'The 24-hour reply window closed.');
        assert.equal(err.body.code, 'WINDOW_CLOSED', 'and `err.body.code` is where it always was');
    });

    it('exposes no code and no params for an uncoded refusal, exactly as before', async () => {
        const plainRefusal = (await refusal(400, JSON.stringify({ error: 'Caption is required.' }))).err;
        assert.equal(plainRefusal.message, 'Caption is required.');
        assert.equal(plainRefusal.code, undefined);
        assert.equal(plainRefusal.params, undefined);
        const viaMessage = (await refusal(400, JSON.stringify({ message: 'From message.' }))).err;
        assert.equal(viaMessage.message, 'From message.', '`message` still stands in for `error`');
        assert.equal(viaMessage.code, undefined);
    });

    it('falls back to the status line when the server gave no sentence, and ignores a code that is not a string', async () => {
        const { err, env } = await refusal(502, '<html>Bad gateway</html>');
        assert.equal(err.message, env.I18N.t('http.5xx', { status: 502 }));
        assert.equal(err.code, undefined);
        const nested = await refusal(400, JSON.stringify({ error: { code: 'NO_SENTENCE', params: { a: 1 } } }));
        assert.equal(nested.err.message, nested.env.I18N.t('http.400'), 'an envelope with no message gets the status line');
        assert.equal(nested.err.code, 'NO_SENTENCE');
        const odd = (await refusal(400, JSON.stringify({ error: 'x', code: 42, params: [1, 2] }))).err;
        assert.equal(odd.code, undefined, 'a numeric code is not a code');
        assert.equal(odd.params, undefined, 'and an array is not params');
    });

    it('keeps the profile-incomplete path: a top-level PROFILE_INCOMPLETE is still answered in the person\'s language', async () => {
        const { err, env } = await refusal(409, JSON.stringify({ code: 'PROFILE_INCOMPLETE', error: 'Profile incomplete.', missing: ['voice.tone'], agent: 'dm' }));
        assert.equal(err.message, env.I18N.t('profileAsk.refused'));
        assert.equal(err.code, 'PROFILE_INCOMPLETE');
    });

    it('readError is pure: both shapes, and anything else is empty', () => {
        const { API } = load();
        assert.deepEqual(plain({ ...API.readError({ error: { code: 'A', message: 'm', params: { x: 1 } } }), flat: undefined }), { message: 'm', code: 'A', params: { x: 1 } });
        assert.deepEqual(plain({ ...API.readError({ error: 'm', code: 'B' }), flat: undefined }), { message: 'm', code: 'B', params: null });
        for (const body of [null, undefined, 'text', 7, [], {}]) {
            const read = API.readError(body);
            assert.equal(read.message, '');
            assert.equal(read.code, '');
            assert.equal(read.params, null);
        }
    });
});

describe('UI.errorText (T015)', () => {
    it('says the catalogue\'s sentence and next step for a known code, with the server\'s words and the code behind "details"', () => {
        const { UI, strings } = load('en');
        strings('en', {
            'errors.TEST_WINDOW': 'The reply window closed for {name}.',
            'errors.TEST_WINDOW.next': 'Reply from the Instagram app instead.',
        });
        const out = plain(UI.errorText({ message: 'The 24-hour reply window closed…', code: 'TEST_WINDOW', status: 409, params: { name: 'Sara' } }));
        assert.equal(out.sentence, `The reply window closed for ${FSI}Sara${PDI}.`, 'a param is isolated so a Latin value cannot reorder an Arabic sentence');
        assert.equal(out.next, 'Reply from the Instagram app instead.');
        assert.equal(out.details, 'The 24-hour reply window closed…\nTEST_WINDOW (HTTP 409)');
    });

    it('translates into Arabic when the Arabic dictionary has the key, and into English otherwise', () => {
        const { UI, strings } = load('ar');
        strings('en', { 'errors.TEST_BOTH': 'English sentence.' });
        strings('ar', { 'errors.TEST_BOTH': 'جملة عربية.', 'errors.TEST_BOTH.next': 'جرّب لاحقاً.' });
        strings('en', { 'errors.TEST_ONLY_EN': 'English only.' });
        const both = plain(UI.errorText({ message: 'raw', code: 'TEST_BOTH' }));
        assert.equal(both.sentence, 'جملة عربية.');
        assert.equal(both.next, 'جرّب لاحقاً.');
        assert.equal(plain(UI.errorText({ message: 'raw', code: 'TEST_ONLY_EN' })).sentence, 'English only.', 'the dictionary\'s own English fallback');
    });

    it('falls back to today\'s message when the key is missing: the sentence IS the server\'s text, so details hold only the code', () => {
        const { UI } = load('en');
        const out = plain(UI.errorText({ message: 'Caption must name every column.', code: 'NOT_IN_ANY_CATALOGUE', status: 400 }));
        assert.equal(out.sentence, 'Caption must name every column.');
        assert.equal(out.next, '');
        assert.equal(out.details, 'NOT_IN_ANY_CATALOGUE (HTTP 400)');
        const uncoded = plain(UI.errorText({ message: 'Plain refusal.', status: 400 }));
        assert.deepEqual(uncoded, { sentence: 'Plain refusal.', next: '', details: '' }, 'nothing is folded away when there is nothing to fold');
    });

    it('falls back to a generic sentence when there is no message at all, and never returns an empty one', () => {
        const { UI, I18N } = load('en');
        const generic = I18N.t('common.error');
        for (const input of [new Error(''), { message: '   ' }, {}, null, undefined, '', { code: 'UNKNOWN_CODE_X' }]) {
            const out = plain(UI.errorText(input));
            assert.equal(out.sentence, generic, JSON.stringify(input));
            assert.equal(out.next, '');
        }
        assert.equal(plain(UI.errorText('A bare string')).sentence, 'A bare string', 'a string is its own message');
    });

    it('does not repeat the server\'s text in details when the sentence is the same text, and ignores params that are not scalars', () => {
        const { UI, strings } = load('en');
        strings('en', { 'errors.TEST_SAME': 'Same words.' });
        assert.equal(plain(UI.errorText({ message: 'Same words.', code: 'TEST_SAME' })).details, 'TEST_SAME', 'only the code');
        strings('en', { 'errors.TEST_P': 'a={a} b={b}' });
        const out = plain(UI.errorText({ message: 'm', code: 'TEST_P', params: { a: 5, b: { nested: true }, c: ['x'] } }));
        assert.equal(out.sentence, `a=${FSI}5${PDI} b={b}`, 'an object is dropped, so its placeholder stays visible rather than saying [object Object]');
    });

    it('keeps `count` a number, so a plural family picks its form', () => {
        const { UI, strings } = load('en');
        strings('en', { 'errors.TEST_COUNT_one': 'One item is left.', 'errors.TEST_COUNT_other': '{count} items are left.' });
        assert.equal(plain(UI.errorText({ message: 'm', code: 'TEST_COUNT', params: { count: 1 } })).sentence, 'One item is left.');
        assert.equal(plain(UI.errorText({ message: 'm', code: 'TEST_COUNT', params: { count: 3 } })).sentence, '3 items are left.');
    });

    it('answers a code that is an Object.prototype name with the fallback, not with a function', () => {
        const { UI } = load('en');
        for (const code of ['constructor', '__proto__', 'toString']) {
            const out = plain(UI.errorText({ message: 'Server text.', code }));
            assert.equal(out.sentence, 'Server text.', code);
        }
    });
});

describe('UI.errorHtml (T015)', () => {
    it('renders the sentence, the next step and a collapsed native Details, all escaped', () => {
        const { UI, I18N, strings } = load('en');
        strings('en', { 'errors.TEST_HTML': 'It <b>failed</b> for {who}.', 'errors.TEST_HTML.next': 'Try "again" & wait.' });
        const out = String(UI.errorHtml({ message: '<img src=x onerror=alert(1)>', code: 'TEST_HTML', status: 500, params: { who: '<script>' } }));
        assert.ok(out.includes('<details class="error-details">'), 'native disclosure, collapsed (no `open`)');
        assert.ok(!/<details[^>]*\sopen/.test(out));
        assert.ok(out.includes(`<summary>${I18N.t('error.details')}</summary>`));
        assert.ok(!out.includes('<img') && !out.includes('<script>') && !out.includes('<b>'), 'no raw markup survives');
        assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'), 'the server text is in Details, escaped');
        assert.ok(out.includes('It &lt;b&gt;failed&lt;/b&gt; for'), 'the catalogue sentence is escaped as well');
        assert.ok(out.includes('Try &quot;again&quot; &amp; wait.'));
        assert.ok(out.includes('dir="auto"'), 'the server\'s English can sit left to right in an Arabic page');
    });

    it('shows no Details when there is nothing behind the sentence, and no next step when there is none', () => {
        const { UI } = load('en');
        const out = String(UI.errorHtml({ message: 'Plain refusal.' }));
        assert.ok(out.includes('Plain refusal.'));
        assert.ok(!out.includes('<details'), 'no empty disclosure');
        assert.ok(!out.includes('error-next'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────

/** The vocabulary of specs/001-dashboard-ux/data-model.md, "StatusPill vocabulary": family → state → tone. Written out here, not read from the code. */
const VOCABULARY: Record<string, Record<string, string>> = {
    post: { scheduled: 'info', publishing: 'info', processing: 'info', needs_you: 'accent', held: 'warning', overdue: 'warning', failed: 'danger', live: 'success', archived: 'neutral' },
    campaign: { live: 'success', dormant: 'warning', failing: 'danger', paused: 'neutral', ended: 'neutral', archived: 'neutral' },
    content: { making: 'info', review: 'accent', scheduled: 'info', posted: 'success', failed: 'danger' },
    connection: { fine: 'success', expiring: 'warning', broken: 'danger', not_set_up: 'neutral' },
    assistant: { on: 'success', off: 'neutral', paused_here: 'neutral', sales_test: 'info', sales_live: 'success' },
};
const BUSY = new Set(['post.publishing', 'post.processing', 'content.making']);
const TONE_CLASS: Record<string, string> = { success: 'badge-success', info: 'badge-info', warning: 'badge-warning', danger: 'badge-danger', neutral: 'badge-neutral', accent: 'badge-accent' };
/** The tags out, the words left. */
const words = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, '').replace(/&#39;/g, '\'').trim();

describe('UI.statusPill (T016)', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`draws every family and state as a glyph, a word and a tone (${lang})`, () => {
            const { UI, I18N } = load(lang);
            const glyphByTone = new Map<string, Set<string>>();
            for (const [family, states] of Object.entries(VOCABULARY)) {
                for (const [state, tone] of Object.entries(states)) {
                    const key = `status.${family}.${state}`;
                    const word = I18N.t(key);
                    assert.notEqual(word, key, `${key} is in the ${lang} dictionary`);
                    const out = String(UI.statusPill(family, state));
                    assert.ok(out.startsWith('<span class="status-pill '), key);
                    assert.ok(out.includes(`class="status-pill ${TONE_CLASS[tone]}"`), `${key}: tone ${tone}`);
                    assert.ok(out.includes(`data-tone="${tone}"`), key);
                    assert.ok(out.includes(`data-status="${family}.${state}"`), key);
                    // Glyph + word, the glyph hidden from a screen reader so the word is the name.
                    const glyph = /<span class="status-pill-glyph[^"]*" aria-hidden="true">([^<]+)<\/span>/.exec(out);
                    assert.ok(glyph, `${key} has an aria-hidden glyph`);
                    assert.ok(glyph![1]!.length >= 1 && !/\p{Letter}|\p{Number}/u.test(glyph![1]!), `${key}: the glyph is a shape, not text`);
                    assert.equal(words(out), `${glyph![1]}${word}`, `${key}: the pill says the glyph then the word and nothing else`);
                    assert.equal(out.includes('is-busy'), BUSY.has(`${family}.${state}`), `${key}: only in-progress states pulse`);
                    if (!glyphByTone.has(tone)) glyphByTone.set(tone, new Set());
                    glyphByTone.get(tone)!.add(glyph![1]!);
                }
            }
            // Colour is never the only signal: danger, warning and neutral each have a glyph no success state uses.
            const successGlyphs = glyphByTone.get('success')!;
            for (const tone of ['danger', 'warning', 'neutral']) {
                for (const g of glyphByTone.get(tone)!) assert.ok(!successGlyphs.has(g), `${tone} shares its glyph "${g}" with success`);
            }
            assert.deepEqual([...glyphByTone.get('danger')!], ['✕']);
            assert.deepEqual([...glyphByTone.get('warning')!], ['▲']);
        });
    }

    it('has a label for every state in the code in both dictionaries, and no state in the code outside the data-model vocabulary', () => {
        const { UI, I18N } = load('en');
        const inCode = plain(Object.fromEntries(Object.entries(UI.STATUS_PILLS).map(([family, rows]) => [family, Object.keys(rows as object).sort()])));
        const inSpec = Object.fromEntries(Object.entries(VOCABULARY).map(([family, rows]) => [family, Object.keys(rows).sort()]));
        assert.deepEqual(inCode, inSpec);
        for (const lang of ['ar', 'en']) {
            const dict = I18N.strings[lang] as Record<string, string>;
            for (const [family, rows] of Object.entries(VOCABULARY)) {
                for (const state of Object.keys(rows)) assert.ok(dict[`status.${family}.${state}`], `${lang} status.${family}.${state}`);
            }
        }
    });

    it('takes a label option as the word, reads the state in lower case, and says what to do in the title when the dictionary has a hint', () => {
        const { UI, I18N } = load('en');
        const custom = String(UI.statusPill('post', 'failed', { label: '3 failed' }));
        assert.equal(words(custom), '✕3 failed');
        assert.ok(custom.includes('badge-danger'), 'a label changes the word, not the tone');
        assert.equal(words(UI.statusPill('post', 'LIVE')), `●${I18N.t('status.post.live')}`);
        const held = String(UI.statusPill('post', 'held'));
        assert.ok(held.includes(`title="${I18N.t('status.post.held.hint')}"`), 'held says what it means and what to do');
        assert.ok(!String(UI.statusPill('post', 'live')).includes('title='), 'a state with no hint carries no title');
        assert.ok(String(UI.statusPill('post', 'needs_you')).includes('badge-accent'));
    });

    it('draws an unknown family or state neutral, as written and escaped, never as a success and never as nothing', () => {
        const { UI } = load('en');
        for (const [family, state] of [['post', 'exploded'], ['mystery', 'live'], ['constructor', 'live'], ['post', 'constructor'], ['post', '__proto__']]) {
            const out = String(UI.statusPill(family, state));
            assert.ok(out.includes('badge-neutral'), `${family}.${state} is neutral`);
            assert.ok(!out.includes('badge-success'), `${family}.${state} is not a success`);
            assert.equal(words(out), `○${state}`, `${family}.${state} says its state as written, after the hollow glyph`);
        }
        assert.equal(words(UI.statusPill('post', '')), '○—');
        assert.equal(words(UI.statusPill('post', null)), '○—');
    });

    it('escapes everything it was given: the state, the family and the label', () => {
        const { UI } = load('en');
        const out = String(UI.statusPill('<i>fam</i>', '"><script>alert(1)</script>', { label: '<b>x</b>' }));
        assert.ok(!out.includes('<script>') && !out.includes('<i>') && !out.includes('<b>'));
        assert.ok(out.includes('&lt;b&gt;x&lt;/b&gt;'));
        assert.ok(!/data-status="[^"]*"[^>]*"><script/.test(out), 'nothing breaks out of the attribute');
        const unlabelled = String(UI.statusPill('post', '<script>alert(1)</script>'));
        assert.ok(!unlabelled.includes('<script>') && unlabelled.includes('&lt;script&gt;'));
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('the tenant zone (T017)', () => {
    it('shows the browser\'s zone until a screen says the tenant\'s, ignores a zone it cannot read, and forgets on ""', () => {
        const { UI } = load('en');
        const device = UI.deviceZone();
        assert.equal(UI.zone(), device, 'unset: the browser\'s zone, as before');
        assert.equal(UI.setZone('Asia/Riyadh'), 'Asia/Riyadh');
        assert.equal(UI.zone(), 'Asia/Riyadh');
        assert.equal(UI.setZone('Mars/Olympus'), '', 'not a zone: unset, not a half-state');
        assert.equal(UI.zone(), device);
        UI.setZone('Europe/London');
        assert.equal(UI.setZone(''), '');
        assert.equal(UI.zone(), device, 'a tenant switch can forget it');
        for (const bad of [null, undefined, 42, {}]) assert.equal(UI.setZone(bad), '');
    });

    it('lets a screen pass the zone it has just read: a valid candidate wins, an invalid one is ignored', () => {
        const { UI } = load('en');
        UI.setZone('Asia/Riyadh');
        assert.equal(UI.zone('America/New_York'), 'America/New_York');
        assert.equal(UI.zone('Mars/Olympus'), 'Asia/Riyadh');
        assert.equal(UI.zone(''), 'Asia/Riyadh');
    });

    it('reads a datetime-local value in the zone, whatever zone this machine is in: Asia/Riyadh, no daylight saving', () => {
        const { UI } = load('en');
        assert.equal(UI.zoneInput('2030-01-15T20:30', 'Asia/Riyadh'), '2030-01-15T17:30:00.000Z');
        assert.equal(UI.zoneInput('2030-07-15T20:30', 'Asia/Riyadh'), '2030-07-15T17:30:00.000Z', 'the same offset in July');
        UI.setZone('Asia/Riyadh');
        assert.equal(UI.zoneInput('2030-01-15T20:30'), '2030-01-15T17:30:00.000Z', 'no zone argument: the tenant\'s');
        assert.equal(UI.zoneInputValue('2030-01-15T17:30:00.000Z'), '2030-01-15T20:30');
        assert.equal(UI.zoneInputValue(new Date('2030-01-15T21:05:00.000Z')), '2030-01-16T00:05', 'a Date, past midnight there');
    });

    it('reads it correctly either side of a daylight-saving change (America/New_York, 2030-03-10 and 2030-11-03)', () => {
        const { UI } = load('en');
        const ny = 'America/New_York';
        assert.equal(UI.zoneInput('2030-03-09T12:00', ny), '2030-03-09T17:00:00.000Z', 'EST, the day before');
        assert.equal(UI.zoneInput('2030-03-10T12:00', ny), '2030-03-10T16:00:00.000Z', 'EDT, the day of');
        assert.equal(UI.zoneInput('2030-03-10T01:30', ny), '2030-03-10T06:30:00.000Z', 'before the jump');
        assert.equal(UI.zoneInput('2030-11-03T12:00', ny), '2030-11-03T17:00:00.000Z', 'EST again');
        for (const [iso, zone] of [
            ['2030-01-15T17:30:00.000Z', 'Asia/Riyadh'], ['2030-07-04T23:00:00.000Z', ny], ['2030-12-31T21:00:00.000Z', 'Europe/London'],
            ['2030-03-10T06:59:00.000Z', ny], ['2030-03-10T07:00:00.000Z', ny], ['2030-11-03T05:30:00.000Z', ny], ['2030-06-01T18:45:00.000Z', 'Asia/Kolkata'],
        ] as const) {
            assert.equal(UI.zoneInput(UI.zoneInputValue(iso, zone), zone), iso, `${zone} ${iso} round trip`);
        }
        const inTheGap = UI.zoneInput('2030-03-10T02:30', ny);
        assert.ok(inTheGap && Math.abs(Date.parse(inTheGap) - Date.parse('2030-03-10T07:30:00.000Z')) <= 3600000, 'a wall time that does not exist lands within the hour, not on NaN');
    });

    it('says null for what is not a datetime-local value, and "" for what is not a time', () => {
        const { UI } = load('en');
        for (const bad of ['', 'tomorrow', null, undefined]) assert.equal(UI.zoneInput(bad, 'Asia/Riyadh'), null, String(bad));
        assert.equal(UI.zoneInput('2030-02-31T25:99', 'Asia/Riyadh'), null, 'an impossible date is not an instant');
        for (const bad of ['', 'nope', null, undefined]) assert.equal(UI.zoneInputValue(bad, 'Asia/Riyadh'), '', String(bad));
    });

    it('formats in the zone, 24-hour by default, with a studio-style override that keeps the locale\'s clock', () => {
        const { UI } = load('en');
        UI.setZone('Asia/Riyadh');
        assert.match(UI.zoneTime('2030-01-15T21:05:00.000Z'), /00:05/, 'past midnight in Riyadh, 24-hour');
        assert.match(UI.zoneTime('2030-01-15T21:05:00.000Z', { zone: 'America/New_York' }), /16:05/, 'a zone option overrides the tenant\'s for one call');
        assert.equal(UI.zoneTime('garbage'), '');
        assert.equal(UI.zoneTime(null), '');
        const studio = UI.zoneTime('2026-09-26T18:00:00.000Z', { hour: 'numeric', hourCycle: undefined });
        const expected = new Intl.DateTimeFormat('en-US', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Riyadh' }).format(new Date('2026-09-26T18:00:00.000Z'));
        assert.equal(studio, expected, 'exactly what studio.js\'s own zoneTime produced before it moved');
        assert.ok(studio.includes('9:00 PM'));
    });

    it('names the city in the interface language when the dictionary has it, else from the zone, else for the tenant\'s own', () => {
        const en = load('en');
        assert.equal(en.UI.zoneCity('Asia/Riyadh'), 'Riyadh');
        assert.equal(en.UI.zoneCity('Asia/Tokyo'), 'Tokyo');
        assert.equal(en.UI.zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
        assert.equal(en.UI.zoneCity('UTC'), 'UTC');
        assert.equal(en.UI.zoneCity(''), 'UTC', 'an explicit empty zone is UTC, as the Monteur read it');
        en.UI.setZone('Asia/Dubai');
        assert.equal(en.UI.zoneCity(), 'Dubai', 'no argument: the tenant\'s zone');
        const ar = load('ar');
        assert.equal(ar.UI.zoneCity('Asia/Riyadh'), 'الرياض');
    });

    it('keeps formatDateTime exactly as it was for every existing call site, and adds weekday and city only on request', () => {
        const { UI } = load('en');
        const iso = '2030-01-17T16:00:00.000Z';
        const before = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
        assert.equal(UI.formatDateTime(iso), before, 'no options: the browser\'s zone, no weekday, no city');
        assert.equal(UI.formatDateTime(iso, {}), before);
        assert.equal(UI.formatDateTime(iso, { weekday: false, zone: false }), before);
        assert.equal(UI.formatDateTime(null), '—');
        UI.setZone('Asia/Riyadh');
        const full = UI.formatDateTime(iso, { weekday: true, zone: true });
        assert.match(full, /^Thu, Jan 17, 2030, 19:00 \(Riyadh\)$/, 'weekday, the tenant\'s wall time, and which zone it is');
        assert.match(UI.formatDateTime(iso, { weekday: 'long', zone: 'Asia/Dubai' }), /^Thursday, .*, 20:00 \(Dubai\)$/);
        assert.match(UI.formatDateTime(iso, { weekday: true }), /^Thu, /, 'weekday alone does not move the zone or add a city');
        assert.ok(!UI.formatDateTime(iso, { weekday: true }).includes('('));
        assert.equal(UI.formatDateTime('nope', { weekday: true, zone: true }), '—', 'a non-time stays a dash, with no orphan city');
        const ar = load('ar');
        ar.UI.setZone('Asia/Riyadh');
        const arFull = ar.UI.formatDateTime(iso, { weekday: true, zone: true });
        assert.ok(arFull.endsWith('(الرياض)'), arFull);
        assert.ok(/19:00/.test(arFull), 'Latin digits (DESIGN.md §5)');
    });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('UI.formatPercent (T027): a left-to-right isolate', () => {
    for (const lang of ['ar', 'en'] as const) {
        it(`wraps the value in U+2066 … U+2069 so the sign stays on the number (${lang})`, () => {
            const { UI } = load(lang);
            assert.equal(UI.formatPercent(46), `${LRI}46%${PDI}`);
            assert.equal(UI.formatPercent(0), `${LRI}0%${PDI}`);
            assert.equal(UI.formatPercent(100), `${LRI}100%${PDI}`);
            assert.equal(UI.formatPercent(12.5), `${LRI}12.5%${PDI}`);
            assert.equal(UI.formatPercent(-3), `${LRI}${UI.formatNumber(-3)}%${PDI}`, 'the locale writes its own minus; it stays inside the isolate');
            assert.ok(UI.formatPercent(-3).includes('3%'));
            assert.equal(UI.formatPercent('72'), `${LRI}72%${PDI}`, 'a numeric string, as the API sends some');
            assert.equal(UI.formatPercent(1234), `${LRI}${UI.formatNumber(1234)}%${PDI}`, 'digits grouped by the locale, still one isolate');
        });
    }

    it('says a dash, with no isolate around it, for a value that is not a number', () => {
        const { UI } = load('ar');
        for (const bad of [undefined, NaN, 'abc', Infinity, {}]) assert.equal(UI.formatPercent(bad), '—', String(bad));
    });

    it('goes through t() into an Arabic sentence as one isolated run, and a sentence with two percents isolates each', () => {
        const { UI, I18N } = load('ar');
        const sentence = I18N.t('profileCard.title', { pct: UI.formatPercent(46) });
        assert.ok(sentence.includes(`${LRI}46%${PDI}`), sentence);
        const two = I18N.t('profileCard.meter', { pct: UI.formatPercent(46) });
        assert.ok(two.includes(`${LRI}46%${PDI}`));
        const both = `${UI.formatPercent(1)} / ${UI.formatPercent(2)}`;
        assert.equal((both.match(/⁦/g) || []).length, 2);
        assert.equal((both.match(/⁩/g) || []).length, 2);
    });

    it('is the only place a percent is isolated: no call site wraps formatPercent a second time', () => {
        const files = ['dashboard/js/charts.js', 'dashboard/js/pages/overview.js', 'dashboard/js/pages/analytics.js', 'dashboard/js/pages/inbox.js', 'dashboard/js/pages/ai_settings.js'];
        for (const f of files) {
            const src = readFileSync(f, 'utf8');
            assert.ok(!/\\u2066\$\{[^}]*formatPercent/.test(src), `${f} wraps formatPercent in its own isolate`);
            assert.ok(!/formatPercent\([^)]*\)\}\\u2069/.test(src), `${f} closes an isolate it did not open`);
        }
        assert.ok(readFileSync('dashboard/js/pages/overview.js', 'utf8').includes('const shown = UI.formatPercent(percent);'), 'the profile card uses it as it comes');
    });
});

describe('the one-section rule', () => {
    it('keeps the new primitives in ONE headed section of components.js, between the date helpers and nextCronRun', () => {
        const src = readFileSync('dashboard/js/components.js', 'utf8');
        const heads = src.match(/═══ UX F4 · Primitives A/g) || [];
        assert.equal(heads.length, 1);
        const at = src.indexOf('═══ UX F4 · Primitives A');
        assert.ok(src.lastIndexOf('fromLocalInputValue(value) {', at) > 0 && src.lastIndexOf('fromLocalInputValue(value) {', at) < at, 'after the formatting helpers');
        assert.ok(src.indexOf('nextCronRun(fromIso) {') > at, 'and before the rest');
        for (const name of ['errorText(err) {', 'errorHtml(err) {', 'statusPill(family, state, opts) {', 'zone(candidate) {', 'zoneTime(value, opts) {', 'zoneCity(zone) {', 'zoneInput(value, zone) {', 'setZone(zone) {']) {
            assert.equal(src.split(name).length - 1, 1, `${name} is defined once`);
            assert.ok(src.indexOf(name) > at, `${name} sits inside the section`);
        }
    });
});
