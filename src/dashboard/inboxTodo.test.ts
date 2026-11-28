/**
 * The Inbox opens on "To do", and every row has ONE status chip (UX plan U2, research DW-I1 and DW-I2).
 *
 * Loaded like the other dashboard suites: the REAL `inbox.js`, `attention.js`, `components.js` and both catalogues in a `node:vm`
 * context (`_harness.ts`), with the API stubbed. What is pinned is what a screenshot cannot:
 *
 *   - the address: `#/inbox?filter=todo` lands on To do, and the two links Today used to send (`waiting`, `needs_you`) still land, on the
 *     view that holds them; a bare `#/inbox` opens on To do; anything else is data and gets the default;
 *   - To do holds EVERY thread the nav badge counts (the badge may be the narrower number, never the wider one), so a number on the badge
 *     never points at an empty list; a hot lead nobody has marked handled is in it, and marking it handled takes it out;
 *   - To do is worked in order: the window closing soonest first, then the threads with no clock, then the closed windows;
 *   - the status chip, by the exact priority of the research: Needs you (reason, time left) > Needs reply (time left) > Hot > Handled > none,
 *     never two of them on one row, never "Handed to you" next to "Handled", never "Inbound";
 *   - the second line draws only what is not the default;
 *   - a search looks through every conversation whatever view is pressed;
 *   - on a phone the view row scrolls inside itself, not the page.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { loadDashboard, type Json } from './_harness.js';

const HOUR = 3600 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** The AI is off for it and the customer wrote last, `age` ago: waiting for the owner. */
const waiting = (over: Json = {}, age = HOUR): Json => ({
    id: 'w', username: 'sara_dev', instagram_user_id: '1', platform: 'instagram', is_bot_active: false,
    last_message_direction: 'inbound', last_message_at: ago(age), last_inbound_message_at: ago(age), ...over,
});
/** The bot handed it over (the bot is left on, as after a failed reply). */
const handed = (over: Json = {}, age = HOUR): Json => ({
    id: 'h', username: 'omar', instagram_user_id: '2', platform: 'instagram', is_bot_active: true, stage: 'handoff', handoff_at: ago(age),
    handoff_reason: 'refund', last_message_direction: 'outbound', last_message_at: ago(age), last_inbound_message_at: ago(age), ...over,
});
/** Answered by the assistant, nothing to do. */
const quiet = (over: Json = {}): Json => ({
    id: 'q', username: 'lina', instagram_user_id: '3', platform: 'instagram', is_bot_active: true,
    last_message_direction: 'outbound', last_message_at: ago(HOUR), last_inbound_message_at: ago(HOUR), ...over,
});
const clicks = (n: number): Json => ({ links: 1, clicks: n });

function load(lang: 'ar' | 'en' = 'en', hash: Record<string, string> = {}) {
    const badge: number[] = [];
    const App = {
        canOperate: () => true, setInboxWaiting: (n: number) => { badge.push(n); },
        hashParam: (name: string) => (Object.prototype.hasOwnProperty.call(hash, name) ? hash[name] : ''), route: (page: string) => `#/${page}`,
    };
    const api: Json = { token: 'tok', markConversationHandled: (id: string) => Promise.resolve({ id, handled_at: new Date().toISOString() }) };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/inbox.js'], globals: { API: api, App } });
    const Inbox = h.run('InboxPage');
    h.UI.toast = () => null;
    h.UI.undoToast = () => Promise.resolve(false);
    const t = (key: string, params?: Json): string => String(h.run(`I18N.t(${JSON.stringify(key)}, ${JSON.stringify(params ?? {})})`));
    return { h, Inbox, badge, hash, t, Attention: h.Attention };
}

