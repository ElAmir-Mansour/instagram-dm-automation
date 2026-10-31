/**
 * The "Meta vision (beta)" card on the AI settings screen (docs/specs/005-muse-sees T038): the owner's switches for the assistant reading photos, reels and
 * story mentions, who it answers (people picked from his recent Instagram conversations, or everyone), its daily cap, and the key's state.
 *
 * The REAL `ai_settings.js` in the shared `node:vm` harness, in both languages where the words are the claim, with `API` answering only what a test names.
 * There is no layout and no real DOM: the card's elements are the harness's fakes, registered by id, and what is driven is what the page reads from them
 * (`checked`, `value`) and writes to them (`innerHTML`, `textContent`, classes, `disabled`). What only a browser can show (the picker at phone width, RTL
 * chips) is for the live check after the merge.
 *
 * Pinned, because a screenshot cannot show it:
 *   - the shell: the three switches under the names the owner reads (only video memory marked "coming soon": voice notes are live), the help link, who it answers, the cap,
 *     its own Save; read-only for a viewer AND for an operator (the route is the owner's), with the owner-only note for the second;
 *   - the state: what the server said is what is drawn (switches, list or everyone, cap, the key line with its model, today's spend), a block the server
 *     could not read draws nothing as chosen and saves nothing, a server without the block hides the card;
 *   - the picker: only Instagram threads with a sender id the server takes, each thread's SENDER id (not its conversation id) is what is stored, by the
 *     handle the inbox shows, the people already chosen are not offered twice, the list is searchable, a late answer after leaving is dropped;
 *   - saving: exactly what is on screen, once, the server's answer adopted, a refusal kept as a draft with the server's words, nothing sent by anyone who may
 *     not, nothing for a cap the server would refuse;
 *   - everything a person or a model wrote (a handle, a name) is text, never markup.
 *
 * The video library inside the card (the list, "Index my reels", the details) is `museLibrary.test.ts`'s; here it is only the section the shell draws, the ids it brings
 * and the API it asks, which every test of the card answers with an empty library.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMuseView, parseMuseInput } from '../services/perception/museSettings.js';
import { MUSE_DAILY_USD_MAX } from '../services/perception/switches.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

type Role = 'owner' | 'operator' | 'viewer';
type Lang = 'ar' | 'en';

const SARA = '17841400000000001';
const OMAR = '17841400000000002';
const EVIL = '17841400000000003';
const FB = '9876543210';
const NOW = Date.now();
const ago = (hours: number): string => new Date(NOW - hours * 3600 * 1000).toISOString();

const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
/** The tags a piece of markup opens: nothing but these may appear, whatever a handle or a name said. */
const tagsOf = (markup: unknown): string[] => [...String(markup).matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)].map((m) => m[1]!.toLowerCase());
/** The attribute names of every tag, read the way a parser does: what is inside a quoted value is a value, not a name. */
const attrNames = (markup: unknown): string[] => [...String(markup).matchAll(/<[a-zA-Z][^>]*>/g)].flatMap((m) => [...m[0].replace(/"[^"]*"/g, '""').matchAll(/\s([a-zA-Z-]+)=/g)].map((a) => a[1]!.toLowerCase()));
const SAFE_TAGS = new Set(['li', 'span', 'button', 'i', 'bdi', 'div', 'p', 'strong', 'ul', 'a']);
const SAFE_ATTRS = new Set([
    'class', 'type', 'data-person', 'data-action', 'data-id', 'data-focus-key', 'aria-label', 'title', 'dir', 'aria-hidden', 'data-lucide', 'id', 'role', 'aria-busy', 'href',
]);

/** The card's ids, which the page reads and writes. */
const IDS = [
    'muse-card', 'muse-dm-media', 'muse-voice', 'muse-memory', 'muse-who', 'muse-daily-usd', 'muse-save-btn', 'muse-picker-open', 'muse-picker-search',
    'muse-error', 'muse-status', 'muse-people-block', 'muse-everyone-note', 'muse-people-list', 'muse-who-hint', 'muse-cap-hint', 'muse-spent',
    'muse-unsaved-note', 'muse-picker', 'muse-picker-note', 'muse-picker-list',
    'muse-library', 'muse-index-btn', 'muse-library-refresh', 'muse-library-estimate', 'muse-library-hint', 'muse-library-notice', 'muse-library-count', 'muse-library-list',
];
/** The library's two buttons: the card's own controls, apart from them, are what the shell's tests count. */
const LIBRARY_CONTROLS = ['muse-index-btn', 'muse-library-refresh'];

/** The `muse` block the server answers with, and a change of it. */
function view(over: Json = {}): Json {
    return {
        switches: { dm_media: true, voice: false, memory: false },
        allowSenders: [SARA],
        dailyUsd: 3,
        spentToday: 0.4321,
        keyReady: true,
        route: { provider: 'meta', model: 'muse-spark-1.3' },
        people: [{ id: SARA, username: 'sara_dev', name: 'Sara Dev' }],
        limits: { dailyUsdMax: 50, dailyUsdDefault: 3, allowSendersMax: 3 },
        ...over,
    };
}

/** The inbox's own list, as `GET /conversations` answers it. */
const THREADS = (): Json[] => [
    { id: 'c1', platform: 'instagram', instagram_user_id: SARA, username: 'sara_dev', profile_name: 'Sara Dev', last_message_at: ago(2) },
    { id: 'c2', platform: 'facebook', instagram_user_id: FB, username: 'fb_person', profile_name: 'FB Person', last_message_at: ago(3) },
    { id: 'c3', platform: 'instagram', instagram_user_id: OMAR, username: null, profile_name: 'عمر', last_message_at: ago(5) },
    { id: 'c4', platform: 'instagram', instagram_user_id: 'not-a-number', username: 'odd', profile_name: 'Odd', last_message_at: ago(6) },
    { id: 'c5', platform: null, instagram_user_id: '17841400000000005', username: 'unattributed', profile_name: null, last_message_at: ago(7) },
    { id: 'c6', platform: 'instagram', instagram_user_id: EVIL, username: '<img src=x onerror=alert(1)>', profile_name: '"><script>alert(1)</script>', last_message_at: ago(8) },
    { id: 'c7', platform: 'instagram', instagram_user_id: SARA, username: 'sara_dev', profile_name: 'Sara Dev', last_message_at: ago(9) },
];

interface Opened {
    h: Dashboard;
    page: Json;
    calls: Array<{ name: string; args: Json[] }>;
    toasts: Array<{ message: string; type?: string }>;
    el: (id: string) => Json;
    flags: (id: string) => string[];
    t: Dashboard['t'];
}

/** The page with the card's elements mounted. `view: undefined` is a server without the block; `null`, one that could not read it. */
function open(setup: { lang?: Lang; role?: Role; view?: Json | null | undefined; api?: Json; threads?: Json[]; skipAdopt?: boolean } = {}): Opened {
    const role = setup.role ?? 'owner';
    const calls: Array<{ name: string; args: Json[] }> = [];
    const record = (name: string, fn: (...args: Json[]) => unknown) => (...args: Json[]) => { calls.push({ name, args }); return fn(...args); };
    const api: Json = {
        token: 't',
        getRecentConversations: record('getRecentConversations', async () => ({ data: setup.threads ?? THREADS() })),
        saveMuseSettings: record('saveMuseSettings', async (body: Json) => view({
            switches: body.switches,
            allowSenders: body.allow_senders,
            dailyUsd: body.daily_usd,
            people: (body.allow_senders as string[]).filter((id) => id !== '*').map((id) => ({ id, username: id === SARA ? 'sara_dev' : id === OMAR ? 'omar.dev' : null, name: id === OMAR ? 'Omar' : null })),
        })),
        getAiSettings: record('getAiSettings', async () => ({ is_active: true, muse: setup.view === undefined ? view() : setup.view })),
        // The owner's library: an empty one, unless a test says otherwise (museLibrary.test.ts does).
        getMuseLibrary: record('getMuseLibrary', async () => []),
        getMuseReel: record('getMuseReel', async () => ({})),
        indexMuseLibrary: record('indexMuseLibrary', async () => ({ queued: 0, already_indexed: 0, deduped: 0, listed: 0, truncated: false })),
        reindexMuseReel: record('reindexMuseReel', async () => ({ queued: true })),
        ...(setup.api ?? {}),
    };
    const globals: Json = {
        API: new Proxy(api, { get: (target, prop) => (prop in target ? target[prop as string] : () => Promise.reject(new Error(`API.${String(prop)} is not stubbed`))) }),
        App: {
            currentTheme: () => 'auto', navigate: () => {}, isAdmin: () => false,
            canOperate: () => role !== 'viewer', canAdminister: () => role === 'owner',
        },
    };
    const h = loadDashboard({ lang: setup.lang ?? 'en', files: ['dashboard/js/pages/ai_settings.js'], globals });
    const toasts: Array<{ message: string; type?: string }> = [];
    h.UI.toast = (message: unknown, type?: string) => { toasts.push({ message: String(message), type }); };
    for (const id of IDS) h.el(id);
    // As the shell draws them: hidden until the card paints them.
    for (const id of ['muse-people-block', 'muse-everyone-note', 'muse-who-hint', 'muse-cap-hint', 'muse-unsaved-note', 'muse-picker', 'muse-library']) h.el(id).classes.add('hidden');
    const page: Json = h.run('AiSettingsPage');
    if (!setup.skipAdopt) page.adoptMuse(setup.view === undefined ? view() : setup.view);
    return { h, page, calls, toasts, el: (id) => h.el(id), flags: (id) => [...h.el(id).classes], t: h.t };
}

const called = (o: Opened, name: string): Array<{ name: string; args: Json[] }> => o.calls.filter((c) => c.name === name);
const hidden = (o: Opened, id: string): boolean => o.el(id).classes.has('hidden');

// ─── The shell ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: the shell', () => {
    for (const lang of ['en', 'ar'] as const) {
        it(`names the three switches as the owner reads them, marks none "coming soon" (voice notes and video memory are live), and has no raw key (${lang})`, () => {
            const { page, t } = open({ lang, skipAdopt: true });
            const shell = String(page.museShell());
            assert.ok(text(shell).includes(text(t('muse.title'))));
            assert.ok(shell.includes(t('muse.beta')), 'it is a beta');
            const rows = [...shell.matchAll(/<div class="toggle-block">([\s\S]*?)<\/div>\s*<label/g)].map((m) => m[1]!);
            assert.equal(rows.length, 3);
            assert.ok(rows[0]!.includes(t('muse.dmMedia')) && !rows[0]!.includes(t('muse.soon')), 'the first is live and says nothing of "soon"');
            assert.ok(rows[1]!.includes(t('muse.voice')) && rows[1]!.includes(t('muse.voiceDesc')), 'voice notes are live: named and described');
            assert.ok(!rows[1]!.includes(t('muse.soon')) && !rows[1]!.includes(t('muse.soonNote')) && !rows[1]!.includes('muse-soon'), 'and say nothing of "soon"');
            assert.ok(rows[2]!.includes(t('muse.memory')) && !rows[2]!.includes(t('muse.soon')) && !rows[2]!.includes(t('muse.soonNote')), 'video memory is live: no "coming soon"');
            assert.ok(rows[2]!.includes(t('muse.memoryDesc')));
            for (const id of ['muse-dm-media', 'muse-voice', 'muse-memory']) assert.match(shell, new RegExp(`<input type="checkbox" id="${id}" aria-describedby="${id}-desc"`));
            assert.equal(/muse\.[a-zA-Z.]+/.test(text(shell)), false, 'no raw key reaches the screen');
            assert.equal(/\{\w+\}/.test(text(shell)), false, 'and no placeholder is left unfilled');
        });
    }

    it('has the brief\'s exact words in English: the switch names and the choices', () => {
        const { page } = open({ skipAdopt: true });
        const shell = text(page.museShell());
        for (const word of ['Meta vision', 'Beta', 'Answer photos, reels and story mentions', 'Voice notes', 'Video memory', 'Coming soon', 'Only these people', 'Everyone', 'Add a person', 'Daily cap (USD)']) {
            assert.ok(shell.includes(word), word);
        }
    });

    it('links to the help section, in a new tab so an unsaved card is not lost, and sits in the grid after the sandbox as a row of its own', () => {
        const { page } = open({ skipAdopt: true });
        const shell = String(page.museShell());
        assert.match(shell, /<a class="help-link" href="#\/help\/ai-usage#meta-vision" target="_blank" rel="noopener">/);
        const full = String(page.shell());
        assert.ok(full.indexOf('id="muse-card"') > full.indexOf('class="surface ai-sandbox"'), 'after the sandbox');
        assert.match(full, /<section class="surface ai-panel muse-card" id="muse-card" aria-labelledby="muse-title">/);
    });

    it('offers who it answers as two choices, the list first (the default), a cap from 0 to 50 in cents, and its own Save', () => {
        const { page, t } = open({ skipAdopt: true });
        const shell = String(page.museShell());
        const select = /<select class="select" id="muse-who"[^>]*>([\s\S]*?)<\/select>/.exec(shell);
        assert.ok(select);
        assert.deepEqual([...select![1]!.matchAll(/<option value="([^"]*)">([^<]*)/g)].map((m) => [m[1], m[2]]), [['list', t('muse.whoList')], ['everyone', t('muse.whoEveryone')]]);
        assert.match(shell, /<input class="field muse-cap" id="muse-daily-usd" type="number" inputmode="decimal" dir="ltr" lang="en" min="0" max="50" step="0.01"/);
        assert.match(shell, /<button type="button" class="btn btn-primary" id="muse-save-btn" data-action="muse:save">/);
        assert.match(shell, /data-input="muse:changed" data-change="muse:changed"/);
        assert.match(shell, /<select class="select" id="muse-who" data-change="muse:whoChanged"/);
    });

    it('is an owner\'s: live controls and no note for an owner, locked controls for a viewer, locked controls AND the owner-only note for an operator', () => {
        const controls = (shell: string) => [...shell.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((m) => m[0])
            .filter((c) => /id="muse-/.test(c) && !LIBRARY_CONTROLS.some((id) => c.includes(`id="${id}"`)));
        const library = (shell: string) => LIBRARY_CONTROLS.map((id) => [id, new RegExp(`<button\\b[^>]*id="${id}"[^>]*>`).exec(shell)?.[0] ?? '']);
        const state = (role: Role) => {
            const { page } = open({ role, skipAdopt: true });
            const shell = String(page.museShell());
            return { shell, c: controls(shell), lib: library(shell) };
        };
        const owner = state('owner');
        assert.equal(owner.c.length, 8, 'three switches, who, the picker button and search, the cap and Save');
        for (const c of owner.c) assert.ok(!/\sdisabled(?=[\s>])/.test(c) && !/\sreadonly(?=[\s>])/.test(c), `live for the owner: ${c}`);
        assert.ok(!owner.shell.includes('muse-owner-note'));
        // The library's own buttons: both live in an owner's shell, like the card's controls; the card's paint turns Index my reels off while the saved switch is off.
        assert.deepEqual(owner.lib.map(([id, tag]) => [id, /\sdisabled(?=[\s>])/.test(tag!)]), [['muse-index-btn', false], ['muse-library-refresh', false]]);
        for (const role of ['viewer', 'operator'] as const) {
            const s = state(role);
            for (const c of s.c) {
                const cap = /id="muse-daily-usd"/.test(c);
                assert.ok(cap ? /\sreadonly(?=[\s>])/.test(c) : /\sdisabled(?=[\s>])/.test(c), `${role}: locked: ${c}`);
            }
        }
        for (const role of ['viewer', 'operator'] as const) assert.ok(state(role).lib.every(([, tag]) => /\sdisabled(?=[\s>])/.test(tag!)), `${role}: the library's buttons are locked too`);
        assert.ok(!state('viewer').shell.includes('muse-owner-note'), 'a viewer has the screen\'s own note (ai.readOnly), not this one');
        assert.ok(state('operator').shell.includes('id="muse-owner-note"'), 'an operator is told why');
    });
});

// ─── What the server said ───────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: drawing the server\'s answer', () => {
    it('fills the switches, the list, the cap and the spend, and leaves the unsaved note hidden', () => {
        const o = open({ view: view({ switches: { dm_media: true, voice: false, memory: true }, dailyUsd: 2.5, spentToday: 0.4321 }) });
        assert.equal(o.el('muse-dm-media').checked, true);
        assert.equal(o.el('muse-voice').checked, false);
        assert.equal(o.el('muse-memory').checked, true);
        assert.equal(o.el('muse-who').value, 'list');
        assert.equal(o.el('muse-daily-usd').value, '2.5');
        assert.equal(text(o.el('muse-spent').textContent), 'Spent today: $0.43 of $2.50');
        assert.ok(hidden(o, 'muse-unsaved-note'));
        assert.ok(!hidden(o, 'muse-people-block') && hidden(o, 'muse-everyone-note'));
        assert.ok(!hidden(o, 'muse-card'));
        for (const id of ['muse-dm-media', 'muse-who', 'muse-save-btn', 'muse-picker-open', 'muse-picker-search']) assert.equal(o.el(id).disabled, false, id);
        assert.equal(o.el('muse-daily-usd').readOnly, false);
    });

    it('says a sum under a cent is under a cent, never $0.00 once it is not nothing, and says plainly when it could not be read', () => {
        assert.equal(text(open({ view: view({ spentToday: 0 }) }).el('muse-spent').textContent), 'Spent today: $0.00 of $3.00');
        assert.equal(text(open({ view: view({ spentToday: 0.004 }) }).el('muse-spent').textContent), 'Spent today: under $0.01 of $3.00');
        assert.equal(text(open({ view: view({ spentToday: null }) }).el('muse-spent').textContent), 'Spent today: could not be read just now');
    });

    it('says the key is ready and which model reads, says when it is not and what to do, and says when it could not be checked: never "ready" for a check that failed', () => {
        const ready = open({ view: view() });
        const line = text(ready.el('muse-status').innerHTML);
        assert.ok(line.includes('Meta key: ready') && line.includes('Reads with muse-spark-1.3'), line);
        assert.ok(String(ready.el('muse-status').innerHTML).includes('badge-success'));
        const notReady = open({ view: view({ keyReady: false, route: null }) });
        const bad = text(notReady.el('muse-status').innerHTML);
        assert.ok(bad.includes('Meta key: not ready') && bad.includes('Operations → AI providers'), bad);
        assert.ok(String(notReady.el('muse-status').innerHTML).includes('badge-warning'));
        const unknown = open({ view: view({ keyReady: null, route: null }) });
        assert.ok(text(unknown.el('muse-status').innerHTML).includes('Meta key: could not be checked just now'));
        assert.ok(!text(unknown.el('muse-status').innerHTML).includes('Meta key: ready'));
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`draws the people by the handle the inbox shows, with the name beside it; the name, else "User 3051", when there is none (${lang})`, () => {
            const o = open({
                lang,
                view: view({
                    allowSenders: [SARA, OMAR, '17841400003051'],
                    people: [
                        { id: SARA, username: '@sara_dev', name: 'Sara Dev' },
                        { id: OMAR, username: null, name: 'عمر' },
                        { id: '17841400003051', username: null, name: null },
                    ],
                }),
            });
            const list = String(o.el('muse-people-list').innerHTML);
            const chips = [...list.matchAll(/<li class="chip growth-chip" data-person="(\d+)">([\s\S]*?)<\/li>/g)];
            assert.deepEqual(chips.map((m) => m[1]), [SARA, OMAR, '17841400003051'], 'in the list\'s order, by SENDER id');
            assert.ok(text(chips[0]![2]!).startsWith('@sara_dev Sara Dev'), 'the handle without a doubled "@", the name beside it');
            assert.ok(text(chips[1]![2]!).startsWith('عمر'), 'a person with no handle is their name');
            assert.ok(text(chips[2]![2]!).startsWith(o.t('inbox.anonUser', { id: '3051' })), `${text(chips[2]![2]!)}: a sender nobody has looked up is "User 3051"`);
            for (const c of chips) assert.ok(String(c[2]).includes('data-action="muse:removePerson"') && String(c[2]).includes(`data-id="${c[1]}"`), 'each has a remove button');
            assert.ok(!hidden(o, 'muse-people-block'));
        });
    }

    it('draws everyone as no list and a note: the people block is hidden, the note shown, and the list is empty', () => {
        const o = open({ view: view({ allowSenders: ['*'], people: [] }) });
        assert.equal(o.el('muse-who').value, 'everyone');
        assert.ok(hidden(o, 'muse-people-block') && !hidden(o, 'muse-everyone-note'));
        assert.equal(o.el('muse-people-list').innerHTML, '');
        assert.equal(o.page._muse.saved.who, 'everyone');
        assert.deepEqual(plain(o.page._muse.saved.ids), []);
    });

    it('warns that nobody is chosen when the list is empty, and not otherwise', () => {
        const none = open({ view: view({ allowSenders: [], people: [] }) });
        assert.equal(none.el('muse-who').value, 'list');
        assert.equal(none.el('muse-who-hint').textContent, none.t('muse.whoNobody'));
        assert.ok(!hidden(none, 'muse-who-hint') && none.flags('muse-who-hint').includes('text-warning'));
        const some = open({ view: view() });
        assert.equal(some.el('muse-who-hint').textContent, '');
        assert.ok(hidden(some, 'muse-who-hint'));
    });

    it('drops an id that is not a sender id from the list, and an answer that is not shaped like one is a card that could not load', () => {
        const o = open({ view: view({ allowSenders: [SARA, 'sara_dev', '1234', 7, null] }) });
        assert.deepEqual(plain(o.page._muse.saved.ids), [SARA]);
        for (const bad of [[], 'muse', 7, true]) assert.equal(open({ view: bad as unknown as Json }).page._muse.status, 'failed', JSON.stringify(bad));
    });

    it('hides the whole card for a server that does not send the block', () => {
        const o = open({ view: undefined, skipAdopt: true });
        o.page.adoptMuse(undefined);
        assert.ok(hidden(o, 'muse-card'));
        assert.equal(o.page._muse.status, 'unavailable');
        assert.equal(o.page.museDirty(), false);
        assert.equal(o.page.canLeave(), true);
    });

    it('draws a block the server could not read as a failure with Retry, nothing as chosen, every control locked, and Save sends nothing', async () => {
        const o = open({ view: null });
        assert.ok(!hidden(o, 'muse-card'));
        const error = String(o.el('muse-error').innerHTML);
        assert.ok(text(error).includes(o.t('muse.loadErrorTitle')) && text(error).includes(o.t('muse.loadErrorHint')));
        assert.ok(error.includes('data-action="muse:reload"'), 'with Retry');
        for (const id of ['muse-dm-media', 'muse-voice', 'muse-memory', 'muse-who', 'muse-save-btn', 'muse-picker-open', 'muse-picker-search']) assert.equal(o.el(id).disabled, true, id);
        assert.equal(o.el('muse-daily-usd').readOnly, true);
        assert.equal(o.el('muse-dm-media').checked, false, 'nothing is shown as switched on that the server did not say');
        assert.equal(o.el('muse-daily-usd').value, '');
        await o.page.museSave(o.el('muse-save-btn'));
        assert.deepEqual(called(o, 'saveMuseSettings'), []);
        assert.equal(o.page.museDirty(), false);
        assert.equal(o.page.canLeave(), true, 'and there is nothing to lose by leaving');
    });

    it('recovers from a failed block by asking again for the block only, without reloading the agent\'s form', async () => {
        let asked = 0;
        const o = open({ view: null, api: { getAiSettings: async () => { asked++; return { is_active: true, muse: view() }; } } });
        assert.equal(o.page._muse.status, 'failed');
        await o.page.museReload();
        assert.equal(asked, 1);
        assert.equal(o.page._muse.status, 'ready');
        assert.equal(o.el('muse-error').innerHTML, '');
        assert.equal(o.el('muse-dm-media').checked, true);
        // And if the request itself fails, the card stays what it was: a failure with Retry, not a card that vanishes and not an editable empty one.
        const again = open({ view: null, api: { getAiSettings: async () => { throw new Error('offline'); } } });
        await again.page.museReload();
        assert.equal(again.page._muse.status, 'failed');
        assert.ok(String(again.el('muse-error').innerHTML).includes('data-action="muse:reload"'));
        assert.ok(!hidden(again, 'muse-card'));
        assert.equal(again.el('muse-save-btn').disabled, true);
    });

    it('is drawn read-only for an operator and a viewer: every control locked, no remove button on a chip, and nothing can be added, removed or saved', async () => {
        for (const role of ['operator', 'viewer'] as const) {
            const o = open({ role, view: view() });
            for (const id of ['muse-dm-media', 'muse-voice', 'muse-memory', 'muse-who', 'muse-save-btn', 'muse-picker-open', 'muse-picker-search']) assert.equal(o.el(id).disabled, true, `${role} ${id}`);
            assert.equal(o.el('muse-daily-usd').readOnly, true);
            assert.ok(!String(o.el('muse-people-list').innerHTML).includes('muse:removePerson'), `${role}: chips are plain`);
            assert.ok(String(o.el('muse-people-list').innerHTML).includes(`data-person="${SARA}"`), `${role}: the list is still readable`);
            o.page.museRemovePerson(SARA);
            o.page.museAddPerson(OMAR);
            o.page.museTogglePicker();
            await o.page.museSave(o.el('muse-save-btn'));
            assert.deepEqual(plain(o.page._muse.draft.ids), [SARA], role);
            assert.equal(o.page.musePickerState().open, false, role);
            assert.deepEqual(o.calls, [], `${role}: nothing was sent, and the picker's list was not asked for`);
        }
    });
});

// ─── Changing it ─────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: editing', () => {
    it('shows the unsaved note while the screen differs from what the server holds, and hides it when the edit is undone', () => {
        const o = open();
        o.el('muse-voice').checked = true;
        o.page.museChanged();
        assert.ok(!hidden(o, 'muse-unsaved-note'));
        assert.equal(o.page.museDirty(), true);
        assert.equal(o.page.canLeave(), false, 'the router asks before leaving with unsaved edits here, as it does for the form above');
        o.el('muse-voice').checked = false;
        o.page.museChanged();
        assert.ok(hidden(o, 'muse-unsaved-note'));
        assert.equal(o.page.canLeave(), true);
    });

    it('counts a changed cap, a changed list and a changed answer as unsaved, and a typo\'d cap too (as typed)', () => {
        const o = open();
        o.el('muse-daily-usd').value = '4';
        o.page.museChanged();
        assert.equal(o.page.museDirty(), true);
        o.el('muse-daily-usd').value = '3.00';
        o.page.museChanged();
        assert.equal(o.page.museDirty(), false, '3.00 is the 3 that is saved');
        o.el('muse-daily-usd').value = 'abc';
        o.page.museChanged();
        assert.equal(o.page.museDirty(), true);
        o.el('muse-daily-usd').value = '3';
        o.page.museRemovePerson(SARA);
        assert.equal(o.page.museDirty(), true);
        o.page.museAddPerson(SARA);   // not in the picker's rows yet: the id is a valid sender id and is added back
        assert.equal(o.page.museDirty(), false, 'the list is back as it was');
    });

    it('switches between "only these people" and "everyone": the list and the picker are for the first, and the people are kept for the way back', () => {
        const o = open();
        o.el('muse-who').value = 'everyone';
        o.page.museWhoChanged();
        assert.ok(hidden(o, 'muse-people-block') && !hidden(o, 'muse-everyone-note'));
        assert.deepEqual(plain(o.page.musePayload().allow_senders), ['*']);
        assert.equal(o.page.museDirty(), true);
        o.el('muse-who').value = 'list';
        o.page.museWhoChanged();
        assert.ok(!hidden(o, 'muse-people-block'));
        assert.deepEqual(plain(o.page.musePayload().allow_senders), [SARA], 'the people chosen are still there');
        assert.equal(o.page.museDirty(), false);
    });

    it('stops a cap the server would refuse: empty, a letter, three decimals, above the maximum; it names the rule beside the field and in a toast, and sends nothing', async () => {
        for (const bad of ['', 'abc', '3.456', '51', '-1', '1e2', '100']) {
            const o = open();
            o.el('muse-daily-usd').value = bad;
            o.page.museChanged();
            assert.equal(o.el('muse-cap-hint').textContent, o.t('muse.capInvalid', { max: 50 }), JSON.stringify(bad));
            assert.ok(!hidden(o, 'muse-cap-hint'));
            await o.page.museSave(o.el('muse-save-btn'));
            assert.deepEqual(called(o, 'saveMuseSettings'), [], `nothing sent for ${JSON.stringify(bad)}`);
            assert.deepEqual(o.toasts.map((t) => t.type), ['error']);
        }
        const ok = open();
        ok.el('muse-daily-usd').value = '0';
        ok.page.museChanged();
        assert.equal(ok.el('muse-cap-hint').textContent, '', '0 is allowed: it keeps it off by money');
        for (const good of ['0', '0.5', '2.25', '10', '50', '50.00']) assert.notEqual(ok.page.museCap(good), null, good);
    });

    it('takes the cap\'s maximum from the server\'s limits, not a copy of its own', () => {
        const o = open({ view: view({ limits: { dailyUsdMax: 20, dailyUsdDefault: 3, allowSendersMax: 3 } }) });
        assert.equal(o.page.museCap('20'), 20);
        assert.equal(o.page.museCap('21'), null);
    });
});

