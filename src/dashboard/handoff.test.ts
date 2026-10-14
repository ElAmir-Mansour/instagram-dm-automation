/**
 * The dashboard's half of DM plan S8: the inbox's "Needs you" flag and filter, the countdown of Meta's 24-hour window, the link in the
 * owner's alert (`#/inbox?c=<id>`), and the Settings card for the Telegram alert and echo takeover.
 *
 * Loaded like the other dashboard tests: the REAL shipped files in a `node:vm` context with a fake DOM, so these test what ships. What is
 * pinned, because a screenshot cannot check it: which threads count as handed over and when that ends, what the countdown says and for
 * whom, that an id in the address bar is data (a UUID or nothing), that the bot token is never in the card's markup, that what a customer
 * typed or the server said is escaped, and that the card sends what the server expects.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

type Json = any;

class FakeFormData {
    private readonly fields: Record<string, unknown>;
    constructor(form: { fields?: Record<string, unknown> } | null) { this.fields = (form && form.fields) || {}; }
    get(name: string): unknown { return Object.prototype.hasOwnProperty.call(this.fields, name) ? this.fields[name] : null; }
}

interface Loaded {
    Inbox: Json;
    Settings: Json;
    UI: Json;
    t: (key: string, params?: Record<string, unknown>) => string;
    hash: Record<string, string>;
    waiting: number[];
    api: Record<string, (...args: Json[]) => unknown>;
    calls: Array<{ method: string; args: Json[] }>;
    toasts: string[];
    dom: Map<string, Json>;
    host(id: string): Json;
}

function load(lang: 'ar' | 'en' = 'en'): Loaded {
    const noop = (): void => {};
    const dom = new Map<string, Json>();
    const api: Record<string, (...args: Json[]) => unknown> = {};
    const calls: Array<{ method: string; args: Json[] }> = [];
    const hash: Record<string, string> = {};
    const waiting: number[] = [];
    const stub = {
        addEventListener: noop, removeEventListener: noop, querySelectorAll: () => [], querySelector: () => null,
        appendChild: noop, setAttribute: noop, getAttribute: () => null, removeAttribute: noop,
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        style: {}, dataset: {}, focus: noop, remove: noop, closest: () => null, contains: () => false, children: [], innerHTML: '', textContent: '',
    };
    const ctx: Json = {
        document: {
            ...stub, createElement: () => ({ ...stub }), body: { ...stub }, head: { ...stub },
            documentElement: { ...stub, lang, dir: lang === 'ar' ? 'rtl' : 'ltr' },
            getElementById: (id: string) => dom.get(id) ?? null, activeElement: null, visibilityState: 'visible',
        },
        window: { addEventListener: noop, removeEventListener: noop, matchMedia: () => ({ matches: false, addEventListener: noop }), location: { hash: '' } },
        Intl, console, clearTimeout, URLSearchParams,
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout: (fn: () => void, ms?: number) => { const h = setTimeout(fn, ms); (h as Json).unref?.(); return h; },
        setInterval: (fn: () => void, ms?: number) => { const h = setInterval(fn, ms); (h as Json).unref?.(); return h; },
        clearInterval, requestAnimationFrame: (f: () => void) => f(),
        navigator: { language: lang }, CSS: { escape: (v: string) => String(v) }, FormData: FakeFormData,
        API: new Proxy(api, {
            get: (target, prop: string) => (prop === 'token' ? 'tok' : prop in target
                ? (...args: Json[]) => { calls.push({ method: prop, args }); return target[prop]!(...args); }
                : () => Promise.reject(new Error(`API.${prop} not stubbed`))),
        }),
        Admin: { emptyState: (_i: string, title: string) => `<div>${title}</div>`, confirm: noop },
        App: {
            currentTheme: () => 'auto', navigate: noop, session: { tenantId: 't1' }, hashParam: (name: string) => hash[name] || '',
            canOperate: () => true, canAdminister: () => true, isAdmin: () => true, setInboxWaiting: (n: number) => { waiting.push(n); },
        },
    };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    for (const f of [
        'dashboard/js/components.js', 'dashboard/js/i18n.js', 'dashboard/js/i18n.ar.js', 'dashboard/js/i18n.en.js', 'dashboard/js/motion.js',
        'dashboard/js/pages/inbox.js', 'dashboard/js/pages/settings.js',
    ]) vm.runInContext(readFileSync(f, 'utf8'), ctx, { filename: f });
    vm.runInContext(`I18N.lang = ${JSON.stringify(lang)};`, ctx);
    const got = vm.runInContext('({ Inbox: InboxPage, Settings: SettingsPage, UI, t })', ctx);
    const toasts: string[] = [];
    got.UI.toast = (m: unknown) => { toasts.push(String(m)); };
    const host = (id: string): Json => {
        const el: Json = { id, innerHTML: '', textContent: '', dataset: {}, classList: stub.classList, scrollIntoView: noop, querySelector: () => null };
        dom.set(id, el);
        return el;
    };
    return { Inbox: got.Inbox, Settings: got.Settings, UI: got.UI, t: got.t, hash, waiting, api, calls, toasts, dom, host };
}

const HOUR = 3600 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');
const at = (msBefore: number): string => new Date(NOW - msBefore).toISOString();
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').replace(/ ([.,:;])/g, '$1').trim();
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));
async function settle(rounds = 8): Promise<void> { for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0)); }

/** A thread the bot handed over to a person two hours ago; the customer's last message was an hour ago. */
const handed = (over: Json = {}): Json => ({
    id: '3f9c2a40-7b1e-4c8d-9a55-0123456789ab', username: 'sara_dev', is_bot_active: false, stage: 'handoff', handoff_at: at(2 * HOUR),
    last_inbound_message_at: at(HOUR), last_operator_at: null, last_message_direction: 'outbound', last_message_at: at(HOUR), ...over,
});