describe('Inbox To do: the address lands', () => {
    it('opens on To do for a bare #/inbox, for ?filter=todo and for anything it does not know', () => {
        for (const raw of ['', 'todo', 'nonsense', 'Todo', ' todo', 'constructor', '__proto__', 'toString', 'needs-you']) {
            const { Inbox } = load('en', { filter: raw });
            assert.equal(Inbox.filterFromHash(), 'todo', JSON.stringify(raw));
        }
    });

    it('keeps the old links working: ?filter=waiting and ?filter=needs_you (Today sends both) land on To do', () => {
        for (const raw of ['waiting', 'needs_you']) {
            const { Inbox } = load('en', { filter: raw });
            assert.equal(Inbox.filterFromHash(), 'todo', raw);
        }
    });

    it('keeps the other views addressable, and opens "More" for the ones in it', () => {
        for (const raw of ['all', 'hot', 'paused', 'ads', 'handled']) assert.equal(load('en', { filter: raw }).Inbox.filterFromHash(), raw, raw);
        const { Inbox, h } = load('en', { filter: 'handled' });
        h.el('page-container');
        Inbox.moreOpen = Inbox.MORE_VIEWS.includes(Inbox.filterFromHash());
        assert.equal(Inbox.moreOpen, true);
        assert.doesNotMatch(String(Inbox.layout()), /id="inbox-more"[^>]*hidden/, 'the row that holds the pressed view is showing');
    });

    it('a view button writes its address: To do is the bare one, the rest carry their name, and All is spelled out', () => {
        const { Inbox, h } = load();
        Inbox.threads = [];
        Inbox.setFilter('all');
        Inbox.setFilter('hot');
        Inbox.setFilter('todo');
        Inbox.setFilter('handled');
        assert.deepEqual(plain(h.replaced), ['#/inbox?filter=all', '#/inbox?filter=hot', '#/inbox', '#/inbox?filter=handled']);
        assert.equal(Inbox.setFilter('nonsense'), undefined);
        assert.equal(Inbox.filter, 'todo', 'a name it does not know is the default view');
        assert.equal(plain(h.replaced).at(-1), '#/inbox', 'and the address says so');
    });

    it('is the default of a page that has been left and come back to', () => {
        const { Inbox } = load();
        Inbox.filter = 'all';
        Inbox.moreOpen = true;
        Inbox.resetViewState();
        assert.equal(Inbox.filter, 'todo');
        assert.equal(Inbox.moreOpen, false);
    });
});

