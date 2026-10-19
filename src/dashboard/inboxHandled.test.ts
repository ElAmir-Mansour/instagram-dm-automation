/**
 * The inbox's "Mark handled" and its effective assistant state (UX US1: audit IN-01 and IN-02, FR-003, FR-006).
 *
 * Loaded like the other dashboard suites: the REAL shipped files (`inbox.js`, `attention.js`, `components.js` and both catalogues) in a
 * `node:vm` context through `_harness.ts`, with the API stubbed. What is pinned is what a screenshot cannot:
 *
 *   - no row, header or hint says "assistant on" while the assistant is switched off, or never set up, and an unknown setting is never
 *     reported as off (IN-02);
 *   - "Mark handled" takes the thread out of To do and every count in the same frame, and is held through a poll that left before the write
 *     committed; a refusal puts it back and says why; Undo reopens it; a viewer is never offered it; the stamp is never older than the
 *     customer's last message (so a slow clock cannot leave the thread in the list), and a newer message from the customer brings the thread
 *     back by itself (IN-01);
 *   - the composer offers it once Meta's 24 h window has closed, in the words of the app the person wrote from.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EFFECTIVE_AI_STATES, effectiveAiOf } from '../services/inboxAssistant.js';
import { loadDashboard, settle, type Dashboard, type Json } from './_harness.js';

const HOUR = 3600 * 1000;
/** An ISO time `ms` before now. (The page stamps with the real clock, so the fixtures count from it too.) */
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const plain = (value: unknown): Json => JSON.parse(JSON.stringify(value));
const text = (markup: unknown): string => String(markup).replace(/<[^>]+>/g, ' ').replace(/[⁦-⁩]/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

const SENDER = '17841400003051';
const ON = { configured: true, is_active: true, sales_mode: 'off', sales_test_senders: [] as string[] };

/** A thread waiting for the owner: the AI is off for it and the customer wrote last, an hour ago. */
const waiting = (over: Json = {}): Json => ({
    id: 'c1', username: 'sara_dev', instagram_user_id: SENDER, platform: 'instagram', is_bot_active: false,
    last_message_direction: 'inbound', last_message_at: ago(HOUR), last_inbound_message_at: ago(HOUR), ...over,
});
/** A thread the AI is answering. */
const answered = (over: Json = {}): Json => ({
    id: 'c2', username: 'omar', instagram_user_id: '999', platform: 'instagram', is_bot_active: true,
    last_message_direction: 'outbound', last_message_at: ago(HOUR), last_inbound_message_at: ago(HOUR), ...over,
});

interface Rig {
    h: Dashboard;
    Inbox: Json;
    calls: Array<{ method: string; args: Json[] }>;
    api: Json;
    badge: number[];
    toasts: Array<{ message: string; arg: Json }>;
    undos: Array<{ message: string; opts: Json }>;
    viewer(): void;
}

function load(lang: 'ar' | 'en' = 'en'): Rig {
    const calls: Rig['calls'] = [];
    const badge: number[] = [];
    let operator = true;
    const api: Json = {
        token: 'tok',
        markConversationHandled: (id: string) => { calls.push({ method: 'mark', args: [id] }); return Promise.resolve({ id, handled_at: new Date().toISOString() }); },
        unmarkConversationHandled: (id: string) => { calls.push({ method: 'unmark', args: [id] }); return Promise.resolve({ id, handled_at: null }); },
    };
    const App = {
        canOperate: () => operator, setInboxWaiting: (n: number) => { badge.push(n); }, hashParam: () => '', route: (page: string) => `#/${page}`,
    };
    const h = loadDashboard({ lang, files: ['dashboard/js/pages/inbox.js'], globals: { API: api, App } });
    const Inbox = h.run('InboxPage');
    const toasts: Rig['toasts'] = [];
    const undos: Rig['undos'] = [];
    h.UI.toast = (message: string, arg: Json) => { toasts.push({ message, arg }); return null; };
    h.UI.undoToast = (message: string, opts: Json) => { undos.push({ message, opts }); return Promise.resolve(false); };
    return { h, Inbox, calls, api, badge, toasts, undos, viewer: () => { operator = false; } };
}

/** Make the page's thread list `threads` and its one-reading-of-the-assistant `assistant`, the way a list answer does. */
function show(r: Rig, threads: Json[], assistant: Json | null = ON): void {
    r.Inbox.threads = threads;
    r.Inbox.adoptAssistant({ data: threads, assistant });
}

// ─── The effective assistant state ─────────────────────────────────────────────────────────

describe('Inbox: every badge about the assistant is the EFFECTIVE state (IN-02)', () => {
    it('says "Assistant off" on every row while the assistant is switched off, even where the thread\'s own switch is on, and never "on"', () => {
        const r = load();
        const thread = answered();
        show(r, [thread], { ...ON, is_active: false });
        const row = String(r.Inbox.threadRow(thread));
        assert.match(row, /data-status="assistant\.off"/);
        assert.ok(text(row).includes('Assistant off'), text(row));
        assert.doesNotMatch(row, /assistant\.on"/, 'no "on" pill');
        assert.doesNotMatch(row, /badge-success/, 'and nothing green');
        assert.ok(!text(row).includes('Assistant on') && !text(row).includes('AI active'));
        // The pill is a glyph, a word and a tone: never colour alone.
        assert.match(row, /data-tone="neutral"/);
        assert.match(row, /status-pill-glyph" aria-hidden="true">○</);
    });

    it('says it in Arabic too, in the product\'s own word for it', () => {
        const r = load('ar');
        const thread = answered();
        show(r, [thread], { ...ON, is_active: false });
        const row = text(r.Inbox.threadRow(thread));
        assert.ok(row.includes('الردّ الآلي متوقف'), row);
        assert.ok(!row.includes('الردّ الآلي يعمل'), row);
    });

    it('says "Assistant on" in green only while the assistant is on and the thread\'s own switch is on', () => {
        const r = load();
        const thread = answered();
        show(r, [thread]);
        const row = String(r.Inbox.threadRow(thread));
        assert.match(row, /data-status="assistant\.on"/);
        assert.ok(text(row).includes('Assistant on'));
        assert.match(row, /data-tone="success"/);
    });

    it('says "Paused here" when the thread\'s own switch is off and the assistant is on', () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        assert.match(String(r.Inbox.threadRow(thread)), /data-status="assistant\.paused_here"/);
    });

    it('says "Sales test" on a test sender\'s thread only, and "Sales live" on every thread that is not paused', () => {
        const r = load();
        const mine = answered({ id: 'mine', instagram_user_id: SENDER });
        const theirs = answered({ id: 'theirs', instagram_user_id: '999' });
        show(r, [mine, theirs], { ...ON, sales_mode: 'test', sales_test_senders: [SENDER] });
        assert.match(String(r.Inbox.threadRow(mine)), /data-status="assistant\.sales_test"/);
        assert.match(String(r.Inbox.threadRow(theirs)), /data-status="assistant\.on"/);
        show(r, [mine, theirs], { ...ON, sales_mode: 'on' });
        assert.match(String(r.Inbox.threadRow(mine)), /data-status="assistant\.sales_live"/);
        assert.match(String(r.Inbox.threadRow(theirs)), /data-status="assistant\.sales_live"/);
    });

    it('never reports an unknown setting as off: with no reading of the assistant a thread says what its own switch says', () => {
        const r = load();
        show(r, [], null);
        assert.equal(r.Inbox.assistant, null);
        assert.equal(r.Inbox.effectiveAi(answered()), 'on');
        assert.equal(r.Inbox.effectiveAi(waiting()), 'paused_thread');
        // …unless the item itself says: the server's `effective_ai` is what there is until a list answer says what the assistant is set to.
        assert.equal(r.Inbox.effectiveAi(answered({ effective_ai: 'off_global' })), 'off_global');
        assert.equal(r.Inbox.effectiveAi(answered({ effective_ai: 'something else' })), 'on', 'a stranger is not a state');
    });

    it('repaints at once when the thread\'s own switch is flipped, because it is worked out from the live thread', () => {
        const r = load();
        const thread = answered();
        show(r, [thread]);
        assert.equal(r.Inbox.effectiveAi(thread), 'on');
        thread.is_bot_active = false;
        assert.equal(r.Inbox.effectiveAi(thread), 'paused_thread');
        thread.is_bot_active = true;
        show(r, [thread], { ...ON, is_active: false });
        assert.equal(r.Inbox.effectiveAi(thread), 'off_global', 'and the global switch outranks it');
    });

    it('decides exactly as the server does, over every combination (the server\'s effective_ai is the same decision)', () => {
        const r = load();
        for (const is_active of [true, false]) for (const is_bot_active of [true, false]) for (const sales_mode of ['off', 'test', 'on'] as const) for (const senders of [[], [SENDER]]) {
            const assistant = { configured: true, is_active, sales_mode, sales_test_senders: senders };
            show(r, [], assistant);
            const thread = { is_bot_active, instagram_user_id: SENDER };
            assert.equal(r.Inbox.effectiveAi(thread), effectiveAiOf(thread, assistant), JSON.stringify({ thread, assistant }));
        }
    });

    it('knows the same five states as the server, and a pill state for each', () => {
        const r = load();
        assert.deepEqual(plain(r.Inbox.EFFECTIVE_STATES), [...EFFECTIVE_AI_STATES]);
        for (const state of EFFECTIVE_AI_STATES) {
            const pill = r.Inbox.ASSISTANT_PILL[state];
            assert.ok(pill && r.h.UI.STATUS_PILLS.assistant[pill], `${state} has a pill state`);
        }
        assert.equal(r.Inbox.ASSISTANT_PILL.constructor, undefined, 'no prototype: a state from the data cannot find a function');
    });

    it('repaints a row when only the effective state changes: it is part of the row\'s signature', () => {
        const r = load();
        const thread = answered();
        show(r, [thread]);
        const before = r.Inbox.effectiveAi(thread);
        show(r, [thread], { ...ON, is_active: false });
        assert.notEqual(before, r.Inbox.effectiveAi(thread));
        const source = r.h.run('InboxPage.renderThreads.toString()') as string;
        assert.match(source, /this\.effectiveAi\(x\)/, 'in the signature, or the badge would stay as it was until something else changed');
    });
});

describe('Inbox: the header and the composer say the same', () => {
    it('with the assistant off, the header says so for the whole inbox, the hint stops promising a pause, and nothing offers a hand-back', () => {
        const r = load();
        const thread = answered();
        show(r, [thread], { ...ON, is_active: false });
        const pane = r.h.el('chat-pane-container');
        r.Inbox.renderChatShell(thread);
        assert.ok(pane.innerHTML.includes('id="ai-state" aria-hidden="true">Assistant off for all conversations<'), 'the effective words');
        assert.ok(!/class="ai-state is-on"/.test(pane.innerHTML), 'not green');
        assert.ok(pane.innerHTML.includes('The assistant is off for every conversation, so you are the one replying.'));
        assert.ok(!pane.innerHTML.includes('inbox:handBack'), 'there is nothing to hand back');
        assert.ok(!pane.innerHTML.includes('A manual reply pauses the AI'), 'and no promise of a pause that changes nothing');
        // The switch is still the thread's OWN switch.
        assert.match(pane.innerHTML, /<input type="checkbox" id="bot-toggle-input"\s+checked/);
    });

    it('with the assistant on, the header is as it was: "AI replies: on" in green, and the pause hint', () => {
        const r = load();
        const thread = answered();
        show(r, [thread]);
        const pane = r.h.el('chat-pane-container');
        r.Inbox.renderChatShell(thread);
        assert.ok(pane.innerHTML.includes('class="ai-state is-on" id="ai-state" aria-hidden="true">AI replies: on<'));
        assert.ok(pane.innerHTML.includes('A manual reply pauses the AI in this conversation until you hand it back.'));
    });

    it('says "sales test" and "sales assistant" where those are who answers', () => {
        const r = load();
        const thread = answered({ instagram_user_id: SENDER });
        show(r, [thread], { ...ON, sales_mode: 'test', sales_test_senders: [SENDER] });
        assert.equal(r.Inbox.aiStateText(r.Inbox.effectiveAi(thread)), 'AI replies: sales test');
        show(r, [thread], { ...ON, sales_mode: 'on' });
        assert.equal(r.Inbox.aiStateText(r.Inbox.effectiveAi(thread)), 'AI replies: sales assistant');
        assert.equal(r.Inbox.aiStateText(true), 'AI replies: on', 'a boolean still reads as the thread\'s own switch');
        assert.equal(r.Inbox.aiStateText(false), 'AI replies: off');
    });

    it('repaints the header\'s words and the hint when the global switch changes under an open thread, and writes nothing when it has not', () => {
        const r = load();
        const thread = answered();
        show(r, [thread]);
        const pane = r.h.el('chat-pane-container');
        r.Inbox.renderChatShell(thread);
        const state = r.h.el('ai-state');
        const hint = r.h.el('composer-hint');
        r.Inbox.paintAiState(thread);
        assert.equal(state.textContent, 'AI replies: on');
        hint.innerHTML = 'SENTINEL';
        r.Inbox.paintAiState(thread);
        // The hint is keyed on the effective state and the thread's own switch, and a repaint with neither changed is a no-op.
        assert.equal(hint.innerHTML, 'SENTINEL');
        assert.ok(pane);
        show(r, [thread], { ...ON, is_active: false });
        r.Inbox.paintAiState(thread);
        assert.equal(state.textContent, 'Assistant off for all conversations');
        assert.equal(hint.dataset.state, 'off_global|on');
        assert.ok(hint.innerHTML.includes('so you are the one replying'));
    });
});

// ─── The strip ─────────────────────────────────────────────────────────────────────────────

describe('Inbox: the strip above the list', () => {
    const strip = (r: Rig) => r.h.el('assistant-strip', {}).classes.has('hidden') ? null : r.h.el('assistant-strip');
    const rig = (assistant: Json | null) => {
        const r = load();
        const host = r.h.el('assistant-strip');
        host.classList.add('hidden');
        r.Inbox.adoptAssistant({ data: [], assistant });
        return { r, host };
    };

    it('says nothing while the assistant is on and sales is off or live, and while the setting is unknown', () => {
        for (const assistant of [ON, { ...ON, sales_mode: 'on' }, null]) {
            const { r, host } = rig(assistant);
            assert.equal(r.Inbox.stripKind(), null);
            assert.equal(strip(r), null, JSON.stringify(assistant));
            assert.equal(host.innerHTML, '');
        }
    });

    it('says the assistant is off for every conversation, with the way to turn it on', () => {
        const { r, host } = rig({ ...ON, is_active: false });
        assert.equal(r.Inbox.stripKind(), 'off');
        assert.equal(host.classes.has('hidden'), false);
        assert.equal(host.dataset.kind, 'off');
        const words = text(host.innerHTML);
        assert.ok(words.includes('The assistant is off for every conversation, so nobody is answered automatically.'), words);
        assert.match(host.innerHTML, /<a class="btn btn-sm btn-secondary" href="#\/ai_settings">Turn it on<\/a>/);
        assert.match(host.innerHTML, /status-strip-glyph|assistant-strip-glyph" aria-hidden="true">○</, 'a glyph as well as words');
    });

    it('says "not set up yet", a different sentence, for a tenant whose assistant was never configured: nobody switched it off', () => {
        const { r, host } = rig({ configured: false, is_active: false, sales_mode: 'off', sales_test_senders: [] });
        assert.equal(r.Inbox.stripKind(), 'notSetUp');
        assert.ok(text(host.innerHTML).includes('The assistant is not set up yet, so nobody is answered automatically.'));
        assert.ok(text(host.innerHTML).includes('Set it up'));
    });

    it('says sales is only in test, and whom it answers, with or without a test account', () => {
        const withSender = rig({ ...ON, sales_mode: 'test', sales_test_senders: [SENDER] });
        assert.equal(withSender.r.Inbox.stripKind(), 'salesTest');
        assert.ok(text(withSender.host.innerHTML).includes('the sales assistant answers only your test accounts'));
        assert.match(withSender.host.innerHTML, /assistant-strip-glyph" aria-hidden="true">◔</);
        const empty = rig({ ...ON, sales_mode: 'test', sales_test_senders: [] });
        assert.equal(empty.r.Inbox.stripKind(), 'salesTestEmpty');
        assert.ok(text(empty.host.innerHTML).includes('no test account is listed'));
    });

    it('with the assistant off, the sales mode is moot: the strip says off, not test', () => {
        const { r } = rig({ ...ON, is_active: false, sales_mode: 'test', sales_test_senders: [SENDER] });
        assert.equal(r.Inbox.stripKind(), 'off');
    });

    it('is in Arabic, and the Arabic is a different sentence for each case', () => {
        const r = load('ar');
        const kinds = new Map<string, string>();
        for (const [name, assistant] of [
            ['off', { ...ON, is_active: false }],
            ['notSetUp', { ...ON, configured: false, is_active: false }],
            ['salesTest', { ...ON, sales_mode: 'test', sales_test_senders: [SENDER] }],
            ['salesTestEmpty', { ...ON, sales_mode: 'test' }],
        ] as Array<[string, Json]>) {
            const host = r.h.el('assistant-strip');
            host.classList.add('hidden');
            r.Inbox._stripMarkup = null;
            r.Inbox.adoptAssistant({ data: [], assistant });
            kinds.set(name, text(host.innerHTML));
        }
        assert.equal(new Set(kinds.values()).size, 4);
        assert.ok(kinds.get('off')!.includes('الردّ الآلي متوقف في كل المحادثات'));
        assert.ok(kinds.get('notSetUp')!.includes('لم يُعَدّ الردّ الآلي بعد'));
        for (const sentence of kinds.values()) assert.ok(!/[A-Za-z]{4,}/.test(sentence), `no English in the Arabic strip: ${sentence}`);
    });

    it('offers no way to the settings to a viewer, who cannot change them, and still says why nobody is answered', () => {
        const r = load();
        r.viewer();
        const host = r.h.el('assistant-strip');
        host.classList.add('hidden');
        r.Inbox.adoptAssistant({ data: [], assistant: { ...ON, is_active: false } });
        assert.ok(text(host.innerHTML).includes('nobody is answered automatically'));
        assert.doesNotMatch(host.innerHTML, /<a /);
    });

    it('is written only when what it says changes, and goes away when the assistant is switched back on', () => {
        const { r, host } = rig({ ...ON, is_active: false });
        host.innerHTML = 'SENTINEL';
        r.Inbox.adoptAssistant({ data: [], assistant: { ...ON, is_active: false } });
        assert.equal(host.innerHTML, 'SENTINEL', 'an idle poll writes nothing');
        r.Inbox.adoptAssistant({ data: [], assistant: ON });
        assert.equal(host.classes.has('hidden'), true);
        assert.equal(host.innerHTML, '');
        assert.equal(host.dataset.kind, undefined);
    });

    it('survives a list answer that does not carry the assistant (an older server, a read that failed): unknown, not off', () => {
        const { r, host } = rig({ ...ON, is_active: false });
        assert.equal(host.classes.has('hidden'), false);
        r.Inbox.adoptAssistant({ data: [] });
        assert.equal(r.Inbox.assistant, null);
        assert.equal(host.classes.has('hidden'), true);
        r.Inbox.adoptAssistant(undefined);
        assert.equal(r.Inbox.assistant, null);
        r.Inbox.adoptAssistant({ data: [], assistant: { is_active: 'yes' } });
        assert.equal(r.Inbox.assistant, null, 'a value that is not a boolean is not a reading');
    });

    it('is in the layout, hidden, at the top of the list pane, and is reset with the page', () => {
        const r = load();
        const layout = String(r.Inbox.layout());
        assert.match(layout, /<div id="assistant-strip" class="assistant-strip hidden" role="status" aria-label="Assistant status"><\/div>/);
        assert.ok(layout.indexOf('assistant-strip') < layout.indexOf('class="inbox-search"'), 'above the search');
        r.Inbox.assistant = { ...ON };
        r.Inbox.resetViewState();
        assert.equal(r.Inbox.assistant, null);
        assert.equal(r.Inbox.pendingHandled.size, 0);
    });
});

// ─── Mark handled ──────────────────────────────────────────────────────────────────────────

describe('Inbox: Mark handled takes a thread out of To do and every count at once (IN-01)', () => {
    it('is offered, in the header and on the row, for a thread that needs a person, and for no other', () => {
        const r = load();
        const needs = waiting();
        const handoff = waiting({ id: 'h', stage: 'handoff', handoff_at: ago(2 * HOUR), last_message_direction: 'outbound', is_bot_active: true });
        const quiet = answered();
        show(r, [needs, handoff, quiet]);

        for (const thread of [needs, handoff]) {
            const row = String(r.Inbox.rowActionMarkup(thread));
            assert.match(row, /data-action="inbox:markHandled"/);
            assert.ok(row.includes(`data-id="${thread.id}"`));
            assert.match(row, /aria-label="Mark handled: \u2068@sara_dev\u2069"/);
            const head = String(r.Inbox.handledSlotMarkup(thread));
            assert.match(head, /data-action="inbox:markHandled"/);
            assert.ok(text(head).includes('Mark handled'));
        }
        assert.equal(String(r.Inbox.rowActionMarkup(quiet)), '', 'the AI is answering it: nothing for the owner to do');
        assert.equal(String(r.Inbox.handledSlotMarkup(quiet)), '');
    });

    it('is never offered to a viewer: the route is the operator\'s', () => {
        const r = load();
        r.viewer();
        const thread = waiting();
        show(r, [thread]);
        assert.equal(String(r.Inbox.rowActionMarkup(thread)), '');
        assert.equal(String(r.Inbox.handledSlotMarkup(thread)), '');
        assert.equal(String(r.Inbox.windowOfferMarkup(waiting({ last_inbound_message_at: ago(30 * HOUR) }))), '');
        return r.Inbox.markHandled('c1').then(() => assert.deepEqual(r.calls, [], 'and a stray call goes nowhere'));
    });

    it('marks the thread handled before the server answers: it leaves needsHuman, the count and the badges in the same frame', async () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        r.Inbox.reportWaiting();
        assert.deepEqual(r.badge, [1]);
        let release: (v: Json) => void = () => {};
        r.api.markConversationHandled = (id: string) => { r.calls.push({ method: 'mark', args: [id] }); return new Promise((resolve) => { release = resolve; }); };

        const pending = r.Inbox.markHandled('c1');
        assert.deepEqual(plain(r.calls), [{ method: 'mark', args: ['c1'] }]);
        assert.ok(thread.handled_at, 'stamped now');
        assert.equal(r.h.Attention.needsHuman(thread), false, 'out of To do');
        assert.equal(r.badge.at(-1), 0, 'the nav badge and the tab title follow at once');
        assert.equal(r.Inbox.needsReply(thread), false, 'out of the "Needs reply" filter and its count');
        assert.equal(r.Inbox.pendingHandled.has('c1'), true, 'held until the server answers');
        const row = String(r.Inbox.threadRow(thread));
        assert.ok(text(row).includes('Handled'), 'the row says why its badges are gone');
        assert.doesNotMatch(row, /badge-danger/, 'no "Inbound" any more');
        assert.ok(!/left to reply/.test(text(row)), 'and no countdown');

        release({ id: 'c1', handled_at: '2026-10-19T09:00:00.000Z' });
        await pending;
        assert.equal(thread.handled_at, '2026-10-19T09:00:00.000Z', 'the server\'s stamp replaces the optimistic one');
        assert.equal(r.Inbox.pendingHandled.size, 0);
        assert.equal(r.h.Attention.isHandled({ ...thread, last_inbound_message_at: '2026-10-19T08:00:00.000Z', last_message_direction: 'outbound' }), true);
    });

    it('offers Undo, says what brings the thread back, and Undo reopens it', async () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        await r.Inbox.markHandled('c1');
        assert.equal(r.undos.length, 1);
        assert.equal(r.undos[0]!.message, 'Marked handled. If they write again, it comes back to your list.');
        assert.equal(r.toasts.length, 0, 'no error');

        await r.undos[0]!.opts.onUndo();
        assert.deepEqual(plain(r.calls.map((c) => c.method)), ['mark', 'unmark']);
        assert.equal(thread.handled_at, null);
        assert.equal(r.h.Attention.needsHuman(thread), true, 'back in To do');
        assert.equal(r.badge.at(-1), 1);
    });

    it('Reopen from the header does the same and says so', async () => {
        const r = load();
        const thread = waiting({ handled_at: new Date().toISOString() });
        show(r, [thread]);
        const head = String(r.Inbox.handledSlotMarkup(thread));
        assert.match(head, /data-action="inbox:unmarkHandled"/);
        assert.ok(text(head).includes('Reopen'));
        await r.Inbox.unmarkHandled('c1');
        assert.deepEqual(plain(r.calls), [{ method: 'unmark', args: ['c1'] }]);
        assert.equal(thread.handled_at, null);
        assert.deepEqual(r.h.announcements, ['Back in your list.']);
    });

    it('puts everything back and says why, in words, when the server refuses; and offers no Undo for what did not happen', async () => {
        const r = load();
        const thread = waiting({ handled_at: null });
        show(r, [thread]);
        r.api.markConversationHandled = () => Promise.reject(Object.assign(new Error('Conversation not found.'), { status: 404 }));
        await r.Inbox.markHandled('c1');
        assert.equal(thread.handled_at, null, 'as it was');
        assert.equal(r.h.Attention.needsHuman(thread), true);
        assert.equal(r.badge.at(-1), 1);
        assert.equal(r.undos.length, 0);
        assert.equal(r.toasts.length, 1);
        assert.equal(r.toasts[0]!.message, 'Conversation not found.');
        assert.equal(r.toasts[0]!.arg, 'error');
        assert.equal(r.Inbox.pendingHandled.size, 0, 'and the hold is released');
    });

    it('a refusal that carries a code is said as that code\'s sentence, not as the server\'s English', async () => {
        const r = load('ar');
        const thread = waiting();
        show(r, [thread]);
        // Any code the catalogue knows will do: what is pinned is that the toast goes through `UI.errorText`.
        r.api.markConversationHandled = () => Promise.reject(Object.assign(new Error('Fix it.'), { code: 'META_NOT_CONNECTED' }));
        await r.Inbox.markHandled('c1');
        assert.notEqual(r.toasts[0]!.message, 'Fix it.');
        assert.equal(r.toasts[0]!.message, r.h.UI.errorText({ code: 'META_NOT_CONNECTED' }).sentence);
    });

    it('a second press while the first is in flight is ignored: one request', async () => {
        const r = load();
        show(r, [waiting()]);
        let release: (v: Json) => void = () => {};
        r.api.markConversationHandled = (id: string) => { r.calls.push({ method: 'mark', args: [id] }); return new Promise((resolve) => { release = resolve; }); };
        const first = r.Inbox.markHandled('c1');
        const second = r.Inbox.markHandled('c1');
        release({ id: 'c1', handled_at: new Date().toISOString() });
        await Promise.all([first, second]);
        assert.equal(r.calls.length, 1);
        assert.equal(r.undos.length, 1, 'and one Undo');
    });

    it('a poll that left before the write committed cannot bring the thread back: the stamp in flight outranks its rows', async () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        r.api.markConversationHandled = () => new Promise(() => {});
        void r.Inbox.markHandled('c1');
        const stamp = thread.handled_at;
        const polled = r.Inbox.applyPending([waiting({ handled_at: null }), answered()]);
        assert.equal(polled[0].handled_at, stamp, 'the polled copy of the thread is handled too');
        assert.equal(r.h.Attention.needsHuman(polled[0]), false);
        assert.equal(polled[1].handled_at, undefined, 'another thread is left alone');
    });

    it('never stamps earlier than the customer\'s last message, even with a clock that is behind the server\'s', () => {
        const r = load();
        // The customer's last message is TEN MINUTES IN THE FUTURE by this computer's clock: the server's clock is ahead.
        const thread = waiting({ last_inbound_message_at: new Date(Date.now() + 10 * 60000).toISOString(), last_message_at: new Date(Date.now() + 10 * 60000).toISOString() });
        show(r, [thread]);
        r.api.markConversationHandled = () => new Promise(() => {});
        void r.Inbox.markHandled('c1');
        assert.ok(Date.parse(thread.handled_at) > Date.parse(thread.last_inbound_message_at), 'handled is after the last message');
        assert.equal(r.h.Attention.needsHuman(thread), false, 'so it really leaves To do');
    });

    it('a customer who writes again brings the thread back, whatever the server did: the newer message ends "handled"', () => {
        const r = load();
        const marked = waiting({ handled_at: ago(30 * 60000), last_inbound_message_at: ago(2 * HOUR), last_message_at: ago(2 * HOUR) });
        show(r, [marked]);
        assert.equal(r.h.Attention.needsHuman(marked), false, 'handled, and quiet since');
        const wroteAgain = { ...marked, last_inbound_message_at: ago(60000), last_message_at: ago(60000), last_message_direction: 'inbound' };
        assert.equal(r.h.Attention.needsHuman(wroteAgain), true, 'even if the stamp was not cleared');
        assert.equal(r.Inbox.needsReply(wroteAgain), true);
        assert.equal(String(r.Inbox.rowActionMarkup(wroteAgain)).includes('inbox:markHandled'), true, 'and the button is back');
        // And the server's own answer, with the stamp cleared, is the same.
        assert.equal(r.h.Attention.isHandled({ ...wroteAgain, handled_at: null }), false);
    });

    it('applies to the search\'s copy of the thread as well as the list\'s', async () => {
        const r = load();
        const inList = waiting();
        const inSearch = waiting();
        show(r, [inList]);
        r.Inbox.searchMatches = { term: 'sara', rows: [inSearch] };
        await r.Inbox.markHandled('c1');
        assert.ok(inList.handled_at && inSearch.handled_at);
    });

    it('filters and counts leave a handled thread out, and keep it findable under All', () => {
        const r = load();
        const open = waiting({ id: 'open' });
        const done = waiting({ id: 'done', handled_at: new Date().toISOString(), last_inbound_message_at: ago(HOUR), last_message_at: ago(HOUR) });
        const handoff = waiting({ id: 'ho', stage: 'handoff', handoff_at: ago(2 * HOUR), last_message_direction: 'outbound' });
        const handoffDone = { ...handoff, id: 'hd', handled_at: new Date().toISOString() };
        show(r, [open, done, handoff, handoffDone]);
        r.Inbox.filter = 'waiting';
        assert.deepEqual(plain(r.Inbox.visibleThreads().map((x: Json) => x.id)), ['open']);
        r.Inbox.filter = 'needs_you';
        assert.deepEqual(plain(r.Inbox.visibleThreads().map((x: Json) => x.id)), ['ho']);
        r.Inbox.filter = 'all';
        assert.equal(r.Inbox.visibleThreads().length, 4, 'handled threads stay findable');
        r.Inbox.reportWaiting();
        assert.equal(r.badge.at(-1), 2, 'open + the handoff');
        const count = r.h.el('inbox-count');
        r.Inbox.renderCount();
        assert.ok(text(count.innerHTML).startsWith('1 need a reply') || text(count.innerHTML).includes('1'), text(count.innerHTML));
    });

    it('the header says the thread is handled, and its detail strip loses the countdown and "Needs you"', () => {
        const r = load();
        const handoff = waiting({ stage: 'handoff', handoff_at: ago(2 * HOUR), last_message_direction: 'outbound' });
        show(r, [handoff]);
        const before = text(r.Inbox.metaMarkup(handoff));
        assert.ok(before.includes('Needs you') && /left to reply/.test(before));
        handoff.handled_at = new Date().toISOString();
        const after = text(r.Inbox.metaMarkup(handoff));
        assert.ok(!after.includes('Needs you') && !/left to reply/.test(after), after);
        assert.ok(after.includes('Handled'));
    });

    it('paints the header slot poll-safely: written when it changes, never when it has not', () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        const pane = r.h.el('chat-pane-container');
        r.Inbox.renderChatShell(thread);
        const slot = r.h.el('chat-handled-slot');
        assert.ok(pane.innerHTML.includes('id="chat-handled-slot"'));
        assert.ok(pane.innerHTML.includes('data-action="inbox:markHandled"'), 'in the shell');
        slot.innerHTML = 'SENTINEL';
        r.Inbox.paintHandled(thread);
        assert.equal(slot.innerHTML, 'SENTINEL', 'nothing changed: nothing written');
        thread.handled_at = new Date().toISOString();
        r.Inbox.paintHandled(thread);
        assert.ok(slot.innerHTML.includes('inbox:unmarkHandled'), 'handled: now "Reopen"');
        thread.handled_at = null;
        thread.is_bot_active = true;
        thread.last_message_direction = 'outbound';
        r.Inbox.paintHandled(thread);
        assert.equal(slot.innerHTML, '', 'nothing for the owner to do');
    });
});

