/**
 * The video library inside the "Meta vision (beta)" card (docs/specs/005-muse-sees T057): what the agent remembers of each reel the owner published, the "Index my reels"
 * button with what it costs, and the details of one reel.
 *
 * The REAL `ai_settings.js` and `api.js` in the shared `node:vm` harness, in both languages where the words are the claim, with `API` answering only what a test names. There is no
 * layout and no real DOM: the section's elements are the harness's fakes, registered by id, and what is driven is what the page writes to them (`innerHTML`, `textContent`,
 * classes, `disabled`). The answers the page reads are, in the last group, the ones the server's own code gives (`listLibrary`, `getLibraryRow`, the route's 202), so the card and
 * the routes cannot drift apart in a field name. What only a browser can show (the list at phone width, RTL rows) is for the live check after the merge.
 *
 * Pinned, because a screenshot cannot show it:
 *   - **who sees it**: the owner's alone (the routes are the owner's, reads included): an operator or a viewer is shown no section and the page asks for nothing;
 *   - **the button**: live only while the SAVED memory switch is on (an unsaved toggle does not count: the server reads what is saved), once at a time, with what it costs said
 *     beside it, and the answer said in words (how many were queued, or why none), the 409s each in their own sentence;
 *   - **the list**: one row a reel with its state, date, hook and summary, or why it could not be watched; counts; a refresh that fails keeps the list; polled while a reel waits,
 *     never forever, and never after the page was left;
 *   - **the details**: opened and closed, loaded each time, every part drawn only when there is something in it, the moments as the m:ss the assistant says;
 *   - **a reel's words are text**: a summary or a narration that holds markup is shown as characters, never drawn.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installWorld, type World } from '../services/perception/testing/testSupport.js';
import { getLibraryRow, listLibrary } from '../services/perception/reelLibrary.js';
import { watchFrom } from '../services/perception/text.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

type Role = 'owner' | 'operator' | 'viewer';
type Lang = 'ar' | 'en';

const SARA = '17841400000000001';
const TENANT = '44444444-4444-4444-8444-444444444444';

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const tagsOf = (markup: unknown): string[] => [...String(markup).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The card's ids the page reads and writes, library included. */
const IDS = [
    'muse-card', 'muse-dm-media', 'muse-voice', 'muse-memory', 'muse-who', 'muse-daily-usd', 'muse-save-btn', 'muse-picker-open', 'muse-picker-search',
    'muse-error', 'muse-status', 'muse-people-block', 'muse-everyone-note', 'muse-people-list', 'muse-who-hint', 'muse-cap-hint', 'muse-spent',
    'muse-unsaved-note', 'muse-picker', 'muse-picker-note', 'muse-picker-list',
    'muse-library', 'muse-index-btn', 'muse-library-refresh', 'muse-library-estimate', 'muse-library-hint', 'muse-library-notice', 'muse-library-count', 'muse-library-list',
];

/** The `muse` block the server answers with. */
function view(over: Json = {}): Json {
    return {
        switches: { dm_media: true, voice: false, memory: true },
        allowSenders: [SARA],
        dailyUsd: 3,
        spentToday: 0.4,
        keyReady: true,
        route: { provider: 'meta', model: 'muse-spark-1.3' },
        people: [{ id: SARA, username: 'sara_dev', name: 'Sara Dev' }],
        limits: { dailyUsdMax: 50, dailyUsdDefault: 3, allowSendersMax: 50 },
        ...over,
    };
}

let rowNo = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++rowNo).padStart(12, '0')}`;

/** One entry of `GET /library`, as the route answers it. */
function item(over: Json = {}): Json {
    const id = over.id ?? uuid();
    return {
        id, ig_media_id: `ig${rowNo}`, permalink: `https://www.instagram.com/reel/${id.slice(-8)}/`, youtube_url: null, posted_at: '2026-10-20T10:00:00.000Z', status: 'ok',
        summary: 'Docker volumes keep a container\'s data after it stops.', hook_score: 8, error: null, model: 'meta-models/muse-spark-open-1026', usd: 0.021594, updated_at: '2026-10-30T08:00:00.000Z', ...over,
    };
}

/** The `result` of one reel, as `GET /library/:id` answers it. */
const RESULT = (over: Json = {}): Json => ({
    summary: 'Docker volumes keep a container\'s data after it stops, shown with docker run -v.',
    topics: ['docker', 'volumes'], seen_on_screen: ['docker run -v data:/app', 'a whale logo'],
    narration: 'First line of speech.\nSecond line of speech.',
    key_moments: [{ second: 7, what: 'the -v flag' }, { second: 65, what: 'data is still there after a restart' }],
    hook_first_3s: 'A terminal and a question.', hook_score: 8, caption_ar: 'وين راحت بياناتي؟', cover_second: 12.5, cover_reason: 'The command and the whale are both visible.', ...over,
});

interface Opened {
    h: Dashboard;
    page: Json;
    calls: Array<{ name: string; args: Json[] }>;
    toasts: Array<{ message: string; type?: string }>;
    el: (id: string) => Json;
    t: Dashboard['t'];
    /** The library the next `getMuseLibrary` answers; change it between asks. */
    answers: { library: Json[] | Error; reel: Json | Error | ((id: string) => Json); index: Json | Error; reindex: Json | Error };
}

/** The page with the card's elements mounted and the card adopted. `rows` is what the library first answers. */
async function open(setup: { lang?: Lang; role?: Role; view?: Json | null; rows?: Json[]; wait?: boolean; skipAdopt?: boolean } = {}): Promise<Opened> {
    const role = setup.role ?? 'owner';
    const calls: Array<{ name: string; args: Json[] }> = [];
    const answers: Opened['answers'] = { library: setup.rows ?? [], reel: RESULT(), index: { queued: 0, already_indexed: 0, deduped: 0, listed: 0, truncated: false }, reindex: { queued: true } };
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push({ name, args }); return fn(...args); };
    const give = (value: unknown, ...args: Json[]) => {
        const v = typeof value === 'function' ? (value as (...a: Json[]) => unknown)(...args) : value;
        return v instanceof Error ? Promise.reject(v) : Promise.resolve(plain(v));
    };
    const api: Json = {
        token: 't',
        getAiSettings: record('getAiSettings', async () => ({ is_active: true, muse: setup.view === undefined ? view() : setup.view })),
        getMuseLibrary: record('getMuseLibrary', () => give(answers.library)),
        getMuseReel: record('getMuseReel', (id: string) => give(answers.reel, id)),
        indexMuseLibrary: record('indexMuseLibrary', () => give(answers.index)),
        reindexMuseReel: record('reindexMuseReel', (id: string) => give(answers.reindex, id)),
    };
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: { currentTheme: () => 'auto', navigate: () => {}, isAdmin: () => false, canOperate: () => role !== 'viewer', canAdminister: () => role === 'owner' },
    };
    const h = loadDashboard({ lang: setup.lang ?? 'en', files: ['dashboard/js/pages/ai_settings.js'], globals });
    const toasts: Array<{ message: string; type?: string }> = [];
    h.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    for (const id of IDS) h.el(id);
    for (const id of ['muse-people-block', 'muse-everyone-note', 'muse-who-hint', 'muse-cap-hint', 'muse-unsaved-note', 'muse-picker', 'muse-library', 'muse-library-hint', 'muse-library-notice']) h.el(id).classes.add('hidden');
    // What the page logs when a request fails is what these tests make fail on purpose: it is not output for the run.
    h.ctx.console = Object.assign(Object.create(console), { error: () => undefined });
    const page: Json = h.run('AiSettingsPage');
    if (!setup.skipAdopt) page.adoptMuse(setup.view === undefined ? view() : setup.view);
    if (setup.wait !== false) await settle();
    return { h, page, calls, toasts, el: (id) => h.el(id), t: h.t, answers };
}