// ─── Needs you ──────────────────────────────────────────────────────────────────────────────

describe('Inbox: which threads need you', () => {
    const { Inbox } = load();

    it('a conversation handed over to a person, with the bot paused and nobody having answered since', () => {
        assert.equal(Inbox.isNeedsYou(handed()), true);
    });

    it('ends when a person replied after the handoff, from the inbox or from the Instagram app, and not when the reply is older than it', () => {
        assert.equal(Inbox.isNeedsYou(handed({ last_operator_at: at(30 * 60 * 1000) })), false, 'replied after');
        assert.equal(Inbox.isNeedsYou(handed({ last_operator_at: at(2 * HOUR) })), false, 'in the same instant: answered');
        assert.equal(Inbox.isNeedsYou(handed({ last_operator_at: at(5 * HOUR) })), true, 'an older reply is not an answer to this handoff');
    });

    it('sales handoff: the bot is paused, and the thread is in Needs you', () => {
        // A refund, a complaint, "I want a person": `handoffDecision` pauses the bot (is_bot_active false) and stamps stage + handoff_at.
        assert.equal(Inbox.isNeedsYou(handed({ is_bot_active: false })), true);
    });

    it('engine failure: the bot is still ON, and the thread is in Needs you all the same', () => {
        // `handoffAfterFailure` stamps stage + handoff_at and leaves is_bot_active alone (an outage is not a request for a person), so the
        // customer's next message gets a normal reply. The owner still has to know that the last one went unanswered.
        const failed = handed({ is_bot_active: true, handoff_reason: 'unsure' });
        assert.equal(Inbox.isNeedsYou(failed), true);
        assert.equal(Inbox.needsHuman(failed), true, 'so it counts on the nav badge and gets the window countdown');
        assert.equal(Inbox.isNeedsYou({ ...failed, last_operator_at: at(60000) }), false, 'and a reply from the owner after it ends it');
    });

    it('ends when the stage moves on: turning the AI back on, or the bot\'s own next turn, and is never true for a thread that was not handed over', () => {
        for (const stage of ['new', 'qualify', 'recommend', 'objection', 'link', 'follow_up', 'closed', undefined, null]) {
            assert.equal(Inbox.isNeedsYou(handed({ stage })), false, String(stage));
            assert.equal(Inbox.isNeedsYou(handed({ stage, is_bot_active: true })), false, `${String(stage)}, bot on`);
        }
        assert.equal(Inbox.isNeedsYou(null), false);
        assert.equal(Inbox.isNeedsYou({}), false, 'a database before v39 flags nothing');
    });

    it('is a handoff even when the stamp is missing or unreadable: the stage says so', () => {
        assert.equal(Inbox.isNeedsYou(handed({ handoff_at: null })), true);
        assert.equal(Inbox.isNeedsYou(handed({ handoff_at: 'not a date', last_operator_at: at(HOUR) })), true);
    });

    it('is its own filter, seeded from the address, and the filter keeps only these', () => {
        const s = load();
        const I = s.Inbox;
        assert.deepEqual(plain(I.FILTERS), ['all', 'waiting', 'needs_you', 'hot', 'paused']);
        s.hash['filter'] = 'needs_you';
        assert.equal(I.filterFromHash(), 'needs_you');
        s.hash['filter'] = 'needs-you';
        assert.equal(I.filterFromHash(), 'all', 'the address is data: anything else is All');
        I.threads = [
            handed({ id: 'a' }), handed({ id: 'b', last_operator_at: at(60000) }), { id: 'c', is_bot_active: false, last_message_direction: 'inbound' },
            { id: 'd', is_bot_active: true }, handed({ id: 'e', is_bot_active: true }),
        ];
        I.filter = 'needs_you';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['a', 'e'], 'paused for a person, or an engine failure with the bot on');
        I.filter = 'waiting';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['c'], 'Needs reply is as it was');
        I.filter = 'paused';
        assert.deepEqual(plain(I.visibleThreads().map((x: Json) => x.id)), ['a', 'b', 'c']);
        assert.ok(String(I.layout()).includes('data-action="inbox:setFilter" data-filter="needs_you"'));
        assert.ok(String(I.emptyMarkup('needs_you')).includes(s.t('inbox.noNeedsYou')));
    });

    it('counts on the nav badge with the threads waiting for a reply, each once', () => {
        const s = load();
        const I = s.Inbox;
        I.threads = [
            handed({ id: 'a' }),                                                                 // handed over, the bot's line was the last message
            handed({ id: 'b', last_message_direction: 'inbound' }),                              // handed over AND waiting: one thread
            { id: 'c', is_bot_active: false, last_message_direction: 'inbound' },                // waiting for a reply
            { id: 'd', is_bot_active: true, last_message_direction: 'inbound' },                 // the AI has it
            handed({ id: 'e', last_operator_at: at(60000) }),                                    // answered
            handed({ id: 'f', is_bot_active: true }),                                            // an engine failure: the bot is on, a person still has to look
        ];
        I.reportWaiting();
        assert.deepEqual(s.waiting, [4]);
    });
});

