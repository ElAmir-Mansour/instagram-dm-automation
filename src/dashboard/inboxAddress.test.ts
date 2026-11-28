/**
 * An address for each conversation (INBOX-L1): `#/inbox?c=<id>`, keeping `filter`.
 *
 * Loaded like the other dashboard suites: the REAL `inbox.js` (with the shared files) in a `node:vm` context through `_harness.ts`, with the API
 * stubbed and a fake `history` that keeps a stack of entries, so Back is a real pop. What is pinned:
 *
 *   - opening a conversation writes `#/inbox?c=<id>`: a PUSHED entry on a phone (860 px and below), a REPLACED one on a wide screen, and the
 *     address is the same one the page was already asked by when it opened from the address (nothing written twice);
 *   - `filter` survives in the address, and a filter change keeps `c`;
 *   - Back (the browser's, and the arrow in the header) shows the list with the row focused, and the conversation keeps its unsent reply;
 *   - `onHashChange` opens and closes without a re-render, and Forward comes back to the open conversation;
 *   - a reloaded or shared `?c=` for a thread past the newest 100 is fetched alone (`GET /conversations/:id`), a 404 is said and the address cleaned.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadDashboard, settle, type Json } from './_harness.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const OLD = '33333333-3333-4333-8333-333333333333';
const HOUR = 3600 * 1000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const thread = (id: string, over: Json = {}): Json => ({
    id, username: `user_${id.slice(0, 4)}`, instagram_user_id: id.slice(0, 8), platform: 'instagram', is_bot_active: false,
    last_message_direction: 'inbound', last_message_at: ago(HOUR), last_inbound_message_at: ago(HOUR), ...over,
});

interface Rig {
    h: ReturnType<typeof loadDashboard>;
    Inbox: Json;
    /** Every entry the page pushed or replaced, in order, and the stack Back pops. */
    log: Array<{ kind: 'push' | 'replace'; url: string }>;
    stack: string[];
    back(): void;
    forward(): void;
    toasts: string[];
    fetched: string[];
    layout: { dataset: Record<string, string> };
}

function load(opts: { phone?: boolean; hash?: string; lang?: 'ar' | 'en'; conversations?: Record<string, Json> } = {}): Rig {
    const log: Rig['log'] = [];
    const stack = [opts.hash ?? '#/inbox'];
    let at = 0;
    const toasts: string[] = [];
    const fetched: string[] = [];
    let rig: Rig;
    const apply = (): void => { rig.h.location.hash = stack[at]!; };
    const history = {
        pushState: (_s: unknown, _t: string, url: string): void => { stack.length = at + 1; stack.push(url); at++; log.push({ kind: 'push', url }); apply(); },
        replaceState: (_s: unknown, _t: string, url: string): void => { stack[at] = url; log.push({ kind: 'replace', url }); apply(); },
        back: (): void => { if (at > 0) { at--; apply(); rig.Inbox.onHashChange(); } },
        forward: (): void => { if (at < stack.length - 1) { at++; apply(); rig.Inbox.onHashChange(); } },
    };
    const hashParam = (name: string): string => {
        const raw = String(rig.h.location.hash || '');
        const q = raw.indexOf('?');
        return new URLSearchParams(q === -1 ? '' : raw.slice(q + 1)).get(name) ?? '';
    };
    const api: Json = {
        token: 'tok',
        getConversation: (id: string) => {
            fetched.push(id);
            const found = opts.conversations?.[id];
            return found ? Promise.resolve(found) : Promise.reject(Object.assign(new Error('Conversation not found.'), { status: 404 }));
        },
    };
    const App = { canOperate: () => true, setInboxWaiting: () => {}, hashParam, route: (page: string) => `#/${page}` };
    const h = loadDashboard({ lang: opts.lang ?? 'en', hash: stack[0], files: ['dashboard/js/pages/inbox.js'], globals: { API: api, App, history } });
    const Inbox = h.run('InboxPage');
    h.window.matchMedia = () => ({ matches: opts.phone === true, addEventListener: () => {}, removeEventListener: () => {} });
    h.UI.toast = (message: string) => { toasts.push(String(message)); return null; };
    // The log and the profile lookup are not what is tested here.
    Inbox.loadMessages = () => Promise.resolve();
    Inbox.maybeRefreshProfile = () => {};
    // A real shell is a NEW textarea each time (innerHTML), empty until the page puts a draft in it: the one fake element is emptied the same way.
    h.el('chat-pane-container');
    const shell = Inbox.renderChatShell.bind(Inbox);
    Inbox.renderChatShell = (t: Json) => { h.el('chat-input-text').value = ''; shell(t); };
    const layout = { dataset: { pane: 'threads' } as Record<string, string> };
    h.document.querySelector = (selector: string) => (selector === '.inbox-layout' ? layout : null);
    rig = { h, Inbox, log, stack, back: history.back, forward: history.forward, toasts, fetched, layout };
    return rig;
}