const called = (o: Opened, name: string): Array<{ name: string; args: Json[] }> => o.calls.filter((c) => c.name === name);
const hidden = (o: Opened, id: string): boolean => o.el(id).classes.has('hidden');
/** The list's rows, each as its own markup: split where a reel starts, because the details of one hold list items of their own. */
const rowsOf = (o: Opened): string[] => String(o.el('muse-library-list').innerHTML).split('<li class="muse-reel"').slice(1).map((chunk) => `<li class="muse-reel"${chunk}`);
const notice = (o: Opened): string => text(o.el('muse-library-notice').textContent);
const press = async (o: Opened, action: () => unknown): Promise<void> => { await action(); await settle(); };

// ─── Who sees it, and when it asks ───────────────────────────────────────────────────────────────────────────────────────

describe('video library: who sees it, and what it asks', () => {
    it('is the owner\'s section: shown once the card is ready, and the list is asked for ONCE', async () => {
        const o = await open({ rows: [item()] });
        assert.ok(!hidden(o, 'muse-library'));
        assert.equal(called(o, 'getMuseLibrary').length, 1);
        assert.equal(o.page._museLib.status, 'ready');
        assert.equal(rowsOf(o).length, 1);
    });

    for (const role of ['operator', 'viewer'] as const) {
        it(`is not drawn for ${role}, who is refused by every route of it: nothing is asked for and the section stays hidden`, async () => {
            const o = await open({ role, rows: [item()] });
            assert.ok(hidden(o, 'muse-library'));
            assert.deepEqual(called(o, 'getMuseLibrary'), []);
            assert.equal(o.el('muse-library-list').innerHTML, '');
            // Nor can a handler of it be driven by hand.
            await o.page.museIndexAll(o.el('muse-index-btn'));
            await o.page.museReindexReel(o.page.museLibState().rows[0]?.id ?? '');
            await o.page.museToggleReel(uuid());
            assert.deepEqual(o.calls.filter((c) => /Muse(Library|Reel)|indexMuse|reindexMuse/.test(c.name)), []);
        });
    }

    it('is not asked for while the card could not load or the server has no card, and is hidden then', async () => {
        for (const v of [null, undefined]) {
            const o = await open({ view: v, skipAdopt: true });
            o.page.adoptMuse(v);
            await settle();
            assert.ok(hidden(o, 'muse-library'), String(v));
            assert.deepEqual(called(o, 'getMuseLibrary'), [], String(v));
        }
    });

    it('is not asked for again when the card is saved or redrawn: once per visit, and again on Refresh', async () => {
        const o = await open({ rows: [item()] });
        o.page.adoptMuse(view(), true);
        o.page.paintMuse();
        await settle();
        assert.equal(called(o, 'getMuseLibrary').length, 1);
        await press(o, () => o.page.museRefreshLibrary());
        assert.equal(called(o, 'getMuseLibrary').length, 2);
    });

    it('is asked for again on the next visit, and never shows another tenant\'s reels: leaving the page forgets the library', async () => {
        const o = await open({ rows: [item()] });
        o.page.destroy();
        assert.equal(o.page._museLib, undefined);
        o.page.adoptMuse(view());
        await settle();
        assert.equal(called(o, 'getMuseLibrary').length, 2);
        o.page.resetTenantState();
        assert.equal(o.page._museLib, undefined);
    });
});

// ─── The button and what it costs ────────────────────────────────────────────────────────────────────────────────────────