describe('Inbox: turning the AI back on ends the handoff', () => {
    function ready(threads: Json[]) {
        const s = load();
        const I = s.Inbox;
        I.threads = threads;
        I.renderThreads = (): void => {};
        I.paintAiState = (): void => {};
        I.resetBackoff = (): void => {};
        return { s, I };
    }

    it('moves the stage on at once, as the server does, so the thread leaves Needs you without waiting for the poll', async () => {
        const { s, I } = ready([handed({ id: 'a' }), handed({ id: 'b', is_bot_active: true })]);
        s.api['toggleConversationBot'] = () => Promise.resolve({ id: 'a' });
        await I.toggleBot('a', true);
        assert.deepEqual(plain(s.calls[0]), { method: 'toggleConversationBot', args: ['a', true] });
        assert.equal(I.threads[0].is_bot_active, true);
        assert.equal(I.threads[0].stage, 'new');
        assert.equal(I.isNeedsYou(I.threads[0]), false);
        assert.equal(I.threads[1].stage, 'handoff', 'another thread is left alone');
    });

    it('puts the stage back with the switch when the server refuses, and leaves a stage that is not a handoff alone', async () => {
        const { s, I } = ready([handed({ id: 'a' }), { id: 'b', is_bot_active: false, stage: 'recommend' }]);
        s.api['toggleConversationBot'] = () => Promise.reject(new Error('Not allowed'));
        await I.toggleBot('a', true);
        assert.equal(I.threads[0].is_bot_active, false, 'back as it was');
        assert.equal(I.threads[0].stage, 'handoff', 'and still waiting for you');
        assert.equal(I.isNeedsYou(I.threads[0]), true);
        s.api['toggleConversationBot'] = () => Promise.resolve({ id: 'b' });
        await I.toggleBot('b', true);
        assert.equal(I.threads[1].stage, 'recommend', 'only a handoff is moved on');
    });

    it('turning it off changes no stage', async () => {
        const { s, I } = ready([handed({ id: 'a', is_bot_active: true })]);
        s.api['toggleConversationBot'] = () => Promise.resolve({ id: 'a' });
        await I.toggleBot('a', false);
        assert.equal(I.threads[0].stage, 'handoff');
        assert.equal(I.threads[0].is_bot_active, false);
    });

    it('a poll that left before the server answered does not bring Needs you back: the toggle in flight outranks its rows', () => {
        const { I } = ready([]);
        I.pendingBotState.set('a', true);
        const rows = I.applyPending([handed({ id: 'a' }), handed({ id: 'b' })]);
        assert.deepEqual(plain(rows.map((r: Json) => [r.id, r.is_bot_active, r.stage])), [['a', true, 'new'], ['b', false, 'handoff']]);
    });
});