describe('Inbox To do: it holds everything the badge counts', () => {
    /** Every combination of the fields the rules read, so a case nobody thought of is still held to it. */
    const everyThread = (): Json[] => {
        const out: Json[] = [];
        let n = 0;
        for (const bot of [true, false]) for (const dir of ['inbound', 'outbound']) for (const stage of [undefined, 'new', 'handoff', 'link', 'closed'])
            for (const handled of [null, 'before', 'after']) for (const hot of ['none', 'clicks', 'intent'])
                for (const operator of [false, true]) {
                    n += 1;
                    out.push({
                        id: `t${n}`, username: `u${n}`, instagram_user_id: String(n), platform: 'instagram', is_bot_active: bot, last_message_direction: dir,
                        last_message_at: ago(HOUR), last_inbound_message_at: ago(2 * HOUR), stage, handoff_at: stage === 'handoff' ? ago(3 * HOUR) : null,
                        last_operator_at: operator ? ago(HOUR / 2) : null,
                        handled_at: handled === null ? null : handled === 'before' ? ago(3 * HOUR) : ago(HOUR / 4),
                        link_clicks: hot === 'clicks' ? clicks(2) : clicks(0), last_intent: hot === 'intent' ? 'ready_to_buy' : null,
                    });
                }
        return out;
    };

    it('every thread that needs a human is in To do (the view and the count), whatever its fields', () => {
        const { Inbox, Attention, badge } = load();
        const threads = everyThread();
        assert.ok(threads.length >= 360);
        Inbox.threads = threads;
        Inbox.filter = 'todo';
        const shown = new Set(Inbox.visibleThreads().map((x: Json) => x.id));
        let badgeThreads = 0;
        for (const thread of threads) {
            if (!Attention.needsHuman(thread)) continue;
            badgeThreads += 1;
            assert.ok(shown.has(thread.id), `the badge counts ${JSON.stringify(thread)} and To do does not hold it`);
        }
        assert.ok(badgeThreads > 20, 'the table really has threads the badge counts');
        assert.equal(Inbox.todoCount() >= badgeThreads, true, 'the To do number is never below what the server counts for the badge (the same predicate)');
        assert.deepEqual(badge, [], 'the Inbox sets no badge of its own: the shell shows the server\'s count');
    });

    it('a hot lead nobody has marked handled is in To do; one that has been marked is not, and Mark handled is offered on it', async () => {
        const { Inbox, h } = load();
        const hot = quiet({ id: 'hot', link_clicks: clicks(3) });
        Inbox.threads = [hot, quiet({ id: 'plain' })];
        Inbox.adoptAssistant({ data: Inbox.threads, assistant: null });
        Inbox.filter = 'todo';
        assert.deepEqual(plain(Inbox.visibleThreads().map((x: Json) => x.id)), ['hot']);
        assert.match(String(Inbox.rowActionMarkup(hot)), /data-action="inbox:markHandled"/, 'it can be cleared where it shows');
        assert.equal(String(Inbox.rowActionMarkup(quiet())), '', 'a thread nobody has to act on has no button');
        await Inbox.markHandled('hot');
        assert.equal(Inbox.todoCount(), 0);
        assert.deepEqual(plain(Inbox.visibleThreads().map((x: Json) => x.id)), []);
        void h;
    });

    it('lists the order to work it: the window closing soonest, then no clock, then the closed windows (the newest first within a group)', () => {
        const { Inbox } = load();
        Inbox.threads = [
            waiting({ id: 'closed-old' }, 30 * HOUR),
            waiting({ id: 'late' }, 2 * HOUR),
            quiet({ id: 'hot-old', link_clicks: clicks(1), last_message_at: ago(5 * HOUR) }),
            waiting({ id: 'soon' }, 22 * HOUR),
            quiet({ id: 'hot-new', link_clicks: clicks(1), last_message_at: ago(HOUR) }),
            waiting({ id: 'closed-new' }, 25 * HOUR),
        ];
        Inbox.filter = 'todo';
        assert.deepEqual(plain(Inbox.visibleThreads().map((x: Json) => x.id)), ['soon', 'late', 'hot-new', 'hot-old', 'closed-new', 'closed-old']);
    });

    it('handled threads leave To do and are the Handled view, and a newer message from the customer brings them back', () => {
        const { Inbox } = load();
        const done = waiting({ id: 'done', handled_at: ago(HOUR / 2) });
        const again = waiting({ id: 'again', handled_at: ago(3 * HOUR), last_inbound_message_at: ago(HOUR), last_message_at: ago(HOUR) });
        Inbox.threads = [done, again, quiet()];
        Inbox.filter = 'todo';
        assert.deepEqual(plain(Inbox.visibleThreads().map((x: Json) => x.id)), ['again']);
        Inbox.filter = 'handled';
        assert.deepEqual(plain(Inbox.visibleThreads().map((x: Json) => x.id)), ['done']);
    });
});