describe('video library: "Index my reels"', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`says what it costs and takes, a reel and the library, and that it counts toward the daily cap (${lang})`, async () => {
            const o = await open({ lang });
            const line = text(o.el('muse-library-estimate').textContent);
            assert.equal(line, o.t('muse.lib.estimate', { cost: '$0.02', seconds: 40, total: '$1.50', reels: 70 }));
            assert.ok(line.includes('$0.02') && line.includes('40') && line.includes('$1.50') && line.includes('70'), line);
            if (lang === 'en') assert.match(line, /about \$0\.02 and takes about 40 seconds .* about \$1\.50 for 70 reels\. It counts toward the daily cap above\./);
            assert.doesNotMatch(line, /[٠-٩]/);
        });
    }

    it('is live only while the SAVED switch is on: off says why and the button is off; an unsaved toggle changes nothing, and saving it does', async () => {
        const off = await open({ view: view({ switches: { dm_media: true, voice: false, memory: false } }) });
        assert.equal(off.el('muse-index-btn').disabled, true);
        assert.ok(!hidden(off, 'muse-library-hint'));
        assert.equal(off.el('muse-library-hint').textContent, off.t('muse.lib.memoryOff'));
        await off.page.museIndexAll(off.el('muse-index-btn'));
        await off.page.museIndexAll();
        assert.deepEqual(called(off, 'indexMuseLibrary'), [], 'and a press that reaches the handler, with or without a button to look at, sends nothing');

        // Switched on in the card but not saved: the server reads what is saved, so the button waits.
        off.el('muse-memory').checked = true;
        off.page.museChanged();
        off.page.paintMuseLibrary();
        assert.equal(off.el('muse-index-btn').disabled, true);

        // Saved: the card adopts the server's answer and the button is live.
        off.page.adoptMuse(view({ switches: { dm_media: true, voice: false, memory: true } }), true);
        assert.equal(off.el('muse-index-btn').disabled, false);
        assert.ok(hidden(off, 'muse-library-hint'));

        const on = await open();
        assert.equal(on.el('muse-index-btn').disabled, false);
        // Switched OFF in the card but not saved: still live, the saved one is on.
        on.el('muse-memory').checked = false;
        on.page.museChanged();
        assert.equal(on.el('muse-index-btn').disabled, false);
    });

    it('queues once, says how many and about what that costs, and asks for the list at once so the reels show as waiting', async () => {
        const o = await open({ rows: [] });
        o.answers.index = { queued: 3, already_indexed: 5, deduped: 0, listed: 8, truncated: false };
        o.answers.library = [item({ status: 'pending', summary: null, hook_score: null, usd: null, model: null }), item({ status: 'pending', summary: null }), item({ status: 'pending', summary: null })];
        await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));

        assert.equal(called(o, 'indexMuseLibrary').length, 1);
        assert.equal(called(o, 'getMuseLibrary').length, 2, 'once on opening, once after the press');
        assert.equal(notice(o), o.t('muse.lib.queued', { queued: 3, cost: '$0.06', seconds: 40 }));
        assert.ok(!hidden(o, 'muse-library-notice'));
        assert.equal(rowsOf(o).length, 3);
        assert.ok(rowsOf(o).every((r) => r.includes(o.t('muse.lib.status.pending'))));
        assert.equal(o.el('muse-index-btn').disabled, false, 'live again, and not stuck busy');
        assert.equal(o.page.museLibState().busy, false);
        assert.deepEqual(o.toasts, [], 'the answer is on the card, not in a toast');
    });

    it('is one request at a time: a second press while the first is in flight sends nothing', { timeout: 10_000 }, async () => {
        const o = await open();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const original = o.h.ctx.API.indexMuseLibrary;
        o.h.ctx.API.indexMuseLibrary = async (...args: Json[]) => { await gate; return original(...args); };
        const first = o.page.museIndexAll(o.el('muse-index-btn'));
        // Pressed again while the first waits: by the button (its busy state stops it) and by the page's own guard, with no button to look at. None is awaited before the
        // first is released, so a guard that is missing makes the count below two or three instead of waiting for ever.
        const again = [o.page.museIndexAll(o.el('muse-index-btn')), o.page.museIndexAll()];
        release();
        await Promise.all([first, ...again]);
        await settle();
        assert.equal(called(o, 'indexMuseLibrary').length, 1);
    });

    it('says why nothing was queued: already queued today, no reel on the account, or every reel already watched, and that older posts were not looked at', async () => {
        const cases: [Json, string][] = [
            [{ queued: 0, already_indexed: 2, deduped: 4, listed: 6, truncated: false }, o_t('muse.lib.queuedAlready')],
            [{ queued: 0, already_indexed: 0, deduped: 0, listed: 0, truncated: false }, o_t('muse.lib.noReels')],
            [{ queued: 0, already_indexed: 6, deduped: 0, listed: 6, truncated: false }, o_t('muse.lib.allWatched')],
            [{ queued: 0, already_indexed: 6, deduped: 0, listed: 6, truncated: true }, `${o_t('muse.lib.allWatched')} ${o_t('muse.lib.truncated')}`],
            [{ queued: 2, already_indexed: 0, deduped: 0, listed: 2, truncated: true }, `${o_t('muse.lib.queued', { queued: 2, cost: '$0.04', seconds: 40 })} ${o_t('muse.lib.truncated')}`],
            [null, o_t('muse.lib.noReels')],
            [{ queued: 'x', deduped: -4, listed: Number.NaN }, o_t('muse.lib.noReels')],
        ];
        function o_t(key: string, params?: Json): string { return loadDashboard({ lang: 'en' }).t(key, params).replace(/[\u2066-\u2069]/g, ''); }
        for (const [answer, expected] of cases) {
            const o = await open();
            o.answers.index = answer;
            await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));
            assert.equal(notice(o), expected, JSON.stringify(answer));
        }
    });

    for (const code of ['MUSE_MEMORY_OFF', 'AI_NOT_CONFIGURED', 'META_NOT_CONNECTED', 'TOKEN_INVALID', 'META_UNAVAILABLE', 'META_ERROR'] as const) {
        for (const lang of ['en', 'ar'] as const) {
            it(`a refusal ${code} is its own sentence in the interface language, on the card and not in a toast (${lang})`, async () => {
                const o = await open({ lang });
                o.answers.index = Object.assign(new Error('The server\'s English words'), { status: 409, code });
                await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));
                assert.equal(notice(o), text(o.t(`muse.lib.e.${code}`)));
                assert.ok(!notice(o).includes('The server'), 'not the server\'s English');
                assert.ok(o.el('muse-library-notice').classes.has('text-warning'));
                assert.equal(o.el('muse-index-btn').disabled, false, 'and the button is live again for a retry');
            });
        }
    }

    it('shows the server\'s own words for a refusal it has no sentence for, and a plain one when there are none', async () => {
        const o = await open();
        o.answers.index = Object.assign(new Error('Something specific happened.'), { status: 500 });
        await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));
        assert.equal(notice(o), 'Something specific happened.');
        o.answers.index = new Error('');
        await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));
        assert.equal(notice(o), o.t('muse.lib.indexFailed'));
    });

    it('a notice goes away when the next press is made, and a late answer for a page that was left is dropped', async () => {
        const o = await open();
        o.answers.index = { queued: 1, listed: 1 };
        await press(o, () => o.page.museIndexAll(o.el('muse-index-btn')));
        assert.ok(notice(o).length > 0);
        o.answers.index = { queued: 0, already_indexed: 1, deduped: 0, listed: 1 };
        const second = o.page.museIndexAll(o.el('muse-index-btn'));
        assert.equal(o.page.museLibState().notice, null, 'cleared while it is asked');
        await second;
        await settle();
        const third = o.page.museIndexAll(o.el('muse-index-btn'));
        o.page.destroy();
        await third;
        await settle();
        assert.equal(o.page._museLib, undefined, 'nothing came back to the forgotten library');
    });
});