// ─── The window ─────────────────────────────────────────────────────────────────────────────

describe('Inbox: the 24-hour window', () => {
    it('counts from the customer\'s LAST message, read from messages, and falls back to the v39 column', () => {
        const { Inbox } = load();
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_message_at: at(HOUR) }), NOW), 23 * HOUR);
        // The v39 stamp is old (only a sales turn writes it): the message the customer sent since is what counts.
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_at: at(20 * HOUR), last_inbound_message_at: at(HOUR) }), NOW), 23 * HOUR);
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_message_at: null, last_inbound_at: at(4 * HOUR) }), NOW), 20 * HOUR);
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_message_at: null }), NOW), null);
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_message_at: at(30 * HOUR) }), NOW), 0, 'closed');
        assert.equal(Inbox.windowLeftMs(handed({ last_inbound_message_at: at(-5 * HOUR) }), NOW), 24 * HOUR, 'a clock a little behind never promises more than 24 h');
        assert.equal(Inbox.windowLeftMs(null, NOW), null);
    });

    it('is said in hours and minutes in English, Latin digits in Arabic, and "closed" once it has', () => {
        const en = load('en');
        const t = (ms: number) => en.Inbox.windowText(handed({ last_inbound_message_at: at(24 * HOUR - ms) }), NOW);
        assert.equal(t(5 * HOUR + 20 * 60000), '5 h 20 min left to reply');
        assert.equal(t(3 * HOUR), '3 h left to reply');
        assert.equal(t(40 * 60000), '40 min left to reply');
        assert.equal(t(20000), 'under a minute left to reply');
        assert.equal(en.Inbox.windowText(handed({ last_inbound_message_at: at(30 * HOUR) }), NOW), 'Reply window closed');

        const ar = load('ar');
        const out = ar.Inbox.windowText(handed({ last_inbound_message_at: at(24 * HOUR - (5 * HOUR + 20 * 60000)) }), NOW);
        assert.equal(out, 'متبقٍّ 5 ساعة و20 دقيقة للردّ');
        assert.ok(!/[٠-٩]/.test(out), 'Latin digits');
    });

    it('is shown only for a thread a person has to act on, and not for one the AI is answering', () => {
        const { Inbox } = load();
        const waiting = { id: 'w', is_bot_active: false, last_message_direction: 'inbound', last_inbound_message_at: at(2 * HOUR) };
        assert.ok(Inbox.windowText(waiting, NOW).includes('22 h'), 'waiting for a reply');
        assert.ok(Inbox.windowText(handed(), NOW).includes('23 h'), 'handed over');
        assert.ok(Inbox.windowText(handed({ is_bot_active: true }), NOW).includes('23 h'), 'handed over by an engine failure, the bot still on');
        assert.equal(Inbox.windowText({ ...waiting, is_bot_active: true }, NOW), '', 'the AI is answering');
        assert.equal(Inbox.windowText(handed({ is_bot_active: true, stage: 'new' }), NOW), '', 'handed back to the AI');
        assert.equal(Inbox.windowText(handed({ last_inbound_message_at: null }), NOW), '', 'no message from the customer: nothing to count');
    });
});