describe('Inbox status chip: one per row, by priority (DW-I2)', () => {
    const chipOf = (L: ReturnType<typeof load>, thread: Json): string => {
        const row = String(L.Inbox.threadRow(thread));
        const found = /data-status-chip="([a-z_]+)"/.exec(row);
        assert.ok(count(row, 'data-status-chip=') <= 1, `one chip at most: ${row}`);
        return found ? found[1]! : 'none';
    };

    const cases: Array<[string, Json, string]> = [
        ['Needs you outranks Needs reply and Hot', waiting({ stage: 'handoff', handoff_at: ago(2 * HOUR), link_clicks: clicks(2), last_operator_at: null }), 'needs_you'],
        ['a handoff with the bot on is Needs you', handed(), 'needs_you'],
        ['Needs reply outranks Hot', waiting({ link_clicks: clicks(2) }), 'needs_reply'],
        ['Needs reply', waiting(), 'needs_reply'],
        ['Hot, when nothing is waiting', quiet({ link_clicks: clicks(2) }), 'hot'],
        ['Hot by intent', quiet({ last_intent: 'ready_to_buy' }), 'hot'],
        ['Handled, when it is not hot', waiting({ handled_at: ago(HOUR / 2) }), 'handled'],
        ['Handled outranks the stage that says Handed to you', handed({ handled_at: ago(HOUR / 2) }), 'handled'],
        ['Handled, not Hot, once a hot lead is marked handled', quiet({ link_clicks: clicks(2), handled_at: ago(HOUR / 2) }), 'handled'],
        ['a thread the owner answered after the handoff has no status', handed({ last_operator_at: ago(HOUR / 2) }), 'none'],
        ['an ordinary answered thread has none', quiet(), 'none'],
        ['a closed thread with clicks is not hot, so none', quiet({ stage: 'closed', link_clicks: clicks(5) }), 'none'],
    ];
    for (const [name, thread, kind] of cases) {
        it(`${name}: ${kind}`, () => {
            for (const lang of ['en', 'ar'] as const) assert.equal(chipOf(load(lang), thread), kind, lang);
        });
    }

    it('Needs you says why and how long is left; Needs reply says how long is left; a closed window says so', () => {
        const L = load();
        const you = text(L.Inbox.statusChip(handed({ handoff_reason: 'refund' })));
        assert.ok(you.startsWith(L.t('inbox.needsYou')), you);
        assert.ok(you.includes(L.t('inbox.handoffReason.refund')), you);
        assert.match(you, /2[23] h( \d+ min)? left to reply/);
        const reply = text(L.Inbox.statusChip(waiting()));
        assert.match(reply, /^Needs reply · 2[23] h( \d+ min)? left to reply$/);
        assert.ok(text(L.Inbox.statusChip(waiting({}, 30 * HOUR))).endsWith(L.t('inbox.window.closed')));
        assert.ok(!text(L.Inbox.statusChip(handed({ handoff_reason: undefined }))).includes('undefined'));
    });

    it('is called "Needs reply" in both languages and never "Inbound"', () => {
        for (const lang of ['en', 'ar'] as const) {
            const L = load(lang);
            const row = text(L.Inbox.threadRow(waiting()));
            assert.ok(row.includes(L.t('inbox.needsReply')), row);
            assert.notEqual(L.t('inbox.needsReply'), 'inbox.needsReply');
            assert.ok(!/Inbound|واردة/.test(row), row);
        }
        assert.equal(load('en').t('inbox.needsReply'), 'Needs reply');
        assert.equal(load('ar').t('inbox.needsReply'), 'بحاجة إلى ردّ');
    });

    it('no row ever has two status chips, whatever its fields', () => {
        const L = load();
        const names = new Set<string>();
        for (let i = 0; i < 4; i++) for (const t of [waiting, handed, quiet]) {
            const thread = t({ link_clicks: i % 2 ? clicks(1) : clicks(0), handled_at: i > 1 ? ago(HOUR / 4) : null, id: `${t.name}${i}` });
            names.add(chipOf(L, thread));
        }
        assert.ok(names.size >= 4, [...names].join());
    });

    it('moves the stage and the assistant to a muted second line, and draws only what is not the default', () => {
        const L = load();
        L.Inbox.adoptAssistant({ data: [], assistant: { configured: true, is_active: true, sales_mode: 'off', sales_test_senders: [] } });
        const second = (thread: Json): string => {
            const row = String(L.Inbox.threadRow(thread));
            const at = row.indexOf('thread-detail');
            return at === -1 ? '' : text(row.slice(at));
        };
        assert.equal(second(quiet({ stage: 'new' })), '', '"New" read as "new message": not drawn');
        assert.equal(second(quiet()), '', 'the assistant answering is the default: not drawn');
        assert.ok(second(quiet({ stage: 'link' })).includes(L.t('inbox.stage.link')), 'a stage that means something is');
        assert.ok(second(waiting()).includes('Paused here'), 'the AI paused for this thread is');
        assert.ok(!/Handed to you/.test(String(L.Inbox.threadRow(handed()))), 'the status chip says it; the stage chip does not say it twice');
        assert.ok(!/Handed to you/.test(String(L.Inbox.threadRow(handed({ handled_at: ago(HOUR / 2) })))), 'and not once it is handled');
        L.Inbox.adoptAssistant({ data: [], assistant: { configured: true, is_active: false } });
        assert.ok(second(quiet()).includes('Assistant off'), 'a switched-off assistant is');
    });

    it('repaints a row when its handoff reason changes', () => {
        const L = load();
        const container = { removeAttribute: () => {}, setAttribute: () => {}, querySelector: () => null, innerHTML: '' };
        L.h.dom.set('threads-container', container as never);
        let options: Json = null;
        L.h.run('Motion').patchList = (_c: unknown, _r: unknown, given: Json) => { options = given; };
        L.Inbox.threads = [handed()];
        L.Inbox.renderThreads();
        assert.ok(options, 'patched');
        assert.notEqual(options.signature(handed()), options.signature(handed({ handoff_reason: 'complaint' })));
    });
});