// ─── The list ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('video library: the list', () => {
    it('is one row a reel, newest first as the server gives it: state, date, hook and summary', async () => {
        const watched = item({ summary: 'A reel about volumes.', hook_score: 9, posted_at: '2026-10-20T10:00:00.000Z' });
        const waiting = item({ status: 'pending', summary: null, hook_score: null, posted_at: '2026-10-18T10:00:00.000Z', model: null, usd: null });
        const o = await open({ rows: [watched, waiting] });
        const [a, b] = rowsOf(o);
        assert.ok(a!.includes(`data-reel="${watched.id}"`) && b!.includes(`data-reel="${waiting.id}"`));
        assert.ok(text(a).includes(o.t('muse.lib.status.ok')) && a!.includes('badge-success'));
        assert.ok(text(a).includes(o.h.UI.formatDay('2026-10-20T10:00:00.000Z')));
        assert.ok(text(a).includes(o.t('muse.lib.hook', { score: 9 })));
        assert.ok(text(a).includes('A reel about volumes.'));
        assert.ok(text(b).includes(o.t('muse.lib.status.pending')) && b!.includes('badge-neutral'));
        assert.ok(text(b).includes(o.t('muse.lib.waiting')) && !text(b).includes('Hook'), 'a waiting reel has no hook');
    });

    it('says why a reel could not be watched, in a sentence, from the reason the server stored, and a reason it has no sentence for as its code', async () => {
        const reasons = ['too_large', 'fetch_failed', 'expired_url', 'timeout', 'no_media_url', 'not_a_video', 'not_found', 'graph_auth', 'graph_unavailable', 'graph_failed', 'provider_error', 'bad_output'];
        const failed = reasons.map((error) => item({ status: 'failed', summary: null, hook_score: null, error }));
        const odd = item({ status: 'failed', summary: null, hook_score: null, error: 'a_new_reason' });
        const none = item({ status: 'failed', summary: null, hook_score: null, error: null });
        for (const lang of ['en', 'ar'] as const) {
            const o = await open({ lang, rows: [...failed, odd, none] });
            const rows = rowsOf(o);
            reasons.forEach((reason, i) => {
                const expected = text(o.t('muse.lib.couldNot', { reason: o.t(`muse.lib.fail.${reason}`) }));
                assert.ok(text(rows[i]).includes(expected), `${lang} ${reason}: ${text(rows[i])}`);
                assert.ok(rows[i]!.includes('badge-warning'));
            });
            assert.ok(text(rows[reasons.length]).includes('a_new_reason'));
            assert.ok(text(rows[reasons.length + 1]).includes(text(o.t('muse.lib.fail.unknown'))));
        }
        const o = await open({ rows: [failed[0]!] });
        assert.match(text(rowsOf(o)[0]), /Could not be watched: it is larger than 35 MB\./);
    });

    it('counts them, and says when there is nothing, when it is loading, and when it could not be loaded', async () => {
        const o = await open({ rows: [item(), item(), item({ status: 'pending', summary: null }), item({ status: 'failed', summary: null, error: 'timeout' })] });
        assert.equal(o.el('muse-library-count').textContent, o.t('muse.lib.count', { total: 4, ok: 2, pending: 1, failed: 1 }));
        assert.match(o.el('muse-library-count').textContent, /^Reels: 4 · watched 2 · waiting 1 · could not be watched 1$/);

        const empty = await open({ rows: [] });
        assert.equal(empty.el('muse-library-count').textContent, empty.t('muse.lib.empty'));
        assert.equal(empty.el('muse-library-list').innerHTML, '');

        const loading = await open({ wait: false });
        assert.equal(loading.el('muse-library-count').textContent, loading.t('muse.lib.loading'));
        await settle();

        const failed = await open({ rows: [] });
        failed.answers.library = new Error('offline');
        await press(failed, () => failed.page.museRefreshLibrary());
        assert.equal(failed.el('muse-library-count').textContent, 'offline');
        assert.equal(failed.el('muse-library-list').innerHTML, '');
        assert.ok(failed.el('muse-library-count').classes.has('text-warning'));
        assert.equal(failed.el('muse-library-refresh').disabled, false, 'and Refresh is the way to try again');
    });

    it('a failure the first time is said in words when the server gave none', async () => {
        const o = await open({ rows: [] });
        o.answers.library = Object.assign(new Error(''), {});
        await press(o, () => o.page.museRefreshLibrary());
        assert.equal(o.el('muse-library-count').textContent, o.t('muse.lib.loadFailed'));
    });

    it('a refresh that fails with a list on screen keeps the list and says so beside the counts', async () => {
        const o = await open({ rows: [item(), item()] });
        o.answers.library = new Error('offline');
        await press(o, () => o.page.museRefreshLibrary());
        assert.equal(rowsOf(o).length, 2, 'the list stays');
        assert.match(o.el('muse-library-count').textContent, new RegExp(`${o.t('muse.lib.refreshFailed').replace('.', '\\.')}$`));
        assert.ok(o.el('muse-library-count').classes.has('text-warning'));
        o.answers.library = [item()];
        await press(o, () => o.page.museRefreshLibrary());
        assert.equal(rowsOf(o).length, 1);
        assert.doesNotMatch(o.el('muse-library-count').textContent, /refreshed/);
    });

    it('Refresh asks again and is off while it asks', async () => {
        const o = await open({ rows: [item()] });
        o.answers.library = [item(), item()];
        const pending = o.page.museRefreshLibrary();
        assert.equal(o.page.museLibState().status, 'loading');
        assert.equal(o.el('muse-library-refresh').disabled, true);
        await pending;
        await settle();
        assert.equal(rowsOf(o).length, 2);
        assert.equal(o.el('muse-library-refresh').disabled, false);
    });

    it('draws only a row that has a uuid, each once; a state it does not know is a failure; a link only when it is https', async () => {
        const good = item();
        const odd = item({ status: 'archived', summary: null });
        const rows = [
            good, { ...good }, item({ id: 'not-a-uuid' }), null, 'text', 7, item({ id: undefined }),
            odd, item({ permalink: 'javascript:alert(1)' }), item({ permalink: 'http://www.instagram.com/reel/x/' }),
        ];
        const o = await open({ rows });
        const drawn = rowsOf(o);
        assert.equal(drawn.length, 4, 'the good one once, the unknown state, and the two with a link that is not https');
        assert.equal(drawn.filter((r) => r.includes(`data-reel="${good.id}"`)).length, 1);
        assert.ok(text(drawn[1]).includes(o.t('muse.lib.status.failed')), 'an unknown state is a failure');
        assert.ok(!drawn.join('').includes('javascript:') && !drawn.join('').includes('http://'));
        const links = [...drawn.join('').matchAll(/<a class="btn btn-ghost btn-sm" href="([^"]*)"/g)].map((m) => m[1]);
        assert.deepEqual(links, [good.permalink, odd.permalink], 'the two rows with a link that is https have one; the other two have none');
        for (const answer of [null, undefined, 'x', {}, 7]) {
            o.answers.library = answer as unknown as Json[];
            await press(o, () => o.page.museRefreshLibrary());
            assert.equal(rowsOf(o).length, 0, JSON.stringify(answer));
        }
    });

    it('says a reel with no date has none, and one with no summary says it was watched with no summary', async () => {
        const o = await open({ rows: [item({ posted_at: null }), item({ summary: '   ' })] });
        const [a, b] = rowsOf(o);
        assert.ok(text(a).includes(o.t('muse.lib.undated')));
        assert.ok(text(b).includes(o.t('muse.lib.noSummary')));
    });

    it('draws everything a model wrote as text, never as markup: a summary full of tags is shown as characters', async () => {
        const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"><b>bold</b>';
        const o = await open({ rows: [item({ summary: evil })] });
        const list = String(o.el('muse-library-list').innerHTML);
        assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.deepEqual([...new Set(tagsOf(list))].sort(), ['a', 'button', 'div', 'i', 'li', 'p', 'span']);
        assert.ok(!/<script|<img|<b>/.test(list));
    });

    it('cuts a long summary to a bounded line and flattens its breaks (the stylesheet shows two lines of it)', async () => {
        const o = await open({ rows: [item({ summary: `line one\nline two\u0000 ${'x'.repeat(2000)}` })] });
        const shown = text(rowsOf(o)[0]);
        assert.ok(shown.includes('line one line two'));
        assert.ok(shown.length < 700);
    });
});

