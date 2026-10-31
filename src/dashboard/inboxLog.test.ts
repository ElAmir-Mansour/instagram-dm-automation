/**
 * The inbox's message log (`dashboard/js/pages/inbox.js`): a thread opens on its newest page, at its newest message, at once; the
 * history comes in from the top as the operator scrolls up; a poll asks only for what is new; and a button goes back down.
 *
 * The bug this pins: opening a thread fetched its newest 100 messages and then scrolled to the bottom through the stylesheet's
 * `scroll-behavior: smooth`, so every open played the whole history past the operator, and nothing older than those 100 could be
 * reached at all.
 *
 * The REAL shipped files in a `node:vm` context (`_harness.ts`). The log is the one element with layout here (`FakeLog`: every row 60px
 * tall, every day divider 30px, a 600px window, `scrollTop` clamped as a browser clamps it), because where the log is scrolled to is
 * the claim. Anything that needs real layout is checked live.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { FakeEl, loadDashboard, settle, type Json } from './_harness.js';

const ID = '11111111-2222-4333-8444-555555555555';
const BASE = Date.parse('2026-10-20T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const plain = (v: unknown): Json => JSON.parse(JSON.stringify(v));

/** The message log, with just enough layout to scroll. */
class FakeLog extends FakeEl {
    clientHeight = 600;
    /** Height added by pictures that finished loading. */
    extra = 0;
    readonly scrollCalls: Json[] = [];
    private top = 0;