// ─── The row and the header ─────────────────────────────────────────────────────────────────

describe('Inbox: where the flag and the countdown show', () => {
    it('a thread row says "Needs you" and the time left, and an ordinary row says neither', () => {
        const { Inbox, t } = load();
        const row = String(Inbox.threadRow(handed({ last_inbound_message_at: new Date(Date.now() - HOUR).toISOString() })));
        assert.ok(row.includes('badge badge-warning'));
        assert.ok(text(row).includes(t('inbox.needsYou')));
        assert.match(text(row), /2[23] h( \d+ min)? left to reply/);
        const plainRow = String(Inbox.threadRow({ id: 'x', username: 'omar', is_bot_active: true, last_message_direction: 'inbound' }));
        assert.ok(!plainRow.includes('badge-warning'));
        assert.ok(!text(plainRow).includes('left to reply'));
    });

    it('escapes what a customer typed: a handle with markup is text in the row, not a tag', () => {
        const { Inbox } = load();
        const row = String(Inbox.threadRow(handed({ username: '<img src=x onerror=alert(1)>', last_message_text: '<script>alert(1)</script>' })));
        assert.ok(!/<img src=x/i.test(row) && !/<script>/i.test(row), row);
        assert.ok(row.includes('&lt;img'), 'shown as text');
    });

    it('puts a chip in the chat header for the handoff and one for the window, with where to reply once it has closed', () => {
        const { Inbox, t } = load();
        const open = String(Inbox.metaMarkup(handed({ last_inbound_message_at: new Date(Date.now() - HOUR).toISOString() })));
        assert.ok(open.includes('chip chip-accent'));
        assert.ok(text(open).includes(t('inbox.needsYou')));
        assert.match(text(open), /left to reply/);
        const closed = text(Inbox.metaMarkup(handed({ last_inbound_message_at: at(30 * HOUR) })));
        assert.ok(closed.includes(`${t('inbox.window.closed')}: ${t('inbox.window.closedHint')}`), closed);
        assert.equal(String(Inbox.metaMarkup({ id: 'x', is_bot_active: true })), '', 'nothing for a thread nobody has to act on');
    });
});

// ─── The link in the alert ──────────────────────────────────────────────────────────────────