// ─── Watch again ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('video library: "Watch again"', () => {
    const again = (o: Opened, id: string): string => /<button[^>]*data-action="muse:reindexReel"[^>]*data-id="([^"]*)"[^>]*>/g.exec(String(o.el('muse-library-list').innerHTML).split(`data-reel="${id}"`)[1] ?? '')?.[0] ?? '';
    const disabledNow = (o: Opened, id: string): boolean => /\sdisabled(?=[\s>])/.test(again(o, id));

    it('queues one reel, and says the notes of a good one are replaced when the new ones are done', async () => {
        const ok = item();
        const o = await open({ rows: [ok] });
        await press(o, () => o.page.museReindexReel(ok.id));
        assert.deepEqual(called(o, 'reindexMuseReel').map((c) => c.args), [[ok.id]]);
        assert.equal(notice(o), o.t('muse.lib.queuedOneKept'));
        assert.equal(called(o, 'getMuseLibrary').length, 2, 'the list is asked for again');
        assert.equal(disabledNow(o, ok.id), false);
    });

    it('says a failed reel will be watched, and that a press the server already had this minute is already queued', async () => {
        const failed = item({ status: 'failed', summary: null, error: 'timeout' });
        const o = await open({ rows: [failed] });
        await press(o, () => o.page.museReindexReel(failed.id));
        assert.equal(notice(o), o.t('muse.lib.queuedOne'));
        o.answers.reindex = { queued: false };
        await press(o, () => o.page.museReindexReel(failed.id));
        assert.equal(notice(o), o.t('muse.lib.alreadyQueued'));
    });

    it('is off while the memory switch is off, for a reel that waits, for one with no Instagram id, and while it is being queued', { timeout: 10_000 }, async () => {
        const o = await open({ rows: [item(), item({ status: 'pending', summary: null }), item({ ig_media_id: null })] });
        const [ok, pending, noId] = o.page.museLibState().rows as Json[];
        assert.deepEqual([disabledNow(o, ok.id), disabledNow(o, pending.id), disabledNow(o, noId.id)], [false, true, true]);
        for (const id of [pending.id, noId.id]) await o.page.museReindexReel(id);
        assert.deepEqual(called(o, 'reindexMuseReel'), [], 'a press that reaches the handler sends nothing');

        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const original = o.h.ctx.API.reindexMuseReel;
        o.h.ctx.API.reindexMuseReel = async (...args: Json[]) => { await gate; return original(...args); };
        const first = o.page.museReindexReel(ok.id);
        assert.equal(disabledNow(o, ok.id), true, 'drawn off while it is in flight');
        const second = o.page.museReindexReel(ok.id);
        release();
        await Promise.all([first, second]);
        await settle();
        assert.equal(called(o, 'reindexMuseReel').length, 1);

        const off = await open({ view: view({ switches: { dm_media: true, voice: false, memory: false } }), rows: [item()] });
        assert.equal(disabledNow(off, (off.page.museLibState().rows[0] as Json).id), true);
        await off.page.museReindexReel((off.page.museLibState().rows[0] as Json).id);
        assert.deepEqual(called(off, 'reindexMuseReel'), []);
    });

    it('a refusal is its own sentence on the card', async () => {
        const ok = item();
        const o = await open({ rows: [ok] });
        o.answers.reindex = Object.assign(new Error('English'), { status: 404, code: 'REEL_NOT_FOUND' });
        await press(o, () => o.page.museReindexReel(ok.id));
        assert.equal(notice(o), o.t('muse.lib.e.REEL_NOT_FOUND'));
        o.answers.reindex = Object.assign(new Error('English'), { status: 409, code: 'NO_MEDIA_ID' });
        await press(o, () => o.page.museReindexReel(ok.id));
        assert.equal(notice(o), o.t('muse.lib.e.NO_MEDIA_ID'));
        assert.equal(disabledNow(o, ok.id), false);
    });

    it('names the reel by its date for a screen reader, so a list of "Watch again" is not a list of the same words', async () => {
        const ok = item({ posted_at: '2026-10-20T10:00:00.000Z' });
        const o = await open({ rows: [ok] });
        const date = o.h.UI.formatDay('2026-10-20T10:00:00.000Z');
        const list = String(o.el('muse-library-list').innerHTML);
        for (const key of ['muse.lib.detailsOf', 'muse.lib.againOf', 'muse.lib.openOf']) assert.ok(list.includes(`aria-label="${o.t(key, { date })}"`), key);
    });
});