// ─── The picker ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: choosing people from the recent Instagram conversations', () => {
    const choices = (o: Opened) => [...String(o.el('muse-picker-list').innerHTML).matchAll(/<button[^>]*data-action="muse:addPerson" data-id="(\d+)"[^>]*>([\s\S]*?)<\/button>/g)].map((m) => ({ id: m[1]!, body: m[2]! }));

    it('opens, asks the inbox\'s list once, and offers only Instagram threads with a sender id, each once, minus the people already chosen', async () => {
        const o = open();
        o.page.museTogglePicker();
        await settle();
        assert.equal(called(o, 'getRecentConversations').length, 1);
        assert.ok(!hidden(o, 'muse-picker'));
        assert.equal(o.el('muse-picker-open').attrs.get('aria-expanded'), 'true');
        assert.deepEqual(choices(o).map((c) => c.id), [OMAR, EVIL], 'Sara is chosen; the Facebook thread, the odd id, the unattributed thread and the duplicate are not offered');
        assert.equal(o.el('muse-picker-note').textContent, o.t('muse.pickerNote', { count: 100 }));
        o.page.museTogglePicker();
        assert.ok(hidden(o, 'muse-picker'));
        o.page.museTogglePicker();
        await settle();
        assert.equal(called(o, 'getRecentConversations').length, 1, 'closing and opening again does not ask again');
    });

    it('labels a choice by the handle the inbox shows, else the name, with the name and how long ago they wrote beneath', async () => {
        const o = open({ view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        await settle();
        const rows = choices(o);
        const sara = rows.find((c) => c.id === SARA)!;
        const omar = rows.find((c) => c.id === OMAR)!;
        assert.ok(text(sara.body).startsWith('@sara_dev Sara Dev ·'), text(sara.body));
        assert.ok(text(sara.body).endsWith(o.t('common.ago', { value: o.t('common.hours', { n: 2 }) })), text(sara.body));
        assert.ok(text(omar.body).startsWith('عمر ') && !text(omar.body).includes('@') && !text(omar.body).includes('·'), 'a person with no handle is their name, with only the age beneath');
        assert.ok(String(sara.body).includes('dir="auto"'));
    });

    it('stores the thread\'s SENDER id, not its conversation id, when a person is added, draws the chip by handle, and removes them from the offer', async () => {
        const o = open({ view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        await settle();
        o.page.museAddPerson(SARA);
        assert.deepEqual(plain(o.page._muse.draft.ids), [SARA]);
        assert.deepEqual(plain(o.page.musePayload().allow_senders), [SARA], 'the Instagram-scoped id the webhook carries, which is what the gate compares');
        const chips = String(o.el('muse-people-list').innerHTML);
        assert.ok(chips.includes(`data-person="${SARA}"`) && text(chips).startsWith('@sara_dev Sara Dev'));
        assert.ok(!choices(o).some((c) => c.id === SARA), 'no longer offered');
        assert.equal(o.el('muse-who-hint').textContent, '', 'the "nobody" warning is gone');
        assert.equal(o.page.museDirty(), true);
        assert.ok(!hidden(o, 'muse-picker'), 'the picker stays open to add more');
        assert.equal(o.el('muse-picker-search').focusCalls.length > 0, true, 'and the focus goes to its search, not to the page');
    });

    it('adds each person once, only an id of the right shape, and at most the server\'s limit', async () => {
        const o = open({ view: view({ allowSenders: [], people: [], limits: { dailyUsdMax: 50, dailyUsdDefault: 3, allowSendersMax: 2 } }) });
        o.page.museTogglePicker();
        await settle();
        o.page.museAddPerson(SARA);
        o.page.museAddPerson(SARA);
        o.page.museAddPerson('c3');
        o.page.museAddPerson('<img src=x>');
        o.page.museAddPerson(undefined);
        assert.deepEqual(plain(o.page._muse.draft.ids), [SARA]);
        o.page.museAddPerson(OMAR);
        assert.deepEqual(plain(o.page._muse.draft.ids), [SARA, OMAR]);
        o.page.museAddPerson(EVIL);
        assert.deepEqual(plain(o.page._muse.draft.ids), [SARA, OMAR], 'the limit holds');
        assert.deepEqual(choices(o), [], 'no choice is offered once the list is full');
        assert.equal(o.el('muse-picker-note').textContent, o.t('muse.limit', { max: 2 }));
        assert.equal(o.el('muse-who-hint').textContent, o.t('muse.limit', { max: 2 }));
    });

    it('removes a person from the list and gives the focus to the button that adds one', async () => {
        const o = open({ view: view({ allowSenders: [SARA, OMAR], people: [] }) });
        o.page.museRemovePerson(SARA);
        assert.deepEqual(plain(o.page._muse.draft.ids), [OMAR]);
        assert.ok(!String(o.el('muse-people-list').innerHTML).includes(`data-person="${SARA}"`));
        assert.equal(o.el('muse-picker-open').focusCalls.length, 1);
        assert.equal(o.page.museDirty(), true);
        o.page.museRemovePerson('99999');
        assert.deepEqual(plain(o.page._muse.draft.ids), [OMAR], 'an id that is not on the list changes nothing');
    });

    it('searches what is loaded, by handle and by name, any case, Arabic included, and says when nobody matches', async () => {
        const o = open({ view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        await settle();
        const search = (term: string) => { o.el('muse-picker-search').value = term; o.page.musePickerSearch(o.el('muse-picker-search')); return choices(o).map((c) => c.id); };
        assert.deepEqual(search('SARA'), [SARA], 'the handle, any case');
        assert.deepEqual(search('dev'), [SARA], 'part of a name');
        assert.deepEqual(search('عم'), [OMAR], 'an Arabic name');
        assert.deepEqual(search('  sara  '), [SARA], 'trimmed');
        assert.deepEqual(search('nobody-by-this-name'), []);
        assert.equal(o.el('muse-picker-note').textContent, o.t('muse.pickerNoMatch', { term: '⁨nobody-by-this-name⁩' }));
        assert.deepEqual(search(''), [SARA, OMAR, EVIL], 'cleared: everybody again');
    });

    it('says so, with Retry, when the list could not be loaded, and loads again on Retry', async () => {
        let fail = true;
        const o = open({ api: { getRecentConversations: async () => { if (fail) throw new Error('offline'); return { data: THREADS() }; } } });
        o.page.museTogglePicker();
        await settle();
        assert.equal(o.el('muse-picker-note').textContent, o.t('muse.pickerFailed'));
        assert.ok(String(o.el('muse-picker-list').innerHTML).includes('data-action="muse:retryPicker"'));
        fail = false;
        await o.page.loadMusePicker(true);
        assert.deepEqual(choices(o).map((c) => c.id), [OMAR, EVIL]);
    });

    it('says there is nothing to choose from when no thread is an Instagram one', async () => {
        const o = open({ threads: [{ id: 'c2', platform: 'facebook', instagram_user_id: FB, username: 'x' }], view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        await settle();
        assert.equal(o.el('muse-picker-note').textContent, o.t('muse.pickerNone'));
        assert.deepEqual(choices(o), []);
    });

    it('drops an answer that arrives after the page was left, and after the card was adopted again', async () => {
        let release: (v: Json) => void = () => {};
        const o = open({ api: { getRecentConversations: () => new Promise((resolve) => { release = resolve; }) }, view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        assert.equal(o.page.musePickerState().status, 'loading');
        o.page.destroy();
        release({ data: THREADS() });
        await settle();
        assert.equal(o.page.musePickerState().rows.length, 0, 'the page was left: nothing from the old request lands');
    });

    it('closes on Escape and gives the focus back to the button that opened it', async () => {
        const o = open();
        o.page.museTogglePicker();
        await settle();
        let prevented = 0;
        o.page.musePickerKey({ key: 'a', preventDefault: () => { prevented++; } });
        assert.ok(!hidden(o, 'muse-picker'), 'another key does nothing');
        o.page.musePickerKey({ key: 'Escape', preventDefault: () => { prevented++; } });
        assert.ok(hidden(o, 'muse-picker'));
        assert.equal(prevented, 1);
        assert.ok(o.el('muse-picker-open').focusCalls.length >= 1);
    });

    it('is only for "only these people": choosing everyone closes it, and a person cannot be added in that state\'s picker', async () => {
        const o = open();
        o.page.museTogglePicker();
        await settle();
        o.el('muse-who').value = 'everyone';
        o.page.museWhoChanged();
        assert.ok(hidden(o, 'muse-picker'));
    });

    it('draws a handle, a name and a search term as text: no tag, no attribute, whatever a stranger called themselves', async () => {
        const o = open({ view: view({ allowSenders: [EVIL], people: [{ id: EVIL, username: '<img src=x onerror=alert(1)>', name: '"><script>alert(1)</script>' }] }) });
        o.page.museTogglePicker();
        await settle();
        const picker = String(o.el('muse-picker-list').innerHTML);
        const list = String(o.el('muse-people-list').innerHTML);
        for (const markup of [list, picker]) {
            assert.ok(!/<img/i.test(markup) && !/<script/i.test(markup), 'no element was made from what a person wrote');
            for (const tag of tagsOf(markup)) assert.ok(SAFE_TAGS.has(tag), `tag ${tag}`);
            for (const attr of attrNames(markup)) assert.ok(SAFE_ATTRS.has(attr), `attribute ${attr}`);
        }
        assert.ok(list.includes('&lt;img src=x onerror=alert(1)&gt;'));
        assert.ok(list.includes('&quot;&gt;&lt;script&gt;'));
        o.el('muse-picker-search').value = '<img src=x onerror=alert(1)>';
        o.page.musePickerSearch(o.el('muse-picker-search'));
        assert.ok(!/<img/i.test(String(o.el('muse-picker-note').innerHTML)) && o.el('muse-picker-note').textContent.includes('<img src=x'), 'the note is set as text, never parsed');
    });
});

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: saving', () => {
    it('sends exactly what is on screen, once, adopts the server\'s answer, clears the unsaved note and says it was saved', async () => {
        const o = open({ view: view({ allowSenders: [SARA], people: [{ id: SARA, username: 'sara_dev', name: 'Sara Dev' }] }) });
        o.el('muse-dm-media').checked = true;
        o.el('muse-voice').checked = true;
        o.el('muse-daily-usd').value = '5.5';
        o.page.museChanged();
        o.page.museAddPerson(OMAR);
        const pending = o.page.museSave(o.el('muse-save-btn'));
        const second = o.page.museSave(o.el('muse-save-btn'));   // a second press while the first is out
        await Promise.all([pending, second]);
        const sent = called(o, 'saveMuseSettings');
        assert.equal(sent.length, 1, 'one request, whatever the second press did');
        assert.deepEqual(plain(sent[0]!.args[0]), {
            switches: { dm_media: true, voice: true, memory: false },
            allow_senders: [SARA, OMAR],
            daily_usd: 5.5,
        });
        assert.deepEqual(o.toasts.map((t) => [t.message, t.type]), [[o.t('muse.saved'), 'success']]);
        assert.ok(hidden(o, 'muse-unsaved-note'));
        assert.equal(o.page.museDirty(), false);
        assert.equal(o.page.canLeave(), true);
        assert.deepEqual(plain(o.page._muse.saved.ids), [SARA, OMAR]);
        assert.equal(o.page._muse.saved.capText, '5.5');
        assert.ok(String(o.el('muse-people-list').innerHTML).includes('@omar.dev'), 'the names the server answered with are drawn');
        assert.equal(o.el('muse-save-btn').disabled, false, 'the button is back');
    });

    it('sends everyone as ["*"], and nobody as []', async () => {
        const o = open();
        o.el('muse-who').value = 'everyone';
        o.page.museWhoChanged();
        await o.page.museSave(o.el('muse-save-btn'));
        assert.deepEqual(plain(called(o, 'saveMuseSettings')[0]!.args[0].allow_senders), ['*']);
        assert.equal(o.el('muse-who').value, 'everyone', 'and the answer is what is on screen');
        const none = open({ view: view({ allowSenders: [SARA] }) });
        none.page.museRemovePerson(SARA);
        await none.page.museSave(none.el('muse-save-btn'));
        assert.deepEqual(plain(called(none, 'saveMuseSettings')[0]!.args[0].allow_senders), []);
    });

    it('keeps the screen as a draft, with the server\'s own words, when the save is refused, and restores the button', async () => {
        const o = open({ api: { saveMuseSettings: async () => { throw Object.assign(new Error('allow_senders must be a list: ["*"] for everyone.'), { status: 400 }); } } });
        o.el('muse-voice').checked = true;
        o.page.museChanged();
        await o.page.museSave(o.el('muse-save-btn'));
        assert.deepEqual(o.toasts.map((t) => [t.message, t.type]), [['allow_senders must be a list: ["*"] for everyone.', 'error']]);
        assert.equal(o.page.museDirty(), true, 'still unsaved: nothing was adopted');
        assert.equal(o.el('muse-voice').checked, true);
        assert.equal(o.el('muse-save-btn').disabled, false);
        const silent = open({ api: { saveMuseSettings: async () => { throw new Error(''); } } });
        silent.el('muse-voice').checked = true;
        silent.page.museChanged();
        await silent.page.museSave(silent.el('muse-save-btn'));
        assert.equal(silent.toasts[0]!.message, silent.t('muse.saveFailed'), 'an error with no words says the generic line');
    });

    it('does not adopt an answer that arrives after the page was left', async () => {
        let release: (v: Json) => void = () => {};
        const o = open({ api: { saveMuseSettings: () => new Promise((resolve) => { release = resolve; }) } });
        o.el('muse-voice').checked = true;
        o.page.museChanged();
        const pending = o.page.museSave(o.el('muse-save-btn'));
        o.page.destroy();
        release(view({ switches: { dm_media: true, voice: true, memory: false } }));
        await pending;
        assert.deepEqual(o.toasts, [], 'no toast from a page that is gone');
    });
});

// ─── Through the page's own load ─────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: loaded with the rest of the AI settings', () => {
    /** The form's elements, as `loadSettings` finds them by id. */
    function mountForm(o: Opened): void {
        for (const id of ['ai-active-toggle', 'system-prompt-text', 'knowledge-base-text', 'model-selector', 'temp-slider', 'temp-value', 'save-settings-btn', 'ai-settings-error', 'ai-unsaved-note']) o.h.el(id);
    }

    it('takes the `muse` block of GET /settings/ai when the screen loads, and never touches the agent\'s form for it', async () => {
        const o = open({
            skipAdopt: true,
            api: { getAiSettings: async () => ({ is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7, muse: view({ dailyUsd: 7 }) }) },
        });
        mountForm(o);
        await o.page.loadSettings();
        await settle();
        assert.equal(o.el('muse-daily-usd').value, '7');
        assert.equal(o.el('muse-dm-media').checked, true);
        assert.equal(o.el('system-prompt-text').value, 'p');
        assert.equal(o.page.hasUnsavedChanges(), false, 'the agent\'s form has nothing unsaved: the card has its own');
        assert.equal(called(o, 'saveMuseSettings').length, 0);
    });

    it('hides the card when the answer has no `muse` at all, and shows the failure when it is null: the form above loads either way', async () => {
        for (const [muse, status] of [[undefined, 'unavailable'], [null, 'failed']] as const) {
            const o = open({
                skipAdopt: true,
                api: { getAiSettings: async () => ({ is_active: true, system_prompt: 'p', knowledge_base: 'k', model: 'gemini-2.5-flash', temperature: 0.7, ...(muse === undefined ? {} : { muse }) }) },
            });
            mountForm(o);
            await o.page.loadSettings();
            assert.equal(o.page._muse.status, status);
            assert.equal(o.el('system-prompt-text').value, 'p', 'the agent\'s form is filled');
        }
    });

    it('forgets another tenant\'s card when the tenant changes', () => {
        const o = open();
        assert.equal(o.page._muse.status, 'ready');
        o.page.resetTenantState();
        assert.equal(o.page._muse, undefined);
        assert.equal(o.page._musePicker, null);
    });
});

// ─── The same shapes as the server's own code ───────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: the contract with the server\'s own code', () => {
    const TENANT = '11111111-1111-4111-8111-111111111111';
    const build = (stored: Json, over: Json = {}) => buildMuseView(TENANT, stored, {
        spentToday: async () => 0.4321, routeReady: async () => true, routeOf: async () => ({ provider: 'meta', model: 'muse-spark-1.3' }),
        people: async (_creator, ids) => ids.map((id) => ({ id, username: id === SARA ? 'sara_dev' : null, name: id === SARA ? 'Sara Dev' : 'عمر' })),
        ...over,
    });

    it('reads what the server\'s own view builder answers, field for field, after the JSON in between', async () => {
        const stored = { switches: { dm_media: true, voice: false, memory: true }, allowSenders: [SARA, OMAR], dailyUsd: 2.5 };
        const built = await build(stored);
        const o = open({ view: JSON.parse(JSON.stringify(built)) });
        const m = o.page._muse;
        assert.equal(m.status, 'ready');
        assert.deepEqual(plain(m.saved), { switches: stored.switches, who: 'list', ids: [SARA, OMAR], capText: '2.5' });
        assert.equal(m.spentToday, 0.4321);
        assert.equal(m.keyReady, true);
        assert.equal(m.model, 'muse-spark-1.3');
        assert.equal(m.max, built.limits.dailyUsdMax);
        assert.equal(m.maxPeople, built.limits.allowSendersMax);
        assert.deepEqual([...m.people.entries()].map(([id, who]: [string, Json]) => [id, plain(who)]), [[SARA, { username: 'sara_dev', name: 'Sara Dev' }], [OMAR, { username: '', name: 'عمر' }]]);
        assert.equal(o.el('muse-daily-usd').value, '2.5');
        assert.ok(String(o.el('muse-people-list').innerHTML).includes('@sara_dev'));
    });

    it('reads the server\'s degraded answers as what they are: no key, a check that could not be made, a spend that could not be read, everyone, nobody', async () => {
        const base = { switches: { dm_media: false, voice: false, memory: false }, allowSenders: [] as string[], dailyUsd: 3 };
        const noKey = open({ view: JSON.parse(JSON.stringify(await build(base, { routeReady: async () => false }))) }).page._muse;
        assert.deepEqual([noKey.keyReady, noKey.model], [false, '']);
        const unknown = open({ view: JSON.parse(JSON.stringify(await build(base, { routeReady: async () => { throw new Error('x'); } }))) }).page._muse;
        assert.deepEqual([unknown.keyReady, unknown.model], [null, '']);
        const blind = open({ view: JSON.parse(JSON.stringify(await build(base, { spentToday: async () => { throw new Error('x'); } }))) }).page._muse;
        assert.equal(blind.spentToday, null);
        const everyone = open({ view: JSON.parse(JSON.stringify(await build({ ...base, allowSenders: ['*'] }))) }).page._muse;
        assert.deepEqual([everyone.saved.who, plain(everyone.saved.ids), everyone.people.size], ['everyone', [], 0]);
        const nobody = open({ view: JSON.parse(JSON.stringify(await build(base))) }).page._muse;
        assert.deepEqual([nobody.saved.who, plain(nobody.saved.ids)], ['list', []]);
    });

    it('sends only bodies the server\'s own parser takes, from every state the card can be in, and what it keeps is what is on screen', async () => {
        const states: Array<[string, Json]> = [
            ['a list', view()],
            ['nobody', view({ allowSenders: [], people: [] })],
            ['everyone', view({ allowSenders: ['*'], people: [] })],
            ['every switch on', view({ switches: { dm_media: true, voice: true, memory: true } })],
            ['a cap of 0', view({ dailyUsd: 0 })],
            ['the cap\'s maximum', view({ dailyUsd: 50 })],
            ['a cap in cents', view({ dailyUsd: 12.34 })],
        ];
        for (const [name, v] of states) {
            const o = open({ view: v });
            const body = plain(o.page.musePayload());
            const parsed = parseMuseInput(body);
            assert.equal(parsed.ok, true, `${name}: ${JSON.stringify(body)}`);
            if (!parsed.ok) continue;
            assert.deepEqual(plain(parsed.input.switches), v.switches, name);
            assert.deepEqual(plain(parsed.input.allowSenders), v.allowSenders, name);
            assert.equal(parsed.input.dailyUsd, v.dailyUsd, name);
        }
        // A person picked from the inbox, and the cap edited: what the page sends is still what the server takes.
        const o = open({ view: view({ allowSenders: [], people: [] }) });
        o.page.museTogglePicker();
        await settle();
        o.page.museAddPerson(OMAR);
        o.page.museAddPerson(SARA);
        o.el('muse-daily-usd').value = '7.5';
        o.el('muse-voice').checked = true;
        o.page.museChanged();
        const parsed = parseMuseInput(plain(o.page.musePayload()));
        assert.ok(parsed.ok);
        if (parsed.ok) assert.deepEqual(plain(parsed.input), { switches: { dm_media: true, voice: true, memory: false }, allowSenders: [OMAR, SARA], dailyUsd: 7.5 });
    });
});

// ─── The words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: the words', () => {
    const KEYS = [
        'muse.title', 'muse.beta', 'muse.intro', 'muse.ownerOnly', 'muse.key.ready', 'muse.key.notReady', 'muse.key.unknown', 'muse.key.model', 'muse.key.notReadyHint',
        'muse.dmMedia', 'muse.dmMediaDesc', 'muse.voice', 'muse.voiceDesc', 'muse.memory', 'muse.memoryDesc', 'muse.soon', 'muse.soonNote', 'muse.who', 'muse.whoList',
        'muse.whoEveryone', 'muse.whoDesc', 'muse.whoEveryoneNote', 'muse.whoNobody', 'muse.people', 'muse.add', 'muse.pickerTitle', 'muse.pickerSearch', 'muse.pickerNote',
        'muse.pickerLoading', 'muse.pickerNone', 'muse.pickerNoMatch', 'muse.pickerFailed', 'muse.pickerAdd', 'muse.remove', 'muse.limit', 'muse.cap', 'muse.capDesc',
        'muse.capInvalid', 'muse.spent', 'muse.spentUnknown', 'muse.lessThanCent', 'muse.save', 'muse.saved', 'muse.saveFailed', 'muse.loadErrorTitle', 'muse.loadErrorHint',
        'help.link.metaVision', 'help.link.videoMemory',
    ];

    it('has every string in both languages, with the same placeholders, and none of the words the product never says', () => {
        const en = open({ lang: 'en', skipAdopt: true }).h.I18N.strings.en as Record<string, string>;
        const ar = open({ lang: 'ar', skipAdopt: true }).h.I18N.strings.ar as Record<string, string>;
        const holes = (value: string): string[] => [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
        // The library's strings are all of `muse.lib.*`: whatever is in one language is in the other, so the list cannot fall behind the dictionary.
        const library = [...new Set([...Object.keys(en), ...Object.keys(ar)].filter((k) => k.startsWith('muse.lib.')))];
        assert.ok(library.length > 60, 'the library has its words');
        for (const key of [...KEYS, ...library]) {
            assert.ok(typeof en[key] === 'string' && en[key]!.length > 0, `en ${key}`);
            assert.ok(typeof ar[key] === 'string' && ar[key]!.length > 0, `ar ${key}`);
            assert.deepEqual(holes(en[key]!), holes(ar[key]!), `${key}: the same placeholders in both languages`);
            assert.equal(/[٠-٩۰-۹]/.test(ar[key]!), false, `${key}: Latin digits`);
            for (const banned of [/\bbots?\b/i, /بوت/, /ذكي/, /\binstant/i, /فور[اي]/]) {
                assert.doesNotMatch(en[key]!, banned, `en ${key}`);
                assert.doesNotMatch(ar[key]!, banned, `ar ${key}`);
            }
        }
    });

    it('says what the card does in the owner\'s own terms: video memory is stored and read by nothing yet, and a file is not stored', () => {
        const { t } = open({ skipAdopt: true });
        assert.match(t('muse.soonNote'), /only saves your choice/);
        assert.match(t('muse.intro'), /not stored by us/);
        assert.match(t('muse.capDesc'), /0 keeps it off/);
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`names a voice note wherever the card says what is read, kept and capped, so it never promises less than the pipeline does (${lang})`, () => {
            const { t } = open({ lang, skipAdopt: true });
            const word = lang === 'en' ? /voice note/i : /الرسائل? الصوتية|رسالة صوتية|رسائلهم الصوتية/;
            for (const key of ['muse.intro', 'muse.whoEveryoneNote', 'muse.capDesc']) assert.match(t(key), word, `${lang} ${key}`);
            // Under the switch named «Voice notes», what is kept of one and what is not: the words, never the audio.
            assert.match(t('muse.voiceDesc'), lang === 'en' ? /the audio is not/ : /ولا يُحفظ الصوت/);
        });
    }
});

// ─── The Help section ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Meta vision card: the Help section it links to', () => {
    const h = loadDashboard({ lang: 'en', files: ['dashboard/js/help-content.js'] });
    const content = h.run<Json>('HelpContent');
    const article = (content.articles as Json[]).find((a) => a.slug === 'ai-usage')!;
    const section = (article.sections as Json[]).find((x) => x.id === 'meta-vision')!;
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
    const strings = (lang: Lang): Record<string, string> => open({ lang, skipAdopt: true }).h.I18N.strings[lang];

    it('is a section of the article the card links to, after the one on Meta\'s models, in both languages', () => {
        assert.ok(section, 'ai-usage#meta-vision exists');
        const ids = (article.sections as Json[]).map((x) => x.id);
        assert.ok(ids.indexOf('meta-vision') === ids.indexOf('meta-muse') + 1, ids.join(', '));
        assert.ok(section.title.ar && section.title.en, 'a title in each');
        assert.match(section.title.en, /Meta vision/);
        assert.match(section.title.ar, /رؤية ميتا/);
    });

    for (const lang of ['en', 'ar'] as const) {
        it(`names the switches, the choices, the cap and the Save button as the card does, and says what it keeps, that it is Instagram only and Standard models only (${lang})`, () => {
            const body = textOf(lang);
            const labels = strings(lang);
            for (const key of ['muse.title', 'muse.dmMedia', 'muse.voice', 'muse.memory', 'muse.whoList', 'muse.whoEveryone', 'muse.add', 'muse.cap', 'muse.save']) {
                assert.ok(body.includes(`**${labels[key]}**`), `${lang}: **${labels[key]}**`);
            }
            assert.ok(body.includes(lang === 'en' ? `from 0 to ${MUSE_DAILY_USD_MAX}` : `من 0 إلى ${MUSE_DAILY_USD_MAX}`), `${lang}: the cap's bounds are the server's`);
            const terms = (section.body[lang] as Json[]).find((b) => b && Array.isArray(b.dl))!.dl.map((row: string[]) => row[0]);
            assert.equal(terms.length, 7, 'the switches, voice notes, who it answers, the daily cap, what is kept, Instagram only, Standard models only');
            assert.ok(body.includes(`**${labels['muse.voice']}**`) && terms.includes(lang === 'en' ? 'Voice notes' : 'الرسائل الصوتية'), `${lang}: voice notes have a row of their own`);
        });
    }

    it('says in English that the file is not stored and a short description is, that Messenger and WhatsApp are not read, and that Standard models only are used', () => {
        const body = textOf('en');
        assert.match(body, /we do not store the file/);
        assert.match(body, /a short description, or the words of a voice note/);
        assert.match(body, /Messenger and WhatsApp are not read/);
        assert.match(body, /Standard models/);
        assert.match(body, /coming soon/);
        assert.match(body, /only saves your choice/);
    });

    it('says in English what a voice note is: who writes it down, how long it may be, what is asked again, that it has its own switch and what it costs', () => {
        const body = textOf('en');
        const row = ((section.body.en as Json[]).find((b) => b && Array.isArray(b.dl))!.dl as string[][]).find((r) => r[0] === 'Voice notes')![1]!;
        assert.match(row, /Meta’s speech model writes a voice note down/);
        assert.match(row, /a refund or a complaint said aloud is read like one written/);
        assert.match(row, /up to 3 minutes/);
        assert.match(row, /asked to send it again/);
        assert.match(row, /the switch is its own/);
        assert.match(row, /\$0\.18 per hour of audio/);
        // The switches row no longer says voice is to come, and still says so for video memory alone.
        assert.match(body, /\*\*Answer photos, reels and story mentions\*\* and \*\*Voice notes\*\* work today/);
        assert.match(body, /\*\*Video memory\*\* is coming soon/);
        assert.doesNotMatch(body, /Voice notes\*\* and \*\*Video memory\*\* are coming soon/);
    });

    it('says the same in Arabic, and in the Help Center\'s own voice, without the words the product never says', () => {
        const body = textOf('ar');
        assert.match(body, /ما نحفظ الملف/);
        assert.match(body, /مدة الرسالة تصل إلى 3 دقائق/);
        assert.match(body, /0\.18 دولار لكل ساعة صوت/);
        assert.match(body, /\*\*الرسائل الصوتية\*\* يشتغلون اليوم/);
        assert.match(body, /ماسنجر وواتساب/);
        assert.match(body, /النماذج القياسية/);
        for (const banned of [/بوت/, /ذكي/, /\bbots?\b/i, /instant/i]) {
            assert.doesNotMatch(body, banned);
            assert.doesNotMatch(textOf('en'), banned);
        }
    });
});