    get scrollHeight(): number {
        const rows = (this.innerHTML.match(/class="message-row /g) || []).length;
        const days = (this.innerHTML.match(/class="chat-day"/g) || []).length;
        return rows * 60 + days * 30 + this.extra;
    }
    get scrollTop(): number { return this.top; }
    set scrollTop(value: number) { this.top = Math.max(0, Math.min(Number(value) || 0, this.scrollHeight - this.clientHeight)); }
    get bottom(): number { return Math.max(0, this.scrollHeight - this.clientHeight); }

    insertAdjacentHTML(where: string, markup: string): void {
        this.innerHTML = where === 'afterbegin' ? markup + this.innerHTML : this.innerHTML + markup;
    }
    /** Only a day divider is ever asked about, so only a divider is answered. */
    get firstElementChild(): Json {
        const found = /^\s*<div class="chat-day">.*?<\/div>/s.exec(this.innerHTML);
        if (!found) return null;
        return { classList: { contains: (c: string) => c === 'chat-day' }, remove: () => { this.innerHTML = this.innerHTML.replace(found[0], ''); } };
    }
    scrollTo(options: Json): void { this.scrollCalls.push(plain(options)); this.scrollTop = options.top; }
    fire(type: 'scroll' | 'load' | 'error'): void { (this.listeners.get(type) ?? []).forEach((fn) => fn({})); }
    get rows(): number { return (this.innerHTML.match(/class="message-row /g) || []).length; }
    get days(): number { return (this.innerHTML.match(/class="chat-day"/g) || []).length; }
}

/** Message `n`, `minutes` after BASE: a customer's on odd numbers, the operator's on even ones, its text `m001`… so no text is inside another. */
function message(n: number, minutes: number, over: Json = {}): Json {
    return {
        id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
        direction: n % 2 ? 'inbound' : 'outbound',
        sender: n % 2 ? 'customer' : 'operator',
        text: `m${String(n).padStart(3, '0')}`,
        created_at: new Date(BASE + minutes * 60 * 1000).toISOString(),
        ...over,
    };
}
/** Messages `from`..`to`, one a minute, starting `offset` minutes after BASE. */
const range = (from: number, to: number, offset = 0): Json[] => Array.from({ length: to - from + 1 }, (_, i) => message(from + i, offset + i));

function rig() {
    const calls: Json[][] = [];
    const answers: Array<() => Promise<Json>> = [];
    const API = {
        token: 'tok',
        getConversationMessages: (...args: Json[]) => {
            calls.push(plain(args));
            const next = answers.shift();
            return next ? next() : Promise.resolve([]);
        },
    };
    const App = { canOperate: () => true, setInboxWaiting: () => {}, hashParam: () => '', route: (page: string) => `#/${page}` };
    const quiet = { ...console, error: () => {} };
    const h = loadDashboard({ files: ['dashboard/js/pages/inbox.js'], globals: { API, App, console: quiet } });
    h.UI.toast = () => null;
    const log = new FakeLog('chat-messages-container');
    h.dom.set('chat-messages-container', log);
    return {
        h, t: h.t, log, calls,
        Inbox: h.run('InboxPage'),
        jump: h.el('chat-jump'),
        older: h.el('chat-older'),
        loading: h.el('chat-messages-loading'),
        answer: (rows: Json[]) => { answers.push(() => Promise.resolve(rows)); },
        fail: (why: string) => { answers.push(() => Promise.reject(new Error(why))); },
        hold: () => { let release: (rows: Json[]) => void = () => {}; answers.push(() => new Promise((resolve) => { release = resolve; })); return (rows: Json[]) => release(rows); },
    };
}
type Rig = ReturnType<typeof rig>;

/** What `selectThread` does for the log: the thread is the open one, its log starts from nothing, and its listeners are on. */
async function open(r: Rig, rows: Json[]): Promise<void> {
    r.Inbox.selectedConversationId = ID;
    r.Inbox.resetMessageState();
    r.Inbox.bindLog();
    r.answer(rows);
    await r.Inbox.loadMessages(ID, { scroll: true });
    await settle();
}

describe('Inbox log: a thread opens on its newest page, already at the newest message', () => {
    it('asks for the newest 40 and is at the bottom on the first frame, with no smooth scroll on the way', async () => {
        const r = rig();
        await open(r, range(41, 80));
        assert.deepEqual(r.calls[0], [ID, { limit: 40 }]);
        assert.equal(r.log.rows, 40);
        assert.equal(r.log.scrollTop, r.log.bottom, 'at the newest message');
        assert.deepEqual(r.log.scrollCalls, [], 'jumped, not scrolled: the history does not play past');
        assert.equal(r.Inbox._hasOlder, true, 'a full page: there may be more above');
        assert.equal(r.jump.hidden, true);
    });

    it('knows a page shorter than 40 is the whole thread, and asks nothing more at the top', async () => {
        const r = rig();
        await open(r, range(1, 10));
        assert.equal(r.Inbox._hasOlder, false);
        r.log.scrollTop = 0;
        r.log.fire('scroll');
        await settle();
        assert.equal(r.calls.length, 1);
    });

    it('drops an answer that lands after another thread was opened', async () => {
        const r = rig();
        r.Inbox.selectedConversationId = ID;
        r.Inbox.resetMessageState();
        const release = r.hold();
        const pending = r.Inbox.loadMessages(ID, { scroll: true });
        r.Inbox.resetMessageState(); // what selectThread does for the next thread, even the same id opened again
        release(range(1, 5));
        await pending;
        assert.equal(r.log.rows, 0);
    });
});

describe('Inbox log: a poll asks only for what is new', () => {
    it('asks from two minutes before the newest message shown, and adds only the messages not on screen', async () => {
        const r = rig();
        await open(r, range(41, 80));
        const newest = Date.parse(message(80, 39).created_at);
        r.answer([message(79, 38), message(80, 39), message(81, 40)]);
        await r.Inbox.loadMessages(ID);
        assert.deepEqual(r.calls[1], [ID, { since: new Date(newest - 2 * 60 * 1000).toISOString() }]);
        assert.equal(r.log.rows, 41, 'the two it already showed are skipped');
        assert.ok(r.log.innerHTML.indexOf('m081') > r.log.innerHTML.indexOf('m080'));
        assert.deepEqual(r.log.scrollCalls, [{ top: r.log.scrollHeight, behavior: 'smooth' }], 'it was at the bottom, so it follows, smoothly');
    });

    it('opens the thread afresh when a poll comes back full, instead of guessing what it missed', async () => {
        const r = rig();
        await open(r, range(41, 80));
        r.answer(range(81, 280, 40));
        r.answer(range(241, 280, 200));
        await r.Inbox.loadMessages(ID);
        await settle();
        assert.deepEqual(r.calls[2], [ID, { limit: 40 }]);
        assert.equal(r.log.rows, 40, 'the newest page, not 240 rows');
        assert.ok(r.log.innerHTML.includes('m280') && !r.log.innerHTML.includes('m041'));
    });

    it('stays where the operator is reading when they are further up, and the button says new messages', async () => {
        const r = rig();
        await open(r, range(41, 80));
        r.log.scrollTop = r.log.bottom - 300; // up, but not so far that the button shows on distance alone
        r.log.fire('scroll');
        assert.equal(r.jump.hidden, true);
        const reading = r.log.scrollTop;
        r.answer([message(81, 40)]);
        await r.Inbox.loadMessages(ID);
        assert.equal(r.log.scrollTop, reading, 'not pulled down');
        assert.equal(r.jump.hidden, false);
        assert.ok(String(r.jump.innerHTML).includes(r.t('inbox.newMessagesBelow')));
        r.Inbox.jumpToLatest();
        assert.equal(r.log.scrollTop, r.log.bottom);
        assert.equal(r.jump.hidden, true);
        assert.equal(r.Inbox._unseenBelow, 0);
    });

    it('offers the way back down once the operator is far up, worded as the latest messages', async () => {
        const r = rig();
        await open(r, range(1, 40));
        r.Inbox._hasOlder = false;
        r.log.scrollTop = 300;
        r.log.fire('scroll');
        assert.equal(r.jump.hidden, false);
        assert.ok(String(r.jump.innerHTML).includes(r.t('inbox.latestMessages')));
    });
});

describe('Inbox log: the history comes in from the top', () => {
    it('fetches the 40 before the first message shown, puts them above, and keeps the place being read', async () => {
        const r = rig();
        await open(r, range(41, 80, 40));
        r.log.scrollTop = 100;
        const height = r.log.scrollHeight;
        r.answer(range(1, 40));
        r.log.fire('scroll');
        await settle();
        assert.deepEqual(r.calls[1], [ID, { limit: 40, before: message(41, 40).id }]);
        assert.equal(r.log.rows, 80);
        assert.ok(r.log.innerHTML.indexOf('m001') < r.log.innerHTML.indexOf('m041'), 'the older page is above');
        assert.equal(r.log.days, 1, 'the same day: one divider, not the old one repeated under the new page');
        assert.equal(r.log.scrollTop, 100 + (r.log.scrollHeight - height), 'the message being read did not move');
        assert.equal(r.older.hidden, true);
    });

    it('keeps both dividers when the page above is from another day', async () => {
        const r = rig();
        await open(r, range(41, 80, 40));
        r.log.scrollTop = 100;
        r.answer(range(1, 40).map((m: Json) => ({ ...m, created_at: new Date(Date.parse(m.created_at) - DAY).toISOString() })));
        r.log.fire('scroll');
        await settle();
        assert.equal(r.log.days, 2);
    });

    it('stops asking once a page comes back short: that was the start of the thread', async () => {
        const r = rig();
        await open(r, range(41, 80, 40));
        r.log.scrollTop = 100;
        r.answer(range(31, 40, 30));
        r.log.fire('scroll');
        await settle();
        assert.equal(r.Inbox._hasOlder, false);
        r.log.scrollTop = 0;
        r.log.fire('scroll');
        await settle();
        assert.equal(r.calls.length, 2);
    });

    it('says so over the log when the page above fails, and asks again only on Retry', async () => {
        const r = rig();
        await open(r, range(41, 80, 40));
        r.log.scrollTop = 100;
        r.fail('offline');
        r.log.fire('scroll');
        await settle();
        assert.equal(r.older.hidden, false);
        assert.ok(String(r.older.innerHTML).includes(r.t('inbox.olderFailed')) && String(r.older.innerHTML).includes('inbox:retryOlder'));
        r.log.fire('scroll');
        await settle();
        assert.equal(r.calls.length, 2, 'scrolling does not retry a failure');
        r.answer(range(1, 40));
        r.Inbox.retryOlder();
        await settle();
        assert.equal(r.calls.length, 3);
        assert.equal(r.log.rows, 80);
        assert.equal(r.older.hidden, true);
    });
});

describe('Inbox log: pictures that load late', () => {
    it('keeps the log at the newest message when a picture finishes loading, and leaves it alone once the operator scrolled away', async () => {
        const r = rig();
        await open(r, range(41, 80));
        r.log.extra = 300;
        r.log.fire('load');
        assert.equal(r.log.scrollTop, r.log.bottom, 'pushed up by the picture, and put back');
        r.log.scrollTop = 1200;
        r.log.fire('scroll');
        r.log.extra = 600;
        r.log.fire('load');
        assert.equal(r.log.scrollTop, 1200);
    });
});

describe('Inbox log: the stylesheet, the strings and the request', () => {
    const css = readFileSync('dashboard/css/styles.css', 'utf8');

    it('does not scroll the log smoothly by CSS, so a jump is a jump', () => {
        assert.doesNotMatch(css, /\.chat-messages[^{]*\{[^}]*(?<!over)scroll-behavior/, '`overscroll-behavior` is fine: it only stops the page behind from scrolling');
        assert.match(css, /\.chat-messages \{[^}]*overscroll-behavior: contain/);
        assert.match(css, /\.chat-older\[hidden\] \{ display: none; \}/);
        assert.match(css, /\.chat-jump\[hidden\] \{ display: none; \}/);
        for (const rule of css.match(/\.chat-(log|older|jump)[^{]*\{[^}]*\}/g) || []) {
            assert.doesNotMatch(rule, /\b(left|right|margin-left|margin-right|padding-left|padding-right)\s*:/, `logical properties only: ${rule}`);
        }
    });

    it('words the button and the page above in both languages', () => {
        const ar = rig();
        for (const key of ['inbox.latestMessages', 'inbox.newMessagesBelow', 'inbox.loadingOlder', 'inbox.olderFailed']) {
            assert.notEqual(ar.t(key), key, key);
        }
        const en = readFileSync('dashboard/js/i18n.en.js', 'utf8');
        const arabic = readFileSync('dashboard/js/i18n.ar.js', 'utf8');
        for (const key of ['inbox.latestMessages', 'inbox.newMessagesBelow', 'inbox.loadingOlder', 'inbox.olderFailed']) {
            assert.ok(en.includes(`'${key}'`) && arabic.includes(`'${key}'`), key);
        }
    });

    it('puts the page and the poll in the query string, and asks the old way with none', () => {
        const ctx: Json = { localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, window: {}, document: {}, URLSearchParams, console };
        vm.createContext(ctx);
        vm.runInContext(readFileSync('dashboard/js/api.js', 'utf8'), ctx, { filename: 'dashboard/js/api.js' });
        const api = vm.runInContext('API', ctx);
        api.request = (path: string) => path;
        assert.equal(api.getConversationMessages('c1'), '/conversations/c1/messages');
        assert.equal(api.getConversationMessages('c1', { limit: 40 }), '/conversations/c1/messages?limit=40');
        assert.equal(api.getConversationMessages('c1', { limit: 40, before: 'm1' }), '/conversations/c1/messages?limit=40&before=m1');
        assert.equal(api.getConversationMessages('c1', { since: '2026-10-31T10:00:00.000Z', limit: '' }), '/conversations/c1/messages?since=2026-10-31T10%3A00%3A00.000Z');
    });
});