// ─── The details ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('video library: the details of one reel', () => {
    const detailOf = (o: Opened, id: string): string => String(o.el('muse-library-list').innerHTML).split(`id="muse-detail-${id}"`)[1] ?? '';
    const sections = (markup: string): [string, string][] => [...markup.matchAll(/<section class="muse-detail-section"><h5 aria-level="4">([^<]*)<\/h5>([\s\S]*?)<\/section>/g)].map((m) => [m[1]!, text(m[2])]);

    it('opens on the button, asks for them once, and draws what is said, what is on screen, the moments, the topics, the hook, the caption and the cover', async () => {
        const row = item();
        const o = await open({ rows: [row] });
        await press(o, () => o.page.museToggleReel(row.id));
        assert.deepEqual(called(o, 'getMuseReel').map((c) => c.args), [[row.id]]);
        const detail = detailOf(o, row.id);
        const got = Object.fromEntries(sections(detail));
        assert.equal(got[o.t('muse.lib.d.summary')], 'Docker volumes keep a container\'s data after it stops, shown with docker run -v.');
        assert.equal(got[o.t('muse.lib.d.narration')], 'First line of speech. Second line of speech.');
        assert.equal(got[o.t('muse.lib.d.screen')], 'docker run -v data:/app a whale logo');
        assert.equal(got[o.t('muse.lib.d.moments')], '0:07 the -v flag 1:05 data is still there after a restart');
        assert.equal(got[o.t('muse.lib.d.topics')], 'docker volumes');
        assert.equal(got[o.t('muse.lib.d.hook')], `A terminal and a question. ${o.t('muse.lib.hook', { score: 8 })}`);
        assert.equal(got[o.t('muse.lib.d.caption')], 'وين راحت بياناتي؟');
        assert.equal(got[o.t('muse.lib.d.cover')], `${o.t('muse.lib.d.coverAt', { clock: '0:12' })} The command and the whale are both visible.`);
        assert.ok(text(detail).includes(o.t('muse.lib.d.by', { model: 'meta-models/muse-spark-open-1026', cost: '$0.02' })));
        assert.deepEqual(Object.keys(got), ['muse.lib.d.summary', 'muse.lib.d.narration', 'muse.lib.d.screen', 'muse.lib.d.moments', 'muse.lib.d.topics', 'muse.lib.d.hook', 'muse.lib.d.caption', 'muse.lib.d.cover'].map((k) => o.t(k)));
    });

    it('says the moments in the clock the assistant says them in', async () => {
        assert.deepEqual([0, 7, 65, 600].map((s) => watchFrom(s)), ['0:00', '0:07', '1:05', '10:00']);
        const row = item();
        const o = await open({ rows: [row] });
        for (const second of [0, 7, 59.9, 65, 600, 3725]) assert.equal(o.page.museClock(second), watchFrom(second), String(second));
        assert.equal(o.page.museClock(-3), '0:00');
        assert.equal(o.page.museClock(Number.NaN), '0:00');
        assert.equal(o.page.museClock('7'), '0:00');
    });

    it('closes on the same button, asks again on the next open, and keeps the focus on the button that was pressed', async () => {
        const row = item();
        const o = await open({ rows: [row] });
        const button = o.h.el(`muse-toggle-${row.id}`);
        await press(o, () => o.page.museToggleReel(row.id));
        assert.ok(String(o.el('muse-library-list').innerHTML).includes('aria-expanded="true"'));
        assert.ok(button.focusCalls.length >= 1);
        await press(o, () => o.page.museToggleReel(row.id));
        assert.ok(!String(o.el('muse-library-list').innerHTML).includes('id="muse-detail-'));
        assert.ok(String(o.el('muse-library-list').innerHTML).includes('aria-expanded="false"'));
        await press(o, () => o.page.museToggleReel(row.id));
        assert.equal(called(o, 'getMuseReel').length, 2);
    });

    it('says it is loading, and says it could not be loaded in words that tell what to do', { timeout: 10_000 }, async () => {
        const row = item();
        const o = await open({ rows: [row] });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const original = o.h.ctx.API.getMuseReel;
        o.h.ctx.API.getMuseReel = async (...args: Json[]) => { await gate; return original(...args); };
        const opening = o.page.museToggleReel(row.id);
        assert.ok(text(detailOf(o, row.id)).includes(o.t('muse.lib.detailLoading')));
        release();
        await opening;
        await settle();
        assert.ok(!text(detailOf(o, row.id)).includes(o.t('muse.lib.detailLoading')));

        const broken = await open({ rows: [row] });
        broken.answers.reel = new Error('offline');
        await press(broken, () => broken.page.museToggleReel(row.id));
        assert.ok(text(detailOf(broken, row.id)).includes(broken.t('muse.lib.detailFailed')));
        await press(broken, () => broken.page.museToggleReel(row.id));
        broken.answers.reel = RESULT();
        await press(broken, () => broken.page.museToggleReel(row.id));
        assert.ok(text(detailOf(broken, row.id)).includes('First line of speech.'), 'closing and opening again is the retry');
    });

    it('draws only the parts that have something in them, and says so when a reel has no notes at all', async () => {
        const row = item();
        const o = await open({ rows: [row] });
        o.answers.reel = RESULT({ narration: '', seen_on_screen: [], key_moments: [], topics: [], caption_ar: '', hook_first_3s: '', hook_score: null, cover_second: null });
        await press(o, () => o.page.museToggleReel(row.id));
        assert.deepEqual(sections(detailOf(o, row.id)).map(([title]) => title), [o.t('muse.lib.d.summary')]);

        const bare = await open({ rows: [row] });
        bare.answers.reel = {};
        await press(bare, () => bare.page.museToggleReel(row.id));
        assert.ok(text(detailOf(bare, row.id)).includes(bare.t('muse.lib.d.nothing')));
        assert.deepEqual(sections(detailOf(bare, row.id)), []);

        for (const odd of [null, [], 'text', 7]) {
            const x = await open({ rows: [row] });
            x.answers.reel = odd as unknown as Json;
            await press(x, () => x.page.museToggleReel(row.id));
            assert.ok(text(detailOf(x, row.id)).includes(x.t('muse.lib.d.nothing')), JSON.stringify(odd));
        }
    });

    it('draws what a model wrote as text: markup is shown as characters, the narration keeps its line breaks, and a broken moment or topic is left out', async () => {
        const row = item();
        const o = await open({ rows: [row] });
        o.answers.reel = RESULT({
            summary: '<img src=x onerror=alert(1)>', narration: 'a <script>alert(2)</script>\r\n\r\n\u0000b', seen_on_screen: ['<b>x</b>', 7, null, ''], topics: ['<i>y</i>', {}, ''],
            key_moments: [{ second: 3, what: '<u>z</u>' }, { second: 'x', what: 'bad second' }, { second: -1, what: 'before' }, { second: 9, what: '' }, null, 'text'],
            hook_first_3s: '<h1>hook</h1>', caption_ar: '<a href=javascript:1>c</a>', cover_second: 'x', cover_reason: '<p>r</p>',
        });
        await press(o, () => o.page.museToggleReel(row.id));
        const detail = detailOf(o, row.id);
        assert.ok(!/<img|<script|<b>|<i>|<u>|<h1>|<a href=javascript|<p>r/.test(detail), 'no tag a model wrote is a tag');
        assert.ok(detail.includes('&lt;img src=x onerror=alert(1)&gt;') && detail.includes('&lt;b&gt;x&lt;/b&gt;'));
        const got = Object.fromEntries(sections(detail));
        assert.equal(got[o.t('muse.lib.d.narration')], 'a <script>alert(2)</script> b');
        assert.ok(detail.includes('a &lt;script&gt;alert(2)&lt;/script&gt;\nb'), 'one line break between two lines, no blank line');
        assert.equal(got[o.t('muse.lib.d.moments')], '0:03 <u>z</u>', 'only the moment with a time and words');
        assert.equal(got[o.t('muse.lib.d.topics')], '<i>y</i>');
        assert.equal(got[o.t('muse.lib.d.cover')], undefined, 'a cover with no time is not drawn');
    });

    it('has no details button for a reel that waits or failed: only one with notes can be opened', async () => {
        const o = await open({ rows: [item({ status: 'pending', summary: null }), item({ status: 'failed', summary: null, error: 'timeout' }), item()] });
        const [pending, failed, ok] = rowsOf(o);
        assert.ok(!pending!.includes('muse:toggleReel') && !failed!.includes('muse:toggleReel'));
        assert.ok(ok!.includes('muse:toggleReel'));
        await o.page.museToggleReel('not-a-uuid');
        assert.deepEqual(called(o, 'getMuseReel'), []);
    });

    it('drops a late answer: closed before it came, a page that was left, or a library that was forgotten', { timeout: 10_000 }, async () => {
        const row = item();
        const o = await open({ rows: [row] });
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const original = o.h.ctx.API.getMuseReel;
        o.h.ctx.API.getMuseReel = async (...args: Json[]) => { await gate; return original(...args); };
        const opening = o.page.museToggleReel(row.id);
        await o.page.museToggleReel(row.id);
        assert.ok(!String(o.el('muse-library-list').innerHTML).includes('id="muse-detail-'), 'closed while it was loading');
        release();
        await opening;
        await settle();
        assert.ok(!String(o.el('muse-library-list').innerHTML).includes('id="muse-detail-'), 'and the answer did not open it again');

        const left = await open({ rows: [row] });
        let release2: () => void = () => {};
        const gate2 = new Promise<void>((resolve) => { release2 = resolve; });
        const original2 = left.h.ctx.API.getMuseReel;
        left.h.ctx.API.getMuseReel = async (...args: Json[]) => { await gate2; return original2(...args); };
        const pending = left.page.museToggleReel(row.id);
        left.page.destroy();
        release2();
        await pending;
        await settle();
        assert.equal(left.page._museLib, undefined);
    });
});