// ─── The composer, once the window has closed ───────────────────────────────────────────────

describe('Inbox: once Meta\'s 24 h window has closed, the composer offers "Replied in Instagram: mark handled"', () => {
    const closed = (over: Json = {}) => waiting({ last_inbound_message_at: ago(30 * HOUR), last_message_at: ago(30 * HOUR), ...over });

    it('says the window has closed, to reply in the Instagram app, then mark it handled, with the button that does', () => {
        const r = load();
        const thread = closed();
        show(r, [thread]);
        const offer = String(r.Inbox.windowOfferMarkup(thread));
        assert.ok(text(offer).includes('The reply window has closed, so a reply from here cannot reach them. Reply from the Instagram app, then mark it handled.'), text(offer));
        assert.match(offer, /data-action="inbox:markHandled"/);
        assert.ok(offer.includes(`data-id="${thread.id}"`));
        assert.ok(text(offer).includes('Replied in Instagram: mark handled'));
    });

    it('speaks of the Page inbox for a Messenger thread, not the Instagram app', () => {
        const r = load();
        const thread = closed({ platform: 'facebook' });
        show(r, [thread]);
        const offer = text(r.Inbox.windowOfferMarkup(thread));
        assert.ok(offer.includes('Reply from your Page inbox on Facebook'));
        assert.ok(offer.includes('Replied on Facebook: mark handled'));
        assert.ok(!offer.includes('Instagram'));
    });

    it('is in Arabic', () => {
        const r = load('ar');
        const thread = closed();
        show(r, [thread]);
        const offer = text(r.Inbox.windowOfferMarkup(thread));
        assert.ok(offer.includes('انتهت مهلة الردّ'));
        assert.ok(offer.includes('رددتُ في إنستغرام: تمّ التعامل'));
    });

    it('offers nothing while the window is open (the owner can just reply), or once the thread is handled, or when nobody has to answer it, or when the customer has not written', () => {
        const r = load();
        const cases: Array<[string, Json]> = [
            ['open', waiting({ last_inbound_message_at: ago(2 * HOUR) })],
            ['handled', closed({ handled_at: new Date().toISOString() })],
            ['the AI is answering', answered({ last_inbound_message_at: ago(30 * HOUR) })],
            ['no message from the customer', waiting({ last_inbound_message_at: null, last_inbound_at: null })],
        ];
        for (const [name, thread] of cases) {
            show(r, [thread]);
            assert.equal(String(r.Inbox.windowOfferMarkup(thread)), '', name);
        }
    });

    it('is part of the composer in the chat shell, and is repainted by a poll when the window closes under an open thread', () => {
        const r = load();
        const thread = waiting({ last_inbound_message_at: ago(23 * HOUR + 59 * 60000) });
        show(r, [thread]);
        const pane = r.h.el('chat-pane-container');
        r.Inbox.renderChatShell(thread);
        assert.ok(pane.innerHTML.includes('id="composer-window"'));
        assert.ok(!pane.innerHTML.includes('composer-mark-handled'), 'one minute left: no offer yet');
        const host = r.h.el('composer-window');
        thread.last_inbound_message_at = ago(24 * HOUR + 60000);
        r.Inbox.paintWindowOffer(thread);
        assert.ok(host.innerHTML.includes('composer-mark-handled'), 'the window closed: now it is offered');
        host.innerHTML = 'SENTINEL';
        r.Inbox.paintWindowOffer(thread);
        assert.equal(host.innerHTML, 'SENTINEL', 'and not rewritten while it is unchanged');
    });
});