describe('Inbox address: opening a conversation writes #/inbox?c=<id>', () => {
    it('pushes a history entry on a phone, so Back returns to the list', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A), thread(B)];
        r.Inbox.selectThread(A);
        assert.deepEqual(r.log, [{ kind: 'push', url: `#/inbox?c=${A}` }]);
        assert.equal(r.layout.dataset.pane, 'chat');
        assert.equal(r.Inbox.selectedConversationId, A);
    });

    it('replaces the entry on a wide screen: the list and the conversation are one page, and Back leaves the Inbox', () => {
        const r = load({ phone: false });
        r.Inbox.threads = [thread(A), thread(B)];
        r.Inbox.selectThread(A);
        r.Inbox.selectThread(B);
        assert.deepEqual(r.log, [{ kind: 'replace', url: `#/inbox?c=${A}` }, { kind: 'replace', url: `#/inbox?c=${B}` }]);
        assert.equal(r.stack.length, 1, 'no entry was added');
    });

    it('keeps the filter in the address, in both directions', () => {
        const r = load({ phone: true, hash: '#/inbox?filter=hot' });
        r.Inbox.filter = 'hot';
        r.Inbox.threads = [thread(A)];
        r.Inbox.selectThread(A);
        assert.equal(r.log[0]!.url, `#/inbox?filter=hot&c=${A}`);
        r.Inbox.setFilter('all');
        assert.equal(r.log[1]!.url, `#/inbox?filter=all&c=${A}`, 'a filter change keeps the open conversation');
        assert.equal(r.log[1]!.kind, 'replace', 'and is never a new entry');
    });

    it('writes nothing when the address already names the conversation (the page was opened on it)', () => {
        const r = load({ phone: true, hash: `#/inbox?c=${A}` });
        r.Inbox.threads = [thread(A)];
        r.Inbox._deepLinkId = r.Inbox.threadFromHash();
        r.Inbox.openDeepLink();
        assert.deepEqual(r.log, []);
        assert.equal(r.Inbox.selectedConversationId, A);
    });
});

describe('Inbox address: Back shows the list, with the row focused and the reply kept', () => {
    it('the browser\'s Back (a hashchange) closes the conversation without a re-render, and Forward returns to it', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A)];
        let rendered = 0;
        r.Inbox.render = () => { rendered++; };
        r.Inbox.selectThread(A);
        r.back();
        assert.equal(r.layout.dataset.pane, 'threads');
        assert.equal(r.h.location.hash, '#/inbox');
        r.forward();
        assert.equal(r.layout.dataset.pane, 'chat');
        assert.equal(r.Inbox.selectedConversationId, A);
        assert.equal(rendered, 0, 'neither direction re-rendered the page');
    });

    it('the header\'s arrow is the same Back: it pops the pushed entry instead of leaving one behind', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A)];
        r.Inbox.selectThread(A);
        r.Inbox.backToThreads();
        assert.equal(r.layout.dataset.pane, 'threads');
        assert.equal(r.h.location.hash, '#/inbox');
        assert.equal(r.stack.length, 2, 'the entry is still there to go Forward to');
        assert.ok(!r.log.some((e) => e.kind === 'replace'), 'popped, not rewritten');
    });

    it('with no entry of ours to pop (opened from a link, or a wide screen) the arrow cleans the address in place', () => {
        const r = load({ phone: true, hash: `#/inbox?c=${A}` });
        r.Inbox.threads = [thread(A)];
        r.Inbox._deepLinkId = A;
        r.Inbox.openDeepLink();
        r.Inbox.backToThreads();
        assert.equal(r.layout.dataset.pane, 'threads');
        assert.deepEqual(r.log, [{ kind: 'replace', url: '#/inbox' }]);
    });

    it('focuses the row that was open', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A)];
        const row = r.h.el('row');
        r.h.document.querySelector = (selector: string) => (selector === '.inbox-layout' ? r.layout : selector === '.thread-item.active' ? row : null);
        r.Inbox.selectThread(A);
        r.back();
        assert.ok(row.focusCalls.length >= 1, 'the open row has focus');
    });

    it('keeps an unsent reply for each conversation: written in A, away to B, back to A', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A), thread(B)];
        const box = r.h.el('chat-input-text');
        r.Inbox.selectThread(A);
        box.value = 'half a sentence about the';
        r.Inbox.selectThread(B);
        assert.equal(box.value, '', 'B starts with an empty box');
        box.value = 'another one';
        r.Inbox.selectThread(A);
        assert.equal(box.value, 'half a sentence about the', 'A has what was typed');
        r.Inbox.selectThread(B);
        assert.equal(box.value, 'another one');
    });

    it('keeps it through Back to the list too, and forgets it when the box was emptied or the workspace changed', () => {
        const r = load({ phone: true });
        r.Inbox.threads = [thread(A), thread(B)];
        const box = r.h.el('chat-input-text');
        r.Inbox.selectThread(A);
        box.value = 'typed';
        r.Inbox.backToThreads();
        assert.equal(r.Inbox._drafts.get(A), 'typed');
        box.value = '   ';
        r.Inbox.selectThread(B);
        r.Inbox.saveDraft();
        r.Inbox.selectThread(A);
        assert.equal(r.Inbox._drafts.has(B), false, 'a blank box keeps nothing');
        r.Inbox.resetTenantState();
        assert.equal(r.Inbox._drafts.size, 0, 'another workspace never sees this one\'s drafts');
    });
});