// ─── Polling ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('video library: the list is asked for again while a reel waits', () => {
    const waiting = (): Json => item({ status: 'pending', summary: null, hook_score: null });

    it('schedules the next ask while a reel waits, and asks again by itself until none does', async () => {
        const o = await open({ rows: [waiting()], wait: false });
        o.page.MUSE_POLL_MS = 2;
        await settle();
        assert.ok(o.page.museLibState().timer, 'a poll is waiting');
        const pending = waiting();
        let asked = 0;
        o.answers.library = [pending];
        const original = o.h.ctx.API.getMuseLibrary;
        o.h.ctx.API.getMuseLibrary = (...args: Json[]) => { asked++; if (asked >= 2) o.answers.library = [{ ...pending, status: 'ok', summary: 'Done.' }]; return original(...args); };
        await sleep(80);
        assert.ok(asked >= 2, `asked ${asked} times`);
        const timer = o.page.museLibState().timer;
        assert.equal(timer, null, 'and when nothing waits any more it stops asking');
        const after = asked;
        await sleep(30);
        assert.equal(asked, after);
        assert.ok(text(rowsOf(o)[0]).includes('Done.'));
    });

    it('does not ask when nothing waits: a list of watched and failed reels has no timer', async () => {
        const o = await open({ rows: [item(), item({ status: 'failed', summary: null, error: 'timeout' })] });
        assert.equal(o.page.museLibState().timer, null);
    });

    it('is not forever: after MUSE_POLL_MAX asks by itself it stops, and Refresh starts it over', async () => {
        const o = await open({ rows: [waiting()], wait: false });
        o.page.MUSE_POLL_MS = 1;
        o.page.MUSE_POLL_MAX = 3;
        await settle();
        await sleep(120);
        const asks = called(o, 'getMuseLibrary').length;
        assert.equal(asks, 1 + 3, 'once on opening and three by itself');
        assert.equal(o.page.museLibState().timer, null);
        await sleep(30);
        assert.equal(called(o, 'getMuseLibrary').length, asks);
        await press(o, () => o.page.museRefreshLibrary());
        await sleep(120);
        assert.equal(called(o, 'getMuseLibrary').length, asks + 1 + 3, 'Refresh started the count over: its own ask, then three more by itself, then it stops again');
        assert.equal(o.page.museLibState().timer, null);
        o.page.destroy();
    });

    it('stops when the page is left, and a poll that was already scheduled does nothing', async () => {
        const o = await open({ rows: [waiting()], wait: false });
        o.page.MUSE_POLL_MS = 5;
        await settle();
        assert.ok(o.page.museLibState().timer);
        const cleared: unknown[] = [];
        const real = o.h.ctx.clearTimeout;
        o.h.ctx.clearTimeout = (handle: unknown) => { cleared.push(handle); return real(handle as never); };
        const timer = o.page.museLibState().timer;
        o.page.destroy();
        assert.deepEqual(cleared, [timer], 'the poll that was waiting is cancelled, not only ignored when it fires');
        const asks = called(o, 'getMuseLibrary').length;
        await sleep(40);
        assert.equal(called(o, 'getMuseLibrary').length, asks);
    });

    it('a poll that fails keeps the list, and the next one is still scheduled', async () => {
        const o = await open({ rows: [waiting()], wait: false });
        o.page.MUSE_POLL_MS = 2;
        await settle();
        o.answers.library = new Error('offline');
        await sleep(40);
        assert.equal(rowsOf(o).length, 1);
        assert.match(o.el('muse-library-count').textContent, /refreshed/);
        o.page.destroy();
    });
});

// ─── The API, and the server's own answers ───────────────────────────────────────────────────────────────────────────────

describe('video library: the API client asks the routes the server has', () => {
    it('GET the list, GET one, POST index, POST one\'s index: the paths, the methods and an id that is encoded', async () => {
        const requests: { url: string; method: string }[] = [];
        const h = loadDashboard({
            lang: 'en',
            files: ['dashboard/js/api.js'],
            globals: {
                fetch: async (url: string, init: { method?: string }) => { requests.push({ url, method: init.method ?? 'GET' }); return { ok: true, status: 200, text: async () => '[]' }; },
            },
        });
        const API = h.run<Json>('API');
        await API.getMuseLibrary();
        await API.getMuseReel('a/b c');
        await API.indexMuseLibrary();
        await API.reindexMuseReel('a/b c');
        assert.deepEqual(requests, [
            { url: '/api/settings/ai/muse/library', method: 'GET' },
            { url: '/api/settings/ai/muse/library/a%2Fb%20c', method: 'GET' },
            { url: '/api/settings/ai/muse/library/index', method: 'POST' },
            { url: '/api/settings/ai/muse/library/a%2Fb%20c/index', method: 'POST' },
        ]);
    });
});