// ─── Wiring: actions, API, strings ──────────────────────────────────────────────────────────

describe('Inbox: Mark handled is wired', () => {
    it('registers both actions, and each reads the id from the button', async () => {
        const r = load();
        const thread = waiting();
        show(r, [thread]);
        const actions = r.h.run('UI._actions') as Json;
        const inbox = actions && actions.inbox;
        assert.ok(inbox && typeof inbox.markHandled === 'function' && typeof inbox.unmarkHandled === 'function', 'registered under "inbox"');
        await inbox.markHandled({ dataset: { id: 'c1' } });
        assert.equal(thread.handled_at !== null, true);
        await inbox.unmarkHandled({ dataset: { id: 'c1' } });
        assert.equal(thread.handled_at, null);
        await inbox.markHandled({});
        assert.equal(r.calls.length, 2, 'a button with no id does nothing');
    });

    it('calls the two routes, with the id encoded, as POST and DELETE', async () => {
        const seen: Array<{ path: string; init: Json }> = [];
        const h = loadDashboard({ files: ['dashboard/js/api.js'] });
        h.run('API').request = (path: string, init: Json) => { seen.push({ path, init }); return Promise.resolve({}); };
        await h.run("API.markConversationHandled('a b/c')");
        await h.run("API.unmarkConversationHandled('a b/c')");
        assert.deepEqual(plain(seen), [
            { path: '/conversations/a%20b%2Fc/handled', init: { method: 'POST' } },
            { path: '/conversations/a%20b%2Fc/handled', init: { method: 'DELETE' } },
        ]);
    });

    it('has every new string in both languages, with the same placeholders', () => {
        const en = loadDashboard({ lang: 'en' }).I18N.strings.en as Record<string, string>;
        const ar = loadDashboard({ lang: 'ar' }).I18N.strings.ar as Record<string, string>;
        const keys = Object.keys(en).filter((k) => /^(inbox\.(assistant|aiState|strip|handled)\.|inbox\.composerHintOffGlobal|inbox\.window\.offer|status\.assistant\.|audit\.action\.dm\.conversation_)/.test(k));
        assert.ok(keys.length >= 28, `found ${keys.length}`);
        const holes = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
        for (const key of keys) {
            assert.ok(typeof ar[key] === 'string' && ar[key]!.trim() !== '', `${key} missing in Arabic`);
            assert.deepEqual(holes(ar[key]!), holes(en[key]!), `${key}: placeholders differ`);
        }
        // Every state has a sentence that says what it means for the person.
        for (const state of ['on', 'off', 'paused_here', 'sales_test', 'sales_live']) assert.ok(en[`status.assistant.${state}.hint`] && ar[`status.assistant.${state}.hint`], state);
    });

    it('is not "bot" anywhere in what a person reads (the voice rule), in either language', () => {
        const en = loadDashboard({ lang: 'en' }).I18N.strings.en as Record<string, string>;
        const ar = loadDashboard({ lang: 'ar' }).I18N.strings.ar as Record<string, string>;
        for (const key of Object.keys(en).filter((k) => /^(inbox\.(assistant|aiState|strip|handled)\.|inbox\.window\.offer)/.test(k))) {
            assert.ok(!/\bbot\b/i.test(en[key]!), key);
            assert.ok(!/بوت/.test(ar[key]!), key);
        }
    });
});

// Keep `settle` referenced: the harness exports it for suites that wait on timers, and none of these does.
void settle;