describe('Inbox address: a link to a conversation past the newest 100', () => {
    it('is fetched alone, opened, and found by every later lookup of the page', async () => {
        const old = thread(OLD, { last_message_at: ago(40 * 24 * HOUR), last_inbound_message_at: ago(40 * 24 * HOUR) });
        const r = load({ phone: true, hash: `#/inbox?c=${OLD}`, conversations: { [OLD]: old } });
        r.Inbox.threads = [thread(A)];
        r.Inbox._deepLinkId = r.Inbox.threadFromHash();
        r.Inbox.openDeepLink();
        await settle();
        assert.deepEqual(r.fetched, [OLD]);
        assert.equal(r.Inbox.selectedConversationId, OLD);
        assert.equal(r.Inbox.findThread(OLD).id, OLD);
        assert.equal(r.Inbox.threadCopies(OLD).length, 1);
        assert.deepEqual(r.log, [], 'the address already said so');
    });

    it('is not fetched when the list holds it', async () => {
        const r = load({ hash: `#/inbox?c=${A}` });
        r.Inbox.threads = [thread(A)];
        r.Inbox._deepLinkId = A;
        r.Inbox.openDeepLink();
        await settle();
        assert.deepEqual(r.fetched, []);
    });

    it('is read again on a poll while open, so its newest message and window stay current', async () => {
        const old = thread(OLD);
        const r = load({ hash: `#/inbox?c=${OLD}`, conversations: { [OLD]: old } });
        r.Inbox.threads = [];
        r.Inbox._deepLinkId = OLD;
        r.Inbox.openDeepLink();
        await settle();
        r.fetched.length = 0;
        r.Inbox.refreshLinked();
        await settle();
        assert.deepEqual(r.fetched, [OLD]);
    });

    it('says so, and cleans the address, when there is no such conversation (another workspace\'s is the same answer)', async () => {
        const r = load({ phone: true, hash: `#/inbox?c=${OLD}` });
        r.Inbox.threads = [thread(A)];
        r.Inbox._deepLinkId = OLD;
        r.Inbox.openDeepLink();
        await settle();
        assert.equal(r.Inbox.selectedConversationId, null);
        assert.deepEqual(r.toasts, ['That conversation could not be found.']);
        assert.equal(r.h.location.hash, '#/inbox');
    });

    it('says it in Arabic', async () => {
        const r = load({ lang: 'ar', hash: `#/inbox?c=${OLD}` });
        r.Inbox.threads = [];
        r.Inbox._deepLinkId = OLD;
        r.Inbox.openDeepLink();
        await settle();
        assert.deepEqual(r.toasts, ['تعذّر العثور على هذه المحادثة.']);
    });

    it('opens one whose address changed while the page was open (a link followed inside the Inbox)', async () => {
        const old = thread(OLD);
        const r = load({ conversations: { [OLD]: old } });
        r.Inbox.threads = [thread(A)];
        r.h.location.hash = `#/inbox?c=${OLD}`;
        r.Inbox.onHashChange();
        await settle();
        assert.equal(r.Inbox.selectedConversationId, OLD);
    });

    it('ignores an id that is not an id', () => {
        const r = load({ hash: '#/inbox?c=../../etc/passwd' });
        assert.equal(r.Inbox.threadFromHash(), '');
    });
});

describe('Inbox address: the client call', () => {
    it('asks GET /conversations/:id, with the id encoded', async () => {
        const seen: string[] = [];
        const h = loadDashboard({ files: ['dashboard/js/api.js'] });
        h.run('API').request = (path: string) => { seen.push(path); return Promise.resolve({}); };
        await h.run("API.getConversation('a b/c')");
        assert.deepEqual(seen, ['/conversations/a%20b%2Fc']);
    });
});