describe('Inbox views: the row, More, and what a search does', () => {
    it('is three views and a More: To do (with its count), Hot, All; and AI paused, From ads, Handled behind More', () => {
        const L = load();
        L.Inbox.threads = [waiting(), handed(), quiet()];
        const markup = String(L.Inbox.layout());
        const row = markup.slice(markup.indexOf('id="inbox-filter"'), markup.indexOf('id="inbox-more"'));
        const more = markup.slice(markup.indexOf('id="inbox-more"'), markup.indexOf('id="inbox-count"'));
        for (const key of ['todo', 'hot', 'all']) assert.ok(row.includes(`data-filter="${key}"`), `${key} is in the row`);
        for (const key of ['paused', 'ads', 'handled']) { assert.ok(more.includes(`data-filter="${key}"`), `${key} is in More`); assert.ok(!row.includes(`data-filter="${key}"`)); }
        assert.ok(row.includes('data-action="inbox:toggleMore"') && row.includes('aria-expanded="false"'), 'More is a toggle, closed');
        assert.match(more, /^id="inbox-more"[^>]*hidden/, 'and its row is hidden until opened');
        assert.ok(!/data-filter="(waiting|needs_you)"/.test(markup), 'no button for the two views that became To do');
        const todo = /id="inbox-filter-todo"[\s\S]*?<\/button>/.exec(row)![0];
        const inner = text(todo.slice(todo.indexOf('>') + 1));
        assert.ok(inner.startsWith('To do') && inner.endsWith('2'), inner);
        assert.ok(todo.includes('aria-label="To do: 2 conversations"'), todo);
        assert.ok(todo.includes('aria-pressed="true"'), 'pressed: the default');
        assert.ok(String(load().Inbox.layout()).includes('aria-label="To do: nothing"'), 'with nothing in the list it says so');
    });

    it('says the To do number in Arabic with the right plural, and prints the digits as Latin like the rest of the screen', () => {
        const L = load('ar');
        for (const [n, word] of [[0, 'لا شيء'], [1, 'محادثة واحدة'], [2, 'محادثتان'], [5, '5 محادثات'], [11, '11 محادثة']] as Array<[number, string]>) {
            L.Inbox.threads = Array.from({ length: n }, (_, i) => waiting({ id: `w${i}` }));
            assert.ok(L.Inbox.todoLabel().includes(word), `${n}: ${L.Inbox.todoLabel()}`);
        }
        assert.ok(String(L.Inbox.layout()).includes('المطلوب'));
    });

    it('opens and closes More, keeps it open while a view inside it is pressed, and closes it again on a view of the row', () => {
        const { Inbox, h } = load();
        const more = h.el('inbox-more');
        const toggle = h.el('inbox-filter-more');
        for (const key of Inbox.FILTERS) h.el(`inbox-filter-${key}`);
        Inbox.toggleMore();
        assert.equal(more.hasAttribute('hidden'), false);
        assert.equal(toggle.getAttribute('aria-expanded'), 'true');
        Inbox.setFilter('handled');
        assert.equal(more.hasAttribute('hidden'), false, 'pressing a view inside More keeps it in sight');
        assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'and More says one of its views is the one on screen');
        assert.equal(h.el('inbox-filter-handled').getAttribute('aria-pressed'), 'true');
        Inbox.setFilter('all');
        assert.equal(more.hasAttribute('hidden'), true);
        assert.equal(toggle.getAttribute('aria-pressed'), 'false');
        Inbox.toggleMore();
        Inbox.toggleMore();
        assert.equal(more.hasAttribute('hidden'), true);
    });

    it('moves the To do count and its spoken label with the list', () => {
        const { Inbox, h } = load();
        const button = h.el('inbox-filter-todo');
        h.el('inbox-count');
        Inbox.threads = [waiting()];
        Inbox.renderCount();
        assert.ok(text(button.innerHTML).endsWith('1') && button.getAttribute('aria-label') === 'To do: 1 conversation', button.innerHTML);
        Inbox.threads = [];
        Inbox.renderCount();
        assert.equal(text(button.innerHTML), 'To do');
        assert.equal(button.getAttribute('aria-label'), 'To do: nothing');
    });

    it('says when To do is empty and offers All; says when nothing is handled', () => {
        const L = load();
        const empty = String(L.Inbox.emptyMarkup('todo'));
        assert.ok(empty.includes(L.t('inbox.noTodo')) && empty.includes('data-filter="all"') && empty.includes(L.t('inbox.showAll')));
        L.Inbox.threads = [quiet()];
        L.Inbox.filter = 'todo';
        assert.equal(L.Inbox.emptyKind(), 'todo');
        L.Inbox.filter = 'handled';
        assert.ok(String(L.Inbox.emptyMarkup('handled')).includes(L.t('inbox.noHandled')));
        for (const lang of ['en', 'ar'] as const) for (const key of ['inbox.noTodo', 'inbox.showAll', 'inbox.noHandled', 'inbox.filter.todo', 'inbox.filter.more', 'inbox.filter.moreLabel', 'inbox.filter.handled', 'inbox.searchingAll']) {
            assert.notEqual(load(lang).t(key), key, `${lang} ${key}`);
        }
    });

    it('a search looks through every conversation whatever view is pressed, and says so under the box', () => {
        const L = load();
        h(L);
        function h(rig: ReturnType<typeof load>): void { rig.h.el('inbox-count'); }
        L.Inbox.threads = [waiting({ id: 'a', username: 'sara_dev' }), quiet({ id: 'b', username: 'sara_old' }), quiet({ id: 'c', username: 'omar' })];
        L.Inbox.filter = 'todo';
        assert.deepEqual(plain(L.Inbox.visibleThreads().map((x: Json) => x.id)), ['a']);
        L.Inbox.searchTerm = 'sara';
        assert.deepEqual(plain(L.Inbox.visibleThreads().map((x: Json) => x.id).sort()), ['a', 'b'], 'To do does not hide the person searched for');
        L.Inbox.filter = 'handled';
        assert.deepEqual(plain(L.Inbox.visibleThreads().map((x: Json) => x.id).sort()), ['a', 'b']);
        L.Inbox.renderCount();
        assert.equal(text(L.h.el('inbox-count').innerHTML), 'Searching all conversations');
    });

    it('scrolls the view row inside itself on a phone, never the page, with every label on one line', () => {
        const css = readFileSync('dashboard/css/styles.css', 'utf8');
        const rule = /\.inbox-search \.segmented \{([^}]*)\}/g;
        const bodies: string[] = [];
        for (let m = rule.exec(css); m; m = rule.exec(css)) bodies.push(m[1]!);
        const joined = bodies.join(' ');
        assert.match(joined, /flex-wrap:\s*nowrap/, 'one line');
        assert.match(joined, /overflow-x:\s*auto/, 'scrolling inside its own box');
        assert.match(joined, /overscroll-behavior-inline:\s*contain/, 'without handing the scroll to the page');
        assert.match(css, /\.inbox-search \.segmented \.btn \{[^}]*white-space:\s*nowrap/);
        assert.match(css, /\.inbox-more\[hidden\]\s*\{\s*display:\s*none/, 'a hidden More row is hidden even though .segmented is a flex box');
        assert.match(css, /\.inbox-count:empty\s*\{\s*display:\s*none/);
    });
});