describe('Inbox: #/inbox?c=<id>, the link in the owner\'s alert', () => {
    const ID = '3f9c2a40-7b1e-4c8d-9a55-0123456789ab';

    it('takes a conversation id from the address and nothing else: the hash is data', () => {
        const s = load();
        for (const [raw, want] of [[ID, ID], [ID.toUpperCase(), ID], ['', ''], ['abc', ''], [`${ID}x`, ''], ['../../etc', ''], ['<script>', ''], [`${ID}&filter=all`, '']] as const) {
            s.hash['c'] = raw;
            assert.equal(s.Inbox.threadFromHash(), want, raw);
        }
    });

    it('opens that conversation once, when the list that holds it has loaded, and not on the polls after', async () => {
        const s = load();
        const I = s.Inbox;
        const opened: string[] = [];
        I.selectThread = (id: string) => { opened.push(id); I.selectedConversationId = id; };
        I.renderThreads = (): void => {};
        I.backfillProfiles = (): void => {};
        s.api['getConversations'] = () => Promise.resolve({ data: [handed({ id: ID }), { id: 'other' }], pagination: { total: 2 } });
        I._deepLinkId = ID;
        await I.loadThreads();
        await I.loadThreads(true);
        assert.deepEqual(opened, [ID], 'once');
        I.destroy();
    });

    it('leaves a conversation that is not among the loaded threads alone, and forgets it', async () => {
        const s = load();
        const I = s.Inbox;
        const opened: string[] = [];
        I.selectThread = (id: string) => { opened.push(id); };
        I.renderThreads = (): void => {};
        I.backfillProfiles = (): void => {};
        s.api['getConversations'] = () => Promise.resolve({ data: [{ id: 'other' }], pagination: { total: 1 } });
        I._deepLinkId = ID;
        await I.loadThreads();
        assert.deepEqual(opened, []);
        assert.equal(I._deepLinkId, '');
        I.destroy();
    });

    it('is read from the address when the page renders, and cleared when the page is left', () => {
        const s = load();
        const I = s.Inbox;
        s.host('page-container');
        s.hash['c'] = ID;
        I.loadThreads = (): void => {};
        I.startPolling = (): void => {};
        I.bindImageGuard = (): void => {};
        I.render();
        assert.equal(I._deepLinkId, ID);
        I.destroy();
        assert.equal(I._deepLinkId, '');
    });
});

// ─── The Settings card ──────────────────────────────────────────────────────────────────────

const NOTIFY = (over: Json = {}): Json => ({
    telegram: { botToken: { set: true, last4: 'abcd' }, chatId: '4242424242', enabled: true, hotLeads: true, ready: true },
    echo: { takeover: false, ownerAppIds: [], documentedAppIds: ['26390203743090', '263902037430900'] },
    ...over,
});