describe('video library: the card reads what the server really answers', () => {
    let world: World;
    let savedKey: string | undefined;
    beforeEach(() => {
        savedKey = process.env.TOKEN_ENCRYPTION_KEY;
        process.env.TOKEN_ENCRYPTION_KEY = 'ab'.repeat(32);
        world = installWorld();
    });
    afterEach(() => {
        world.restore();
        if (savedKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
        else process.env.TOKEN_ENCRYPTION_KEY = savedKey;
    });

    it('draws the list `listLibrary` gives and the details `getLibraryRow` gives, field for field', async () => {
        const at = new Date('2026-10-20T10:00:00.000Z');
        const mk = (n: number, status: string, result: Json, over: Json = {}) => world.reel.reels.push({
            id: `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`, creator_id: TENANT, ig_media_id: `ig${n}`, permalink: `https://www.instagram.com/reel/R${n}/`, youtube_url: null,
            posted_at: new Date(at.getTime() - n * 86_400_000), status, result, model: 'meta-models/muse-spark-open-1026', ms: 41_000, usd: '0.021594', created_at: at, updated_at: at, ...over,
        });
        mk(1, 'ok', RESULT({ summary: 'The newest, watched.' }));
        mk(2, 'pending', {}, { model: null, usd: null, ms: null });
        mk(3, 'failed', { error: 'too_large', detail: 'baseten:server:503' }, { model: null, usd: null, ms: null });

        const served = plain(await listLibrary(TENANT));
        const first = await getLibraryRow(TENANT, '00000000-0000-4000-8000-000000000001');
        const o = await open({ rows: served });
        o.answers.reel = plain(first!.result);

        const [ok, waiting, failed] = rowsOf(o);
        assert.deepEqual([ok, waiting, failed].map((r) => (r!.match(/badge (badge-[a-z]+)/) ?? [])[1]), ['badge-success', 'badge-neutral', 'badge-warning']);
        assert.ok(text(ok).includes('The newest, watched.'));
        assert.ok(text(ok).includes(o.t('muse.lib.hook', { score: 8 })));
        assert.ok(text(waiting).includes(o.t('muse.lib.waiting')));
        assert.ok(text(failed).includes(text(o.t('muse.lib.couldNot', { reason: o.t('muse.lib.fail.too_large') }))));
        assert.ok(ok!.includes('href="https://www.instagram.com/reel/R1/"'));
        assert.deepEqual(plain(o.page.museLibState().rows.map((r: Json) => [r.mediaId, r.status])), [['ig1', 'ok'], ['ig2', 'pending'], ['ig3', 'failed']], 'ig_media_id is what the re-index needs');

        await press(o, () => o.page.museToggleReel(first!.id));
        const detail = String(o.el('muse-library-list').innerHTML).split('id="muse-detail-')[1]!;
        for (const part of ['The newest, watched.', 'First line of speech.', 'a whale logo', '0:07', '1:05', 'docker', 'A terminal and a question.', 'وين راحت بياناتي؟', '0:12']) assert.ok(text(detail).includes(part), part);
        assert.ok(text(detail).includes(o.t('muse.lib.d.by', { model: 'meta-models/muse-spark-open-1026', cost: '$0.02' })));
    });

    it('draws a failed row\'s details as nothing to open, and the route\'s own answer for a failed row is `{ error }` that is never drawn as notes', async () => {
        const at = new Date('2026-10-20T10:00:00.000Z');
        world.reel.reels.push({
            id: '00000000-0000-4000-8000-000000000009', creator_id: TENANT, ig_media_id: 'ig9', permalink: 'https://www.instagram.com/reel/R9/', youtube_url: null, posted_at: at, status: 'failed',
            result: { error: 'timeout', detail: 'baseten:timeout | meta:timeout' }, model: null, ms: null, usd: null, created_at: at, updated_at: at,
        });
        const served = plain(await listLibrary(TENANT));
        const o = await open({ rows: served });
        assert.equal(rowsOf(o).length, 1);
        assert.ok(!rowsOf(o)[0]!.includes('muse:toggleReel'));
        assert.ok(!text(rowsOf(o)[0]).includes('baseten'), 'the detail note of the failure is the operator\'s, not the owner\'s list');
        assert.ok(text(rowsOf(o)[0]).includes(text(o.t('muse.lib.couldNot', { reason: o.t('muse.lib.fail.timeout') }))));
    });
});

// ─── The words, and the Help section the card links to ───────────────────────────────────────────────────────────────────

describe('video library: the Help section it links to', () => {
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/help-content.js'] });
    const content = h.run<Json>('HelpContent');
    const article = (content.articles as Json[]).find((a) => a.slug === 'ai-usage')!;
    const sectionIds = (article.sections as Json[]).map((x) => x.id as string);
    const section = (article.sections as Json[]).find((x) => x.id === 'video-memory')!;
    const textOf = (lang: Lang): string => {
        const out: string[] = [];
        const walk = (value: unknown): void => {
            if (typeof value === 'string') out.push(value);
            else if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') Object.values(value).forEach(walk);
        };
        walk(section.body[lang]);
        return out.join('\n');
    };
    const strings = async (lang: Lang): Promise<Record<string, string>> => (await open({ lang, wait: false })).h.I18N.strings[lang];

    it('is a section of the article the card links to, right after Meta vision and before the ways to spend less, with a title in each language', () => {
        assert.ok(section, 'ai-usage#video-memory exists');
        assert.equal(sectionIds.indexOf('video-memory'), sectionIds.indexOf('meta-vision') + 1, sectionIds.join(', '));
        assert.equal(sectionIds[sectionIds.indexOf('video-memory') + 1], 'save');
        assert.match(section.title.en, /Video memory/);
        assert.match(section.title.ar, /ذاكرة الفيديو/);
    });

    it('is what the card links to: the link\'s target is a section that exists, and the card draws it as a link that opens in a new tab so an unsaved card is not lost', async () => {
        const o = await open({ wait: false, skipAdopt: true });
        const shell = String(o.page.museShell());
        assert.match(shell, /<a class="help-link" href="#\/help\/ai-usage#video-memory" target="_blank" rel="noopener">/);
        assert.ok(sectionIds.includes('video-memory'));
        // Meta vision's own section sends the reader to it, in both languages.
        for (const lang of ['en', 'ar'] as const) {
            const meta = (article.sections as Json[]).find((x) => x.id === 'meta-vision')!;
            assert.ok(JSON.stringify(meta.body[lang]).includes('[[ai-usage#video-memory]]'), lang);
        }
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`names the switch, the button, the buttons of the list, the states and the cap exactly as the card does (${lang})`, async () => {
            const body = textOf(lang);
            const labels = await strings(lang);
            for (const key of [
                'muse.memory', 'muse.lib.index', 'muse.lib.title', 'muse.lib.details', 'muse.lib.again', 'muse.lib.refresh', 'muse.lib.status.ok', 'muse.lib.status.pending', 'muse.lib.status.failed',
                'muse.save', 'muse.cap', 'muse.title', 'nav.ai_settings', 'nav.inbox',
            ]) {
                if (key === 'nav.inbox' && lang === 'en') assert.ok(body.includes('**Inbox**'), `${lang}: **Inbox**`);
                else assert.ok(body.includes(`**${labels[key]}**`), `${lang}: **${labels[key]}**`);
            }
        });
    }

    it('says in English what it watches, who watches, what a reply does with it, what the button costs and takes, and that no link is sent that is not in the library', () => {
        const body = textOf('en');
        assert.match(body, /Only your own published reels, which are public/);
        assert.match(body, /no message, comment or follower goes with it/);
        assert.match(body, /We do not keep the video file/);
        assert.match(body, /the open-weights model that our partner Baseten runs for us, or Meta’s own hosted one/);
        assert.match(body, /picks the one reel that covers it/);
        assert.match(body, /says where to watch from, like “from 0:13”/);
        assert.match(body, /links its YouTube copy at that second/);
        assert.match(body, /there is no video on that yet, with no link/);
        assert.match(body, /It never sends a link that is not in your library/);
        assert.match(body, /about 40 seconds and about \$0\.02 a reel, so about \$1\.50 for seventy/);
        assert.match(body, /A reel larger than 35 MB is not watched/);
        assert.match(body, /Instagram messages only/);
        assert.match(body, /Recalled: a video from your library/);
    });

    it('says the same in Arabic, in the Help Center\'s own voice', () => {
        const body = textOf('ar');
        assert.match(body, /ريلزك أنت المنشورة بس، وهي عامة/);
        assert.match(body, /ما نحتفظ به/);
        assert.match(body, /Baseten/);
        assert.match(body, /من 0:13/);
        assert.match(body, /ما في فيديو عن الموضوع هذا لسا، بدون أي رابط/);
        assert.match(body, /ما يرسل أبداً رابطاً مو في مكتبتك/);
        assert.match(body, /نحو 40 ثانية ونحو 0\.02 دولار للريل، يعني نحو 1\.50 دولار لسبعين ريل/);
        assert.match(body, /الأكبر من 35 ميغابايت/);
        assert.match(body, /تذكّر: فيديو من مكتبتك/);
    });

    it('gives the same cost and time as the card says beside the button', async () => {
        const o = await open();
        const card = text(o.el('muse-library-estimate').textContent);
        assert.ok(card.includes('$0.02') && card.includes('40 seconds') && card.includes('$1.50') && card.includes('70 reels'));
        const body = textOf('en');
        assert.ok(body.includes('about 40 seconds and about $0.02 a reel') && body.includes('about $1.50 for seventy'));
        assert.equal(o.page.MUSE_REEL_SECONDS, 40);
        assert.equal(o.page.MUSE_SAMPLE_USD, 1.5);
        assert.equal(o.page.MUSE_SAMPLE_REELS, 70);
    });

    it('never uses the words the product does not say, or the ones the video memory is never called: RAG, a million-token context, remembering everything', async () => {
        for (const lang of ['en', 'ar'] as const) {
            const labels = await strings(lang);
            const everything = [textOf(lang), ...Object.entries(labels).filter(([k]) => k.startsWith('muse.')).map(([, v]) => v)].join('\n');
            for (const banned of [/\bRAG\b/, /\b1\s?M\b/i, /million[- ]token/i, /remembers? everything/i, /\bbots?\b/i, /بوت/, /ذكي/, /\binstant/i, /فور[اي]/, /ذاكرة (?:غير )?محدودة/, /يتذكر كل شيء/]) {
                assert.doesNotMatch(everything, banned, `${lang}: ${banned}`);
            }
        }
    });
});