describe('Settings: the handoff alerts card', () => {
    it('is a platform admin\'s: nothing for a page with no settings, and a card that says why for one that failed to load', () => {
        const { Settings, t } = load();
        assert.equal(String(Settings.notifySection(null, null)), '');
        const failed = String(Settings.notifySection(null, new Error('Settings are asleep')));
        assert.ok(text(failed).includes(t('settings.notify.loadFailed', { message: 'Settings are asleep' })));
        assert.ok(failed.includes('data-action="settings:render"'), 'with Retry');
    });

    it('never holds the token: a password field that is never filled, and "{set, last4}" in words', () => {
        const { Settings, t } = load();
        const markup = String(Settings.notifySection(NOTIFY(), null));
        assert.match(markup, /id="notify-token" name="botToken" type="password"/);
        assert.ok(!/id="notify-token"[^>]*value=/.test(markup), 'not prefilled');
        assert.ok(text(markup).includes(t('settings.notify.tokenSaved', { last4: 'abcd' })), 'the last four, in words');
        const none = String(Settings.notifySection(NOTIFY({ telegram: { botToken: { set: false, last4: null }, chatId: null, enabled: false, hotLeads: true, ready: false } }), null));
        assert.ok(text(none).includes(t('settings.notify.tokenNone')));
        assert.ok(!none.includes('notify-remove-token'), 'nothing to remove');
        assert.ok(markup.includes('id="notify-remove-token"'));
    });

    it('shows the saved switches and chat id, with the chat id escaped', () => {
        const { Settings } = load();
        const on = String(Settings.notifySection(NOTIFY(), null));
        assert.match(on, /id="notify-enabled" name="enabled" checked/);
        assert.match(on, /id="notify-hot" name="hotLeads" checked/);
        assert.match(on, /id="notify-echo" name="takeover" aria-describedby="notify-echo-hint" >/, 'takeover is off');
        assert.match(on, /id="notify-chat"[^>]*value="4242424242"/);
        const off = String(Settings.notifySection(NOTIFY({ telegram: { botToken: { set: true, last4: 'abcd' }, chatId: '"><script>alert(1)</script>', enabled: false, hotLeads: false } }), null));
        assert.ok(!/id="notify-enabled" name="enabled" checked/.test(off));
        assert.ok(!/id="notify-hot" name="hotLeads" checked/.test(off));
        assert.ok(!off.includes('<script>alert(1)</script>'), 'the chat id is escaped');
        assert.ok(off.includes('&quot;&gt;&lt;script&gt;'));
    });

    it('has the four steps of making the bot and finding the chat id, and a Send test message button, in both languages', () => {
        for (const lang of ['en', 'ar'] as const) {
            const { Settings, t } = load(lang);
            const markup = String(Settings.notifySection(NOTIFY(), null));
            assert.equal((markup.match(/<li>/g) || []).length, 4, `${lang}: four steps`);
            assert.ok(markup.includes('@BotFather') && markup.includes('@userinfobot'));
            for (const key of ['settings.notify.help.step2', 'settings.notify.help.step3']) assert.ok(text(markup).includes(text(t(key))), `${lang} ${key}`);
            assert.match(markup, /data-action="settings:testNotify"/);
            assert.ok(text(markup).includes(t('settings.notify.test')));
            assert.ok(text(markup).includes(t('settings.notify.testHint')), 'it says the test uses what is saved');
        }
    });

    it('keeps @BotFather as an isolated left-to-right run in the Arabic steps, so its @ does not jump to the other end', () => {
        const { Settings } = load('ar');
        const markup = String(Settings.notifySection(NOTIFY(), null));
        assert.ok(/⁦@BotFather⁩|dir="ltr"[^>]*>@BotFather/.test(markup), 'isolated');
    });

    it('shows the echo block with the documented ids and the owner\'s own list', () => {
        const { Settings } = load();
        const markup = String(Settings.notifySection(NOTIFY({ echo: { takeover: true, ownerAppIds: ['1217981644879628', '99887766'], documentedAppIds: ['26390203743090', '263902037430900'] } }), null));
        assert.match(markup, /id="notify-echo" name="takeover" aria-describedby="notify-echo-hint" checked/);
        assert.match(markup, /id="notify-app-ids"[^>]*value="1217981644879628, 99887766"/);
        assert.ok(markup.includes('26390203743090, 263902037430900'), 'the ids that are always included');
    });
});

describe('Settings: saving, testing, removing', () => {
    function ready(over: Json = {}) {
        const s = load();
        const S = s.Settings;
        S.render = async (): Promise<void> => {};
        s.UI.formBusy = () => () => {};
        s.UI.captureFocus = () => null;
        s.UI.restoreFocus = () => {};
        s.UI.clearInvalid = () => {};
        s.host('notify-settings-error');
        s.host('notify-settings-form');
        s.host('notify-test-result');
        Object.assign(s.api, { saveNotifySettings: () => Promise.resolve(NOTIFY()), ...over });
        return s;
    }
    const form = (fields: Record<string, unknown>): Json => ({ fields });
    const event = { preventDefault: () => {} };

    it('sends the chat id, both switches and the app ids always, and the token only when one was typed', async () => {
        const s = ready();
        await s.Settings.saveNotify(form({ chatId: ' 4242 ', botToken: '', enabled: 'on', ownerAppIds: ' 12345678 ' }), event);
        assert.deepEqual(plain(s.calls[0]!.args[0]), {
            telegram: { chatId: '4242', enabled: true, hotLeads: false }, echo: { takeover: false, ownerAppIds: '12345678' },
        });
        assert.ok(!('botToken' in s.calls[0]!.args[0].telegram), 'a blank token is "keep it"');

        const typed = ready();
        await typed.Settings.saveNotify(form({ chatId: '4242', botToken: ' 123456789:AAH_fake_token_for_tests_0123456789abcd ', hotLeads: 'on', takeover: 'on' }), event);
        assert.deepEqual(plain(typed.calls[0]!.args[0]), {
            telegram: { chatId: '4242', enabled: false, hotLeads: true, botToken: '123456789:AAH_fake_token_for_tests_0123456789abcd' },
            echo: { takeover: true, ownerAppIds: '' },
        });
        assert.deepEqual(typed.toasts, [typed.t('settings.notify.saved')]);
    });

    it('marks the field the server refused, in the dashboard\'s language, and never repeats what was typed', async () => {
        const s = ready({
            saveNotifySettings: () => Promise.reject(Object.assign(new Error('That does not look like a bot token. It is the line…'), { body: { field: 'botToken' } })),
        });
        const marked: string[] = [];
        s.UI.clearInvalid = () => {};
        s.UI.markInvalid = (el: Json) => { marked.push(el.id); };
        s.dom.set('notify-token', { id: 'notify-token' });
        await s.Settings.saveNotify(form({ chatId: '4242', botToken: 'typo' }), event);
        assert.ok(text(s.dom.get('notify-settings-error').innerHTML).includes(s.t('settings.notify.invalid.botToken')));
        assert.deepEqual(marked, ['notify-token']);
        assert.ok(!s.dom.get('notify-settings-error').innerHTML.includes('typo'));
    });

    it('answers a successful test with a pill, and each refusal in words, with the status and Telegram\'s description escaped', () => {
        const { Settings, t } = load();
        assert.ok(text(Settings.notifyTestResult({ ok: true })).includes(t('settings.notify.test.ok')));
        const rejected = String(Settings.notifyTestResult({ ok: false, reason: 'rejected', status: 401, description: '<b>Unauthorized</b>' }));
        assert.ok(text(rejected).includes('Telegram refused it (401).'));
        assert.ok(!rejected.includes('<b>Unauthorized</b>') && rejected.includes('&lt;b&gt;Unauthorized'), 'escaped');
        assert.ok(text(Settings.notifyTestResult({ ok: false, reason: 'not_configured', status: null, description: '' })).includes(t('settings.notify.test.not_configured')));
        assert.ok(text(Settings.notifyTestResult({ ok: false, reason: 'unreachable', status: null, description: 'ECONNABORTED' })).includes(t('settings.notify.test.unreachable')));
        assert.ok(text(Settings.notifyTestResult({ ok: false, reason: 'surprise' })).includes(t('settings.notify.test.unreachable')), 'an unknown reason reads as unreachable');
    });

    it('sends the test in the dashboard\'s language and shows the result where the button is', async () => {
        const s = ready({ testNotify: () => Promise.resolve({ ok: true }) });
        s.UI.actionBusy = () => () => {};
        await s.Settings.testNotify({});
        assert.deepEqual(plain(s.calls[0]), { method: 'testNotify', args: ['en'] });
        assert.ok(text(s.dom.get('notify-test-result').innerHTML).includes(s.t('settings.notify.test.ok')));
        const failing = ready({ testNotify: () => Promise.reject(new Error('Network down')) });
        failing.UI.actionBusy = () => () => {};
        await failing.Settings.testNotify({});
        assert.ok(text(failing.dom.get('notify-test-result').innerHTML).includes(failing.t('settings.notify.test.requestFailed')));
    });

    it('removing the token also switches alerts off, because "on" with nothing to send with is refused', async () => {
        const s = ready();
        await s.Settings.removeNotifyTokenConfirmed();
        assert.deepEqual(plain(s.calls[0]!.args[0]), { telegram: { botToken: null, enabled: false } });
        await settle();
        assert.deepEqual(s.toasts, [s.t('settings.notify.tokenRemoved')]);
    });
});
